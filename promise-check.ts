/**
 * promise-check.ts — catches replies that promise deferred/background work
 * the agent has no way to deliver on (CLAUDE.md: "You have NO background
 * execution... nothing keeps running after [this reply] is sent").
 *
 * Pure regex heuristic, no IO. poller.ts pairs a match with a check of what
 * actually backs the claim (see incident 2026-08-xx: a reply ended with
 * "אשלח את הממצאים כשהבדיקה תסתיים" though nothing was scheduled and no
 * process kept running after the reply was sent).
 *
 * Two claims hide in here and they need different backing, which is why
 * `classifyDeferredPromise` returns a kind rather than a boolean:
 *
 *  - "agent-acts": the MODEL says it will act later ("I'll update you when
 *    it's done"). Nothing survives the reply, so this is honest only if the
 *    turn created a mechanism that fires later: an [AUTO] reminder, a plain
 *    reminder, or a monitor.
 *  - "mechanism-runs": the reply says something KEEPS RUNNING ("המוניטור רץ
 *    ברקע", "keeps checking"). Monitors and reminders genuinely do keep
 *    running, because the poller owns them rather than the model, so this is
 *    honest whenever such a mechanism exists for the chat, whether or not it
 *    was created this turn. Treating it like the first kind was a live false
 *    positive: Maor has a standing dollar monitor, so a correct answer about
 *    it came back with a note calling itself unreal.
 */

// Hebrew: a promise verb ("I'll update/get back/notify/send") followed,
// within the same clause, by a deferral trigger ("when/once X finishes/is
// ready") or by "later" ("בהמשך").
const HE_VERB = String.raw`(?:אעדכן|אחזור אליך|אודיע(?: לך)?|אשלח(?: לך)?|אעביר(?: לך)?|אבדוק ואחזור)`;
const HE_TRIGGER = String.raw`(?:כש|ברגע ש|לאחר ש|אחרי ש)[^.!?\n]{0,25}(?:יסתיים|תסתיים|יושלם|תושלם|מוכן|יגמר|תיגמר|יסיים|תסיים)`;

