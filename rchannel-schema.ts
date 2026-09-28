/**
 * rchannel-schema.ts — the routine channel's wire format (version 1) and its limits, shared by
 * the server (rchannel.ts) and the PC (scripts/rchannel-pc.ts) so both sides refuse the same
 * things. Pure: no imports, no I/O. Spec: docs/superpowers/specs/2026-09-27-routine-channel-design.md.
 *
 * A request is one file a routine leaves in the PC's outbox: a plain notice, or cards the owner
 * answers one at a time. The PC's sync task carries requests, acks, results and closes to the
 * server in one payload and takes answers back in the reply.
 */

export const LIMITS = {
  title: 60,
  text: 1000,
  cards: 30,
  key: 300,
  heading: 100,
  body: 600,
  note: 40,
  detail: 80,
} as const;

/** Over this many bytes a sync payload is refused unread. */
export const PAYLOAD_MAX_BYTES = 1_000_000;
/** The most answers one sync reply carries: the server hands back no more, and the PC refuses more. */
export const REPLY_ANSWERS_MAX = 1000;

export type RequestKind = "cards" | "notice";

export interface RcCard {
  key: string; // what the routine's handler finds the item by; never shown
  heading: string;
  body: string;
  note?: string;
}

export interface RcRequest {
  v: 1;
  id: string;
  routine: string;
  title: string;
  kind: RequestKind;
  text: string;
  supersedes: boolean;
  cards: RcCard[];
}

export type Verdict = "approve" | "reject" | "correct";
export type Outcome = "approved" | "rejected" | "corrected" | "already" | "refused" | "failed";

