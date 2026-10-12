import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  TAR_BIN,
  archiveName,
  buildManifest,
  copyNoFollow,
  mayDescend,
  pruneList,
  readChecked,
  run,
  verify,
} from "./backup.ts";

// --- archiveName -----------------------------------------------------------------

test("archiveName embeds a sortable local timestamp", () => {
  const d = new Date(2026, 6, 9, 3, 30, 7); // 2026-07-09 03:30:07 local
  expect(archiveName(d)).toBe("agent-backup-20260709-033007.tar.gz");
});

test("archiveName pads single-digit fields", () => {
  const d = new Date(2026, 0, 2, 4, 5, 6);
  expect(archiveName(d)).toBe("agent-backup-20260102-040506.tar.gz");
});

// --- pruneList -------------------------------------------------------------------

test("pruneList keeps the newest N by name and returns the rest for deletion", () => {
  const names = [
    "agent-backup-20260701-033000.tar.gz",
    "agent-backup-20260703-033000.tar.gz",
    "agent-backup-20260702-033000.tar.gz",
  ];
  expect(pruneList(names, 2)).toEqual(["agent-backup-20260701-033000.tar.gz"]);
});

test("pruneList returns nothing when at or under the cap", () => {
  const names = ["agent-backup-20260701-033000.tar.gz"];
  expect(pruneList(names, 14)).toEqual([]);
  expect(pruneList([], 14)).toEqual([]);
});

test("pruneList does not mutate its input", () => {
  const names = [
    "agent-backup-20260701-033000.tar.gz",
    "agent-backup-20260702-033000.tar.gz",
  ];
  const copy = [...names];
  pruneList(names, 1);
  expect(names).toEqual(copy);
});

// --- buildManifest ---------------------------------------------------------------

