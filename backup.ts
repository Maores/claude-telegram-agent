/**
 * backup.ts, nightly state backup (roadmap 0.1).
 *
 *   bun run backup.ts run              snapshot state to ~/backups/agent-backup-<ts>.tar.gz
 *   bun run backup.ts verify <tar.gz>  restore drill: extract to a temp dir, check the
 *                                      db snapshot, print table and file counts
 *
 * What goes in: a WAL-safe snapshot of memory/bot.db (VACUUM INTO), the JSON
 * state files, quiz-paused.flag, memory markdown + mirror, skills/, history/,
 * quiz data, the Avot study position, the untracked guard-hook wiring
 * (.claude/settings.local.json), and the Telegram allowlist from the home dir. Secrets (.env files) are
 * deliberately excluded: tokens are re-issuable, archives leave the box.
 * uploads/ is excluded as replaceable bulk. Rotation keeps the newest 14.
 *
 * The manifest lists below are the backup's own inventory on purpose (no
 * imports from app modules, so a broken app can't break its backup; the one
 * import is paths.ts, the leaf module that says where the state lives); when a
 * new state file is added to the bot, add it here too.
 *
 * Layout: with STATE_DIR (or the repo's .state-dir marker) set, state is read
 * from the state folder (poller-only files at its top, turn-writable ones under
 * shared/), but archive member names stay repo/<logical>, so an archive
 * restores into either layout.
 */

import { Database } from "bun:sqlite";
import {
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { REPO_DIR, stateDir } from "./paths.ts";
import { hardenDb } from "./db.ts";

const KEEP = 14;

/** Where the db snapshot sits inside the archive (also checked by verify). */
const DB_DEST = "repo/memory/bot.db";

/** Tables a healthy snapshot must contain; verify fails if any is missing. */
const REQUIRED_TABLES = ["messages", "memory", "skills"];

// Paths (files or dirs) copied when present, by where they live. Each lands in
// the archive as `repo/<logical>` whatever the layout, so an archive restores
// into either layout. The live bot.db is NOT here on purpose: it gets a
// consistent VACUUM INTO snapshot instead.

/** Always read from the repo. */
const REPO_ONLY = ["data/questions.json", ".claude/settings.local.json"];
/** Poller-only state: the top of the state folder. */
const TOP = ["cal_notified.json", "data/quiz-state.json", "history", "approvals.json"];
/** Turn-writable state: logical name -> path under the state folder's shared/.
 *  Copied without following a link or opening anything but a regular file. */
const SHARED: Record<string, string> = {
  "reminders.json": "stores/reminders.json",
  "followups.json": "stores/followups.json",
  "choices.json": "stores/choices.json",
  "pending.json": "stores/pending.json",
  "quiz-paused.flag": "stores/quiz-paused.flag",
  "memory/MEMORY.md": "memory/MEMORY.md",
  "memory/calendar_defaults.md": "memory/calendar_defaults.md",
  "memory/mirror": "memory/mirror",
  skills: "skills",
  "data/avot-state.json": "data/avot-state.json",
};

/** Home-relative paths copied when present. Never .env: secrets stay out of
 *  archives. */
const HOME_PATHS = [".claude/channels/telegram/access.json"];

/** On Windows, bare "tar" can resolve to Git's GNU tar, which misreads
 *  drive-letter paths as remote host specs; pin the native bsdtar instead. */
export const TAR_BIN =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

export interface ManifestEntry {
  src: string; // absolute source path
  dest: string; // path inside the archive (repo/... or home/...)
  noFollow: boolean; // turn-writable: copy regular files only, never through a link
}

export function archiveName(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `agent-backup-${stamp}.tar.gz`;
}

/** Which archives to delete: everything past the newest `keep`, judged by the
 *  timestamp embedded in the name (lexicographic = chronological). */
export function pruneList(names: string[], keep: number): string[] {
  return [...names].sort().reverse().slice(Math.max(0, keep));
}

/** Existing state files/dirs mapped to archive entries. Pure inventory.
 *  stateRoot === repoRoot is the old layout (every logical path under the
 *  repo); otherwise poller-only state sits at the top of stateRoot and
 *  turn-writable state under stateRoot/shared/. */
export function buildManifest(
  repoRoot: string,
  home: string,
  stateRoot: string = repoRoot,
): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  const add = (src: string, logical: string, noFollow = false) => {
    if (existsSync(src)) entries.push({ src, dest: `repo/${logical}`, noFollow });
  };
  const oldLayout = stateRoot === repoRoot;
  for (const rel of REPO_ONLY) add(join(repoRoot, rel), rel);
  for (const rel of TOP) add(join(stateRoot, rel), rel);
  for (const [rel, under] of Object.entries(SHARED)) {
    add(oldLayout ? join(repoRoot, rel) : join(stateRoot, "shared", under), rel, true);
  }
  for (const rel of HOME_PATHS) {
    const src = join(home, rel);
    if (existsSync(src)) entries.push({ src, dest: `home/${rel}`, noFollow: false });
  }
  return entries;
}

type Ident = { dev: bigint; ino: bigint };

