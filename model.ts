/**
 * model.ts — cheap model routing, no extra LLM call.
 *
 * Default to a fast model (Sonnet); escalate to Opus only on an explicit trigger
 * or a clear signal. Deliberately NOT an LLM classifier: a per-message routing
 * call would re-pay the `claude -p` startup/connector-init cost on every message,
 * which would dominate the latency we're trying to save.
 */

export type Model = "sonnet" | "opus";

export interface Routed {
  model: Model;
  prompt: string; // message with any /command prefix removed
}

const OPUS_KEYWORDS = ["think hard", "use opus", "ultrathink", "deep dive", "reason carefully"];
const OPUS_PREFIX = /^\/opus\b[ \t]*/i;
const SONNET_PREFIX = /^\/sonnet\b[ \t]*/i;
// "/opus" is often appended at the END of a message; a prefix-only match
// silently ran those on the fast model, so the token escalates from anywhere.
const OPUS_TOKEN = /(^|\s)\/opus\b[ \t]*/i;

export function pickModel(text: string): Routed {
  const trimmed = text.trim();

  // Explicit slash prefixes win and are stripped from the prompt.
  if (OPUS_PREFIX.test(trimmed)) return { model: "opus", prompt: trimmed.replace(OPUS_PREFIX, "") };
  if (SONNET_PREFIX.test(trimmed)) return { model: "sonnet", prompt: trimmed.replace(SONNET_PREFIX, "") };
  if (OPUS_TOKEN.test(trimmed)) {
    return {
      model: "opus",
      prompt: trimmed.replace(OPUS_TOKEN, " ").replace(/\s{2,}/g, " ").trim(),
    };
  }

  // Cheap signals that a stronger model is worth it. Dev-intent rides this
  // tier too — Maor's standing rule (2026-07-28, given by voice): development
  // and build requests always run on Opus without a manual /opus. The /sonnet
  // prefix above remains the manual escape hatch.
  const lower = trimmed.toLowerCase();
  const wantsOpus =
    OPUS_KEYWORDS.some((k) => lower.includes(k)) ||
    trimmed.includes("```") ||
    detectDevIntent(trimmed);

  return { model: wantsOpus ? "opus" : "sonnet", prompt: trimmed };
}

// Dev-intent detection (agenda #4). When Maor asks the agent to build/change its
// OWN code, the poller injects a directive that makes it interview first and then
// recommend a model, instead of building blindly. Deliberately permissive — false
// positives are harmless because the injected directive carries an escape clause
// ("if this isn't a build request, just answer normally").
//
// Since 2026-07-28 dev-intent ALSO escalates pickModel to Opus (Maor's standing
// rule, given by voice during the cinema-tickets thread): the interview and the
// build thinking run on the strong model directly, no manual /opus needed. A
// false positive therefore costs an Opus turn, which Maor accepted; /sonnet is
// the manual override.
//
// Single-word triggers are matched per-token by prefix (so "building"/"develops"
// hit, and Hebrew "בנה" matches the token "בנה" but NOT "הבנה" = understanding).
// PHRASES are matched as substrings of the whole message — that is also where
// the Hebrew development stems live, because clitics glue to the word
// ("הפיתוחים", "והפיצ'ר") and defeat token-prefix matching; these stems have no
// false-friend collisions ("לפתח" never appears inside "לפתוח" = to open), so
// substring matching is safe for them. The bare noun "מפתח" = key is
// deliberately absent — only the phrase "אני מפתח" fires.
const DEV_INTENT_TOKENS = [
  "develop", "implement", "build", "refactor", "rewrite", "debug",
  "תבנה", "תפתח", "בנה", "יישם", "תממש", "תכתוב", "תתקן",
];
const DEV_INTENT_PHRASES = [
  "add a feature", "write code", "code up", "fix the bug", "fix this bug",
  "תוסיף פיצ'ר", "תכתוב קוד", "תקן את הבאג", "פיצ'ר חדש",
  "אני מפתח", "בוא נפתח", "work on the code",
  "לפתח", "פיתוח", "מפתחים", "פיצ'ר",
];

export function detectDevIntent(text: string): boolean {
  // iPhone smart punctuation (U+2019) and the Hebrew geresh (U+05F3) both stand
  // in for the apostrophe in פיצ'ר — normalize so one spelling matches all.
  const lower = (text ?? "").toLowerCase().replace(/[׳’]/g, "'");
  for (const p of DEV_INTENT_PHRASES) if (lower.includes(p)) return true;
  const tokens = lower.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  for (const t of tokens) {
    for (const k of DEV_INTENT_TOKENS) if (t.startsWith(k)) return true;
  }
  return false;
}
