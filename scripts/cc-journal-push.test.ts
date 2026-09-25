import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultLogPath,
  defaultConfigPath,
  remoteCmd,
  parsePushArgs,
  journalDates,
  readStable,
  writeLog,
  runPush,
  type PushArgs,
  type PushDeps,
} from "./cc-journal-push";

const env = { LOCALAPPDATA: "C:\\Users\\someone\\AppData\\Local" };
const noConfig = () => null;
const config = (o: object) => () => JSON.stringify(o);

test("the log and the config live in the agent's LOCALAPPDATA folder", () => {
  expect(defaultLogPath(env)).toBe(join(env.LOCALAPPDATA, "TelegramAgent", "cc-journal-push.log"));
  expect(defaultConfigPath(env)).toBe(join(env.LOCALAPPDATA, "TelegramAgent", "cc-journal-push.json"));
});

test("parsePushArgs reads the config file, and flags override it", () => {
  const cfg = config({ vault: "V", target: "bot@example.org", key: "K" });
  expect(parsePushArgs([], env, cfg)).toEqual({ vault: "V", target: "bot@example.org", key: "K", days: 7, log: defaultLogPath(env), dryRun: false });
  expect(parsePushArgs(["--vault", "W", "--days", "3"], env, cfg)).toMatchObject({ vault: "W", target: "bot@example.org", days: 3 });
  expect(parsePushArgs(["--vault", "V", "--target", "bot@example.org", "--key", "K"], env, noConfig)).toMatchObject({ vault: "V", key: "K" });
  // a config saved with a byte-order mark (Notepad, Windows PowerShell 5.1) still parses
  const bom = () => String.fromCharCode(0xfeff) + JSON.stringify({ vault: "V", target: "bot@example.org", key: "K" });
  expect(parsePushArgs([], env, bom)).toMatchObject({ vault: "V", target: "bot@example.org", key: "K" });
});

test("parsePushArgs refuses missing, placeholder and malformed settings", () => {
  expect(parsePushArgs([], env, noConfig)).toEqual({ error: "no vault: set it in the config file or pass --vault" });
  expect(parsePushArgs(["--config", "C:\\nowhere.json"], env, noConfig)).toEqual({ error: "no config file at C:\\nowhere.json" });
  expect(parsePushArgs([], env, () => "{not json")).toMatchObject({ error: expect.stringContaining("bad config file") });
  expect(parsePushArgs([], env, () => "[1]")).toMatchObject({ error: expect.stringContaining("not a JSON object") });
  expect(parsePushArgs(["--vault", "V", "--target", "claudebot@<YOUR_SERVER_IP>", "--key", "K"], env, noConfig)).toEqual({
    error: "target must be user@host (the committed placeholder is refused)",
  });
  expect(parsePushArgs(["--vault", "V", "--target", "bot@example.org"], env, noConfig)).toEqual({
    error: "no key: set it in the config file or pass --key",
  });
  expect(parsePushArgs(["--vault", "V", "--days", "30", "--dry-run"], env, noConfig)).toEqual({ error: "days must be 1..14" });
  expect(parsePushArgs(["--vault", "V", "stray"], env, noConfig)).toEqual({ error: "unexpected argument: stray" });
  expect(parsePushArgs(["--vault", "V", "--dry-run"], env, noConfig)).toMatchObject({ vault: "V", dryRun: true });
});

test("the remote command clears stale uploads and checks the upload's size before it replaces the journal", () => {
  expect(remoteCmd(1234)).toBe(
    "f=$HOME/cc-journal/.journal.json.part.$$; mkdir -p $HOME/cc-journal && rm -f $HOME/cc-journal/.journal.json.part.* && cat > $f && [ $(wc -c < $f) -eq 1234 ] && mv -f $f $HOME/cc-journal/journal.json || { rm -f $f; exit 3; }",
  );
  expect(remoteCmd(1)).not.toContain('"');
});

test("journalDates lists the local days oldest first", () => {
  // 00:30 local on 2026-09-25 is still 2026-09-24 in UTC
  expect(journalDates(new Date("2026-09-24T21:30:00Z"), 3)).toEqual(["2026-09-23", "2026-09-24", "2026-09-25"]);
});

test("readStable returns null for a missing note and waits out a note being written", async () => {
  const reads = ["half", "full", "full"];
  const deps = { read: () => reads.shift()!, exists: () => true, sleep: async () => {} };
  expect(await readStable("x", deps)).toBe("full");
  expect(await readStable("x", { ...deps, exists: () => false })).toBeNull();
});

