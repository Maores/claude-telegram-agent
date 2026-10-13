/**
 * approvals.ts: the owner's approval for new [AUTO] jobs and for new or changed skills
 * (spec docs/superpowers/specs/2026-10-07-server-hardening-design.md, section 3).
 *
 * A turn is the legitimate writer of reminders and skills, so a planted job or skill could renew
 * itself. The gates close that: with AUTO_APPROVAL=1 a due [AUTO] job runs only when its key is
 * approved; with SKILL_APPROVAL=1 a skill reaches a prompt (and `skill.ts view|search|list` as a
 * turn runs them) only when its current key is approved. The poller sends one ✓/✗ card per new key
 * to the owner's chat and records the answer here.
 *
 * Every card carries a random token, recorded with the exact full key it showed. A tap applies only
 * to that key, and only while the item still has it: a button names exactly one carded item, so an
 * item changed after its card (even to a text whose key shares a prefix) is never approved by it.
 *
 * The file sits at the poller-only top of the state folder (0640): a turn can read it and never
 * write it. Reads go through readNoFollow; every change goes through mutateApprovals (the stores'
 * file lock around load, change and an atomic replace), which is synchronous: never held across an
 * await, and which never writes over a file it could not read.
 *
 *   bun run approvals.ts list [--keys <file>]   every [AUTO] job and active or stale skill with its
 *                               key and state; --keys also writes their key lines to <file>
 *   bun run approvals.ts seed --expect <file>   approve exactly those items, only when the store's
 *                               key lines still equal <file>; replaces approvals.json (the rollout
 *                               step, on the owner's word)
 */
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { statePath, sharedPath, writeAtomic, readNoFollow } from "./paths.ts";
import { withFileLock, loadStore, fmt, type Reminder } from "./reminders.ts";
import { listSkills, skillBodyPath, parseSkillMd, type SkillRow } from "./skills.ts";
import { getDb } from "./db.ts";

/** One sent card: the exact full key it showed (and, for a job, the reminder id). */
export interface Card {
  kind: "job" | "skill";
  key: string;
  id?: string;
  at: number;
  /** The card was too long to show in full, so it carries only ✗: a ✓ on it is never applied. */
  long?: true;
}

export interface Approvals {
  v: 1;
  jobs: { approved: string[]; carded: Record<string, Card> };
  skills: { approved: string[]; rejected: string[]; carded: Record<string, Card> };
}

const MAX_BYTES = 4 * 1024 * 1024;
const AUTO_PREFIX = "[AUTO] ";
const TOKEN_RE = /^[0-9a-f]{16}$/;

export function approvalsPath(): string {
  return statePath("approvals.json");
}

export function emptyApprovals(): Approvals {
  return { v: 1, jobs: { approved: [], carded: {} }, skills: { approved: [], rejected: [], carded: {} } };
}

/** A fresh card token: 8 random bytes as 16 hex characters. */
export function newCardToken(): string {
  return randomBytes(8).toString("hex");
}

function strList(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return [...new Set(x.filter((s): s is string => typeof s === "string"))];
}
function cardMap(x: unknown, kind: Card["kind"]): Record<string, Card> {
  const out: Record<string, Card> = {};
  if (!x || typeof x !== "object" || Array.isArray(x)) return out;
  for (const [t, c] of Object.entries(x as Record<string, any>)) {
    if (!TOKEN_RE.test(t) || !c || typeof c !== "object") continue;
    if (c.kind !== kind || typeof c.key !== "string" || typeof c.at !== "number" || !Number.isFinite(c.at)) continue;
    if (c.id !== undefined && typeof c.id !== "string") continue;
    const card: Card = c.id === undefined ? { kind, key: c.key, at: c.at } : { kind, key: c.key, id: c.id, at: c.at };
    if (c.long === true) card.long = true;
    out[t] = card;
  }
  return out;
}
function normalize(x: any): Approvals {
  const jobs = x?.jobs && typeof x.jobs === "object" ? x.jobs : {};
  const skills = x?.skills && typeof x.skills === "object" ? x.skills : {};
  return {
    v: 1,
    jobs: { approved: strList(jobs.approved), carded: cardMap(jobs.carded, "job") },
    skills: { approved: strList(skills.approved), rejected: strList(skills.rejected), carded: cardMap(skills.carded, "skill") },
  };
}

/** The approvals and whether the file could be read: missing or empty is fine (the empty
 *  default); a link, a FIFO, anything but a regular file, a file over the cap or bad JSON is logged
 *  and not ok (the approvals read as empty: nothing approved, fail closed). */
export function readApprovals(path: string): { a: Approvals; ok: boolean } {
  let text: string;
  try {
    text = readNoFollow(path, MAX_BYTES);
  } catch (e: any) {
    if (e?.code === "ENOENT") return { a: emptyApprovals(), ok: true };
    console.error(`[APPROVALS] ${path} unreadable, treated as empty: ${e?.message ?? e}`);
    return { a: emptyApprovals(), ok: false };
  }
  if (!text.trim()) return { a: emptyApprovals(), ok: true };
  try {
    return { a: normalize(JSON.parse(text)), ok: true };
  } catch (e: any) {
    console.error(`[APPROVALS] ${path} is not valid JSON, treated as empty: ${e?.message ?? e}`);
    return { a: emptyApprovals(), ok: false };
  }
}

