/**
 * backup.ts, nightly state backup (roadmap 0.1).
 *
 *   bun run backup.ts run              snapshot state to ~/backups/agent-backup-<ts>.tar.gz
 *   bun run backup.ts verify <tar.gz>  restore drill: extract to a temp dir, check the
 *                                      db snapshot, print table and file counts
 *
 * What goes in: a WAL-safe snapshot of memory/bot.db (VACUUM INTO), the JSON
 * state files, quiz-paused.flag, memory markdown + mirror, skills/, history/,
 * quiz data, the untracked guard-hook wiring (.claude/settings.local.json),
 * and the Telegram allowlist from the home dir. Secrets (.env files) are
 * deliberately excluded: tokens are re-issuable, archives leave the box.
 * uploads/ is excluded as replaceable bulk. Rotation keeps the newest 14.
 *
 * The manifest lists below are the backup's own inventory on purpose (no
 * imports from app modules, so a broken app can't break its backup); when a
 * new state file is added to the bot, add it here too.
 */

import { Database } from "bun:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const KEEP = 14;

/** Where the db snapshot sits inside the archive (also checked by verify). */
const DB_DEST = "repo/memory/bot.db";

/** Tables a healthy snapshot must contain; verify fails if any is missing. */
const REQUIRED_TABLES = ["messages", "memory", "skills"];

/** Repo-relative paths (files or dirs) copied when present. The live bot.db
 *  is NOT here on purpose: it gets a consistent VACUUM INTO snapshot instead. */
const REPO_PATHS = [
  "reminders.json",
  "followups.json",
  "choices.json",
  "pending.json",
  "cal_notified.json",
  "quiz-paused.flag",
  "data/questions.json",
  "data/quiz-state.json",
  "memory/MEMORY.md",
  "memory/calendar_defaults.md",
  "memory/mirror",
  "skills",
  "history",
  ".claude/settings.local.json",
];

/** Home-relative paths copied when present. Never .env: secrets stay out of
 *  archives. */
const HOME_PATHS = [".claude/channels/telegram/access.json"];

/** On Windows, bare "tar" can resolve to Git's GNU tar, which misreads
 *  drive-letter paths as remote host specs; pin the native bsdtar instead. */
const TAR_BIN =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

export interface ManifestEntry {
  src: string; // absolute source path
  dest: string; // path inside the archive (repo/... or home/...)
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

/** Existing state files/dirs mapped to archive entries. Pure inventory. */
export function buildManifest(repoRoot: string, home: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const rel of REPO_PATHS) {
    const src = join(repoRoot, rel);
    if (existsSync(src)) entries.push({ src, dest: `repo/${rel}` });
  }
  for (const rel of HOME_PATHS) {
    const src = join(home, rel);
    if (existsSync(src)) entries.push({ src, dest: `home/${rel}` });
  }
  return entries;
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
): string {
  mkdirSync(backupsDir, { recursive: true });

  const stage = mkdtempSync(join(tmpdir(), "agent-backup-"));
  try {
    snapshotDb(join(repoRoot, "memory", "bot.db"), join(stage, DB_DEST));

    const entries = buildManifest(repoRoot, home);
    for (const e of entries) {
      const dest = join(stage, e.dest);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(e.src, dest, { recursive: true });
    }

    const lines = [
      `created: ${new Date().toISOString()}`,
      `db: ${DB_DEST} (VACUUM INTO snapshot)`,
      ...entries.map((e) => e.dest),
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
      `[BACKUP] wrote ${name} (${kb} KB, db snapshot + ${entries.length} items), ` +
        `keeping ${Math.min(archives.length, KEEP)}/${KEEP} in ${backupsDir}`,
    );
    return out;
  } finally {
    rmSync(stage, { recursive: true, force: true });
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
    rmSync(stage, { recursive: true, force: true });
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
