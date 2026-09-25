/**
 * ccjournal.ts — the PC half of the evening Claude Code digest (spec:
 * docs/superpowers/specs/2026-09-25-cc-digest-design.md).
 *
 * Turns the owner's daily notes into the journal the server summarizes: only the timed
 * log lines of Claude Code sessions, with editorial brackets, emails and phone numbers
 * removed here, on the PC, before anything leaves it. scripts/cc-journal-push.ts runs this
 * hourly from a deployed copy (DEPLOY.md step 14); ccdigest.ts, the server half, reads the
 * result.
 *
 * SANITIZER_VERSION: bump it in the same commit as any change that alters the text this
 * module produces for an existing line (the golden test in ccjournal-sanitize.test.ts pins
 * that text). The server re-keys already-sent lines when the version changes, instead of
 * sending a week of old work again, and `status` warns when the PC copy is out of step.
 *
 * All clock math is Asia/Jerusalem through Intl, never the process timezone: Bun forces
 * TZ=UTC in tests on Windows, so the tests exercise exactly this path.
 */

export const SANITIZER_VERSION = 1;
export const TZ = "Asia/Jerusalem";
export const ENTRY_MAX = 4000;
export const NOTE_MAX = 200;

export interface Entry {
  time: string; // "HH:MM", local time of the log line (an unread minute digit "x" reads as 0)
  text: string; // sanitized line body
  links: string[]; // wikilink targets, without a leading "Projects/"
  notes?: string[]; // truth-status notes (false, refuted, corrected, imprecise, a plan); never part of the key
}
export interface JournalDay {
  date: string; // "YYYY-MM-DD"
  entries: Entry[];
}
export interface NoteStats {
  ignoredBelowHeading: number; // timed lines after a "## " heading (translation sections)
  testLinesDropped: number; // planted gate-test lines (DELIBERATE TRUE/FALSE TEST LINE)
  automationDropped: number; // lines the watchdog script writes ("watchdog: ..."), not Claude Code work
  unparsedTimed: number; // bullets that start with a digit but do not parse as "- HH:MM — ...", or leave no text
}
export interface Journal {
  v: 1;
  sanitizer: number; // SANITIZER_VERSION of the PC copy that built it
  pushedAt: number; // epoch seconds, when the PC built it
  days: JournalDay[];
  stats?: NoteStats & { entries: number }; // extraction health, shown by the server's `status`
  copy?: string; // the deployed PC copy's commit, from its version.txt
}

// ---------------------------------------------------------------------------
// Time (Asia/Jerusalem wall clock)
// ---------------------------------------------------------------------------

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function localParts(d: Date): { date: string; minutes: number; hhmm: string } {
  const p: Record<string, string> = {};
  for (const x of partsFmt.formatToParts(d)) p[x.type] = x.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    hhmm: `${p.hour}:${p.minute}`,
  };
}

/** Noon UTC of a civil date: far from any day boundary, so date arithmetic is exact. */
function noonUtc(date: string): number {
  return Date.parse(`${date}T12:00:00Z`);
}

export function addDays(date: string, n: number): string {
  return new Date(noonUtc(date) + n * 86_400_000).toISOString().slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(noonUtc(date)).getUTCDay();
}

// ---------------------------------------------------------------------------
// Contacts: removed before anything leaves the PC
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** A mailbox at a well-known provider written without its domain ending ("name@outlook"). */
const PROVIDER_EMAIL_RE = /[A-Za-z0-9._%+-]+@(?:gmail|googlemail|outlook|hotmail|yahoo|icloud|walla|protonmail|proton)\b/gi;
/** A mailbox whose domain was cut off, as in a list like "main box@; digests box@". */
const PARTIAL_EMAIL_RE = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@(?=[\s;,.:)\]`'"/–—\u0590-\u05FF]|$)/g;
/** Israeli mobile, landline and +972 numbers in the usual groupings. */
const PHONE_RE =
  /(?<![\w.+])(?:\+?972[-.\s]?(?:\(0\))?[-.\s]?|\(?0)(?:5\d|7\d|[23489])\)?[-.\s]?\d{3}[-.\s]?\d{2}[-.\s]?\d{2}(?!\w|\.\d)/g;

export function scrubContacts(s: string): string {
  return s.replace(EMAIL_RE, "").replace(PROVIDER_EMAIL_RE, "").replace(PARTIAL_EMAIL_RE, "").replace(PHONE_RE, "");
}

// ---------------------------------------------------------------------------
// Sanitizing one log-line body
// ---------------------------------------------------------------------------

/** "- HH:MM — body"; an unread second minute digit written as "x" ("21:0x") reads as 0. */
const LINE_RE = /^- (\d{1,2}):(\d)([\dxX]) (?:—|-) (.+)$/;
/** A bullet that looks timed but did not parse: counted, never silently lost. */
const TIMED_LOOKING_RE = /^\s*[-*+]\s+~?\**\d/;
/** The watchdog script's own alert lines ("- HH:mm — watchdog: ..."): automation, not
 *  Claude Code work. Lower case on purpose: a session's "Watchdog: ..." topic is work. */
const AUTOMATION_RE = /^watchdog: /;
/** The planted gate-test marker, always written in capitals inside the line's own bracket. */
const TEST_MARKER_RE = /^\s*DELIBERATE (?:TRUE|FALSE) TEST LINE\b/;
/** A planted test announced in the line's own label, before its first ": ", ". " or "; ". */
const TEST_LABEL_RE = /\bdeliberately (?:false|true)\b/i;
/** C0 controls (tab kept), DEL, the soft hyphen, zero-width characters and marks, and bidi
 *  embedding and isolate controls: all invisible, and each able to hide an address. The
 *  zero-width joiner stays (it builds emoji); MARKS_RE catches it inside an address. */
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F\u00AD\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const CODE_RE = /`[^`\n]*`/g;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
const MD_LINK_RE = /\[([^\[\]]*)\]\((?:https?:\/\/|mailto:)[^)\s]*\)/g;
/** Bracket notes that open with a verdict on their line travel as notes, not as noise. A
 *  bracket that merely mentions a verdict further in (provenance) is dropped like the rest. */
