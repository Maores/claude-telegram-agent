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

export interface Question {
  id: string;
  type: QuestionType;
  category: string;
  title: string;
  difficulty?: "easy" | "medium" | "hard";
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
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const VALID_TYPES: QuestionType[] = ["algo", "concept", "behavioral", "system-design"];

function questionsPath(): string {
  return process.env.QUIZ_QUESTIONS_FILE ?? join(import.meta.dir, "data", "questions.json");
}

function statePath(): string {
  return process.env.QUIZ_STATE_FILE ?? join(import.meta.dir, "data", "quiz-state.json");
}

/** Read the question bank, dropping anything that doesn't match the schema —
 *  a malformed entry must never break the daily send. */
export function loadQuestions(): Question[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(questionsPath(), "utf8"));
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
    out.push({
      category: typeof q.category === "string" ? q.category : "",
      source: typeof q.source === "string" ? q.source : "",
      tags: Array.isArray(q.tags) ? q.tags.filter((t) => typeof t === "string") : [],
      ...(q as unknown as Question),
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

/** Work-focused week (Maor, 2026-07-07): 5 of 7 days on job-interview material
 *  (design/concept/behavioral), 2 algo days to keep LeetCode practice alive. */
export const ROTATION: QuestionType[] = [
  "system-design",
  "algo",
  "concept",
  "behavioral",
  "system-design",
  "concept",
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

export function pickByType(
  questions: Question[],
  type: QuestionType,
  seen: string[],
): { question: Question | null; seen: string[] } {
  const pool = questions.filter((q) => q.type === type);
  if (type !== "algo") return pickFromPool(pool, seen);
  // Algo days prefer the LeetCode set first (guide's "LeetCode priority").
  const lcUnseen = pool.filter((q) => isLeetCode(q) && !seen.includes(q.id));
  if (lcUnseen.length) return { question: pickRandom(lcUnseen), seen };
  return pickFromPool(pool, seen);
}

export function pickDiagram(
  questions: Question[],
  seen: string[],
): { question: Question | null; seen: string[] } {
  return pickFromPool(questions.filter((q) => !!q.diagram_url), seen);
}

export function pickPattern(
  questions: Question[],
  seen: string[],
): { question: Question | null; seen: string[] } {
  return pickFromPool(questions.filter((q) => !!q.pattern), seen);
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
  lines.push(q.title);
  lines.push("");
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

export function quizEvalDirective(q: Question, hintsUsed: number): string {
  const hints = splitHints(q.hint);
  const lines = [
    "[הקשר פנימי: למאור נשלחה שאלת תרגול לראיונות והיא עדיין פתוחה.]",
    `השאלה (${TYPE_HE[q.type]}): ${q.title}`,
    q.prompt,
    "",
    "התשובה המלאה (לשיפוט בלבד, אל תדביק אותה כמו שהיא):",
    q.answer,
  ];
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
