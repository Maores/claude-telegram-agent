import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archiveName, buildManifest, pruneList, run, verify } from "./backup.ts";

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
