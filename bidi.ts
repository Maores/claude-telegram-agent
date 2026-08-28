/**
 * bidi.ts — keeps mixed Hebrew/Latin messages from visually scrambling.
 *
 * Telegram renders each LINE as its own bidi paragraph and picks the paragraph
 * direction from the first strong character. So a Hebrew line that happens to
 * start with an English word (a digest headline, a file path, a command) flips
 * the whole line to LTR, and the punctuation, times and Hebrew tail land in the
 * wrong visual order. The neutral characters between a Latin run and the Hebrew
 * around it get pulled to the wrong side for the same reason.
 *
 * The fix is to wrap every Latin run in an isolate — U+2068 FIRST STRONG
 * ISOLATE ... U+2069 POP DIRECTIONAL ISOLATE. Inside the isolate the run keeps
 * its own LTR order; outside it counts as a single neutral, so it can no longer
 * decide the paragraph direction or drag neighbouring punctuation with it.
 * The characters are invisible and Telegram stores them verbatim.
 *
 * This is applied in poller.ts inside tg() — the one chokepoint every outgoing
 * text/caption passes through, the same place redact() runs — so scheduled
 * [AUTO] jobs, reminders and digests are covered too, not only the replies the
 * model writes by hand. Pure and side-effect free; tests call it directly.
 *
 * Checked against the live Bot API (2026-08-28): a wrapped URL still parses as
 * one `url` entity and the isolates fall outside it, so links stay clickable.
 *
 * No control character is written literally in this file — they are invisible,
 * and a source file that embeds them scrambles itself in every diff viewer.
 * Hence String.fromCharCode() and RegExp built from escaped strings.
 */

/** U+2068 FIRST STRONG ISOLATE — opens an isolated run. */
export const FSI = String.fromCharCode(0x2068);
/** U+2069 POP DIRECTIONAL ISOLATE — closes it. */
export const PDI = String.fromCharCode(0x2069);

/** Hebrew, Arabic, Syriac, Thaana, N'Ko ... plus the Arabic presentation forms. */
const RTL_RE = new RegExp("[\\u0590-\\u08FF\\uFB1D-\\uFDFF\\uFE70-\\uFEFE]");

/** U+2066-U+2069 (the four isolate controls). One already in the text means it
 *  was shaped deliberately — or we already ran — so we must not nest inside. */
const ISOLATE_CLASS = "[\\u2066-\\u2069]";
const HAS_ISOLATE_RE = new RegExp(ISOLATE_CLASS);

// A "Latin run" starts and ends on an alphanumeric and may carry ASCII
// punctuation and horizontal whitespace in between, so `bun run cal.ts list`
// and `https://a.co/b?c=1` each stay one run. Trailing punctuation is left
// outside (it belongs to the Hebrew sentence), and newline is excluded so a run
// can never straddle two lines — each line is its own bidi paragraph.
const CORE = "A-Za-z0-9\\u00C0-\\u024F";
const INNER = "\\t\\u0020-\\u007E\\u00C0-\\u024F";
const RUN_RE = new RegExp(`[${CORE}](?:[${INNER}]*[${CORE}])?`, "g");

/** Digit-only runs (23/12, 08:30-11:30) already order correctly under the bidi
 *  algorithm, so only runs holding an actual Latin letter are worth wrapping. */
const HAS_LATIN_RE = new RegExp("[A-Za-z\\u00C0-\\u024F]");

/**
 * Wrap the Latin runs of every RTL line in FSI...PDI.
 *
 * No-ops on text with no RTL character at all (a pure English message has
 * nothing to scramble) and on text that already carries isolate controls.
 *
 * @param maxLength when the added controls would push the text past this many
 *   UTF-16 units — Telegram's per-field limit — the original is returned
 *   unchanged. A cosmetic fix must never cost a message.
 */
export function isolateLatin(text: string, maxLength = Infinity): string {
  if (!text || !RTL_RE.test(text)) return text;
  if (HAS_ISOLATE_RE.test(text)) return text;

  const out = text.split("\n").map(isolateLine).join("\n");
  return out.length > maxLength ? text : out;
}

/** One paragraph. A line with no RTL character keeps its own direction and is
 *  left alone — which is why a URL parked on its own line is never touched. */
function isolateLine(line: string): string {
  if (!RTL_RE.test(line)) return line;
  return line.replace(RUN_RE, (run) => (HAS_LATIN_RE.test(run) ? FSI + run + PDI : run));
}

/** Strip the controls again — for logs, tests, and anything comparing text. */
export function stripIsolates(text: string): string {
  return text.replace(new RegExp(ISOLATE_CLASS, "g"), "");
}

// Also usable as a filter, so the shell senders (cal_check.sh) get the same
// treatment as everything that goes through the poller:  ... | bun run bidi.ts
if (import.meta.main) {
  process.stdout.write(isolateLatin(await Bun.stdin.text()));
}