/** The approvals for gating: an unreadable file approves nothing. A load never rewrites the file. */
export function loadApprovals(path: string): Approvals {
  return readApprovals(path).a;
}

/** Load, change and replace under the stores' file lock. Synchronous: never across an await. The
 *  replace is a rename, so a link at the path is replaced, never written through. A file that could
 *  not be read is never overwritten: this throws, and the caller treats the action as not done. */
export function mutateApprovals<T>(path: string, fn: (a: Approvals) => T): T {
  return withFileLock(path, () => {
    const { a, ok } = readApprovals(path);
    if (!ok) {
      console.error("[ERR] approvals.json unreadable: not overwriting");
      throw new Error("approvals.json unreadable: not overwriting");
    }
    const out = fn(a);
    writeAtomic(path, JSON.stringify(a, null, 2) + "\n");
    return out;
  });
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const own = <V>(m: Record<string, V>, k: string): V | undefined => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined);
const addOnce = (list: string[], k: string) => {
  if (!list.includes(k)) list.push(k);
};
const without = (list: string[], k: string) => list.filter((x) => x !== k);
const cardedKey = (m: Record<string, Card>, key: string) => Object.values(m).some((c) => c.key === key);
function dropCards(m: Record<string, Card>, key: string): void {
  for (const [t, c] of Object.entries(m)) if (c.key === key) delete m[t];
}

// ---------------------------------------------------------------------------
// Card text: what the owner sees is what he approves
// ---------------------------------------------------------------------------

/** At most this many characters per card (Telegram's limit is 4096; the bidi isolates tg() adds
 *  need the rest). */
export const CARD_MAX = 3900;
/** Shown in place of a zero-width, bidi control or other default-ignorable character, so a turn
 *  cannot hide or reorder what the owner reads. */
export const HIDDEN_MARK = "⟦?⟧";
const cc = (n: number) => String.fromCodePoint(n);
/** Every default-ignorable code point (tag characters, variation selectors, fillers, ZWJ and the
 *  rest; the tag block named too), every format character (category Cf), plus the bidi, zero-width
 *  and line-separator controls. Built from code points, so this file holds no invisible character. */
const HIDDEN_CLASS =
  `[\\p{Default_Ignorable_Code_Point}\\p{Cf}${cc(0xe0000)}-${cc(0xe007f)}` +
  `${cc(0x00ad)}${cc(0x061c)}${cc(0x180e)}${cc(0x200b)}-${cc(0x200f)}${cc(0x2028)}-${cc(0x202e)}${cc(0x2060)}-${cc(0x2064)}${cc(0x2066)}-${cc(0x2069)}${cc(0xfeff)}]`;
const CONTROL_RE = new RegExp(HIDDEN_CLASS, "gu");
const HIDDEN_RE = new RegExp(HIDDEN_CLASS, "u");
export function showable(s: string): string {
  return String(s).replace(CONTROL_RE, HIDDEN_MARK);
}
/** True when the text holds any character showable() would replace (ZWJ in an emoji included):
 *  such an item is never carded, it stays held. */
export function hasHidden(s: string): boolean {
  return HIDDEN_RE.test(String(s));
}
/** The owner's line for an item held because it holds hidden characters. */
export const HIDDEN_NOTICE = "פריט עם תווים נסתרים לא יוצג לאישור";
/** The notice naming the held item (a job id or a skill name as shownId gives it) on its own line. */
export function hiddenNotice(label: string): string {
  return `${HIDDEN_NOTICE}\n${showable(label)}`;
}
/** The last line of a card whose text is too long to send in full: it gets only ✗. */
export const TOO_LONG_LINE = "ארוך מדי להצגה; אפשר לקצר ולבקש שוב";
/** The hourly line while more items wait than may be carded at once (a count only). */
export function moreWaitingLine(n: number): string {
  return `${n} פריטים נוספים מחכים לאישור`;
}
export function hiddenLine(n: number): string {
  return `עוד ${n} תווים לא מוצגים`;
}

/** head lines, the item, tail lines; when the whole would pass CARD_MAX the item is cut and a line
 *  saying how many of its characters are not shown follows it. */
function fitCard(head: string[], item: string, tail: string[]): string {
  const full = [...head, item, ...tail].join("\n");
  if (!cardClips(head, item, tail)) return full;
  const fixed = [...head, ...tail].reduce((n, l) => n + l.length, 0) + head.length + tail.length + 1 + hiddenLine(item.length).length;
  let shown = item.slice(0, Math.max(0, CARD_MAX - fixed));
  const last = shown.charCodeAt(shown.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) shown = shown.slice(0, -1); // never split a surrogate pair
  const out = [...head, shown, hiddenLine(item.length - shown.length), ...tail].join("\n");
  return out.length <= CARD_MAX ? out : out.slice(0, CARD_MAX);
}
function cardClips(head: string[], item: string, tail: string[]): boolean {
  return [...head, item, ...tail].join("\n").length > CARD_MAX;
}

