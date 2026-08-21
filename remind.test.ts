import { test, expect, beforeEach } from "bun:test";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Drives the real CLI. Every function-level test for snoozeFollowup passed
// while `remind.ts snooze-followup --id …` died on "invalid chatId: --id",
// because argv is destructured as [cmd, chatId, ...rest] before the switch and
// this subcommand carries no chatId. Only running the binary caught it.

const R = join(import.meta.dir, `remind.clitest-${process.pid}.json`);
const F = join(import.meta.dir, `followups.clitest-${process.pid}.json`);
process.env.REMINDERS_FILE = R;
process.env.FOLLOWUPS_FILE = F;

import { addFollowup } from "./reminders.ts";

beforeEach(() => {
  for (const p of [R, F, R + ".lock", F + ".lock"]) rmSync(p, { force: true });
});

const cli = (...args: string[]) =>
  Bun.spawnSync({
    cmd: ["bun", "run", join(import.meta.dir, "remind.ts"), ...args],
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