/** The model claiming it will act after this reply is sent. */
const AGENT_ACTS: RegExp[] = [
  new RegExp(`${HE_VERB}[^.!?\\n]{0,40}${HE_TRIGGER}`),
  new RegExp(`${HE_VERB}[^.!?\\n]{0,20}בהמשך`),
  /יעודכן בהמשך/,

  // English
  /\bI['’ ]?ll (?:update you|get back to you|let you know|notify you)\b[^.!?\n]{0,30}\b(?:when|once|later|shortly|soon)\b/i,
  /\bI['’]ll (?:update you|get back to you|let you know|notify you) later\b/i,
  /\bwill follow up\b[^.!?\n]{0,30}\b(?:when|once|later|shortly|soon)\b/i,
];

/** The reply claiming something is left running. True of monitors and
 *  reminders, false of the model itself. */
const MECHANISM_RUNS: RegExp[] = [
  /(?:רץ|רצה|עובד|יעבוד|ירוץ|ממשיך לרוץ)\s+ברקע/,
  /\brunning in the background\b/i,
  /\bkeep(?:s|ing)? checking\b/i,
];

export type PromiseKind = "agent-acts" | "mechanism-runs";

// --- what the 400-reply corpus test found (2026-08-17) ----------------------
// Run against 400 real archive replies, the first cut flagged 9 and was right
// about 1. All 8 false positives were the agent talking ABOUT the phrase
// rather than using it, in exactly two shapes:
//
//   quoted   #1198 הפיצ'ר שמזהה הבטחות "אעדכן בהמשך"      (describing the feature)
//            #1192 סיימתי תשובה עם "אשלח כשיהיה מוכן"      (apologising for it)
//            #795  "רץ ברקע" באותה הודעה קודמת לא היה נכון (correcting itself)
//   negated  #896  אין תהליך שרץ ברקע ומחכה לשמוע אותך
//            #818  אני לא "רץ ברקע" בין הודעות
//            #1084 לוודא שאין עדכון תקוע שרץ ברקע          (a Windows update!)
//
// Both are cheap to exclude and neither can hide a real promise: a genuine
// promise is made in the agent's own voice, unquoted and unnegated. The PR
// body had called negation "a real edge" — on real data it is the dominant
// failure mode, because this agent explains its own background limitation
// constantly.

/** Quoted spans are the agent discussing a phrase, not committing to it.
 *  Only paired double quotes and gershayim — single quotes are left alone
 *  because Hebrew uses the geresh inside ordinary words (פיצ'ר, קוטג'). */
function blankQuotedSpans(text: string): string {
  return text
    .replace(/"[^"\n]{0,160}"/g, " ")
    .replace(/[“”][^“”\n]{0,160}[“”]/g, " ")
    .replace(/״[^״\n]{0,160}״/g, " ");
}

/** A past-tense speech verb before the match makes it reported speech, not a
 *  commitment: "כשכתבתי שאכין את הסקירה ואשלח… זו הייתה טעות שלי" is the agent
 *  apologising for a promise, and flagging the apology would be absurd. Quotes
 *  cover most of this shape; this covers the unquoted rest (#1190). */
const REPORTED = /(?:^|[\s,:;("'״“])(?:כשכתבתי|כתבתי|אמרתי|הבטחתי|ציינתי|טענתי|השבתי|כשאמרתי|כשהבטחתי|when i (?:said|wrote|promised)|i (?:said|wrote|promised)|earlier i)(?=[\s,:;)"'״”ש]|$)/i;

/** A negator anywhere before the match in the same sentence flips the meaning:
 *  "אין תהליך שרץ ברקע" states the opposite of what the pattern matches. */
const NEGATORS = /(?:^|[\s,:;("'״“])(?:אין|שאין|אינני|איני|לא|שלא|בלי|ללא|never|not|no longer|isn['’]t|won['’]t|doesn['’]t|cannot|can['’]t)(?=[\s,:;)"'״”]|$)/i;

/** Split on sentence enders, keeping it crude on purpose — the only thing that
 *  matters is not letting a negation leak across a full stop. */
const sentences = (text: string): string[] => text.split(/(?<=[.!?\n])/);

/** True if some sentence matches `res` in the agent's own voice: not inside a
 *  quotation, and not negated earlier in that same sentence. */
function assertedIn(text: string, res: RegExp[]): boolean {
  for (const raw of sentences(text)) {
    const s = blankQuotedSpans(raw);
    for (const re of res) {
      const m = re.exec(s);
      if (!m) continue;
      const before = s.slice(0, m.index);
      if (NEGATORS.test(before)) continue; // "אין … שרץ ברקע"
      if (REPORTED.test(before)) continue; // "כשכתבתי ש… אשלח …"
      return true;
    }
  }
  return false;
}

/** Which kind of deferred-work claim `text` makes, or null for none. A text
 *  making both claims classifies as "agent-acts", the stricter of the two,
 *  since that is the part that cannot fulfil itself. */
export function classifyDeferredPromise(text: string): PromiseKind | null {
  if (assertedIn(text, AGENT_ACTS)) return "agent-acts";
  if (assertedIn(text, MECHANISM_RUNS)) return "mechanism-runs";
  return null;
}

/** True if `text` reads like a promise to do something after this reply is
 *  sent. Kept as the coarse predicate; callers deciding whether to flag want
 *  `classifyDeferredPromise`, because the two kinds need different backing. */
export function looksLikeDeferredPromise(text: string): boolean {
  return classifyDeferredPromise(text) !== null;
}

/** True if `after` holds an id `before` did not, i.e. the turn created a new
 *  mechanism that can deliver later work. A null `after` means the read
 *  failed, which fails open (counted as backed) so a storage hiccup can never
 *  append a false note to a real reply. */
export function gainedBacking(before: Set<string>, after: Set<string> | null): boolean {
  if (after === null) return true;
  for (const id of after) if (!before.has(id)) return true;
  return false;
}

export const UNBACKED_PROMISE_NOTE =
  "\n\n(הערה: אין לי יכולת להמשיך לפעול אחרי ההודעה הזו, אז המשפט למעלה על עדכון/חזרה בהמשך לא באמת יקרה מעצמו. אם צריך שאחזור לנושא, תבקש שוב או שאתזמן תזכורת AUTO.)";