/** Text in parts of at most `max` characters, never splitting a surrogate pair. */
export function textParts(s: string, max = CARD_MAX): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(s.length, i + max);
    const last = s.charCodeAt(end - 1);
    if (end < s.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}
/** At most this many plain parts carry a clipped card's full text before the card. */
export const MAX_PARTS = 5;
/** At most this many cards wait unanswered at once. */
export const MAX_OUTSTANDING = 10;

// ---------------------------------------------------------------------------
// [AUTO] jobs: keyed by id, chat, text and once-or-repeat (never by the time)
// ---------------------------------------------------------------------------

type JobLike = Pick<Reminder, "id" | "chatId" | "text" | "repeat">;

export function isAutoJob(r: { text: unknown }): boolean {
  return typeof r.text === "string" && r.text.startsWith(AUTO_PREFIX);
}
export function jobKey(r: JobLike): string {
  return sha256(JSON.stringify([r.id, r.chatId, r.text, r.repeat ? "repeat" : "once"])).slice(0, 32);
}
export function isJobApproved(a: Approvals, r: JobLike): boolean {
  return a.jobs.approved.includes(jobKey(r));
}
export function isJobCarded(a: Approvals, key: string): boolean {
  return cardedKey(a.jobs.carded, key);
}
/** An [AUTO] job that is neither approved nor already carded (by its full key). */
export function jobNeedsCard(a: Approvals, r: JobLike): boolean {
  return isAutoJob(r) && !isJobApproved(a, r) && !isJobCarded(a, jobKey(r));
}

/** Ids the poller cards and logs: the store's own `r<n>` shape and anything as tame. A job whose
 *  id is not (a turn can write any id) gets no card, so it stays held. */
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export function cardableJob(r: JobLike): boolean {
  return typeof r.id === "string" && CARD_ID_RE.test(r.id);
}

/** A repeating key that passed less than this long ago is held (its schedule is at most daily). */
export const REPEAT_REPASS_S = 60 * 60;

/** The hold for popDue under AUTO_APPROVAL=1: an [AUTO] job is held unless its key is approved.
 *  An approved one-time key lets one job through per pop; its approval is used up when that job
 *  leaves the store, so its duplicates stay held until it is given again. An approved repeating key
 *  passes only when it has not passed in the last REPEAT_REPASS_S seconds, by `repeatPassedAt`,
 *  which the poller keeps for its lifetime (key -> time it last passed): a clone, or the job's own
 *  fire time rewound, cannot run it again within the hour. Without the map, one per pop. Approvals
 *  are read on first use, inside the reminders lock. `onHeld` says why: "waiting" (not approved)
 *  or "duplicate" (an approved key that already passed). */
export function approvalHold(
  path: string,
  onHeld?: (r: Reminder, key: string, why: "waiting" | "duplicate") => void,
  repeatPassedAt?: Map<string, number>,
  now: () => number = () => Math.floor(Date.now() / 1000),
): (r: Reminder) => boolean {
  let a: Approvals | null = null;
  const passed = new Set<string>();
  return (r) => {
    if (!isAutoJob(r)) return false;
    a ??= loadApprovals(path);
    const k = jobKey(r);
    const approved = a.jobs.approved.includes(k);
    const last = r.repeat && repeatPassedAt ? repeatPassedAt.get(k) : undefined;
    const recent = last !== undefined && now() - last < REPEAT_REPASS_S;
    if (approved && !passed.has(k) && !recent) {
      passed.add(k);
      if (r.repeat && repeatPassedAt) repeatPassedAt.set(k, now());
      return false;
    }
    onHeld?.(r, k, approved ? "duplicate" : "waiting");
    return true;
  };
}

export interface AjCallback { token: string; act: "y" | "n" }
export function parseAjCallback(data: string): AjCallback | null {
  const m = /^aj:([0-9a-f]{16}):(y|n)$/.exec(data ?? "");
  return m ? { token: m[1], act: m[2] as "y" | "n" } : null;
}

