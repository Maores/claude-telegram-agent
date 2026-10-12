import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stateDir, statePath, sharedPath, sharedPathIn, REPO_DIR } from "./paths";

const BUN = process.execPath;
const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
const withEnv = (k: string, v: string | undefined, fn: () => void) => {
  const prev = process.env[k];
  if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { fn(); } finally { if (prev === undefined) delete process.env[k]; else process.env[k] = prev; }
};
const u = (p: string) => p.replace(/\\/g, "/");

test("unset: the repo folder for every path (and no marker file in the repo)", () => {
  expect(existsSync(join(REPO_DIR, ".state-dir"))).toBe(false);
  withEnv("STATE_DIR", undefined, () => {
    expect(stateDir()).toBe(REPO_DIR);
    expect(statePath("heartbeat")).toBe(join(REPO_DIR, "heartbeat"));
    expect(sharedPath("reminders.json")).toBe(join(REPO_DIR, "reminders.json"));
    expect(sharedPath("data", "avot-state.json")).toBe(join(REPO_DIR, "data", "avot-state.json"));
  });
});

test("set: poller-only at the top, flat stores in shared/stores, fixed folders in shared/", () => {
  withEnv("STATE_DIR", "/var/lib/x", () => {
    expect(u(statePath("heartbeat"))).toBe("/var/lib/x/heartbeat");
    expect(u(sharedPath("reminders.json"))).toBe("/var/lib/x/shared/stores/reminders.json");
    expect(u(sharedPath("memory", "bot.db"))).toBe("/var/lib/x/shared/memory/bot.db");
    expect(u(sharedPath("data", "avot-state.json"))).toBe("/var/lib/x/shared/data/avot-state.json");
  });
  expect(u(sharedPathIn({ STATE_DIR: "/var/lib/y" }, "memory", "bot.db"))).toBe("/var/lib/y/shared/memory/bot.db");
});

test("the CLIs a turn runs write into the layout (folders made first, as the rollout does)", () => {
  const dir = tmp("statedir-");
  for (const f of ["shared/stores", "shared/memory"]) mkdirSync(join(dir, f), { recursive: true });
  const before = existsSync(join(REPO_DIR, "reminders.json")) ? readFileSync(join(REPO_DIR, "reminders.json")) : null;
  const env = { ...process.env, STATE_DIR: dir, TELEGRAM_CHAT_ID: "1" } as Record<string, string>;
  for (const k of ["REMINDERS_FILE", "FOLLOWUPS_FILE", "CHOICES_FILE", "PENDING_FILE"]) delete env[k];
  const at = String(Math.floor(Date.now() / 1000) + 3600);
  expect(Bun.spawnSync([BUN, "run", "remind.ts", "add-once", "1", at, "x"], { cwd: REPO_DIR, env }).exitCode).toBe(0);
  expect(existsSync(join(dir, "shared", "stores", "reminders.json"))).toBe(true);
  expect(Bun.spawnSync([BUN, "run", "mem.ts", "add", "--kind", "agent", "--source", "maor", "--content", "statedir probe"], { cwd: REPO_DIR, env }).exitCode).toBe(0);
  expect(existsSync(join(dir, "shared", "memory", "bot.db"))).toBe(true);
  const after = existsSync(join(REPO_DIR, "reminders.json")) ? readFileSync(join(REPO_DIR, "reminders.json")) : null;
  expect(after === null ? null : Buffer.compare(after, before!)).toBe(before === null ? null : 0);
});

test("the marker file is honoured when STATE_DIR is unset; a relative line is ignored", () => {
  const fake = tmp("marker-repo-");
  const state = tmp("marker-state-");
  writeFileSync(join(fake, "paths.ts"), readFileSync(join(REPO_DIR, "paths.ts")));
  const env = { ...process.env } as Record<string, string>;
  delete env.STATE_DIR;
  const run = () => Bun.spawnSync([BUN, "-e", `import { stateDir } from "./paths.ts"; console.log(stateDir())`], { cwd: fake, env }).stdout.toString().trim();
  writeFileSync(join(fake, ".state-dir"), state + "\n");
  expect(run()).toBe(state);
  writeFileSync(join(fake, ".state-dir"), "relative/path\n");
  expect(run()).toBe(fake);
});