test("writeLog appends a local-time line and keeps the last 200", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccpush-"));
  const path = join(dir, "sub", "push.log");
  for (let i = 0; i < 205; i++) writeLog(path, `line ${i}`, new Date("2026-09-24T18:20:00Z"));
  const lines = readFileSync(path, "utf8").trim().split("\n");
  rmSync(dir, { recursive: true, force: true });
  expect(lines.length).toBe(200);
  expect(lines[0]).toBe("2026-09-24 21:20  line 5");
  expect(lines[199]).toBe("2026-09-24 21:20  line 204");
});

const args: PushArgs = { vault: "V", target: "bot@example.org", key: "K", days: 2, log: "L", dryRun: false };
const NOTE =
  "- 10:00 — A: done.\n- 10:30 — Gate: x **[DELIBERATE FALSE TEST LINE]**\n- 10:40 — watchdog: an alert.\n- 10:50 x no separator\n- 11:00 — B: also.\n## English translation\n- 12:00 — C: below.\n";

function fakeDeps(sendResults: (Error | null)[], over: Partial<PushDeps> = {}) {
  const log: string[] = [];
  const sent: string[] = [];
  const slept: number[] = [];
  const printed: string[] = [];
  let marked = 0;
  const deps: PushDeps = {
    now: () => new Date("2026-09-24T18:20:00Z"),
    readNote: async (p) => (p.endsWith("2026-09-24.md") ? NOTE : null),
    send: async (_a, json) => {
      const r = sendResults.shift() ?? null;
      if (r) throw r;
      sent.push(json);
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
    log: (m) => log.push(m),
    markOk: () => {
      marked++;
    },
    print: (s) => printed.push(s),
    version: "abc1234",
    ...over,
  };
  return { deps, log, sent, slept, printed, marked: () => marked };
}

test("runPush sends once, logs the count with what it left out, and marks success", async () => {
  const f = fakeDeps([null]);
  expect(await runPush(args, f.deps)).toBe(0);
  const journal = JSON.parse(f.sent[0]);
  expect(journal.sanitizer).toBe(1);
  expect(journal.copy).toBe("abc1234");
  expect(journal.stats).toEqual({ entries: 2, ignoredBelowHeading: 1, testLinesDropped: 1, automationDropped: 1, unparsedTimed: 1 });
  expect(journal.days).toEqual([
    { date: "2026-09-24", entries: [{ time: "10:00", text: "A: done.", links: [] }, { time: "11:00", text: "B: also.", links: [] }] },
  ]);
  expect(f.log).toEqual([
    `pushed 2 entries over 1 days (${Buffer.byteLength(f.sent[0])} bytes); 1 timed lines below a heading ignored; 1 test lines dropped; 1 watchdog lines dropped; 1 timed-looking lines not parsed or empty; copy abc1234`,
  ]);
  expect(f.marked()).toBe(1);
});

test("runPush retries twice 30 s apart, then gives up with exit 1", async () => {
  const f = fakeDeps([new Error("ssh exited 255: timeout"), new Error("ssh exited 255: timeout"), new Error("ssh exited 255: refused")]);
  expect(await runPush(args, f.deps)).toBe(1);
  expect(f.slept).toEqual([30_000, 30_000]);
  expect(f.log[f.log.length - 1]).toStartWith("FAILED after 3 attempt(s): ssh exited 255: refused");
  expect(f.marked()).toBe(0);
});

test("runPush recovers on the second attempt and says so", async () => {
  const f = fakeDeps([new Error("ssh exited 255: timeout"), null]);
  expect(await runPush(args, f.deps)).toBe(0);
  expect(f.log[f.log.length - 1]).toContain("on attempt 2");
});

test("runPush logs a note it cannot read and pushes nothing", async () => {
  const f = fakeDeps([null], {
    readNote: async () => {
      throw new Error("EBUSY: resource busy or locked");
    },
  });
  expect(await runPush(args, f.deps)).toBe(1);
  expect(f.sent).toEqual([]);
  expect(f.log).toEqual(["FAILED reading 2026-09-23.md: EBUSY: resource busy or locked"]);
});

test("a dry run prints the journal and sends nothing", async () => {
  const f = fakeDeps([]);
  expect(await runPush({ ...args, dryRun: true }, f.deps)).toBe(0);
  expect(f.sent).toEqual([]);
  expect(f.log).toEqual([]);
  expect(JSON.parse(f.printed[0]).v).toBe(1);
});
