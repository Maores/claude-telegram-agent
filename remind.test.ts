import { test, expect, beforeEach, afterAll } from "bun:test";
import { rmSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drives the real CLI. Every function-level test for snoozeFollowup passed
// while `remind.ts snooze-followup --id …` died on "invalid chatId: --id",
// because argv is destructured as [cmd, chatId, ...rest] before the switch and
// this subcommand carries no chatId. Only running the binary caught it.

// Both stores live in a temp dir that afterAll removes, never in the repo root.
const DIR = mkdtempSync(join(tmpdir(), "remind-clitest-"));
const R = join(DIR, "reminders.json");
const F = join(DIR, "followups.json");
process.env.REMINDERS_FILE = R;
process.env.FOLLOWUPS_FILE = F;

import { addFollowup, markNudged, resolveFollowup } from "./reminders.ts";

beforeEach(() => {
  for (const p of [R, F, R + ".lock", F + ".lock"]) rmSync(p, { force: true });
});
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  Bun.spawnSync({
    cmd: [process.execPath, "run", join(import.meta.dir, "remind.ts"), ...args],
    env: { ...process.env, REMINDERS_FILE: R, FOLLOWUPS_FILE: F },
    cwd: import.meta.dir,
  });
const out = (r: ReturnType<typeof cli>) => r.stdout.toString() + r.stderr.toString();
const soon = () => Math.floor(Date.now() / 1000) + 3600;

test("snooze-followup runs without a chatId argument", () => {
  const id = addFollowup(2824, "ללכת לאדיסו", 9, 1000).id;
  const r = cli("snooze-followup", "--id", id, "--at", String(soon()));
  expect(out(r)).not.toContain("invalid chatId"); // the bug this test exists for
  expect(r.exitCode).toBe(0);
  expect(out(r)).toContain("OK snoozed");
  // follow-up closed and its replacement created, in one step
  expect(JSON.parse(readFileSync(F, "utf8"))[0].status).toBe("snoozed");
  expect(JSON.parse(readFileSync(R, "utf8"))[0].text).toBe("ללכת לאדיסו");
});

test("snooze-followup refuses an unknown id, a past time, and a missing id", () => {
  const id = addFollowup(2824, "x", 9, 1000).id;
  expect(out(cli("snooze-followup", "--id", "f-nope", "--at", String(soon())))).toContain("no open follow-up");
  expect(out(cli("snooze-followup", "--id", id, "--at", "100"))).toContain("already past");
  expect(out(cli("snooze-followup", "--at", String(soon())))).toContain("usage:");
});

test("every other subcommand still demands its chatId in the same position", () => {
  expect(out(cli("list"))).toContain("invalid chatId");
  expect(out(cli("cancel", "notanumber", "r1"))).toContain("invalid chatId");
  expect(cli("add-once", "2824", String(soon()), "בדיקה").exitCode).toBe(0);
  expect(out(cli("list", "2824"))).toContain("בדיקה");
});

// A turn answers "what is still open?" through this verb instead of reading
// followups.json by path (after the rollout the file lives in the state folder).
test("followups prints the open follow-ups only, with no chatId argument", () => {
  const open = addFollowup(2824, "open-errand", 9, 1000).id;
  const closed = addFollowup(2824, "closed-errand", 10, 1000).id;
  expect(cli("snooze-followup", "--id", closed, "--at", String(soon())).exitCode).toBe(0);
  const r = cli("followups");
  expect(out(r)).not.toContain("invalid chatId");
  expect(r.exitCode).toBe(0);
  const text = r.stdout.toString();
  expect(text).toContain(open);
  expect(text).toContain("open-errand");
  expect(text).not.toContain("closed-errand");
});

test("followups leaves out a done follow-up and marks a nudged one", () => {
  const done = addFollowup(2824, "done-errand", 11, 1000).id;
  const nudged = addFollowup(2824, "nudged-errand", 12, 1000).id;
  const plain = addFollowup(2824, "plain-errand", 13, 1000).id;
  expect(resolveFollowup(done, "done")?.status).toBe("done");
  markNudged(nudged);
  const r = cli("followups");
  expect(r.exitCode).toBe(0);
  const lines = r.stdout.toString().trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(r.stdout.toString()).not.toContain("done-errand");
  const nudgedLine = lines.find((l) => l.startsWith(nudged))!;
  expect(nudgedLine).toContain("  (nudged)  nudged-errand");
  const plainLine = lines.find((l) => l.startsWith(plain))!;
  expect(plainLine).toContain("plain-errand");
  expect(plainLine).not.toContain("(nudged)");
});

test("followups says so when nothing is open", () => {
  const r = cli("followups");
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString().trim()).toBe("(no open follow-ups)");
});