/** The same per-file cap as paths.ts readNoFollow. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The backup's own uid; undefined on win32, where there is no owner rule. */
function processUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Descend only into a folder the backup's own user owns: a folder a turn
 *  owns, it can swap for a link at any moment. No uid (win32): always. */
export function mayDescend(st: { uid: number | bigint }, uid: number | undefined): boolean {
  return uid === undefined || BigInt(st.uid) === BigInt(uid);
}

/** Read a turn-writable file's bytes the way readNoFollow does (no link at the
 *  last component, no FIFO, never blocking, size-capped), and also check that
 *  the opened file is the one lstat saw (same dev and inode) and, on Linux,
 *  that the kernel's path for the open file lies under `root` (so a folder
 *  swapped for a link mid-path cannot redirect the read outside). */
export function readChecked(path: string, expect: Ident, root: string | null): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
    if (st.dev !== expect.dev || st.ino !== expect.ino) throw new Error(`changed since its lstat: ${path}`);
    if (st.size > BigInt(MAX_FILE_BYTES)) throw new Error(`file over cap: ${path}`);
    if (root !== null && process.platform === "linux") {
      const real = readlinkSync(`/proc/self/fd/${fd}`);
      if (!real.startsWith(root + sep)) throw new Error(`resolves outside ${root}: ${path}`);
    }
    const size = Number(st.size);
    const buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

export interface CopyOpts {
  /** Owner a folder must have to be descended into (default: the process uid). */
  uid?: number;
  /** Real path every copied file must resolve under (default: the entry's own folder). */
  root?: string;
  /** Test seam: runs just before a folder is listed. */
  beforeReaddir?: (dir: string) => void;
}

/** Copy a turn-writable file or folder into the stage. A folder is descended
 *  into only when the backup's user owns it, and is skipped when it is no
 *  longer the same folder (dev, inode) after being listed; a file is read with
 *  readChecked. A link, FIFO, foreign or unreadable folder, or any other
 *  failure is skipped with a warning instead of failing the whole backup.
 *  Returns how many items were skipped.
 *
 *  Residual race: a folder swapped for a link and back within the listing
 *  window can leak its entry names (empty folders at most) into the archive;
 *  no file content outside `root` is read, since every read is checked by the
 *  kernel's path of the open file (Linux). */
export function copyNoFollow(src: string, dest: string, opts: CopyOpts = {}): number {
  const uid = opts.uid ?? processUid();
  const skip = (why: unknown) => {
    console.error(`[BACKUP] skipped ${src}: ${why}`);
    return 1;
  };
  let st;
  try {
    st = lstatSync(src, { bigint: true });
  } catch (e) {
    return skip(e);
  }
  let root = opts.root;
  if (root === undefined) {
    try {
      root = realpathSync(st.isDirectory() ? src : dirname(src));
    } catch (e) {
      return skip(e);
    }
  }
  if (st.isDirectory()) {
    if (!mayDescend(st, uid)) return skip("folder not owned by the backup's user");
    let names: string[];
    try {
      opts.beforeReaddir?.(src);
      names = readdirSync(src);
      const again = lstatSync(src, { bigint: true });
      if (!again.isDirectory() || again.dev !== st.dev || again.ino !== st.ino) {
        return skip("folder changed while being listed");
      }
    } catch (e) {
      return skip(e);
    }
    mkdirSync(dest, { recursive: true });
    let skipped = 0;
    for (const name of names) {
      skipped += copyNoFollow(join(src, name), join(dest, name), { ...opts, uid, root });
    }
    return skipped;
  }
  if (!st.isFile()) return skip("not a regular file or folder");
  try {
    writeFileSync(dest, readChecked(src, st, root));
    return 0;
  } catch (e) {
    return skip(e);
  }
}

/** Remove a temp dir without letting cleanup failures outrank the real
 *  outcome (Windows can hold handles briefly: EBUSY). Retries, then warns. */
function cleanupDir(dir: string, label: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {
    console.error(`[BACKUP] temp cleanup failed (${label}, non-fatal): ${e}`);
  }
}

function tar(args: string[]): void {
  const p = Bun.spawnSync([TAR_BIN, ...args]);
  if (p.exitCode !== 0) {
    throw new Error(`tar ${args[0]} failed: ${p.stderr.toString().trim()}`);
  }
}