const BAD_SCHEDULE = "לוח זמנים לא תקין";
const DAY = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
const pad = (n: number) => String(n).padStart(2, "0");
const isInt = (n: unknown, lo: number, hi: number) => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
/** Total: a malformed schedule (a turn writes the store) renders as a fixed line, never throws. */
function scheduleLine(r: Pick<Reminder, "fireAt" | "repeat">): string {
  try {
    const rep: any = r.repeat;
    if (!rep) return Number.isFinite(r.fireAt) ? `פעם אחת, ${fmt(r.fireAt)}` : BAD_SCHEDULE;
    if (typeof rep !== "object" || !isInt(rep.hour, 0, 23) || !isInt(rep.minute, 0, 59)) return BAD_SCHEDULE;
    if (!Array.isArray(rep.days) || !rep.days.length || !rep.days.every((d: unknown) => isInt(d, 0, 6))) return BAD_SCHEDULE;
    const at = `${pad(rep.hour)}:${pad(rep.minute)}`;
    const days = [...new Set(rep.days as number[])].sort();
    if (days.length === 7) return `כל יום בשעה ${at}`;
    return `בימים ${days.map((d) => DAY[d]).join(" ")} בשעה ${at}`;
  } catch {
    return BAD_SCHEDULE;
  }
}

/** The card: a header line, the job's text (after the [AUTO] prefix) on its own line, then its
 *  schedule on its own line; at most CARD_MAX characters, saying how many are not shown. */
export function ajCardText(r: Pick<Reminder, "text" | "fireAt" | "repeat">, long = false): string {
  return fitCard(...ajCardParts(r, long));
}
function ajItem(r: Pick<Reminder, "text">): string {
  return showable(isAutoJob(r) ? r.text.slice(AUTO_PREFIX.length) : String(r.text));
}
function ajCardParts(r: Pick<Reminder, "text" | "fireAt" | "repeat">, long: boolean): [string[], string, string[]] {
  return [["משימה אוטומטית חדשה מחכה לאישור שלך"], ajItem(r), long ? [scheduleLine(r), TOO_LONG_LINE] : [scheduleLine(r)]];
}

/** ✓ and ✗; a card too long to show in full gets only ✗. */
export function ajKeyboard(token: string, long = false): unknown {
  const no = { text: "✗ מחק", callback_data: `aj:${token}:n` };
  return { inline_keyboard: [long ? [no] : [{ text: "✓ אשר", callback_data: `aj:${token}:y` }, no]] };
}

export type JobTapResult = { outcome: "stale" } | { outcome: "approve" | "remove"; r: Reminder };
/** A ✓/✗ on a job card, applied to `a` (call inside mutateApprovals). The token names one card and
 *  the exact key it showed; the tap applies only while a current [AUTO] job with the card's id still
 *  has that key. ✓ approves that key; ✗ forgets its cards and asks the caller to remove the job. */
export function applyJobTap(a: Approvals, list: Reminder[], tap: AjCallback): JobTapResult {
  const card = own(a.jobs.carded, tap.token);
  if (!card || card.kind !== "job") return { outcome: "stale" };
  const r = list.find((x) => x && x.id === card.id && isAutoJob(x) && jobKey(x) === card.key);
  if (!r) return { outcome: "stale" };
  if (tap.act === "y" && card.long) return { outcome: "stale" }; // its full text was never shown
  if (tap.act === "y") {
    addOnce(a.jobs.approved, card.key);
    return { outcome: "approve", r };
  }
  a.jobs.approved = without(a.jobs.approved, card.key);
  dropCards(a.jobs.carded, card.key);
  return { outcome: "remove", r };
}

/** A one-time job's approval is used up when the job leaves the store to run. Writes only when that
 *  approval is there, so with the gates off and no file nothing is ever written. */
export function consumeOnceApproval(path: string, r: Reminder): boolean {
  if (r.repeat || !isAutoJob(r)) return false;
  const k = jobKey(r);
  if (!loadApprovals(path).jobs.approved.includes(k)) return false;
  return mutateApprovals(path, (a) => {
    const had = a.jobs.approved.includes(k);
    a.jobs.approved = without(a.jobs.approved, k);
    dropCards(a.jobs.carded, k);
    return had;
  });
}

// ---------------------------------------------------------------------------
// Skills: keyed by name, description and the body file's text
// ---------------------------------------------------------------------------

/** The full sha-256 over the description and the file as two separate fields, so no text can move
 *  between them without changing the key. */
export function skillKey(name: string, description: string, fileText: string): string {
  return `${name}:${sha256(JSON.stringify([description, fileText]))}`;
}

/** The key of a skill as it is on disk now, or null when its body cannot be read safely (missing,
 *  a link, a FIFO, a bad name): such a skill is never approved. */
export function currentSkillKey(dir: string, row: Pick<SkillRow, "name" | "description" | "status">): { key: string; fileText: string } | null {
  try {
    const fileText = readNoFollow(skillBodyPath(dir, row));
    return { key: skillKey(row.name, String(row.description ?? ""), fileText), fileText };
  } catch {
    return null;
  }
}

/** True when the row's current key is approved (and not rejected). Given `fileText` (the bytes the
 *  caller already read and will serve), the key is taken from exactly those, never a second read. */
export function skillGate(a: Approvals, dir: string): (row: SkillRow, fileText?: string) => boolean {
  return (row, fileText) => {
    // Only a string is file text: Array.prototype.filter passes an index in that place.
    const key = typeof fileText === "string" ? skillKey(row.name, String(row.description ?? ""), fileText) : currentSkillKey(dir, row)?.key;
    return key !== undefined && a.skills.approved.includes(key) && !a.skills.rejected.includes(key);
  };
}