test("no store default joins import.meta.dir or PROJECT_DIR directly", () => {
  const exemptFiles = /^(confirm|selfdev-check|backup|paths)\.ts$/;
  const exemptLines = [/questions\.json/];
  const hits: string[] = [];
  for (const f of readdirSync(REPO_DIR).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
    if (exemptFiles.test(f)) continue;
    for (const line of readFileSync(join(REPO_DIR, f), "utf8").split("\n")) {
      if (/join\((?:import\.meta\.dir|PROJECT_DIR)\s*,/.test(line) && !exemptLines.some((a) => a.test(line))) hits.push(`${f}: ${line.trim()}`);
    }
  }
  expect(hits).toEqual([]);
});

import { writeAtomic, readNoFollow, writeAll } from "./paths";
import { symlinkSync, readdirSync as ls, statSync } from "node:fs";

test("writeAll loops over short writes until every byte is written, and refuses a write that stalls", () => {
  const got: number[] = [];
  let calls = 0;
  const shortWrite = (_fd: number, buf: Uint8Array, off: number, len: number) => {
    calls++;
    const n = Math.min(3, len); // at most three bytes per call
    for (let i = 0; i < n; i++) got.push(buf[off + i]);
    return n;
  };
  const data = Buffer.from("שלום, a short-write test");
  writeAll(7, data, shortWrite);
  expect(Buffer.from(got).equals(data)).toBe(true);
  expect(calls).toBe(Math.ceil(data.length / 3));
  let stalls = 0;
  expect(() => writeAll(7, data, () => (stalls++ < 2 ? 4 : 0))).toThrow("short write: 8 of");
  expect(stalls).toBe(3);
});

test("writeAtomic replaces the file and leaves no temp files", () => {
  const d = tmp("wa-");
  const p = join(d, "s.json");
  writeAtomic(p, "a"); writeAtomic(p, "b");
  expect(readFileSync(p, "utf8")).toBe("b");
  expect(ls(d)).toEqual(["s.json"]);
});

test.skipIf(process.platform === "win32")("writeAtomic never writes through a planted link (old temp name or target)", () => {
  const d = tmp("wa-link-");
  const victim = join(d, "victim.txt");
  writeFileSync(victim, "untouched");
  symlinkSync(victim, join(d, "s.json.tmp"));
  symlinkSync(victim, join(d, "s.json"));
  writeAtomic(join(d, "s.json"), "new");
  expect(readFileSync(victim, "utf8")).toBe("untouched");
  expect(readFileSync(join(d, "s.json"), "utf8")).toBe("new");
});

test.skipIf(process.platform === "win32")("writeAtomic sets 0640 at the top level and 0660 under shared/, whatever the umask", () => {
  const s = tmp("wa-mode-");
  mkdirSync(join(s, "shared", "stores"), { recursive: true });
  const old = process.umask(0o007);
  try {
    withEnv("STATE_DIR", s, () => {
      writeAtomic(join(s, "approvals.json"), "{}");
      writeAtomic(join(s, "shared", "stores", "reminders.json"), "[]");
    });
  } finally { process.umask(old); }
  expect(statSync(join(s, "approvals.json")).mode & 0o777).toBe(0o640);
  expect(statSync(join(s, "shared", "stores", "reminders.json")).mode & 0o777).toBe(0o660);
});

test.skipIf(process.platform === "win32")("readNoFollow refuses a link and a FIFO without blocking", () => {
  const d = tmp("rn-");
  writeFileSync(join(d, "real"), "x");
  symlinkSync(join(d, "real"), join(d, "link"));
  expect(readNoFollow(join(d, "real"))).toBe("x");
  expect(() => readNoFollow(join(d, "link"))).toThrow();
  expect(Bun.spawnSync(["mkfifo", join(d, "fifo")]).exitCode).toBe(0);
  const t = Date.now();
  expect(() => readNoFollow(join(d, "fifo"))).toThrow();
  expect(Date.now() - t).toBeLessThan(1000);
});

test("store modules and the MEMORY.md readers go through the helpers", () => {
  for (const f of ["reminders.ts", "choices.ts", "pending.ts", "voice-confirm.ts", "avot.ts", "skills.ts", "memory.ts", "health.ts"]) {
    const t = readFileSync(join(REPO_DIR, f), "utf8");
    expect([f, /writeFileSync\(tmp,/.test(t), /copyFileSync\(/.test(t), /readFileSync\(/.test(t)]).toEqual([f, false, false, false]);
  }
  for (const [f, re] of [["poller.ts", /readFileSync\(MEMORY_FILE/], ["mem.ts", /readFileSync\(MEMORY_MD/]] as const) {
    expect([f, re.test(readFileSync(join(REPO_DIR, f), "utf8"))]).toEqual([f, false]);
  }
});
