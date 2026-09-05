/**
 * quiz.ts — daily interview-prep quiz core (ported from the sister-project guide,
 * docs/quiz-system-guide.md flow).
 *
 * Pure logic only: question picking with a 7-day type rotation, the Israel-week
 * send window, seen-tracking with per-type reset, Hebrew UI formatting around
 * English question content, qz: inline-callback encoding, and the evaluation
 * directive that rides Maor's next normal message. All I/O beyond the two JSON
 * files (questions + state) lives in poller.ts.
 *
 * Design deviation from the guide: no separate "is this an answer?" Claude call
 * and no unrelated-counter. This bot is a general assistant, so most messages
 * near an open question are NOT answers; the evaluation directive itself routes
 * ("if unrelated, answer normally") and evaluation auto-expires after
 * EVAL_WINDOW_S. One model call per message either way.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Types (schema per the guide)
// ---------------------------------------------------------------------------

export type QuestionType = "algo" | "concept" | "behavioral" | "system-design";

export type Difficulty = "easy" | "medium" | "hard";

export interface Question {
  id: string;
  type: QuestionType;
  category: string;
  title: string;
  difficulty?: Difficulty;
  prompt: string;
  answer: string;
  hint?: string; // up to 3 hints separated by "||"
  solution_code?: string;
  time_complexity?: string;
  space_complexity?: string;
  leetcode_url?: string;
  lc_description?: string;
  source: string;
  tags: string[];
  diagram_url?: string; // set → flashcard mode (image + explanation, no quiz)
  pattern?: string;
}

export interface QuizState {
  chatId: number | null; // bound on first send; auto-send needs a target
  dayIndex: number;
  lastQuestionId: string | null;
  awaitingAnswer: boolean;
  lastSentDate: string | null; // YYYY-MM-DD, prevents duplicate daily sends
  seenIds: string[];
  hintsUsed: number;
  sentAtS: number; // when the active question went out (epoch s)
  difficultyFilter?: Difficulty[]; // when set, every pick prefers these difficulties
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const VALID_TYPES: QuestionType[] = ["algo", "concept", "behavioral", "system-design"];

export function questionsPath(): string {
  return process.env.QUIZ_QUESTIONS_FILE ?? join(import.meta.dir, "data", "questions.json");
}

function statePath(): string {
  return process.env.QUIZ_STATE_FILE ?? join(import.meta.dir, "data", "quiz-state.json");
}

/** Read the question bank, dropping anything that doesn't match the schema —
 *  a malformed entry must never break the daily send. */
export function loadQuestions(path = questionsPath()): Question[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const q = item as Record<string, unknown>;
    if (
      typeof q.id !== "string" ||
      typeof q.title !== "string" ||
      typeof q.prompt !== "string" ||
      typeof q.answer !== "string" ||
      typeof q.type !== "string" ||
      !VALID_TYPES.includes(q.type as QuestionType)
    ) {
      continue;
    }
    // The spread must come FIRST: it carries every optional field through, and
    // the sanitized values below then override whatever the entry had. Written
    // the other way round (2026-07-07 to 2026-07-30) the spread overwrote the
    // defaults, so this validation was dead code and a numeric category or a
    // tags string passed straight into the bank.
    out.push({
      ...(q as unknown as Question),
      category: typeof q.category === "string" ? q.category : "",
      source: typeof q.source === "string" ? q.source : "",
      tags: Array.isArray(q.tags) ? q.tags.filter((t) => typeof t === "string") : [],
    });
  }
  return out;
}

export function defaultQuizState(): QuizState {
  return {
    chatId: null,
    dayIndex: 0,
    lastQuestionId: null,
    awaitingAnswer: false,
    lastSentDate: null,
    seenIds: [],
    hintsUsed: 0,
    sentAtS: 0,
  };
}

/** State survives restarts; unknown/missing fields fall back to defaults so a
 *  schema change can never brick the poller at startup. */
export function loadQuizState(): QuizState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8"));
    return { ...defaultQuizState(), ...(typeof raw === "object" && raw ? raw : {}) };
  } catch {
    return defaultQuizState();
  }
}

export function saveQuizState(state: QuizState): void {
  const path = statePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path); // atomic replace
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** Gilboa's mix (Maor, 2026-07-22, replacing the 2026-07-07 work-focused week):
 *  4 algo days for LeetCode volume, one day each of concept/behavioral/design.
 *  Chosen together with the imported bank, whose 165 algo questions sustain it. */