export function isSkillCarded(a: Approvals, key: string): boolean {
  return cardedKey(a.skills.carded, key);
}
export function skillNeedsCard(a: Approvals, key: string): boolean {
  return !a.skills.approved.includes(key) && !a.skills.rejected.includes(key) && !isSkillCarded(a, key);
}

export interface SkillEntry { row: SkillRow; key: string; fileText: string }
/** Every active or stale skill with its current key; one whose body cannot be read is left out. */
export function skillEntries(db: Database, dir: string): SkillEntry[] {
  const rows = [...listSkills(db, { status: "active" }), ...listSkills(db, { status: "stale" })];
  const out: SkillEntry[] = [];
  for (const row of rows) {
    const cur = currentSkillKey(dir, row);
    if (cur) out.push({ row, key: cur.key, fileText: cur.fileText });
  }
  return out;
}

export interface AsCallback { token: string; act: "y" | "n" }
export function parseAsCallback(data: string): AsCallback | null {
  const m = /^as:([0-9a-f]{16}):(y|n)$/.exec(data ?? "");
  return m ? { token: m[1], act: m[2] as "y" | "n" } : null;
}

/** The skill's body as `skill.ts view` shows it (after the frontmatter), or the whole file when it
 *  does not parse. */
export function skillBodyText(fileText: string): string {
  try {
    return parseSkillMd(fileText).body.replace(/\s+$/, "");
  } catch {
    return fileText;
  }
}

/** The card: a header line, then the name, the description and the body from its start, each
 *  starting on its own line; at most CARD_MAX characters, ending with how many are not shown when
 *  anything is cut. */
export function asCardText(name: string, description: string, body: string, long = false): string {
  return fitCard(...asCardParts(name, description, body, long));
}
function asCardParts(name: string, description: string, body: string, long: boolean): [string[], string, string[]] {
  return [["כישור חדש או שהשתנה מחכה לאישור שלך", showable(name)], `${showable(description)}\n${showable(body)}`, long ? [TOO_LONG_LINE] : []];
}

/** ✓ and ✗; a card too long to show in full gets only ✗. */
export function asKeyboard(token: string, long = false): unknown {
  const no = { text: "✗ דחה", callback_data: `as:${token}:n` };
  return { inline_keyboard: [long ? [no] : [{ text: "✓ אשר", callback_data: `as:${token}:y` }, no]] };
}

export type SkillTapResult = { outcome: "stale" } | { outcome: "approved" | "rejected"; name: string };
/** A ✓/✗ on a skill card, applied to `a` (call inside mutateApprovals). The token names one card
 *  and the exact key it showed; the tap applies only while an active or stale skill still has that
 *  key (an edited skill is stale). */
export function applySkillTap(a: Approvals, entries: Pick<SkillEntry, "row" | "key">[], tap: AsCallback): SkillTapResult {
  const card = own(a.skills.carded, tap.token);
  if (!card || card.kind !== "skill") return { outcome: "stale" };
  const e = entries.find((x) => x.key === card.key);
  if (!e) return { outcome: "stale" };
  if (tap.act === "y" && card.long) return { outcome: "stale" }; // its full text was never shown
  if (tap.act === "y") {
    addOnce(a.skills.approved, card.key);
    a.skills.rejected = without(a.skills.rejected, card.key);
    return { outcome: "approved", name: e.row.name };
  }
  addOnce(a.skills.rejected, card.key);
  a.skills.approved = without(a.skills.approved, card.key);
  return { outcome: "rejected", name: e.row.name };
}

// ---------------------------------------------------------------------------
// One round of cards (the poller's 30 s tick)
// ---------------------------------------------------------------------------

/** Forget what no longer matches anything: job approvals that match no current [AUTO] job, skill
 *  approvals that match no current skill (rejections stay), and cards whose item is gone or already
 *  answered. A null list (its gate off) is left alone. True when anything changed. */
export function pruneApprovals(a: Approvals, jobs: Reminder[] | null, skills: Pick<SkillEntry, "key">[] | null): boolean {
  let changed = false;
  if (jobs) {
    const live = jobs.filter((r) => r && isAutoJob(r));
    const keys = new Set(live.map((r) => jobKey(r)));
    const kept = a.jobs.approved.filter((k) => keys.has(k));
    if (kept.length !== a.jobs.approved.length) {
      a.jobs.approved = kept;
      changed = true;
    }
    for (const [t, c] of Object.entries(a.jobs.carded)) {
      const present = live.some((r) => r.id === c.id && jobKey(r) === c.key);
      if (!present || a.jobs.approved.includes(c.key)) {
        delete a.jobs.carded[t];
        changed = true;
      }
    }
  }
  if (skills) {
    const keys = new Set(skills.map((e) => e.key));
    const kept = a.skills.approved.filter((k) => keys.has(k));
    if (kept.length !== a.skills.approved.length) {
      a.skills.approved = kept;
      changed = true;
    }
    for (const [t, c] of Object.entries(a.skills.carded)) {
      if (!keys.has(c.key) || a.skills.approved.includes(c.key) || a.skills.rejected.includes(c.key)) {
        delete a.skills.carded[t];
        changed = true;
      }
    }
  }
  return changed;
}

