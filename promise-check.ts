/**
 * promise-check.ts — catches replies that promise deferred/background work
 * the agent has no way to deliver on (CLAUDE.md: "You have NO background
 * execution... nothing keeps running after [this reply] is sent").
 *
 * Pure regex heuristic, no IO. poller.ts pairs a match with a check of
 * whether an `[AUTO] ` reminder was actually scheduled during the same turn
 * — that's the only real "later" the agent has (see incident 2026-08-xx:
 * a reply ended with "אשלח את הממצאים כשהבדיקה תסתיים" though nothing was
 * scheduled and no process kept running after the reply was sent).
 */

// Hebrew: a promise verb ("I'll update/get back/notify/send") followed,
// within the same clause, by a deferral trigger ("when/once X finishes/is
// ready") or by "later" ("בהמשך").
const HE_VERB = String.raw`(?:אעדכן|אחזור אליך|אודיע(?: לך)?|אשלח(?: לך)?|אעביר(?: לך)?|אבדוק ואחזור)`;
const HE_TRIGGER = String.raw`(?:כש|ברגע ש|לאחר ש|אחרי ש)[^.!?\n]{0,25}(?:יסתיים|תסתיים|יושלם|תושלם|מוכן|יגמר|תיגמר|יסיים|תסיים)`;

const PATTERNS: RegExp[] = [
  new RegExp(`${HE_VERB}[^.!?\\n]{0,40}${HE_TRIGGER}`),
  new RegExp(`${HE_VERB}[^.!?\\n]{0,20}בהמשך`),
  /יעודכן בהמשך/,
  /(?:רץ|רצה|עובד|יעבוד|ירוץ|ממשיך לרוץ)\s+ברקע/,

  // English
  /\bI['’ ]?ll (?:update you|get back to you|let you know|notify you)\b[^.!?\n]{0,30}\b(?:when|once|later|shortly|soon)\b/i,
  /\bI['’]ll (?:update you|get back to you|let you know|notify you) later\b/i,
  /\brunning in the background\b/i,
  /\bkeep(?:s|ing)? checking\b/i,
  /\bwill follow up\b[^.!?\n]{0,30}\b(?:when|once|later|shortly|soon)\b/i,
];

/** True if `text` reads like a promise to do something after this reply is
 *  sent, with no mechanism (a scheduled [AUTO] reminder) actually backing it. */
export function looksLikeDeferredPromise(text: string): boolean {
  return PATTERNS.some((re) => re.test(text));
}

export const UNBACKED_PROMISE_NOTE =
  "\n\n(הערה: אין לי יכולת להמשיך לפעול אחרי ההודעה הזו, אז המשפט למעלה על עדכון/חזרה בהמשך לא באמת יקרה מעצמו. אם צריך שאחזור לנושא, תבקש שוב או שאתזמן תזכורת AUTO.)";
