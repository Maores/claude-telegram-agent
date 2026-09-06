/**
 * usage.ts — the bot's own claude -p usage tracking (agenda #5).
 *
 * claude -p reports total_cost_usd + token counts on its result event; the bot
 * used to discard them. We record each call into the `usage_log` table and use
 * the rolling-window spend to ping Maor when the bot has been burning a lot
 * lately (a self-set, data-grounded PROXY — the real subscription quota is not
 * queryable). We also classify a usage-limit failure so the chat gets a clear
 * message instead of a generic error.
 *
 * All pure / db-only — no Telegram IO here (the poller does the ping). Every
 * caller wraps these so a usage hiccup can never break the reply.
 */
import { Database } from "bun:sqlite";

export interface UsageRow {
  ts: number; // unix seconds
  chatId: number;
  model: string; // 'sonnet' | 'opus' | …
  kind: string; // 'interactive' | 'auto'
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** Insert one usage record. Caller wraps in try/catch — never throws into the reply path. */
export function recordUsage(db: Database, row: UsageRow): void {
  db.query(
    `INSERT INTO usage_log (ts, chat_id, model, kind, cost_usd, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.ts,
    String(row.chatId),
    row.model,
    row.kind,
    row.costUsd,
    row.inputTokens,
    row.outputTokens,
  );
}

/** Sum cost_usd over [sinceTs, now]; NULL costs are ignored. Returns dollars. */
export function windowSpendUsd(db: Database, sinceTs: number): number {
  const r = db
    .query(`SELECT COALESCE(SUM(cost_usd), 0) AS s FROM usage_log WHERE ts >= ?`)
    .get(sinceTs) as { s: number } | undefined;
  return r?.s ?? 0;
}

/**
 * Edge-detected threshold check. Fires ONCE when the rolling spend crosses the
 * threshold upward; re-arms only after it drops back below — so no spam. The
 * caller holds `armed` (in-memory, resets on restart, like the review cooldown).
 */
export function shouldWarn(
  spendUsd: number,
  thresholdUsd: number,
  armed: boolean,
): { warn: boolean; armed: boolean } {
  if (spendUsd >= thresholdUsd) {
    return armed ? { warn: true, armed: false } : { warn: false, armed: false };
  }
  return { warn: false, armed: true }; // below threshold → re-arm for the next crossing
}

// Conservative limit-hit patterns. NOTE: the exact claude -p limit-hit stderr
// wording is UNVERIFIED — keep this list narrow so we err toward the generic
// error rather than falsely claiming a limit. Revisit once a real limit-hit is
// observed (or the paused Anthropic billing change documents it).
const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /\bquota\b/i,
  /too many requests/i,
  /limit reached/i,
  /limit exceeded/i,
  /exceeded your .*limit/i,
  /\b429\b/,
];

/** Does this stderr/error text look like a usage/rate-limit failure? */
export function isLimitHitStderr(s: string | undefined | null): boolean {
  if (!s) return false;
  return LIMIT_PATTERNS.some((re) => re.test(s));
}

/** Best-effort: pull a human retry hint from the error text, or null. */
export function parseRetryAfter(s: string | undefined | null): string | null {
  if (!s) return null;
  // Unit alternatives are ordered LONGEST-first so "2 hours" captures "hours", not "h".
  const UNIT = "(?:seconds|minutes|hours|sec|min|hrs|hr|h|m|s)";
  const patterns = [
    new RegExp(`retry after\\s+([0-9]+\\s*${UNIT}?)`, "i"),
    new RegExp(`try again in\\s+([0-9]+\\s*${UNIT})`, "i"),
    /resets?\s+(?:at|in)\s+([0-9:apm\s.]+(?:hours|minutes|min|hrs)?)/i,
    /available again (?:at|in)\s+([0-9:apm\s.]+)/i,
    // The CLI's own limit line drops the preposition: "resets 4:40am (Asia/Jerusalem)".
    /resets?\s+([0-9][0-9:.]*\s*(?:am|pm)?)/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

/**
 * The Hebrew chat message for a usage-limit failure, or null if the error isn't
 * a limit hit (caller falls back to the generic error). Plain Hebrew, no LTR
 * tokens that would trip the bidi rule.
 */
export function limitHitReply(errText: string | undefined | null): string | null {
  if (!isLimitHitStderr(errText)) return null;
  const hint = parseRetryAfter(errText);
  const base = "נראה שהגעת למגבלת השימוש כרגע.";
  return hint ? `${base} אפשר לנסות שוב בעוד ${hint}.` : `${base} נסה שוב מאוחר יותר.`;
}

// ---------------------------------------------------------------------------
// Upstream API errors that arrive as the ANSWER rather than as a thrown error.
//
// Live incident 2026-07-29 23:25-23:40: the CLI answered three turns with
// "API Error: 529 Overloaded". Because a reply was produced, the poller counted
// each turn as a success — no [ERR] line, [MSG] and [DONE] perfectly balanced,
// and Maor received a raw English error in the middle of a Hebrew conversation.
// Every monitoring signal reported green. Hence this check on the ANSWER.
// ---------------------------------------------------------------------------

export type UpstreamKind = "overloaded" | "auth" | "server" | "limit";
export interface UpstreamError { kind: UpstreamKind; retryable: boolean }

/** How much of a reply may surround the signature before we assume the model is
 *  merely *discussing* an error instead of having hit one. The real failures are
 *  short and consist of nothing else. */
const MAX_ERROR_REPLY_CHARS = 300;

export function detectUpstreamError(answer: string | undefined | null): UpstreamError | null {
  const text = (answer ?? "").trim();
  if (!text || text.length > MAX_ERROR_REPLY_CHARS) return null;
  // The CLI announces an exhausted subscription window in plain English with no
  // "API Error" prefix and no status URL. On 2026-09-06 at 03:55 it answered a
  // turn with "You've hit your session limit · resets 4:40am (Asia/Jerusalem)" and
  // the shape check below passed it through as an ordinary reply, so Maor got the
  // raw English line and his question was never answered. English wording only,
  // so a Hebrew answer discussing limits is left alone.
  const isLimit =
    /\b(?:hit your|reached)\s+(?:\w+\s+){0,2}(?:session|usage|message)\s+limit\b/i.test(text) ||
    /\b(?:session|usage) limit (?:reached|exceeded)\b/i.test(text);
  // Never retried: a limit resets on the clock, so the 8-second retry would only
  // spend another call to be refused again.
  if (isLimit) return { kind: "limit", retryable: false };

  // Require the API-error shape, not a bare status number: a short reply could
  // legitimately mention 529 while explaining something.
  const hasShape = /\bAPI Error\b|overloaded_error|status\.claude\.com|Failed to authenticate/i.test(text);
  if (!hasShape) return null;

  if (/\b529\b|overloaded/i.test(text)) return { kind: "overloaded", retryable: true };
  if (/\b401\b|invalid authentication|unauthorized|Failed to authenticate/i.test(text)) {
    return { kind: "auth", retryable: false };
  }
  if (/\b5\d\d\b/.test(text)) return { kind: "server", retryable: true };
  return null;
}

/** What Maor sees instead of the raw error. Plain Hebrew, no LTR tokens, per the
 *  bidi rule in CLAUDE.md. */
export function upstreamErrorReply(e: UpstreamError, raw?: string | null): string {
  if (e.kind === "limit") {
    const hint = parseRetryAfter(raw);
    const base = "הגעתי למגבלת השימוש כרגע ולכן לא הצלחתי לענות.";
    // The reset time is an LTR token, so it goes on its own line per the bidi rule.
    return hint
      ? `${base} אפשר לשלוח שוב אחרי האיפוס, שנקבע לשעה:\n${hint}`
      : `${base} אפשר לנסות שוב מאוחר יותר.`;
  }
  if (e.kind === "auth") {
    return "יש בעיית התחברות אצלי לשרת, וזה משהו שצריך טיפול ידני. שווה לבדוק את הטוקן.";
  }
  if (e.kind === "overloaded") {
    return "השרת של המודל עמוס כרגע וזאת תקלה זמנית שלו, לא שלך. ניסיתי שוב ולא הסתדר. כדאי לשלוח לי את זה עוד רגע.";
  }
  return "השרת של המודל מחזיר שגיאה זמנית. ניסיתי שוב ולא הסתדר, אפשר לנסות עוד רגע.";
}
