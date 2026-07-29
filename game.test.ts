import { describe, expect, test } from "bun:test";
import { openDb } from "./db";
import {
  xpToReach, levelFor, progressIn, POINTS,
  awardXp, totalXp, eventDays, computeStreak, syncFollowups, statusReport,
} from "./game";

const NOW = 1_781_000_000; // a fixed instant; nothing here reads the clock
const DAY = 86_400;
const fresh = () => openDb(":memory:");

// --- the level curve (pure) ---------------------------------------------------

describe("level curve", () => {
  test("levels start at 1 and get progressively more expensive", () => {
    expect(xpToReach(1)).toBe(0);
    expect(xpToReach(2)).toBe(50);
    expect(xpToReach(3)).toBe(150);
    expect(xpToReach(4)).toBe(300);
    // each step costs more than the last — that is what makes it feel like
    // progression rather than a counter
    const steps = [2, 3, 4, 5, 6].map((l) => xpToReach(l) - xpToReach(l - 1));
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
  });

  test("levelFor maps xp to the right level, including exact boundaries", () => {
    expect(levelFor(0)).toBe(1);
    expect(levelFor(49)).toBe(1);
    expect(levelFor(50)).toBe(2);
    expect(levelFor(149)).toBe(2);
    expect(levelFor(150)).toBe(3);
    expect(levelFor(2250)).toBe(10);
  });

  test("progressIn reports position inside the current level", () => {
    const p = progressIn(200); // level 3 spans 150..300
    expect(p.level).toBe(3);
    expect(p.into).toBe(50);
    expect(p.span).toBe(150);
    expect(p.toNext).toBe(100);
  });

  test("a brand-new player sits at the very start of level 1", () => {
    const p = progressIn(0);
    expect(p.level).toBe(1);
    expect(p.into).toBe(0);
    expect(p.toNext).toBe(50);
  });
});

// --- the ledger ---------------------------------------------------------------

describe("awardXp", () => {
  test("records points and adds them to the total", () => {
    const db = fresh();
    awardXp(db, { kind: "followup", ref: "f1", points: 10, ts: NOW });
    awardXp(db, { kind: "followup", ref: "f2", points: 10, ts: NOW });
    expect(totalXp(db)).toBe(20);
    db.close();
  });

  test("the same source id never scores twice, so sync can re-run safely", () => {
    const db = fresh();
    expect(awardXp(db, { kind: "followup", ref: "f1", points: 10, ts: NOW })).toBe(true);
    expect(awardXp(db, { kind: "followup", ref: "f1", points: 10, ts: NOW })).toBe(false);
    expect(totalXp(db)).toBe(10);
    db.close();
  });

  test("the same ref under a different kind is a separate achievement", () => {
    const db = fresh();
    awardXp(db, { kind: "followup", ref: "x", points: 10, ts: NOW });
    awardXp(db, { kind: "task", ref: "x", points: 5, ts: NOW });
    expect(totalXp(db)).toBe(15);
    db.close();
  });

  test("an empty ledger totals zero rather than throwing", () => {
    const db = fresh();
    expect(totalXp(db)).toBe(0);
    db.close();
  });
});

// --- streaks ------------------------------------------------------------------

describe("computeStreak", () => {
  test("counts consecutive days ending today", () => {
    const days = ["2026-07-27", "2026-07-28", "2026-07-29"];
    expect(computeStreak(days, "2026-07-29")).toBe(3);
  });

  test("still counts when today has no activity yet but yesterday did", () => {
    // mid-morning, before anything is done — the streak is alive, not broken
    expect(computeStreak(["2026-07-27", "2026-07-28"], "2026-07-29")).toBe(2);
  });

  test("breaks once a full day is missed", () => {
    expect(computeStreak(["2026-07-25", "2026-07-26"], "2026-07-29")).toBe(0);
  });

  test("ignores gaps further back and counts only the current run", () => {
    const days = ["2026-07-01", "2026-07-02", "2026-07-28", "2026-07-29"];
    expect(computeStreak(days, "2026-07-29")).toBe(2);
  });

  test("no activity at all is a streak of zero", () => {
    expect(computeStreak([], "2026-07-29")).toBe(0);
  });

  test("duplicate entries for one day still count as a single day", () => {
    expect(computeStreak(["2026-07-29", "2026-07-29", "2026-07-28"], "2026-07-29")).toBe(2);
  });
});

