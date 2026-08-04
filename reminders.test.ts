import { test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Use a throwaway store file so tests never touch the real reminders.json.
const TMP = join(import.meta.dir, "reminders.test.tmp.json");
process.env.REMINDERS_FILE = TMP;

import { nextFire, addOnce, addRepeat, listFor, cancel, editReminder, popDue, loadStore } from "./reminders.ts";

const DAILY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const epochOf = (y: number, m0: number, d: number, h: number, min: number) =>
  Math.floor(new Date(y, m0, d, h, min, 0, 0).getTime() / 1000);

beforeEach(() => {
  if (existsSync(TMP)) rmSync(TMP);
});
afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP);
});

// --- nextFire -----------------------------------------------------------

test("nextFire daily: before today's time → today", () => {
  const now = epochOf(2026, 5, 5, 7, 0); // Jun 5 2026, 07:00 local
  const f = nextFire(now, 8, 0, DAILY);
  const d = new Date(f * 1000);
  expect(f).toBeGreaterThan(now);
  expect(d.getHours()).toBe(8);
  expect(d.getMinutes()).toBe(0);
  expect(d.getDate()).toBe(5);
});

test("nextFire daily: after today's time → tomorrow", () => {
  const now = epochOf(2026, 5, 5, 9, 0);
  const f = nextFire(now, 8, 0, DAILY);
  const d = new Date(f * 1000);
  expect(d.getDate()).toBe(6);
  expect(d.getHours()).toBe(8);
});

test("nextFire weekdays: result is always a weekday, after now", () => {
  // try a week of starting points
  for (let day = 1; day <= 7; day++) {
    const now = epochOf(2026, 5, day, 23, 0);
    const f = nextFire(now, 8, 0, WEEKDAYS);
    const d = new Date(f * 1000);
    expect(f).toBeGreaterThan(now);
    expect(WEEKDAYS).toContain(d.getDay());
    expect(d.getHours()).toBe(8);
  }
});

test("nextFire weekly (single day) lands on that weekday", () => {
  const now = epochOf(2026, 5, 5, 12, 0);
  const f = nextFire(now, 10, 30, [1]); // Mondays 10:30
  const d = new Date(f * 1000);
  expect(d.getDay()).toBe(1);
  expect(d.getHours()).toBe(10);
  expect(d.getMinutes()).toBe(30);
  expect(f).toBeGreaterThan(now);
});

// --- add / list / cancel ------------------------------------------------

test("addOnce then list then cancel roundtrip", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  const r = addOnce(42, future, "call the bank");
  expect(r.id).toBe("r1");
  let items = listFor(42);
  expect(items.length).toBe(1);
  expect(items[0].text).toBe("call the bank");
  expect(cancel(42, "r1")).toBe(true);
  expect(listFor(42).length).toBe(0);
  expect(cancel(42, "r1")).toBe(false); // already gone
});

test("list is scoped per chat", () => {
  const t = Math.floor(Date.now() / 1000) + 3600;
  addOnce(1, t, "a");
  addOnce(2, t, "b");
  expect(listFor(1).length).toBe(1);
  expect(listFor(2).length).toBe(1);
  expect(listFor(1)[0].text).toBe("a");
});

// --- popDue -------------------------------------------------------------

test("popDue fires and removes a one-time reminder", () => {
  const past = Math.floor(Date.now() / 1000) - 10;
  addOnce(7, past, "ping");
  const due = popDue();
  expect(due.length).toBe(1);
  expect(due[0].text).toBe("ping");
  expect(loadStore().length).toBe(0); // removed
});

test("popDue fires and reschedules a recurring reminder", () => {
  const now = epochOf(2026, 5, 5, 9, 0);
  // first fire computed for 08:00 daily relative to a now BEFORE that, so it's pending...
  addRepeat(7, 8, 0, DAILY, "standup", epochOf(2026, 5, 5, 7, 0));
  // now it's 09:00 (past 08:00) → should be due, fire once, reschedule to tomorrow 08:00
  const due = popDue(now);
  expect(due.length).toBe(1);
  const after = loadStore();
  expect(after.length).toBe(1); // still there
  const next = new Date(after[0].fireAt * 1000);
  expect(after[0].fireAt).toBeGreaterThan(now);
  expect(next.getHours()).toBe(8);
});