/** Cards sent and not yet answered (nor pruned). */
export function outstandingCards(a: Approvals): number {
  const jobs = Object.values(a.jobs.carded).filter((c) => !a.jobs.approved.includes(c.key)).length;
  const skills = Object.values(a.skills.carded).filter((c) => !a.skills.approved.includes(c.key) && !a.skills.rejected.includes(c.key)).length;
  return jobs + skills;
}

/** What the poller keeps between rounds: which held items were logged and noticed (once per key),
 *  when hidden-item notices went out (at most MAX_OUTSTANDING an hour), and when the hourly
 *  "more waiting" line last went out. */
export interface CardState {
  hiddenLogged: Set<string>;
  hiddenNoticed: Set<string>;
  hiddenSentAt: number[];
  moreAt: number;
}
export function newCardState(): CardState {
  return { hiddenLogged: new Set(), hiddenNoticed: new Set(), hiddenSentAt: [], moreAt: -Infinity };
}

export interface CardRound {
  path: string;
  /** Current reminders, or null when the job gate is off. */
  jobs: Reminder[] | null;
  /** Current skills, or null when the skill gate is off. */
  skills: SkillEntry[] | null;
  /** `keyboard` undefined: a plain message (a part of a long text, a notice). */
  send: (text: string, keyboard: unknown) => Promise<unknown>;
  now: () => number;
  log: (line: string) => void;
  /** Failures already logged, by item, so each is logged at most once an hour. */
  failLogged: Map<string, number>;
  cap?: number;
  token?: () => string;
  /** False when the reminders store was not read cleanly (corrupt, a link, not a list): its empty
   *  list must not prune every job approval. Default true. */
  jobsClean?: boolean;
  state?: CardState;
}

/** A name or id a turn chose, as a log line may show it. */
const shownId = (s: unknown) => (typeof s === "string" && CARD_ID_RE.test(s) ? s : JSON.stringify(String(s).slice(0, 40)));

/** Prune, then send a card for each item that needs one, at most `cap` per round and while fewer
 *  than MAX_OUTSTANDING cards wait unanswered (beyond that, one count line an hour), recording each
 *  card only after its send succeeded. An item holding hidden characters is never carded: it is
 *  logged and noticed once per key. A clipped card's full text goes first in plain parts; past
 *  MAX_PARTS parts the card gets only ✗. One item that fails is logged and skipped. Nothing is sent
 *  while the approvals file cannot be read. */