const STATUS_RE = /^\s*(?:gate:\s*)?(?:marked\s+)?(?:false|refuted|corrected|imprecise|plan)\b/i;
const PLACEHOLDER_RE = /\u0000(\d+)\u0001/g;

/** Remove every top-level [ … ] group (nested ones go with it) and return the groups'
 *  inner text. An unmatched "[" stays as a literal. */
export function splitBrackets(s: string): { text: string; groups: string[] } {
  let text = "";
  const groups: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "[") {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === "[") depth++;
        else if (s[j] === "]" && --depth === 0) break;
      }
      if (j < s.length) {
        groups.push(s.slice(i + 1, j));
        i = j + 1;
        continue;
      }
    }
    text += s[i++];
  }
  return { text, groups };
}

function tidy(s: string): string {
  return s
    .replace(/(^|\s)\(\s*(?:[,;:]\s*)*\)/g, "$1") // parentheses emptied by the removals, e.g. " (, , )"
    .replace(/\(\s*[,;]\s*/g, "(") // "(, cc" left by a removed address
    .replace(/\s+([,.;:!?)])(?=\s|$)/g, "$1") // no space before punctuation that ends a clause
    .replace(/\(\s+/g, "(")
    .replace(/([,;])(?:\s*[,;])+/g, "$1") // doubled separators
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A planted line that tests the vault's verification gate: its own bracket carries the
 *  marker, or its label announces a deliberately false (or true) test. A line that only
 *  mentions such a test, in prose or in code, is real work and stays. */
export function isPlantedTestLine(body: string): boolean {
  const plain = body.replace(CODE_RE, "");
  if (splitBrackets(plain).groups.some((g) => TEST_MARKER_RE.test(g))) return true;
  const label = plain.split(/[:.;]\s/)[0].slice(0, 80);
  return TEST_LABEL_RE.test(label);
}

function sanitizeCore(body: string): { text: string; links: string[]; notes: string[] } {
  const codes: string[] = [];
  const restore = (s: string) => s.replace(PLACEHOLDER_RE, (_m, i: string) => codes[Number(i)]);
  let s = body.replace(CODE_RE, (m) => {
    codes.push(scrubContacts(m));
    return `\u0000${codes.length - 1}\u0001`;
  });

  // One scrub while bold still marks the edges ("Tel.**050-000-0000**" needs the marks), then bold
  // goes ("**name**@example.com" needs them gone) and the scrub below runs again. Runs of
  // spaces collapse first, as tidy does to the text at the end, so "050  000-0000" is seen as a number.
  s = scrubContacts(s.replace(/\s{2,}/g, " ")).replace(/\*\*/g, "");

  const links: string[] = [];
  s = s.replace(WIKILINK_RE, (_m, target: string) => {
    const name = scrubContacts(restore(target)).trim().replace(/^Projects\//, "");
    if (name && !links.includes(name)) links.push(name);
    return "";
  });
  s = s.replace(MD_LINK_RE, "$1");

  const split = splitBrackets(s);
  s = split.text;
  const notes: string[] = [];
  for (const g of split.groups) {
    if (!STATUS_RE.test(g)) continue;
    let note = restore(splitBrackets(g).text);
    note = scrubContacts(note).replace(/\s+/g, " ").trim();
    if (note.length > NOTE_MAX) note = note.slice(0, NOTE_MAX - 1).trimEnd() + "…";
    if (note) notes.push(note);
  }

  s = scrubContacts(s);
  s = restore(tidy(s));
  if (s.length > ENTRY_MAX) s = s.slice(0, ENTRY_MAX - 1).trimEnd() + "…";
  return { text: s, links, notes };
}

/**
 * Clean one log-line body for the server. Control characters go first. Code spans are
 * kept verbatim (only contacts are scrubbed inside them). Outside them: wikilinks become
 * `links` (a leading "Projects/" dropped, aliases ignored), markdown links keep their text,
 * every editorial [ … ] note is removed, and the ones that open with a verdict on the line
 * (false, refuted, corrected, imprecise, a plan) become `notes`. Emails, cut-off addresses
 * and phone numbers go everywhere (scrubbed once before bold markers go and once after),
 * and the text is capped at ENTRY_MAX characters. A contact that a mark still splits (a
 * code-span edge, "`name`@example.com", italics, strikethrough, highlight or an escape)
 * escapes every pattern, so the text, the notes and the links are checked once more with
 * those marks removed, and a line that still holds a contact is sanitized again without them.
 */
export function sanitizeLine(body: string): { text: string; links: string[]; notes: string[] } {
  const clean = body.replace(CONTROL_RE, "");
  let out = sanitizeCore(clean);
  if (holdsContact(out)) out = sanitizeCore(clean.replace(/`/g, ""));
  if (holdsContact(out)) out = sanitizeCore(clean.replace(MARKS_RE, ""));
  return out;
}

/** Code-span, emphasis, strikethrough, highlight and escape marks, and the zero-width
 *  joiner, which can split an address or a number from every pattern. */
const MARKS_RE = /[`*~=\\\u200D]/g;

function holdsContact(o: { text: string; links: string[]; notes: string[] }): boolean {
  return [o.text, ...o.notes, ...o.links].some((s) => {
    const bare = s.replace(MARKS_RE, "");
    return scrubContacts(bare) !== bare;
  });
}

// ---------------------------------------------------------------------------
// Extraction from a daily note, and the journal
// ---------------------------------------------------------------------------

/** The timed log lines of one daily note, in file order, plus what was left out. */
export function extractNote(noteText: string): { entries: Entry[] } & NoteStats {
  const entries: Entry[] = [];
  const stats: NoteStats = { ignoredBelowHeading: 0, testLinesDropped: 0, automationDropped: 0, unparsedTimed: 0 };
  let below = false;
  for (const line of noteText.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      below = true;
      continue;
    }
    const m = LINE_RE.exec(line);
    if (!m) {
      if (!below && TIMED_LOOKING_RE.test(line)) stats.unparsedTimed++;
      continue;
    }
    if (below) {
      stats.ignoredBelowHeading++;
      continue;
    }
    const body = m[4];
    if (AUTOMATION_RE.test(body)) {
      stats.automationDropped++;
      continue;
    }
    if (isPlantedTestLine(body)) {
      stats.testLinesDropped++;
      continue;
    }
    const { text, links, notes } = sanitizeLine(body);
    if (!text) {
      stats.unparsedTimed++; // nothing left once sanitized (only links or brackets)
      continue;
    }
    const time = `${m[1].padStart(2, "0")}:${m[2]}${/\d/.test(m[3]) ? m[3] : "0"}`;
    entries.push(notes.length ? { time, text, links, notes } : { time, text, links });
  }
  return { entries, ...stats };
}

export function extractEntries(noteText: string): Entry[] {
  return extractNote(noteText).entries;
}

/** The journal for the given notes (a null text means the note does not exist). `copy` is
 *  the deployed PC copy's commit, when known. */
export function buildJournal(
  notes: { date: string; text: string | null }[],
  pushedAt: number,
  copy?: string,
): { journal: Journal; stats: NoteStats & { entries: number } } {
  const days: JournalDay[] = [];
  const stats = { entries: 0, ignoredBelowHeading: 0, testLinesDropped: 0, automationDropped: 0, unparsedTimed: 0 };
  for (const n of notes) {
    if (n.text === null) continue;
    const x = extractNote(n.text);
    days.push({ date: n.date, entries: x.entries });
    stats.entries += x.entries.length;
    stats.ignoredBelowHeading += x.ignoredBelowHeading;
    stats.testLinesDropped += x.testLinesDropped;
    stats.automationDropped += x.automationDropped;
    stats.unparsedTimed += x.unparsedTimed;
  }
  const journal: Journal = { v: 1, sanitizer: SANITIZER_VERSION, pushedAt, days, stats: { ...stats } };
  if (copy) journal.copy = copy;
  return { journal, stats };
}