test("popDue leaves future reminders untouched", () => {
  const future = Math.floor(Date.now() / 1000) + 3600;
  addOnce(7, future, "later");
  expect(popDue().length).toBe(0);
  expect(loadStore().length).toBe(1);
});

// --- editReminder: move or reword without cancel+re-add ---------------------
// Rescheduling used to mean cancel + add, which loses the reminder outright if
// the second half fails, and mints a new id. Maor reschedules constantly
// ("תדחה את זה ליום שני ב-10:20"), so it gets a first-class operation.

test("editReminder moves a one-time reminder and keeps its id", () => {
  const soon = Math.floor(Date.now() / 1000) + 600;
  const r = addOnce(7, soon, "call the bank");
  const moved = editReminder(7, r.id, { fireAt: soon + 7200 });
  expect(moved).not.toBeNull();
  expect(moved!.id).toBe(r.id);
  expect(moved!.fireAt).toBe(soon + 7200);
  expect(moved!.text).toBe("call the bank");
  expect(loadStore().length).toBe(1); // moved, not duplicated
});

test("editReminder rewords without touching the time", () => {
  const soon = Math.floor(Date.now() / 1000) + 600;
  const r = addOnce(7, soon, "old wording");
  const edited = editReminder(7, r.id, { text: "new wording" });
  expect(edited!.text).toBe("new wording");
  expect(edited!.fireAt).toBe(soon);
});