export const ROTATION: QuestionType[] = [
  "algo",
  "concept",
  "algo",
  "behavioral",
  "algo",
  "system-design",
  "algo",
];

export function typeForDay(dayIndex: number): QuestionType {
  return ROTATION[((dayIndex % ROTATION.length) + ROTATION.length) % ROTATION.length];
}

/** Israel week: Fri+Sat are the weekend (morning window), Sun-Thu evenings. */
export function inSendWindow(now: Date): boolean {
  const day = now.getDay();
  const weekend = day === 5 || day === 6;
  const targetHour = weekend ? 10 : 18;
  return now.getHours() === targetHour && now.getMinutes() < 30;
}

export function todayStr(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

const SEEN_CAP = 500;

export function markSeen(seen: string[], id: string): string[] {
  return [...seen, id].slice(-SEEN_CAP);
}

function pickRandom<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Optional difficulty narrowing (guide v2): questions with no difficulty field
 *  always pass, and an over-narrow filter falls back to the full pool so the
 *  daily send can never dead-end on it. */
function applyDifficulty(pool: Question[], filter?: Difficulty[]): Question[] {
  if (!filter?.length) return pool;
  const narrowed = pool.filter((q) => !q.difficulty || filter.includes(q.difficulty));
  return narrowed.length ? narrowed : pool;
}

/** Core picker: unseen from the pool; when the whole pool was seen, forget the
 *  pool's ids (per-type reset, per the guide) and start the cycle over. */
function pickFromPool(
  pool: Question[],
  seen: string[],
): { question: Question | null; seen: string[] } {
  if (!pool.length) return { question: null, seen };
  let unseen = pool.filter((q) => !seen.includes(q.id));
  let nextSeen = seen;
  if (!unseen.length) {
    const poolIds = new Set(pool.map((q) => q.id));
    nextSeen = seen.filter((id) => !poolIds.has(id));
    unseen = pool;
  }
  return { question: pickRandom(unseen), seen: nextSeen };
}

const isLeetCode = (q: Question) => q.tags.includes("blind75") || !!q.leetcode_url;
const isResume = (q: Question) => q.tags.includes("resume");

/** On non-algo days, this fraction of sends prefers an unseen question about
 *  Maor's own resume projects (Telegram agent / certimanager) — steady
 *  interview-story practice without crowding out the imported bank. */
const RESUME_PRIORITY_P = 0.5;

export function pickByType(
  questions: Question[],
  type: QuestionType,
  seen: string[],
  difficulty?: Difficulty[],
  rng: () => number = Math.random,
): { question: Question | null; seen: string[] } {
  const pool = applyDifficulty(
    questions.filter((q) => q.type === type),
    difficulty,
  );
  if (type !== "algo") {
    const resumeUnseen = pool.filter((q) => isResume(q) && !seen.includes(q.id));
    if (resumeUnseen.length && rng() < RESUME_PRIORITY_P) {
      return { question: pickRandom(resumeUnseen), seen };
    }
    return pickFromPool(pool, seen);
  }
  // Algo days prefer the LeetCode set first (guide's "LeetCode priority").
  const lcUnseen = pool.filter((q) => isLeetCode(q) && !seen.includes(q.id));
  if (lcUnseen.length) return { question: pickRandom(lcUnseen), seen };
  return pickFromPool(pool, seen);
}

export function pickDiagram(
  questions: Question[],
  seen: string[],
  difficulty?: Difficulty[],
): { question: Question | null; seen: string[] } {
  return pickFromPool(applyDifficulty(questions.filter((q) => !!q.diagram_url), difficulty), seen);
}

export function pickPattern(
  questions: Question[],
  seen: string[],
  difficulty?: Difficulty[],
): { question: Question | null; seen: string[] } {
  return pickFromPool(applyDifficulty(questions.filter((q) => !!q.pattern), difficulty), seen);
}

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

export function splitHints(hint: string | undefined): string[] {
  if (!hint) return [];
  return hint
    .split("||")
    .map((h) => h.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Formatting (Hebrew UI, English content; BiDi: LTR blocks on their own lines)
// ---------------------------------------------------------------------------

const TYPE_HE: Record<QuestionType, string> = {
  algo: "אלגוריתמים",
  concept: "מושג",
  behavioral: "שאלה התנהגותית",
  "system-design": "עיצוב מערכות",
};

const LC_DESC_CAP = 600;

export function formatQuestion(q: Question): string {
  const lines: string[] = [];
  const diff = q.difficulty ? ` (${q.difficulty})` : "";
  lines.push(`🎯 שאלת תרגול יומית, ${TYPE_HE[q.type]}${diff}`);
  lines.push("");
  // Some imported questions carry a title that is only the opening of the prompt
  // (a hard 60-char slice for 17 behavioral ones), which printed the same sentence
  // twice, once cut mid-word. When the prompt already starts with the title, the
  // prompt alone is the whole question.
  if (!q.prompt.startsWith(q.title)) {
    lines.push(q.title);
    lines.push("");
  }
  lines.push(q.prompt);
  if (q.lc_description) {
    const desc =
      q.lc_description.length > LC_DESC_CAP
        ? q.lc_description.slice(0, LC_DESC_CAP) + "…"
        : q.lc_description;
    lines.push("");
    lines.push(desc);
  }
  lines.push("");
  if (q.diagram_url) {
    // Flashcard mode: the explanation follows immediately, no quiz commands.
    lines.push("כרטיסיית לימוד להיום. עברו על הדיאגרמה, ההסבר מגיע מיד.");
  } else {
    lines.push("רמז, פתרון מלא או דילוג:");
    lines.push("/hint · /reveal · /skip");
  }
  return lines.join("\n");
}

/** Telegram caps photo captions at 1024 chars: short text rides as the caption,
 *  long text is sent as a separate follow-up message instead. */
export function splitForCaption(text: string): { caption?: string; extra?: string } {
  if (text.length <= 1024) return { caption: text };
  return { extra: text };
}

// ---------------------------------------------------------------------------
// Inline callbacks (qz: namespace — disjoint from fu:/pa:/ch:)
// ---------------------------------------------------------------------------

export type QzCallback =
  | { kind: "start"; choice: "yes" | "no" }
  | { kind: "next"; choice: "pattern" | "diagram" | "normal" };

export function parseQzCallback(data: string): QzCallback | null {
  const m = /^qz:(start|next):([a-z]+)$/.exec(data);
  if (!m) return null;
  if (m[1] === "start" && (m[2] === "yes" || m[2] === "no")) {
    return { kind: "start", choice: m[2] };
  }
  if (m[1] === "next" && (m[2] === "pattern" || m[2] === "diagram" || m[2] === "normal")) {
    return { kind: "next", choice: m[2] };
  }
  return null;
}

export function quizStartKeyboard(): unknown {
  return {
    inline_keyboard: [
      [
        { text: "יאללה, עכשיו 🎯", callback_data: "qz:start:yes" },
        { text: "לא היום", callback_data: "qz:start:no" },
      ],
    ],
  };
}

export function quizNextKeyboard(): unknown {
  return {
    inline_keyboard: [
      [
        { text: "שאלת pattern", callback_data: "qz:next:pattern" },
        { text: "עם דיאגרמה", callback_data: "qz:next:diagram" },
      ],
      [{ text: "נמשיך מחר", callback_data: "qz:next:normal" }],
    ],
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type QuizCommand = "quiz" | "hint" | "reveal" | "skip" | "reset";

/** Exact-match quiz commands, with an optional @mention of THIS bot. Anything
 *  else (including other bots' mentions) is a normal message. */
export function parseQuizCommand(text: string, botUsername: string): QuizCommand | null {
  const m = /^\/(quiz_reset|quiz|hint|reveal|skip)(?:@(\S+))?\s*$/.exec(text.trim());
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null;
  return m[1] === "quiz_reset" ? "reset" : (m[1] as QuizCommand);
}

// ---------------------------------------------------------------------------
// Evaluation directive (rides the normal claude turn — one call per message)
// ---------------------------------------------------------------------------

export const EVAL_WINDOW_S = 6 * 3600;

/** Attach the evaluation directive only while an answer is genuinely expected;
 *  after the window the question stays revealable but chat returns to normal. */
export function shouldAttachQuizDirective(state: QuizState, nowS: number): boolean {
  return state.awaitingAnswer && nowS - state.sentAtS <= EVAL_WINDOW_S;
}

const RUBRIC: Record<QuestionType, string> = {
  algo:
    "בדוק את נכונות הגישה, נתח סיבוכיות זמן ומקום מול הפתרון האופטימלי, והצבע על פערים. אל תחשוף את הפתרון המלא אלא כוון אליו.",
  concept: "בדוק שלמות מול התשובה המלאה וציין במפורש אילו נקודות חסרות או לא מדויקות.",
  behavioral:
    "הערך לפי מבנה STAR (Situation, Task, Action, Result): האם יש סיטואציה ברורה, פעולה אישית ותוצאה מדידה? תן פידבק ממוקד.",
  "system-design":
    "הערך את הרכיבים שהוזכרו, את ההתמודדות עם scale ואת ההתייחסות ל-trade-offs, מול התשובה המלאה.",
};

/** Gilboa's imported algo entries store a "Share your approach…" stub instead of
 *  a solution; treat those as having no stored answer. */
export function isPlaceholderAnswer(answer: string): boolean {
  return /share your approach|i'?ll evaluate/i.test(answer);
}

export function quizEvalDirective(q: Question, hintsUsed: number): string {
  const hints = splitHints(q.hint);
  const lines = [
    "[הקשר פנימי: למאור נשלחה שאלת תרגול לראיונות והיא עדיין פתוחה.]",
    `השאלה (${TYPE_HE[q.type]}): ${q.title}`,
    q.prompt,
  ];
  if (q.lc_description) lines.push(q.lc_description);
  if (isPlaceholderAnswer(q.answer)) {
    lines.push("", "אין תשובת עזר שמורה לשאלה הזו; שפוט לפי הידע שלך.");
  } else {
    lines.push("", "התשובה המלאה (לשיפוט בלבד, אל תדביק אותה כמו שהיא):", q.answer);
  }
  if (q.time_complexity) lines.push(`Time: ${q.time_complexity}`);
  if (q.space_complexity) lines.push(`Space: ${q.space_complexity}`);
  if (hintsUsed > 0 && hints.length) {
    lines.push(`(מאור כבר קיבל ${Math.min(hintsUsed, hints.length)} רמזים.)`);
  }
  lines.push(
    "",
    "אם ההודעה החדשה היא ניסיון לענות על השאלה: הערך אותה בעברית. " + RUBRIC[q.type],
    "בסוף ההערכה הזכר בקצרה שאפשר /reveal לפתרון המלא או /skip לדילוג.",
    "אם ההודעה החדשה לא קשורה לשאלה: ענה עליה כרגיל לגמרי והתעלם מהשאלה הפתוחה.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Bank merging (scripts/merge-questions.ts drives this when importing a bank)
// ---------------------------------------------------------------------------

/** Same question, different id: normalize title-within-type for collision checks. */
const titleKey = (q: Question) =>
  `${q.type}:${q.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;

export interface MergeResult {
  merged: Question[];
  incoming: number; // valid incoming questions (after in-file dedupe)
  dupesInIncoming: number; // duplicate ids inside the incoming file itself
  replacedOurs: number; // ours dropped because incoming covers them (id or title)
  keptOurs: number; // ours that survived alongside
  keptOursOverIncoming: number; // collisions where ours won (their side dropped)
}

/** Merge an incoming bank over the existing one. Incoming wins a collision
 *  (same id, or same title within a type) UNLESS its answer is a placeholder
 *  while ours is real — a question with an actual solution never loses to a
 *  stub of itself. Non-colliding entries on both sides are kept, so existing
 *  ids in seenIds stay valid and the extra variety costs nothing. */
export function mergeQuestionBanks(existing: Question[], incoming: Question[]): MergeResult {
  const ids = new Set<string>();
  const uniqIncoming = incoming.filter((q) => (ids.has(q.id) ? false : (ids.add(q.id), true)));
  const ourById = new Map(existing.map((q) => [q.id, q]));
  const ourByTitle = new Map(existing.map((q) => [titleKey(q), q]));
  const losers = new Set<Question>(); // incoming entries beaten by a richer ours
  const beatenOurIds = new Set<string>(); // ours covered by an accepted incoming entry
  for (const q of uniqIncoming) {
    const hits = [ourById.get(q.id), ourByTitle.get(titleKey(q))].filter(
      (o, i, a): o is Question => !!o && a.indexOf(o) === i,
    );
    if (!hits.length) continue;
    if (isPlaceholderAnswer(q.answer) && hits.some((o) => !isPlaceholderAnswer(o.answer))) {
      losers.add(q);
    } else {
      for (const o of hits) beatenOurIds.add(o.id);
    }
  }
  const accepted = uniqIncoming.filter((q) => !losers.has(q));
  const keep = existing.filter((q) => !beatenOurIds.has(q.id));
  return {
    merged: [...accepted, ...keep],
    incoming: uniqIncoming.length,
    dupesInIncoming: incoming.length - uniqIncoming.length,
    replacedOurs: existing.length - keep.length,
    keptOurs: keep.length,
    keptOursOverIncoming: losers.size,
  };
}