describe("buildManifest", () => {
  test("includes only files and dirs that exist, with repo/ and home/ prefixes", () => {
    const repo = mkdtempSync(join(tmpdir(), "backup-repo-"));
    const home = mkdtempSync(join(tmpdir(), "backup-home-"));
    try {
      // present in the fake repo
      writeFileSync(join(repo, "reminders.json"), "[]");
      writeFileSync(join(repo, "quiz-paused.flag"), "");
      mkdirSync(join(repo, "data"), { recursive: true });
      writeFileSync(join(repo, "data", "quiz-state.json"), "{}");
      mkdirSync(join(repo, "skills"), { recursive: true });
      writeFileSync(join(repo, "skills", "a.md"), "x");
      mkdirSync(join(repo, "memory"), { recursive: true });
      writeFileSync(join(repo, "memory", "MEMORY.md"), "x");
      // present in the fake home
      mkdirSync(join(home, ".claude", "channels", "telegram"), { recursive: true });
      writeFileSync(join(home, ".claude", "channels", "telegram", "access.json"), "{}");

      const entries = buildManifest(repo, home);
      const dests = entries.map((e) => e.dest).sort();

      expect(dests).toContain("repo/reminders.json");
      expect(dests).toContain("repo/quiz-paused.flag");
      expect(dests).toContain("repo/data/quiz-state.json");
      expect(dests).toContain("repo/skills");
      expect(dests).toContain("repo/memory/MEMORY.md");
      expect(dests).toContain("home/.claude/channels/telegram/access.json");
      // absent things stay out
      expect(dests).not.toContain("repo/followups.json");
      expect(dests).not.toContain("repo/history");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never includes the live db, secrets, uploads, or a stray repo-root access.json", () => {
    const repo = mkdtempSync(join(tmpdir(), "backup-repo-"));
    const home = mkdtempSync(join(tmpdir(), "backup-home-"));
    try {
      mkdirSync(join(repo, "memory"), { recursive: true });
      writeFileSync(join(repo, "memory", "bot.db"), "raw");
      mkdirSync(join(repo, "uploads"), { recursive: true });
      writeFileSync(join(repo, "uploads", "big.bin"), "x");
      writeFileSync(join(repo, "access.json"), "{}"); // dev leftover, not prod state
      mkdirSync(join(home, ".claude", "channels", "telegram"), { recursive: true });
      writeFileSync(join(home, ".claude", "channels", "telegram", ".env"), "TOKEN=secret");

      const entries = buildManifest(repo, home);
      const srcs = entries.map((e) => e.src);
      expect(srcs.some((s) => s.endsWith("bot.db"))).toBe(false);
      expect(srcs.some((s) => s.includes("uploads"))).toBe(false);
      expect(srcs.some((s) => s.endsWith(".env"))).toBe(false);
      expect(entries.some((e) => e.dest === "repo/access.json")).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// --- run + verify integration (real sqlite, real tar) -----------------------------

describe("run/verify round trip", () => {
  function makeFakeState(): { repo: string; home: string; backups: string } {
    const repo = mkdtempSync(join(tmpdir(), "backup-int-repo-"));
    const home = mkdtempSync(join(tmpdir(), "backup-int-home-"));
    const backups = mkdtempSync(join(tmpdir(), "backup-int-out-"));
    mkdirSync(join(repo, "memory"), { recursive: true });
    const db = new Database(join(repo, "memory", "bot.db"));
    db.exec(`
      CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT);
      CREATE TABLE memory (id INTEGER PRIMARY KEY, content TEXT);
      CREATE TABLE skills (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO messages (content) VALUES ('hello');
      INSERT INTO memory (content) VALUES ('fact');
      INSERT INTO skills (name) VALUES ('how-to');
    `);
    db.close();
    writeFileSync(join(repo, "reminders.json"), "[]");
    mkdirSync(join(repo, "skills"), { recursive: true });
    writeFileSync(join(repo, "skills", "a.md"), "steps");
    mkdirSync(join(home, ".claude", "channels", "telegram"), { recursive: true });
    writeFileSync(join(home, ".claude", "channels", "telegram", "access.json"), "{}");
    return { repo, home, backups };
  }

  test("run() produces an archive that verify() accepts", () => {
    const { repo, home, backups } = makeFakeState();
    try {
      const out = run(repo, home, backups);
      expect(existsSync(out)).toBe(true);
      const archives = readdirSync(backups).filter((n) => n.startsWith("agent-backup-"));
      expect(archives.length).toBe(1);
      expect(verify(out)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(backups, { recursive: true, force: true });
    }
  });

  test("verify() rejects a missing archive and a snapshot without required tables", () => {
    expect(verify(join(tmpdir(), "no-such-archive.tar.gz"))).toBe(false);

    // db missing the required tables → verify must fail, not print OK
    const { repo, home, backups } = makeFakeState();
    try {
      rmSync(join(repo, "memory", "bot.db"));
      const db = new Database(join(repo, "memory", "bot.db"));
      db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
      db.close();
      const out = run(repo, home, backups);
      expect(verify(out)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(backups, { recursive: true, force: true });
    }
  });
});

// --- the state layout (STATE_DIR) -------------------------------------------------

describe("backup with STATE_DIR set", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    made.push(d);
    return d;
  };
  const put = (root: string, rel: string, content: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  function makeDb(path: string, marker: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    db.exec(`
      CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT);
      CREATE TABLE memory (id INTEGER PRIMARY KEY, content TEXT);
      CREATE TABLE skills (id INTEGER PRIMARY KEY, name TEXT);
    `);
    db.query("INSERT INTO memory (content) VALUES (?)").run(marker);
    db.close();
  }
  function extract(archive: string): string {
    const out = tmp("backup-x-");
    const p = Bun.spawnSync([TAR_BIN, "xzf", archive, "-C", out]);
    expect(p.exitCode).toBe(0);
    return out;
  }
  /** A repo with old-layout leftovers (which must NOT be archived) and a state folder in the new
   *  layout (which must be, under the same repo/<logical> names). */
  function makeLayout() {
    const repo = tmp("backup-layout-repo-");
    const home = tmp("backup-layout-home-");
    const backups = tmp("backup-layout-out-");
    const state = tmp("backup-layout-state-");
    // repo: tracked-ish files that stay in the repo, plus stale old-layout state
    put(repo, "data/questions.json", "[\"from-repo\"]");
    put(repo, "reminders.json", "stale-repo");
    put(repo, "cal_notified.json", "stale-repo");
    put(repo, "data/avot-state.json", "stale-repo");
    makeDb(join(repo, "memory", "bot.db"), "stale-repo-db");
    // state: poller-only at the top, turn-writable under shared/
    put(state, "cal_notified.json", "{\"top\":1}");
    put(state, "approvals.json", "{\"v\":1}");
    put(state, "data/quiz-state.json", "{\"quiz\":1}");
    put(state, "history/1.json", "{\"h\":1}");
    put(state, "shared/stores/reminders.json", "[\"state-reminders\"]");
    put(state, "shared/stores/quiz-paused.flag", "");
    put(state, "shared/data/avot-state.json", "{\"avot\":1}");
    put(state, "shared/memory/MEMORY.md", "state memory");
    put(state, "shared/memory/mirror/a.md", "mirror a");
    put(state, "shared/skills/s.md", "skill body");
    makeDb(join(state, "shared", "memory", "bot.db"), "state-db");
    return { repo, home, backups, state };
  }

  test("buildManifest reads the state folder's layout under the old archive names", () => {
    const { repo, home, state } = makeLayout();
    const bySrc = new Map(buildManifest(repo, home, state).map((e) => [e.dest, e.src]));
    expect(bySrc.get("repo/reminders.json")).toBe(join(state, "shared", "stores", "reminders.json"));
    expect(bySrc.get("repo/quiz-paused.flag")).toBe(join(state, "shared", "stores", "quiz-paused.flag"));
    expect(bySrc.get("repo/data/avot-state.json")).toBe(join(state, "shared", "data", "avot-state.json"));
    expect(bySrc.get("repo/memory/MEMORY.md")).toBe(join(state, "shared", "memory", "MEMORY.md"));
    expect(bySrc.get("repo/memory/mirror")).toBe(join(state, "shared", "memory", "mirror"));
    expect(bySrc.get("repo/skills")).toBe(join(state, "shared", "skills"));
    expect(bySrc.get("repo/cal_notified.json")).toBe(join(state, "cal_notified.json"));
    expect(bySrc.get("repo/approvals.json")).toBe(join(state, "approvals.json"));
    expect(bySrc.get("repo/data/quiz-state.json")).toBe(join(state, "data", "quiz-state.json"));
    expect(bySrc.get("repo/history")).toBe(join(state, "history"));
    expect(bySrc.get("repo/data/questions.json")).toBe(join(repo, "data", "questions.json"));
  });

  test("run() archives the state's content as repo/<logical>, and the db snapshot from shared/memory", () => {
    const { repo, home, backups, state } = makeLayout();
    const out = run(repo, home, backups, { STATE_DIR: state });
    const x = extract(out);
    const read = (rel: string) => readFileSync(join(x, rel), "utf8");
    expect(read("repo/reminders.json")).toBe("[\"state-reminders\"]");
    expect(read("repo/cal_notified.json")).toBe("{\"top\":1}");
    expect(read("repo/approvals.json")).toBe("{\"v\":1}"); // poller-only state, archived like the rest
    expect(read("repo/data/avot-state.json")).toBe("{\"avot\":1}");
    expect(read("repo/data/quiz-state.json")).toBe("{\"quiz\":1}");
    expect(read("repo/data/questions.json")).toBe("[\"from-repo\"]");
    expect(read("repo/quiz-paused.flag")).toBe("");
    expect(read("repo/memory/MEMORY.md")).toBe("state memory");
    expect(read("repo/memory/mirror/a.md")).toBe("mirror a");
    expect(read("repo/skills/s.md")).toBe("skill body");
    expect(read("repo/history/1.json")).toBe("{\"h\":1}");
    const db = new Database(join(x, "repo", "memory", "bot.db"), { readonly: true });
    try {
      const row = db.query("SELECT content FROM memory").get() as { content: string };
      expect(row.content).toBe("state-db");
    } finally {
      db.close();
    }
    expect(verify(out)).toBe(true);
  });

  test("without STATE_DIR, a temp repo root is its own state root (old layout, plus avot)", () => {
    const { repo, home, backups } = makeLayout();
    const out = run(repo, home, backups, {});
    const x = extract(out);
    expect(readFileSync(join(x, "repo", "reminders.json"), "utf8")).toBe("stale-repo");
    expect(readFileSync(join(x, "repo", "data", "avot-state.json"), "utf8")).toBe("stale-repo");
  });

  test.skipIf(process.platform === "win32")(
    "a link or FIFO planted in a turn-writable folder is not followed or opened",
    () => {
      const { repo, home, backups, state } = makeLayout();
      const secret = join(tmp("backup-secret-"), "secret.txt");
      writeFileSync(secret, "tok-test");
      rmSync(join(state, "shared", "stores", "reminders.json"));
      symlinkSync(secret, join(state, "shared", "stores", "reminders.json"));
      symlinkSync(secret, join(state, "shared", "skills", "planted.md"));
      expect(Bun.spawnSync(["mkfifo", join(state, "shared", "skills", "pipe.md")]).exitCode).toBe(0);
      const out = run(repo, home, backups, { STATE_DIR: state });
      const x = extract(out);
      expect(existsSync(join(x, "repo", "reminders.json"))).toBe(false);
      expect(existsSync(join(x, "repo", "skills", "planted.md"))).toBe(false);
      expect(existsSync(join(x, "repo", "skills", "pipe.md"))).toBe(false);
      expect(readFileSync(join(x, "repo", "skills", "s.md"), "utf8")).toBe("skill body");
      const all = (readdirSync(x, { recursive: true }) as string[])
        .map((rel) => join(x, rel))
        .filter((p) => lstatSync(p).isFile())
        .map((p) => readFileSync(p, "utf8"));
      expect(all.length).toBeGreaterThan(5);
      expect(all.some((c) => c.includes("tok-test"))).toBe(false);
    },
  );

  // Runs as an ordinary user (never root): mode 000 then makes readdirSync fail.
  test.skipIf(process.platform === "win32")(
    "an unreadable folder a turn planted is skipped, and the backup still completes",
    () => {
      const { repo, home, backups, state } = makeLayout();
      const locked = join(state, "shared", "skills", "locked");
      mkdirSync(locked);
      writeFileSync(join(locked, "x.md"), "x");
      chmodSync(locked, 0o000);
      try {
        const out = run(repo, home, backups, { STATE_DIR: state });
        const x = extract(out);
        expect(readFileSync(join(x, "repo", "skills", "s.md"), "utf8")).toBe("skill body");
        expect(existsSync(join(x, "repo", "skills", "locked", "x.md"))).toBe(false);
        expect(readFileSync(join(x, "MANIFEST.txt"), "utf8")).toContain("skipped: 1");
      } finally {
        chmodSync(locked, 0o700); // so afterAll can remove it
      }
    },
  );
});

// --- copying turn-writable folders: owner rule, swap checks, identity checks -----

describe("copyNoFollow guards", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (p: string) => {
    const d = mkdtempSync(join(tmpdir(), p));
    made.push(d);
    return d;
  };
  const big = (s: { dev: bigint; ino: bigint }) => ({ dev: s.dev, ino: s.ino });

  test("mayDescend: only a folder owned by the backup's uid, or any folder with no uid (win32)", () => {
    expect(mayDescend({ uid: 1000 }, 1000)).toBe(true);
    expect(mayDescend({ uid: 1000n }, 1000)).toBe(true);
    expect(mayDescend({ uid: 1001 }, 1000)).toBe(false);
    expect(mayDescend({ uid: 1001n }, 1000)).toBe(false);
    expect(mayDescend({ uid: 0 }, undefined)).toBe(true);
  });

  test("a folder owned by another uid is not descended into (skipped and counted)", () => {
    const src = tmp("backup-owner-src-");
    mkdirSync(join(src, "sub"));
    writeFileSync(join(src, "sub", "a.md"), "a");
    writeFileSync(join(src, "b.md"), "b");
    const own = Number(lstatSync(src).uid);

    const destOk = join(tmp("backup-owner-dest-"), "out");
    expect(copyNoFollow(src, destOk, { uid: own })).toBe(0);
    expect(readFileSync(join(destOk, "sub", "a.md"), "utf8")).toBe("a");
    expect(readFileSync(join(destOk, "b.md"), "utf8")).toBe("b");

    const destNo = join(tmp("backup-owner-dest-"), "out");
    expect(copyNoFollow(src, destNo, { uid: own + 1 })).toBe(1);
    expect(existsSync(destNo)).toBe(false);
  });

  test("readChecked refuses a file whose identity changed since its lstat, and copies bytes exactly", () => {
    const dir = tmp("backup-ident-");
    const a = join(dir, "a.bin");
    const b = join(dir, "b.bin");
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]); // not valid UTF-8
    writeFileSync(a, bytes);
    writeFileSync(b, "b");
    expect(() => readChecked(b, big(lstatSync(a, { bigint: true })), null)).toThrow(/changed/);
    expect(Buffer.compare(readChecked(a, big(lstatSync(a, { bigint: true })), null), bytes)).toBe(0);
  });

  test.skipIf(process.platform !== "linux")(
    "readChecked refuses a file that resolves outside the folder being copied",
    () => {
      const root = realpathSync(tmp("backup-root-"));
      const outside = join(tmp("backup-outside-"), "secret.txt");
      writeFileSync(outside, "tok-test");
      expect(() => readChecked(outside, big(lstatSync(outside, { bigint: true })), root)).toThrow(/outside/);
      writeFileSync(join(root, "ok.txt"), "ok");
      const ok = join(root, "ok.txt");
      expect(readChecked(ok, big(lstatSync(ok, { bigint: true })), root).toString()).toBe("ok");
    },
  );

  test.skipIf(process.platform === "win32")(
    "a link swapped in for a subfolder between its lstat and its listing is not followed",
    () => {
      const src = tmp("backup-swap-src-");
      mkdirSync(join(src, "sub"));
      writeFileSync(join(src, "sub", "a.md"), "a");
      const secretDir = tmp("backup-swap-secret-");
      writeFileSync(join(secretDir, "secret.md"), "tok-test");
      const dest = join(tmp("backup-swap-dest-"), "out");
      const skipped = copyNoFollow(src, dest, {
        uid: process.getuid!(),
        beforeReaddir: (d) => {
          if (d === join(src, "sub")) {
            renameSync(d, `${d}-moved`);
            symlinkSync(secretDir, d);
          }
        },
      });
      expect(skipped).toBeGreaterThanOrEqual(1);
      const files = (readdirSync(dest, { recursive: true }) as string[])
        .map((rel) => join(dest, rel))
        .filter((p) => lstatSync(p).isFile());
      expect(files.some((p) => readFileSync(p, "utf8").includes("tok-test"))).toBe(false);
      expect(existsSync(join(dest, "sub", "secret.md"))).toBe(false);
    },
  );
});
