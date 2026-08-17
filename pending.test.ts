import { test, expect, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import {
  proposeAction,
  takePending,
  consumeAction,
  pruneActions,
  validateArgv,
  newTurnId,
  type PendingAction,
} from "./pending";

// Isolate the store per run.
const TEST_FILE = `${import.meta.dir}/pending.test-${process.pid}.json`;
process.env.PENDING_FILE = TEST_FILE;
beforeEach(() => {
  rmSync(TEST_FILE, { force: true });
  rmSync(TEST_FILE + ".lock", { force: true });
});

const CAL_ADD = ["bun", "run", "cal.ts", "add", "--title", "רופא שיניים", "--start", "2026-06-13T15:00:00+03:00"];
const TODO_DEL = ["bun", "run", "todo.ts", "delete", "--uid", "abc@maor-bot"];

test("validateArgv: allowlisted commands pass", () => {
  expect(validateArgv(CAL_ADD).ok).toBe(true);
  expect(validateArgv(["bun", "run", "cal.ts", "edit", "--uid", "x", "--set-title", "y"]).ok).toBe(true);
  expect(validateArgv(["bun", "run", "cal.ts", "delete", "--uid", "x"]).ok).toBe(true);
  expect(validateArgv(TODO_DEL).ok).toBe(true);
});

test("validateArgv: everything off the allowlist refuses", () => {
  expect(validateArgv(["bun", "run", "todo.ts", "add", "--title", "x"]).ok).toBe(false); // sub not allowed
  expect(validateArgv(["bun", "run", "remind.ts", "add-once", "1", "2", "x"]).ok).toBe(false); // script not allowed
  expect(validateArgv(["bun", "run", "../cal.ts", "add"]).ok).toBe(false); // path trick
  expect(validateArgv(["bun", "run", "cal.ts/../guard.ts", "add"]).ok).toBe(false);
  expect(validateArgv(["node", "run", "cal.ts", "add"]).ok).toBe(false); // wrong argv0
  expect(validateArgv(["bun", "x", "cal.ts", "add"]).ok).toBe(false); // wrong argv1
  expect(validateArgv(["bun", "run", "cal.ts"]).ok).toBe(false); // too short
  expect(validateArgv("bun run cal.ts add" as any).ok).toBe(false); // not an array
  expect(validateArgv(["bun", "run", "cal.ts", "add", ""]).ok).toBe(false); // empty element
  expect(validateArgv(["bun", "run", "cal.ts", "add", "x\0y"]).ok).toBe(false); // NUL
});

test("validateArgv: guard blocklist scans the joined argv", () => {
  // rm -rf / style content inside an argument still trips the hardline floor
  const v = validateArgv(["bun", "run", "cal.ts", "add", "--title", "x; rm -rf --no-preserve-root /"]);
  expect(v.ok).toBe(false);
});

test("propose → takePending picks up exactly the turn's pending entries", () => {
  const turn = newTurnId();
  const a = proposeAction(5, "להוסיף: רופא שיניים — מחר 15:00", CAL_ADD, turn, 1000);
  proposeAction(5, "other turn", TODO_DEL, newTurnId(), 1000); // different turn
  proposeAction(6, "other chat", TODO_DEL, turn, 1000); // different chat
  const picked = takePending(5, turn);
  expect(picked.map((p) => p.id)).toEqual([a.id]);
  expect(picked[0].status).toBe("pending");
  expect(picked[0].argv).toEqual(CAL_ADD);
});

test("proposeAction refuses an argv that fails validation", () => {
  expect(() => proposeAction(5, "evil", ["bash", "-c", "true"], newTurnId(), 1000)).toThrow();
});

test("consumeAction: once-only approve, then stale", () => {
  const a = proposeAction(5, "s", CAL_ADD, newTurnId(), 1000);
  const first = consumeAction(a.id, "approved", 2000);
  expect(first.outcome).toBe("ok");
  if (first.outcome === "ok") expect(first.action.status).toBe("approved");
  expect(consumeAction(a.id, "approved", 2001).outcome).toBe("stale");
  expect(consumeAction(a.id, "cancelled", 2002).outcome).toBe("stale");
  expect(consumeAction("pa-no-such", "approved", 2003).outcome).toBe("stale");
});

test("consumeAction: cancel works and is once-only too", () => {
  const a = proposeAction(5, "s", CAL_ADD, newTurnId(), 1000);
  expect(consumeAction(a.id, "cancelled", 1500).outcome).toBe("ok");
  expect(consumeAction(a.id, "approved", 1501).outcome).toBe("stale");
});

test("consumeAction: 24h expiry boundary", () => {
  const a = proposeAction(5, "s", CAL_ADD, newTurnId(), 1000);
  const justInside = consumeAction(a.id, "approved", 1000 + 24 * 3600);
  expect(justInside.outcome).toBe("ok"); // exactly 24h is still valid
  const b = proposeAction(5, "s2", CAL_ADD, newTurnId(), 1000);
  const past = consumeAction(b.id, "approved", 1000 + 24 * 3600 + 1);
  expect(past.outcome).toBe("expired");
  // expired is terminal AND idempotent: a later tap still reports expired
  expect(consumeAction(b.id, "approved", 1000 + 24 * 3600 + 2).outcome).toBe("expired");
});

test("pruneActions: drops old resolved entries, expires old pendings, keeps fresh ones", () => {
  const nowS = 1000 + 8 * 24 * 3600;
  // done: very old resolved entry (8 days old) — dropped by prune (>PRUNE_AFTER_S)
  const done = proposeAction(5, "old resolved", CAL_ADD, newTurnId(), 1000);
  consumeAction(done.id, "approved", 1001);
  // old and keep: 2 days old — past EXPIRY_S (24h) so prune flips them to expired,
  // but within PRUNE_AFTER_S (7 days) so the entry is kept in the file
  const expiredBase = nowS - 2 * 24 * 3600;
  const old = proposeAction(5, "old pending", CAL_ADD, newTurnId(), expiredBase);
  const keep = proposeAction(5, "keep pending", CAL_ADD, newTurnId(), expiredBase);
  const fresh = proposeAction(5, "really fresh", CAL_ADD, newTurnId(), nowS - 10);
  pruneActions(nowS);
  const left = takePending(5, fresh.turnId);
  expect(left.map((p) => p.id)).toEqual([fresh.id]); // only the fresh one is still pending
  expect(consumeAction(old.id, "approved", nowS).outcome).toBe("expired"); // was expired by prune
  expect(consumeAction(keep.id, "approved", nowS).outcome).toBe("expired"); // ditto (also >24h old)
  expect(consumeAction(done.id, "approved", nowS).outcome).toBe("stale"); // dropped entirely
});

test("newTurnId returns unique-ish ids", () => {
  expect(newTurnId()).not.toBe(newTurnId());
});

// --- morning nudge (2026-08-16) ---------------------------------------------
// The 2026-08-13 תור לחי case: proposed 23:16 for a 09:34 appointment the
// next morning, buttons arrived while Maor slept, the proposal expired after
// the appointment had passed. One re-ping at 09:00 is the fix.

import { dueMorningNudges, markActionNudged, bindActionMessage, listPending, NUDGE_HOUR } from "./pending";

const H = 3600;

test("a proposal that survived the night is due exactly at the nudge hour", () => {
  const a = proposeAction(1, "קביעת תור לחי - מחר 09:34", CAL_ADD, newTurnId(), 1000);
  const morning = 1000 + 10 * H; // 23:16 → ~09:16 next day
  expect(dueMorningNudges(morning, NUDGE_HOUR).map((x) => x.id)).toEqual([a.id]);
  expect(dueMorningNudges(morning, NUDGE_HOUR + 1)).toEqual([]); // any other hour: silent
  expect(dueMorningNudges(morning, 0)).toEqual([]);
});

test("a fresh proposal is unanswered, not forgotten — no nudge under an hour", () => {
  proposeAction(1, "s", CAL_ADD, newTurnId(), 1000);
  expect(dueMorningNudges(1000 + H - 1, NUDGE_HOUR)).toEqual([]);
  expect(dueMorningNudges(1000 + H, NUDGE_HOUR).length).toBe(1); // exactly 1h is old enough
});

test("one nudge ever: the flag holds across loads, legacy records default to un-nudged", () => {
  const a = proposeAction(1, "s", CAL_ADD, newTurnId(), 1000);
  expect(dueMorningNudges(1000 + 2 * H, NUDGE_HOUR).length).toBe(1); // legacy shape: no `nudged` key
  markActionNudged(a.id);
  expect(dueMorningNudges(1000 + 2 * H, NUDGE_HOUR)).toEqual([]);
  expect(dueMorningNudges(1000 + 20 * H, NUDGE_HOUR)).toEqual([]); // next morning too
});

test("resolved and expired proposals are never nudged", () => {
  const ok = proposeAction(1, "approved one", CAL_ADD, newTurnId(), 1000);
  consumeAction(ok.id, "approved", 2000);
  proposeAction(1, "too old", CAL_ADD, newTurnId(), 1000);
  expect(dueMorningNudges(1000 + 25 * H, NUDGE_HOUR)).toEqual([]); // past 24h expiry
  expect(dueMorningNudges(1000 + 2 * H, NUDGE_HOUR).map((x) => x.summary)).toEqual(["too old"]);
});

test("nudging never blocks the tap: consume still works after markActionNudged", () => {
  const a = proposeAction(1, "s", CAL_ADD, newTurnId(), 1000);
  markActionNudged(a.id);
  const r = consumeAction(a.id, "approved", 1000 + 2 * H);
  expect(r.outcome).toBe("ok");
});

test("the nudge hands the buttons over: one live message id at a time", () => {
  const a = proposeAction(1, "s", CAL_ADD, newTurnId(), 1000);
  expect(a.messageId).toBeUndefined(); // not known until Telegram answers
  bindActionMessage(a.id, 5001); // first send
  expect(listPending(1)[0].messageId).toBe(5001);
  bindActionMessage(a.id, 5002); // nudge takes over
  expect(listPending(1)[0].messageId).toBe(5002);
});

test("binding a message never resurrects or alters a resolved proposal", () => {
  const a = proposeAction(1, "s", CAL_ADD, newTurnId(), 1000);
  consumeAction(a.id, "approved", 1500);
  bindActionMessage(a.id, 5003); // late Telegram response after the tap
  expect(listPending(1)).toEqual([]); // still resolved, not pending again
  expect(dueMorningNudges(1000 + 2 * H, NUDGE_HOUR)).toEqual([]);
});