test("editReminder retimes a repeating reminder and recomputes the next fire", () => {
  const r = addRepeat(7, 8, 0, [1, 2, 3, 4, 5], "standup");
  const edited = editReminder(7, r.id, { hour: 20, minute: 35, days: [0, 1, 2, 3, 4, 5, 6] });
  expect(edited!.repeat).toEqual({ hour: 20, minute: 35, days: [0, 1, 2, 3, 4, 5, 6] });
  const next = new Date(edited!.fireAt * 1000);
  expect(next.getHours()).toBe(20);
  expect(next.getMinutes()).toBe(35);
  expect(edited!.fireAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
});

test("editReminder rewords a repeating reminder without disturbing its schedule", () => {
  const r = addRepeat(7, 9, 30, [0], "weekly thing");
  const edited = editReminder(7, r.id, { text: "weekly thing, revised" });
  expect(edited!.text).toBe("weekly thing, revised");
  expect(edited!.repeat).toEqual({ hour: 9, minute: 30, days: [0] });
  expect(edited!.fireAt).toBe(r.fireAt);
});

test("editReminder returns null for an unknown id or another chat's reminder", () => {
  const soon = Math.floor(Date.now() / 1000) + 600;
  const r = addOnce(7, soon, "mine");
  expect(editReminder(7, "nope", { text: "x" })).toBeNull();
  expect(editReminder(999, r.id, { text: "x" })).toBeNull(); // wrong chat
  expect(loadStore()[0].text).toBe("mine");
});

test("editReminder refuses a one-time move into the past", () => {
  const soon = Math.floor(Date.now() / 1000) + 600;
  const r = addOnce(7, soon, "future thing");
  expect(() => editReminder(7, r.id, { fireAt: Math.floor(Date.now() / 1000) - 60 })).toThrow(/past/i);
  expect(loadStore()[0].fireAt).toBe(soon); // unchanged
});

test("editReminder with nothing to change is rejected rather than silently passing", () => {
  const soon = Math.floor(Date.now() / 1000) + 600;
  const r = addOnce(7, soon, "unchanged");
  expect(() => editReminder(7, r.id, {})).toThrow(/nothing to change/i);
});

test("editReminder will not put a repeat schedule on a one-time reminder", () => {
  const soon = Math.floor(Date.now() / 1000) + 600;
  const r = addOnce(7, soon, "one-off");
  expect(() => editReminder(7, r.id, { hour: 9, minute: 0, days: [1] })).toThrow(/one-time/i);
});

// --- follow-up lifecycle (Phase 5) ----------------------------------------

import {
  addFollowup, getFollowup, resolveFollowup, revertFollowup, rebindFollowup,
  markNudged, dueNudges, pruneFollowups, loadFollowups, type Followup,
} from "./reminders.ts";

const T0 = 1_781_000_000;

function freshFollowupFile() {
  process.env.FOLLOWUPS_FILE = join(mkdtempSync(join(tmpdir(), "fu-")), "followups.json");
}

test("addFollowup creates a pending, un-nudged follow-up with a fresh id", () => {
  freshFollowupFile();
  const f = addFollowup(282408422, "לקנות חלב", 111, T0);
  expect(f.status).toBe("pending");
  expect(f.nudged).toBe(false);
  expect(f.messageId).toBe(111);
  const again = addFollowup(282408422, "משהו אחר", 112, T0);
  expect(again.id).not.toBe(f.id);
  expect(loadFollowups().length).toBe(2);
});

test("resolveFollowup marks done/snoozed once; second resolve returns null", () => {
  freshFollowupFile();
  const f = addFollowup(1, "x", 5, T0);
  expect(resolveFollowup(f.id, "done")!.status).toBe("done");
  expect(resolveFollowup(f.id, "snoozed")).toBeNull(); // already resolved
  expect(getFollowup(f.id)!.status).toBe("done");
});

test("marking one done closes same-errand pending duplicates (2026-08-04)", () => {
  freshFollowupFile();
  const stale = addFollowup(7, "לשמוע את ההקלטה של מתן", 10, T0);
  const latest = addFollowup(7, "לשמוע את ההקלטה של מתן", 11, T0 + 200_000);
  const otherErrand = addFollowup(7, "להגיש משרות", 12, T0);
  const otherChat = addFollowup(8, "לשמוע את ההקלטה של מתן", 13, T0);

  expect(resolveFollowup(latest.id, "done")!.status).toBe("done");
  expect(getFollowup(stale.id)!.status).toBe("done"); // the orphan the summary kept reporting
  expect(getFollowup(otherErrand.id)!.status).toBe("pending");
  expect(getFollowup(otherChat.id)!.status).toBe("pending");
});

test("snoozing does not cascade to duplicates", () => {
  freshFollowupFile();
  const a = addFollowup(7, "להגיש משרות", 10, T0);
  const b = addFollowup(7, "להגיש משרות", 11, T0 + 100);
  resolveFollowup(b.id, "snoozed");
  expect(getFollowup(a.id)!.status).toBe("pending");
});

test("a done cascade leaves snoozed duplicates alone so undo still works", () => {
  freshFollowupFile();
  const a = addFollowup(7, "להגיש משרות", 10, T0);
  const b = addFollowup(7, "להגיש משרות", 11, T0 + 100);
  resolveFollowup(a.id, "snoozed");
  resolveFollowup(b.id, "done");
  expect(getFollowup(a.id)!.status).toBe("snoozed");
  expect(revertFollowup(a.id, T0 + 500)!.status).toBe("pending");
});

test("revertFollowup turns a snoozed follow-up back to pending and resets the timer", () => {
  freshFollowupFile();
  const f = addFollowup(1, "x", 5, T0);
  resolveFollowup(f.id, "snoozed");
  const r = revertFollowup(f.id, T0 + 10_000);
  expect(r!.status).toBe("pending");
  expect(r!.firedAt).toBe(T0 + 10_000); // reset to "now" so no instant nudge
  expect(r!.nudged).toBe(false);
  expect(getFollowup(f.id)!.status).toBe("pending");
});

test("revertFollowup returns null for a missing id or a non-snoozed follow-up", () => {
  freshFollowupFile();
  expect(revertFollowup("nope", T0)).toBeNull();
  const f = addFollowup(1, "x", 5, T0);
  expect(revertFollowup(f.id, T0)).toBeNull(); // pending, nothing to revert
  resolveFollowup(f.id, "done");
  expect(revertFollowup(f.id, T0)).toBeNull(); // done, not a snooze
});

test("revertFollowup clears a prior nudge so the cycle restarts from now", () => {
  freshFollowupFile();
  const f = addFollowup(1, "x", 5, T0);
  markNudged(f.id);
  resolveFollowup(f.id, "snoozed");
  revertFollowup(f.id, T0 + 100);
  // pending again, un-nudged, timer reset → not due until an hour after the revert
  expect(dueNudges(T0 + 100 + 3599).length).toBe(0);
  expect(dueNudges(T0 + 100 + 3600).map((d) => d.id)).toEqual([f.id]);
});

test("dueNudges returns pending follow-ups older than the age, once only", () => {
  freshFollowupFile();
  const f = addFollowup(1, "x", 5, T0);
  expect(dueNudges(T0 + 3599).length).toBe(0); // not old enough
  const due = dueNudges(T0 + 3600);
  expect(due.map((d) => d.id)).toEqual([f.id]);
  markNudged(f.id);
  expect(dueNudges(T0 + 7200).length).toBe(0); // never twice
});

test("resolved follow-ups never nudge; rebind moves the buttons' message", () => {
  freshFollowupFile();
  const f = addFollowup(1, "x", 5, T0);
  rebindFollowup(f.id, 99);
  expect(getFollowup(f.id)!.messageId).toBe(99);
  resolveFollowup(f.id, "snoozed");
  expect(dueNudges(T0 + 9999).length).toBe(0);
});

test("pruneFollowups drops resolved entries older than 7 days, keeps pending", () => {
  freshFollowupFile();
  const a = addFollowup(1, "old done", 1, T0 - 8 * 86_400);
  const b = addFollowup(1, "old pending", 2, T0 - 8 * 86_400);
  resolveFollowup(a.id, "done");
  const removed = pruneFollowups(T0);
  expect(removed).toBe(1);
  expect(getFollowup(a.id)).toBeNull();
  expect(getFollowup(b.id)!.status).toBe("pending");
});

test("follow-up ids are never reused, even after prune", () => {
  freshFollowupFile();
  const a = addFollowup(1, "x", 1, T0 - 8 * 86_400);
  resolveFollowup(a.id, "done");
  pruneFollowups(T0);
  const b = addFollowup(1, "y", 2, T0);
  expect(b.id).not.toBe(a.id);
});

// --- withFileLock: cross-process mutation lock (poller vs remind.ts CLI) ------

import { withFileLock } from "./reminders.ts";
import { writeFileSync, utimesSync, statSync } from "node:fs";

test("withFileLock holds the lockfile during fn and removes it after", () => {
  const lock = TMP + ".lock";
  let seenDuring = false;
  const out = withFileLock(TMP, () => {
    seenDuring = existsSync(lock);
    return 42;
  });
  expect(out).toBe(42);
  expect(seenDuring).toBe(true);
  expect(existsSync(lock)).toBe(false);
});

test("withFileLock removes the lock even when fn throws", () => {
  const lock = TMP + ".lock";
  expect(() => withFileLock(TMP, () => { throw new Error("boom"); })).toThrow("boom");
  expect(existsSync(lock)).toBe(false);
});

test("withFileLock steals a stale lock without waiting out the timeout", () => {
  const lock = TMP + ".lock";
  writeFileSync(lock, "99999"); // a crashed process's leftover
  const old = Date.now() / 1000 - 60;
  utimesSync(lock, old, old); // make it 60s old (stale threshold is 5s)
  const t0 = Date.now();
  const out = withFileLock(TMP, () => "ran", { timeoutMs: 1500, staleMs: 5000 });
  expect(out).toBe("ran");
  expect(Date.now() - t0).toBeLessThan(500); // stolen, not waited
  expect(existsSync(lock)).toBe(false);
});

test("withFileLock proceeds (availability over deadlock) when a FRESH lock never clears", () => {
  const lock = TMP + ".lock";
  writeFileSync(lock, "12345"); // fresh foreign lock, never released
  const t0 = Date.now();
  const out = withFileLock(TMP, () => "ran-anyway", { timeoutMs: 200, staleMs: 60_000 });
  expect(out).toBe("ran-anyway");
  expect(Date.now() - t0).toBeGreaterThanOrEqual(190); // waited out the timeout first
  rmSync(lock); // ours to clean: fn ran lockless, so the foreign lock remains
});

test("mutators run under the lock (addOnce leaves no lockfile behind)", () => {
  addOnce(7, 1_900_000_000, "lock smoke");
  expect(existsSync(TMP + ".lock")).toBe(false);
  expect(listFor(7).length).toBe(1);
});