export async function sendCardRound(d: CardRound): Promise<{ sent: number; unreadable: boolean }> {
  const first = readApprovals(d.path);
  if (!first.ok) return { sent: 0, unreadable: true };
  let a = first.a;
  const cap = d.cap ?? 5;
  const token = d.token ?? newCardToken;
  const st = d.state ?? newCardState();
  const fail = (item: string, e: any) => {
    const t = d.now();
    if (t - (d.failLogged.get(item) ?? -Infinity) < 3600) return;
    d.failLogged.set(item, t);
    d.log(`[ERR] approval card ${item}: ${e?.message ?? e}`);
  };
  const pruneJobs = d.jobsClean === false ? null : d.jobs;
  if (pruneApprovals(structuredClone(a), pruneJobs, d.skills)) {
    try {
      a = mutateApprovals(d.path, (x) => {
        pruneApprovals(x, pruneJobs, d.skills);
        return x;
      });
    } catch (e: any) {
      fail("prune", e);
      return { sent: 0, unreadable: true };
    }
  }
  let outstanding = outstandingCards(a);
  let sent = 0;
  let waiting = 0;
  const held = async (id: string, line: string, label: string) => {
    if (!st.hiddenLogged.has(id)) {
      st.hiddenLogged.add(id);
      d.log(line);
    }
    if (st.hiddenNoticed.has(id)) return;
    const t = d.now();
    st.hiddenSentAt = st.hiddenSentAt.filter((x) => t - x < 3600);
    if (st.hiddenSentAt.length >= MAX_OUTSTANDING) return;
    await d.send(hiddenNotice(label), undefined);
    // marked only once sent: a failed send is tried again next round
    st.hiddenNoticed.add(id);
    st.hiddenSentAt.push(t);
  };
  /** The full text in plain parts before a clipped card; false when it needs more than MAX_PARTS. */
  const sendParts = async (clipped: boolean, item: string): Promise<boolean> => {
    if (!clipped) return true;
    const parts = textParts(item);
    if (parts.length > MAX_PARTS) return false;
    for (const p of parts) await d.send(p, undefined);
    return true;
  };
  for (const r of d.jobs ?? []) {
    if (sent >= cap) break;
    let item = "job ?";
    try {
      if (!jobNeedsCard(a, r) || !cardableJob(r)) continue;
      const key = jobKey(r);
      item = `job ${r.id} ${key.slice(0, 8)}`;
      if (hasHidden(r.text)) {
        await held(`job:${key}`, `[AUTO] held ${r.id} (hidden characters)`, r.id);
        continue;
      }
      if (outstanding >= MAX_OUTSTANDING) {
        waiting++;
        continue;
      }
      const parts = ajCardParts(r, false);
      const long = !(await sendParts(cardClips(...parts), parts[1]));
      const t = token();
      await d.send(ajCardText(r, long), ajKeyboard(t, long));
      a = mutateApprovals(d.path, (x) => {
        x.jobs.carded[t] = long ? { kind: "job", key, id: r.id, at: d.now(), long: true } : { kind: "job", key, id: r.id, at: d.now() };
        return x;
      });
      sent++;
      outstanding++;
      d.log(`[APPROVALS] carded job ${r.id}`);
    } catch (e: any) {
      fail(item, e);
    }
  }
  for (const e of d.skills ?? []) {
    if (sent >= cap) break;
    let item = "skill ?";
    try {
      item = `skill ${shownId(e.row.name)} ${e.key.slice(e.key.lastIndexOf(":") + 1, e.key.lastIndexOf(":") + 9)}`;
      if (!skillNeedsCard(a, e.key)) continue;
      const description = String(e.row.description ?? "");
      if (hasHidden(e.row.name) || hasHidden(description) || hasHidden(e.fileText)) {
        await held(`skill:${e.key}`, `[SKILL] held ${shownId(e.row.name)} (hidden characters)`, shownId(e.row.name));
        continue;
      }
      if (outstanding >= MAX_OUTSTANDING) {
        waiting++;
        continue;
      }
      const body = skillBodyText(e.fileText);
      const parts = asCardParts(e.row.name, description, body, false);
      const long = !(await sendParts(cardClips(...parts), parts[1]));
      const t = token();
      await d.send(asCardText(e.row.name, description, body, long), asKeyboard(t, long));
      a = mutateApprovals(d.path, (x) => {
        x.skills.carded[t] = long ? { kind: "skill", key: e.key, at: d.now(), long: true } : { kind: "skill", key: e.key, at: d.now() };
        return x;
      });
      sent++;
      outstanding++;
      d.log(`[APPROVALS] carded skill ${shownId(e.row.name)}`);
    } catch (err: any) {
      fail(item, err);
    }
  }
  if (waiting > 0 && d.now() - st.moreAt >= 3600) {
    st.moreAt = d.now();
    try {
      await d.send(moreWaitingLine(waiting), undefined);
    } catch (e: any) {
      fail("more-waiting", e);
    }
  }
  return { sent, unreadable: false };
}

// ---------------------------------------------------------------------------
// Seeding at rollout, and the CLI
// ---------------------------------------------------------------------------

/** One line per current item, as `list` prints it and `seed --expect` reads it: `job <key>` for
 *  each [AUTO] job, `skill <key>` for each active or stale skill; sorted. */
export function keyLines(reminders: Reminder[], skills: Array<{ name: string; description: string; fileText: string }>): string[] {
  return [
    ...reminders.filter((r) => r && isAutoJob(r)).map((r) => `job ${jobKey(r)}`),
    ...skills.map((s) => `skill ${skillKey(s.name, s.description, s.fileText)}`),
  ].sort();
}

/** The expected-keys file: one key line per line, blank lines ignored, sorted. */
export function parseKeyLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).sort();
}

export type SeedResult = { ok: true; jobs: string[]; skills: string[]; hidden: number } | { ok: false; missing: number; unexpected: number };

type PlainSkill = { name: string; description: string; fileText: string };
const jobHidden = (r: Reminder) => hasHidden(r.text) || hasHidden(String(r.id)) || hasHidden(String(r.chatId));
const skillHidden = (s: PlainSkill) => hasHidden(s.name) || hasHidden(s.description) || hasHidden(s.fileText);

/** Approve exactly the current [AUTO] jobs and the given skills, but only when their key lines equal
 *  `expected` (the list the owner compared with his record), item for item; otherwise nothing is
 *  written. An item holding hidden characters is left unapproved (it then stays held and gets the
 *  hidden-item notice, as any new one would); `hidden` counts them. The approvals file is replaced
 *  by a fresh one, never merged into what is there (a file a turn may have shaped earlier). Returns
 *  what it approved (job ids, skill names). */
