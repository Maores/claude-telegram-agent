/**
 * game.ts — progress, XP and levels over things Maor actually finished.
 *
 *   bun run game.ts sync     (award XP for newly-completed items; idempotent)
 *   bun run game.ts status   (level, XP, progress to next level, streak)
 *
 * Maor asked for this on 2026-07-15 and was specific about the shape: he wants
 * to FEEL progress through leveling, not read a counter. So levels cost
 * progressively more, and a streak of consecutive active days is reported
 * alongside the total.
 *
 * Honesty rule: XP is only ever awarded for a completion the data can prove —
 * a follow-up he marked בוצע, a task he ticked off. The quiz is deliberately
 * NOT a source yet: quiz state records which questions were SENT, not which
 * were answered, so awarding from it would hand out points for questions he
 * ignored. That needs a quiz.ts change first.
 *
 * The ledger is append-only and every row carries the source's own id, so
 * `sync` can run on every nightly summary without ever double-counting.
 */
import type { Database } from "bun:sqlite";
import { getDb } from "./db";
import { loadFollowups } from "./reminders.ts";

export const POINTS = {
  followup: 10, // a reminder he confirmed he actually did
  task: 5, // an Apple Reminders task ticked off
} as const;
export type XpKind = keyof typeof POINTS;

// --- the level curve ---------------------------------------------------------

/** Cumulative XP needed to reach `level`. Quadratic, so each level costs more
 *  than the one before: 0, 50, 150, 300, 500, 750, … */
export function xpToReach(level: number): number {
  return 25 * level * (level - 1);
}

export function levelFor(xp: number): number {
  let l = 1;
  while (xpToReach(l + 1) <= xp) l++;
  return l;
}

export interface Progress { level: number; into: number; span: number; toNext: number }

/** Where `xp` sits inside its current level. */
export function progressIn(xp: number): Progress {
  const level = levelFor(xp);
  const base = xpToReach(level);
  const next = xpToReach(level + 1);
  return { level, into: xp - base, span: next - base, toNext: next - xp };
}

// --- the ledger --------------------------------------------------------------

export interface AwardArgs { kind: XpKind; points: number; ts: number; ref?: string; note?: string }

/** Record an award. Returns false when this (kind, ref) already scored, which
 *  is what lets sync run repeatedly without inflating the total. */
export function awardXp(db: Database, a: AwardArgs): boolean {
  const existing = db
    .query("SELECT 1 FROM xp_events WHERE kind = ? AND ref IS ?")
    .get(a.kind, a.ref ?? null);
  if (existing) return false;
  db.query("INSERT INTO xp_events (ts, kind, points, ref, note) VALUES (?, ?, ?, ?, ?)").run(
    a.ts, a.kind, a.points, a.ref ?? null, a.note ?? null,
  );
  return true;
}

export function totalXp(db: Database): number {
  const r = db.query("SELECT COALESCE(SUM(points), 0) AS n FROM xp_events").get() as { n: number };
  return r.n;
}

/** Distinct local dates (YYYY-MM-DD) on which anything was earned. */
export function eventDays(db: Database): string[] {
  return (
    db
      .query("SELECT DISTINCT date(ts, 'unixepoch', 'localtime') AS d FROM xp_events ORDER BY d")
      .all() as { d: string }[]
  ).map((r) => r.d);
}

/** Length of the run of consecutive active days ending today. Today having no
 *  activity yet does not break it — a streak should not look dead at 09:00. */
export function computeStreak(days: string[], today: string): number {
  const set = new Set(days);
  const dayBefore = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  let cursor = set.has(today) ? today : dayBefore(today);
  if (!set.has(cursor)) return 0;
  let n = 0;
  while (set.has(cursor)) {
    n++;
    cursor = dayBefore(cursor);
  }
  return n;
}

// --- syncing real completions ------------------------------------------------

export interface SyncResult {
  awarded: number; xpBefore: number; xpAfter: number;
  levelBefore: number; levelAfter: number; leveledUp: boolean;
}

interface FollowupLike { id?: string; status?: string; firedAt?: number; text?: string }

/** Award for every follow-up marked done that has not scored yet. */
export function syncFollowups(db: Database, followups: FollowupLike[]): SyncResult {
  const xpBefore = totalXp(db);
  let awarded = 0;
  for (const f of followups ?? []) {
    if (!f?.id || f.status !== "done") continue;
    if (awardXp(db, {
      kind: "followup",
      ref: f.id,
      points: POINTS.followup,
      ts: f.firedAt ?? Math.floor(Date.now() / 1000),
      note: f.text,
    })) awarded++;
  }
  const xpAfter = totalXp(db);
  const levelBefore = levelFor(xpBefore);
  const levelAfter = levelFor(xpAfter);
  return { awarded, xpBefore, xpAfter, levelBefore, levelAfter, leveledUp: levelAfter > levelBefore };
}

// --- reporting ----------------------------------------------------------------

export interface StatusReport extends Progress {
  xp: number; streak: number; byKind: Record<string, number>; recent: { ts: number; note: string | null }[];
}

export function statusReport(db: Database, today: string): StatusReport {
  const xp = totalXp(db);
  const byKind: Record<string, number> = {};
  for (const r of db.query("SELECT kind, COUNT(*) AS n FROM xp_events GROUP BY kind").all() as
    { kind: string; n: number }[]) byKind[r.kind] = r.n;
  const recent = db
    .query("SELECT ts, note FROM xp_events ORDER BY ts DESC, id DESC LIMIT 5")
    .all() as { ts: number; note: string | null }[];
  return { ...progressIn(xp), xp, streak: computeStreak(eventDays(db), today), byKind, recent };
}

// --- CLI ----------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
function todayISO(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A short progress bar, because a number alone does not read as progress. */
export function bar(into: number, span: number, width = 10): string {
  const filled = span <= 0 ? width : Math.max(0, Math.min(width, Math.round((into / span) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function main() {
  const cmd = process.argv[2];
  const db = getDb();

  if (cmd === "sync") {
    const res = syncFollowups(db, loadFollowups() as FollowupLike[]);
    if (!res.awarded) {
      console.log("no new completions");
    } else {
      console.log(`awarded ${res.awarded} completion(s), ${res.xpBefore} -> ${res.xpAfter} XP`);
      if (res.leveledUp) console.log(`LEVEL UP: ${res.levelBefore} -> ${res.levelAfter}`);
    }
    return;
  }

  if (cmd === "status") {
    const r = statusReport(db, todayISO());
    console.log(`level ${r.level}  ${bar(r.into, r.span)}  ${r.into}/${r.span} to level ${r.level + 1}`);
    console.log(`total ${r.xp} XP · streak ${r.streak} day(s)`);
    const parts = Object.entries(r.byKind).map(([k, n]) => `${n} ${k}`);
    if (parts.length) console.log(`from: ${parts.join(", ")}`);
    return;
  }

  console.log("usage:\n  bun run game.ts sync\n  bun run game.ts status");
  process.exitCode = 1;
}

if (import.meta.main) main();