function snapshotDb(dbPath: string, outPath: string): void {
  mkdirSync(dirname(outPath), { recursive: true });
  const db = new Database(dbPath, { readonly: true });
  try {
    hardenDb(db); // a turn can write bot.db: no schema-defined code runs with this reader's trust
    db.exec("PRAGMA busy_timeout = 5000"); // ride out a concurrent poller write
    db.exec(`VACUUM INTO '${outPath.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

/** Point latest.tar.gz at `name` atomically (tmp link + rename), and remove a
 *  dangling link first (existsSync follows links, so rmSync force is the only
 *  safe cleanup). Non-fatal: the archive itself is already on disk. */
function refreshLatestLink(backupsDir: string, name: string): void {
  const latest = join(backupsDir, "latest.tar.gz");
  const tmpLink = join(backupsDir, "latest.tar.gz.tmp");
  try {
    rmSync(tmpLink, { force: true });
    symlinkSync(name, tmpLink); // relative target: survives dir moves
    renameSync(tmpLink, latest);
  } catch (e) {
    rmSync(tmpLink, { force: true });
    console.error(`[BACKUP] latest symlink failed (non-fatal): ${e}`);
  }
}

export function run(
  repoRoot: string = import.meta.dir,
  home: string = homedir(),
  backupsDir: string = join(homedir(), "backups"),
  env: Record<string, string | undefined> = process.env,
): string {
  mkdirSync(backupsDir, { recursive: true });
  // The real repo follows paths.ts (STATE_DIR, then the .state-dir marker); a
  // temp repo root (tests) is never redirected by the real repo's marker.
  const stateRoot = repoRoot === REPO_DIR ? stateDir(env) : (env.STATE_DIR || repoRoot);
  const memoryDir = stateRoot === repoRoot ? join(repoRoot, "memory") : join(stateRoot, "shared", "memory");

  const stage = mkdtempSync(join(tmpdir(), "agent-backup-"));
  try {
    snapshotDb(join(memoryDir, "bot.db"), join(stage, DB_DEST));

    const manifest = buildManifest(repoRoot, home, stateRoot);
    let skipped = 0;
    for (const e of manifest) {
      const dest = join(stage, e.dest);
      mkdirSync(dirname(dest), { recursive: true });
      if (e.noFollow) skipped += copyNoFollow(e.src, dest);
      else cpSync(e.src, dest, { recursive: true });
    }
    // List what actually landed (a skipped turn-writable file is not listed).
    const entries = manifest.filter((e) => existsSync(join(stage, e.dest)));

    const lines = [
      `created: ${new Date().toISOString()}`,
      `db: ${DB_DEST} (VACUUM INTO snapshot)`,
      ...entries.map((e) => e.dest),
      ...(skipped ? [`skipped: ${skipped} (turn-writable items not copied; see the log)`] : []),
    ];
    writeFileSync(join(stage, "MANIFEST.txt"), lines.join("\n") + "\n");

    const name = archiveName(new Date());
    const out = join(backupsDir, name);
    tar(["czf", `${out}.part`, "-C", stage, "."]);
    renameSync(`${out}.part`, out); // archive appears only when complete

    refreshLatestLink(backupsDir, name);

    const archives = readdirSync(backupsDir).filter((n) =>
      /^agent-backup-\d{8}-\d{6}\.tar\.gz$/.test(n),
    );
    for (const stale of pruneList(archives, KEEP)) {
      rmSync(join(backupsDir, stale), { force: true });
    }

    const kb = Math.round(statSync(out).size / 1024);
    console.log(
      `[BACKUP] wrote ${name} (${kb} KB, db snapshot + ${entries.length} items` +
        `${skipped ? `, ${skipped} skipped` : ""}), ` +
        `keeping ${Math.min(archives.length, KEEP)}/${KEEP} in ${backupsDir}`,
    );
    return out;
  } finally {
    cleanupDir(stage, "run stage");
  }
}

/** Restore drill. Returns true only when the archive extracts, the db snapshot
 *  opens, and every required table exists. */
export function verify(archive: string): boolean {
  if (!archive || !existsSync(archive)) {
    console.error(`[BACKUP] verify FAILED: archive not found: ${archive}`);
    return false;
  }
  const stage = mkdtempSync(join(tmpdir(), "agent-verify-"));
  try {
    tar(["xzf", archive, "-C", stage]);

    const dbPath = join(stage, DB_DEST);
    if (!existsSync(dbPath)) {
      console.error("[BACKUP] verify FAILED: no db snapshot in archive");
      return false;
    }

    let ok = true;
    const db = new Database(dbPath, { readonly: true });
    try {
      hardenDb(db);
      const tables = (
        db
          .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      ).map((r) => r.name);
      for (const t of tables) {
        const row = db.query(`SELECT COUNT(*) AS c FROM "${t}"`).get() as { c: number };
        console.log(`${t}: ${row.c}`);
      }
      for (const req of REQUIRED_TABLES) {
        if (!tables.includes(req)) {
          console.error(`[BACKUP] verify FAILED: required table missing: ${req}`);
          ok = false;
        }
      }
    } finally {
      db.close();
    }

    const files = readdirSync(stage, { recursive: true, withFileTypes: true }).filter((d) =>
      d.isFile(),
    ).length;
    console.log(`files in archive: ${files}`);
    console.log(ok ? "[BACKUP] verify OK" : "[BACKUP] verify FAILED");
    return ok;
  } catch (e) {
    console.error(`[BACKUP] verify FAILED: ${e}`);
    return false;
  } finally {
    cleanupDir(stage, "verify stage");
  }
}

if (import.meta.main) {
  const [cmd = "run", arg] = Bun.argv.slice(2);
  if (cmd === "run") {
    run();
  } else if (cmd === "verify") {
    process.exit(verify(arg ?? "") ? 0 : 1);
  } else {
    console.error("usage: bun run backup.ts [run | verify <archive.tar.gz>]");
    process.exit(1);
  }
}