describe("eventDays", () => {
  test("returns the distinct local dates that earned anything", () => {
    const db = fresh();
    awardXp(db, { kind: "followup", ref: "a", points: 10, ts: NOW });
    awardXp(db, { kind: "followup", ref: "b", points: 10, ts: NOW + 60 }); // same day
    awardXp(db, { kind: "followup", ref: "c", points: 10, ts: NOW + DAY });
    expect(eventDays(db).length).toBe(2);
    db.close();
  });
});

// --- syncing real completions -------------------------------------------------

describe("syncFollowups", () => {
  const fu = (id: string, status: string, firedAt = NOW) => ({ id, status, firedAt, text: "t " + id });

  test("awards only for follow-ups Maor actually marked done", () => {
    const db = fresh();
    const res = syncFollowups(db, [fu("f1", "done"), fu("f2", "pending"), fu("f3", "snoozed")] as any);
    expect(res.awarded).toBe(1);
    expect(totalXp(db)).toBe(POINTS.followup);
    db.close();
  });

  test("re-running it awards nothing new", () => {
    const db = fresh();
    const list = [fu("f1", "done"), fu("f2", "done")] as any;
    expect(syncFollowups(db, list).awarded).toBe(2);
    expect(syncFollowups(db, list).awarded).toBe(0);
    expect(totalXp(db)).toBe(2 * POINTS.followup);
    db.close();
  });

  test("a follow-up completed later is picked up on the next sync", () => {
    const db = fresh();
    syncFollowups(db, [fu("f1", "pending")] as any);
    expect(totalXp(db)).toBe(0);
    const res = syncFollowups(db, [fu("f1", "done")] as any);
    expect(res.awarded).toBe(1);
    db.close();
  });

  test("reports the level crossing so the nightly summary can celebrate it", () => {
    const db = fresh();
    // 5 completions x 10 = 50 XP, which is exactly the level-2 threshold
    const many = Array.from({ length: 5 }, (_, i) => fu("f" + i, "done"));
    const res = syncFollowups(db, many as any);
    expect(res.levelBefore).toBe(1);
    expect(res.levelAfter).toBe(2);
    expect(res.leveledUp).toBe(true);
    db.close();
  });

  test("no level crossing means nothing to announce", () => {
    const db = fresh();
    const res = syncFollowups(db, [fu("f1", "done")] as any);
    expect(res.leveledUp).toBe(false);
    db.close();
  });

  test("an empty or malformed followups file is survivable", () => {
    const db = fresh();
    expect(syncFollowups(db, [] as any).awarded).toBe(0);
    expect(syncFollowups(db, [{ id: "x" }] as any).awarded).toBe(0);
    db.close();
  });
});

// --- the human-facing report ---------------------------------------------------

describe("statusReport", () => {
  test("summarises level, xp, and what is left to the next level", () => {
    const db = fresh();
    for (let i = 0; i < 3; i++) awardXp(db, { kind: "followup", ref: "f" + i, points: 10, ts: NOW });
    const r = statusReport(db, "2026-07-29");
    expect(r.xp).toBe(30);
    expect(r.level).toBe(1);
    expect(r.toNext).toBe(20);
    expect(r.byKind.followup).toBe(3);
    db.close();
  });

  test("an untouched ledger reports level 1 and no streak instead of erroring", () => {
    const db = fresh();
    const r = statusReport(db, "2026-07-29");
    expect(r.level).toBe(1);
    expect(r.xp).toBe(0);
    expect(r.streak).toBe(0);
    db.close();
  });
});