export function seedApprovals(path: string, reminders: Reminder[], skills: PlainSkill[], expected: string[]): SeedResult {
  const have = keyLines(reminders, skills);
  const want = [...expected].sort();
  const same = have.length === want.length && have.every((k, i) => k === want[i]);
  if (!same) {
    const rest = [...want];
    let unexpected = 0;
    for (const k of have) {
      const i = rest.indexOf(k);
      if (i >= 0) rest.splice(i, 1);
      else unexpected++;
    }
    return { ok: false, missing: rest.length, unexpected };
  }
  const allJobs = reminders.filter((r) => r && isAutoJob(r));
  const jobs = allJobs.filter((r) => !jobHidden(r));
  const clean = skills.filter((s) => !skillHidden(s));
  const a = emptyApprovals();
  for (const r of jobs) addOnce(a.jobs.approved, jobKey(r));
  for (const s of clean) addOnce(a.skills.approved, skillKey(s.name, s.description, s.fileText));
  withFileLock(path, () => writeAtomic(path, JSON.stringify(a, null, 2) + "\n"));
  return { ok: true, jobs: jobs.map((r) => r.id), skills: clean.map((s) => s.name), hidden: allJobs.length - jobs.length + skills.length - clean.length };
}

/** `list`'s lines: per item its key line, then (a job) its id, chat, once-or-repeat, state and full
 *  text, or (a skill) its name, description, the sha256 of its body and state; texts as JSON strings,
 *  so a newline in them cannot fake a line, and through showable(), so nothing on the screen is
 *  invisible; an item holding hidden characters is marked "(hidden characters)". */
export function listLines(a: Approvals, reminders: Reminder[], skills: SkillEntry[]): string[] {
  const out: string[] = [];
  const mark = (hidden: boolean) => (hidden ? " (hidden characters)" : "");
  const jobs = reminders.filter((r) => r && isAutoJob(r));
  out.push(`[AUTO] jobs (${jobs.length}):`);
  for (const r of jobs) {
    const k = jobKey(r);
    const state = isJobApproved(a, r) ? "approved" : isJobCarded(a, k) ? "waiting (carded)" : "waiting";
    out.push(`job ${k}`);
    out.push(`  id ${showable(JSON.stringify(r.id))}, chat ${showable(JSON.stringify(r.chatId))}, ${r.repeat ? "repeat" : "once"}, ${state}${mark(jobHidden(r))}`);
    out.push(`  text ${showable(JSON.stringify(r.text.slice(AUTO_PREFIX.length)))}`);
  }
  out.push(`skills (${skills.length}):`);
  for (const e of skills) {
    const state = a.skills.approved.includes(e.key) ? "approved" : a.skills.rejected.includes(e.key) ? "rejected" : isSkillCarded(a, e.key) ? "waiting (carded)" : "waiting";
    const description = String(e.row.description ?? "");
    out.push(`skill ${showable(e.key)}`);
    out.push(`  name ${showable(JSON.stringify(e.row.name))}, ${state}${mark(skillHidden({ name: e.row.name, description, fileText: e.fileText }))}`);
    out.push(`  description ${showable(JSON.stringify(description))}`);
    out.push(`  body sha256 ${sha256(skillBodyText(e.fileText))}`);
  }
  return out;
}

const flag = (args: string[], name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const path = approvalsPath();
  const dir = sharedPath("skills");
  const store = () => loadStore();
  const skillsNow = () => skillEntries(getDb(), dir);
  const plain = (es: SkillEntry[]) => es.map((e) => ({ name: e.row.name, description: String(e.row.description ?? ""), fileText: e.fileText }));
  if (cmd === "seed") {
    const file = flag(args, "--expect");
    if (!file) {
      console.error("usage: approvals.ts seed --expect <file of key lines, as list --keys wrote it>");
      process.exit(1);
    }
    let expected: string[];
    try {
      expected = parseKeyLines(readNoFollow(file, MAX_BYTES));
    } catch (e: any) {
      console.error(`REFUSED: cannot read ${file}: ${e?.code ?? e?.message ?? e}`);
      process.exit(1);
    }
    const out = seedApprovals(path, store(), plain(skillsNow()), expected);
    if (!out.ok) {
      console.error(`REFUSED: the store differs from ${file} (${out.missing} expected items missing, ${out.unexpected} not expected); nothing written`);
      process.exit(1);
    }
    console.log(`approved ${out.jobs.length} [AUTO] job(s): ${out.jobs.join(", ") || "none"}`);
    console.log(`approved ${out.skills.length} skill(s): ${out.skills.map((n) => shownId(n)).join(", ") || "none"}`);
    console.log(`left ${out.hidden} item(s) with hidden characters unapproved (they stay held; each gets the hidden-item notice)`);
    return;
  }
  if (cmd === "list") {
    // One snapshot for both the printed list and the keys file, so the owner reads what seed checks.
    const reminders = store();
    const entries = skillsNow();
    for (const l of listLines(loadApprovals(path), reminders, entries)) console.log(l);
    const keysFile = flag(args, "--keys");
    if (keysFile) {
      writeAtomic(keysFile, keyLines(reminders, plain(entries)).join("\n") + "\n");
      console.log(`key lines written to ${keysFile}`);
    }
    return;
  }
  console.error("usage: approvals.ts list [--keys <file>] | seed --expect <file>");
  process.exit(1);
}

if (import.meta.main) main();