/** One tap, as the server hands it to the PC. `text` only with verdict "correct". */
export interface RcAnswer {
  id: string;
  request: string;
  card: string;
  verdict: Verdict;
  text?: string;
}
export interface RcResult {
  request: string;
  card: string;
  outcome: Outcome;
  detail?: string;
}
export interface RcClose {
  request: string;
  card: string;
}
export interface SyncPayload {
  v: 1;
  requests: RcRequest[];
  acks: string[];
  results: RcResult[];
  closes: RcClose[];
}
export interface SyncReply {
  v: 1;
  received: string[];
  answers: RcAnswer[];
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

export const REQUEST_ID_RE = /^[a-z0-9-]{1,60}$/;
export const ROUTINE_RE = /^[a-z0-9-]{1,40}$/;
export const ANSWER_ID_RE = /^[a-z0-9-]{1,40}$/;
const VERDICTS: readonly string[] = ["approve", "reject", "correct"];
const OUTCOMES: readonly string[] = ["approved", "rejected", "corrected", "already", "refused", "failed"];

// C0 and C1 controls and DEL (a newline is allowed only in multi-line fields), the bidi marks,
// embeddings and isolates (one in the text switches off the poller's own isolation, bidi.ts), and
// a lone surrogate (Telegram refuses the message). Built from code points, as in bidi.ts, so no
// invisible character or escape of one appears in this file.
const chars = (...ranges: [number, number][]) =>
  ranges.map(([a, b]) => (a === b ? String.fromCharCode(a) : `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)).join("");
const CONTROL_RE = new RegExp(`[${chars([0x00, 0x1f], [0x7f, 0x9f])}]`);
const CONTROL_BUT_NEWLINE_RE = new RegExp(`[${chars([0x00, 0x09], [0x0b, 0x1f], [0x7f, 0x9f])}]`);
const BIDI_RE = new RegExp(`[${chars([0x061c, 0x061c], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069])}]`);
const HIGH = chars([0xd800, 0xdbff]);
const LOW = chars([0xdc00, 0xdfff]);
const LONE_SURROGATE_RE = new RegExp(`[${HIGH}](?![${LOW}])|(?<![${HIGH}])[${LOW}]`);
// Invisible format characters (Unicode tag characters, zero-width marks, a soft hyphen) and variation
// selectors: the phone shows nothing for them, so they could hide words from the owner that a turn
// still reads. Written as property escapes, so no such character appears in this file either.
const FORMAT_RE = /[\p{Cf}\p{Variation_Selector}]/u;

/** A reason the value cannot be this field, or null when it can. */
export function checkText(v: unknown, field: string, max: number, min: number, multiline: boolean): string | null {
  if (typeof v !== "string") return `${field} must be text`;
  if (v.trim().length < min) return `${field} is empty`;
  if (v.length > max) return `${field} is over ${max} characters`;
  if ((multiline ? CONTROL_BUT_NEWLINE_RE : CONTROL_RE).test(v)) return `${field} holds a control character`;
  if (BIDI_RE.test(v)) return `${field} holds a direction mark`;
  if (FORMAT_RE.test(v)) return `${field} holds an invisible character`;
  if (LONE_SURROGATE_RE.test(v)) return `${field} holds a broken character`;
  return null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bad = <T>(reason: string): Checked<T> => ({ ok: false, reason });

/** The one gate a request passes on the PC (before it leaves) and on the server (before it is
 *  stored). Only the known fields are copied into the result. */
export function validateRequest(raw: unknown): Checked<RcRequest> {
  if (!isObject(raw)) return bad("the request is not a JSON object");
  if (raw.v !== 1) return bad("v must be 1");
  if (typeof raw.id !== "string" || !REQUEST_ID_RE.test(raw.id)) return bad("id must be 1 to 60 of a-z, 0-9 and -");
  const id = raw.id;
  if (typeof raw.routine !== "string" || !ROUTINE_RE.test(raw.routine)) return bad(`${id}: routine must be 1 to 40 of a-z, 0-9 and -`);
  if (raw.kind !== "cards" && raw.kind !== "notice") return bad(`${id}: kind must be cards or notice`);
  const kind = raw.kind;
  const text = raw.text ?? "";
  const e =
    checkText(raw.title, "title", LIMITS.title, 1, false) ??
    checkText(text, "text", LIMITS.text, kind === "notice" ? 1 : 0, true);
  if (e) return bad(`${id}: ${e}`);
  if (raw.supersedes !== undefined && typeof raw.supersedes !== "boolean") return bad(`${id}: supersedes must be true or false`);
  const list = raw.cards ?? [];
  if (!Array.isArray(list)) return bad(`${id}: cards must be a list`);
  if (kind === "notice" && list.length) return bad(`${id}: a notice has no cards`);
  if (kind === "cards" && (list.length < 1 || list.length > LIMITS.cards)) return bad(`${id}: a cards request has 1 to ${LIMITS.cards} cards`);
  const cards: RcCard[] = [];
  const keys = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const at = `${id}: card ${i + 1}`;
    if (!isObject(c)) return bad(`${at} is not a JSON object`);
    const ce =
      checkText(c.key, `${at} key`, LIMITS.key, 1, false) ??
      checkText(c.heading, `${at} heading`, LIMITS.heading, 1, false) ??
      checkText(c.body, `${at} body`, LIMITS.body, 1, true) ??
      (c.note === undefined ? null : checkText(c.note, `${at} note`, LIMITS.note, 0, false));
    if (ce) return bad(ce);
    const key = c.key as string;
    if (keys.has(key)) return bad(`${at} repeats a key`);
    keys.add(key);
    const card: RcCard = { key, heading: c.heading as string, body: c.body as string };
    if (typeof c.note === "string" && c.note.trim()) card.note = c.note;
    cards.push(card);
  }
  return {
    ok: true,
    value: { v: 1, id, routine: raw.routine, title: raw.title as string, kind, text: text as string, supersedes: raw.supersedes === true, cards },
  };
}

function checkPair(o: unknown, what: string): string | null {
  if (!isObject(o)) return `${what} is not a JSON object`;
  if (typeof o.request !== "string" || !REQUEST_ID_RE.test(o.request)) return `${what}: bad request id`;
  return checkText(o.card, `${what} card`, LIMITS.key, 1, false);
}

/** The server's gate for a whole payload: any bad part refuses all of it, so a half-applied sync
 *  never happens. */
export function validatePayload(raw: unknown): Checked<SyncPayload> {
  if (!isObject(raw)) return bad("the payload is not a JSON object");
  if (raw.v !== 1) return bad("v must be 1");
  const lists: Record<string, unknown[]> = {};
  for (const [name, cap] of [["requests", 50], ["acks", 1000], ["results", 1000], ["closes", 1000]] as const) {
    const v = raw[name] ?? [];
    if (!Array.isArray(v)) return bad(`${name} must be a list`);
    if (v.length > cap) return bad(`${name} holds more than ${cap}`);
    lists[name] = v;
  }
  const requests: RcRequest[] = [];
  for (const r of lists.requests) {
    const c = validateRequest(r);
    if (!c.ok) return bad(c.reason);
    requests.push(c.value);
  }
  for (const a of lists.acks) if (typeof a !== "string" || !ANSWER_ID_RE.test(a)) return bad("an ack is not an answer id");
  const results: RcResult[] = [];
  for (const [i, r] of lists.results.entries()) {
    const e = checkPair(r, `result ${i + 1}`);
    if (e) return bad(e);
    const o = r as Record<string, unknown>;
    if (typeof o.outcome !== "string" || !OUTCOMES.includes(o.outcome)) return bad(`result ${i + 1}: bad outcome`);
    if (o.detail !== undefined) {
      const de = checkText(o.detail, `result ${i + 1} detail`, LIMITS.detail, 0, false);
      if (de) return bad(de);
    }
    results.push({
      request: o.request as string,
      card: o.card as string,
      outcome: o.outcome as Outcome,
      ...(typeof o.detail === "string" && o.detail ? { detail: o.detail } : {}),
    });
  }
  const closes: RcClose[] = [];
  for (const [i, c] of lists.closes.entries()) {
    const e = checkPair(c, `close ${i + 1}`);
    if (e) return bad(e);
    const o = c as Record<string, unknown>;
    closes.push({ request: o.request as string, card: o.card as string });
  }
  return { ok: true, value: { v: 1, requests, acks: lists.acks as string[], results, closes } };
}

/** The PC's gate for the server's reply: the answers are untrusted input to a handler. */
export function validateReply(raw: unknown): Checked<SyncReply> {
  if (!isObject(raw)) return bad("the reply is not a JSON object");
  if (raw.v !== 1) return bad("v must be 1");
  if (!Array.isArray(raw.received) || !raw.received.every((x) => typeof x === "string" && REQUEST_ID_RE.test(x))) {
    return bad("received must be a list of request ids");
  }
  if (!Array.isArray(raw.answers)) return bad("answers must be a list");
  if (raw.answers.length > REPLY_ANSWERS_MAX) return bad(`answers holds more than ${REPLY_ANSWERS_MAX}`);
  const answers: RcAnswer[] = [];
  for (const [i, a] of raw.answers.entries()) {
    const e = checkPair(a, `answer ${i + 1}`);
    if (e) return bad(e);
    const o = a as Record<string, unknown>;
    if (typeof o.id !== "string" || !ANSWER_ID_RE.test(o.id)) return bad(`answer ${i + 1}: bad id`);
    if (typeof o.verdict !== "string" || !VERDICTS.includes(o.verdict)) return bad(`answer ${i + 1}: bad verdict`);
    if (o.verdict === "correct") {
      const te = checkText(o.text, `answer ${i + 1} text`, LIMITS.body, 1, false);
      if (te) return bad(te);
    } else if (o.text !== undefined) {
      return bad(`answer ${i + 1}: only a correction carries text`);
    }
    answers.push({
      id: o.id,
      request: o.request as string,
      card: o.card as string,
      verdict: o.verdict as Verdict,
      ...(o.verdict === "correct" ? { text: o.text as string } : {}),
    });
  }
  return { ok: true, value: { v: 1, received: raw.received as string[], answers } };
}
