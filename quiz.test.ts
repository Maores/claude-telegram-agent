import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ROTATION,
  typeForDay,
  inSendWindow,
  todayStr,
  splitHints,
  pickByType,
  pickDiagram,
  pickPattern,
  markSeen,
  formatQuestion,
  splitForCaption,
  quizStartKeyboard,
  quizNextKeyboard,
  parseQzCallback,
  quizEvalDirective,
  parseQuizCommand,
  shouldAttachQuizDirective,
  defaultQuizState,
  loadQuizState,
  saveQuizState,
  loadQuestions,
  type Question,
} from "./quiz";

// --- helpers -------------------------------------------------------------------

const q = (over: Partial<Question> = {}): Question => ({
  id: "algo-1",
  type: "algo",
  category: "arrays",
  title: "Two Sum",
  prompt: "Solve: Two Sum",
  answer: "Use a hash map; O(n) time, O(n) space.",
  source: "test",
  tags: [],
  ...over,
});

// --- send window (Israel week: Sun-Thu weekdays 18:00-18:30, Fri-Sat 10:00-10:30)

test("inSendWindow opens on a weekday evening", () => {
  // 2026-07-07 is a Tuesday
  expect(inSendWindow(new Date(2026, 6, 7, 18, 10))).toBe(true);
});

test("inSendWindow is closed before and after the weekday window", () => {
  expect(inSendWindow(new Date(2026, 6, 7, 17, 59))).toBe(false);
  expect(inSendWindow(new Date(2026, 6, 7, 18, 31))).toBe(false);
  expect(inSendWindow(new Date(2026, 6, 7, 10, 10))).toBe(false);
});

test("inSendWindow uses the morning window on Friday and Saturday", () => {
  // 2026-07-10 Friday, 2026-07-11 Saturday
  expect(inSendWindow(new Date(2026, 6, 10, 10, 15))).toBe(true);
  expect(inSendWindow(new Date(2026, 6, 11, 10, 5))).toBe(true);
  expect(inSendWindow(new Date(2026, 6, 10, 18, 10))).toBe(false);
});

test("inSendWindow treats Sunday as a weekday (Israel)", () => {
  // 2026-07-12 is a Sunday
  expect(inSendWindow(new Date(2026, 6, 12, 18, 5))).toBe(true);
  expect(inSendWindow(new Date(2026, 6, 12, 10, 15))).toBe(false);
});

test("todayStr formats as YYYY-MM-DD", () => {
  expect(todayStr(new Date(2026, 6, 7, 18, 10))).toBe("2026-07-07");
});

// --- rotation -------------------------------------------------------------------

test("rotation is the work-focused 7-day cycle and wraps", () => {
  expect(ROTATION).toEqual([
    "system-design",
    "algo",
    "concept",
    "behavioral",
    "system-design",
    "concept",
    "algo",
  ]);
  expect(typeForDay(0)).toBe("system-design");
  expect(typeForDay(1)).toBe("algo");
  expect(typeForDay(3)).toBe("behavioral");
  expect(typeForDay(5)).toBe("concept");
  expect(typeForDay(7)).toBe("system-design");
  expect(typeForDay(12)).toBe("concept");
});

// --- hints -----------------------------------------------------------------------

test("splitHints splits on || and trims", () => {
  expect(splitHints("think DP || rob[i] formula || O(n)/O(1)")).toEqual([
    "think DP",
    "rob[i] formula",
    "O(n)/O(1)",
  ]);
});

test("splitHints handles a missing hint", () => {
  expect(splitHints(undefined)).toEqual([]);
});

// --- picking ---------------------------------------------------------------------

test("pickByType prefers an unseen LeetCode question on algo days", () => {
  const questions = [
    q({ id: "algo-plain", tags: [] }),
    q({ id: "algo-lc", tags: ["blind75"] }),
  ];
  const { question } = pickByType(questions, "algo", ["nothing-seen"]);
  expect(question?.id).toBe("algo-lc");
});

test("pickByType falls back to non-LC algo when all LC are seen", () => {
  const questions = [
    q({ id: "algo-plain", tags: [] }),
    q({ id: "algo-lc", tags: ["blind75"] }),
  ];
  const { question } = pickByType(questions, "algo", ["algo-lc"]);
  expect(question?.id).toBe("algo-plain");
});

test("pickByType resets seen for the type once it is exhausted", () => {
  const questions = [q({ id: "c-1", type: "concept" }), q({ id: "c-2", type: "concept" })];
  const { question, seen } = pickByType(questions, "concept", ["c-1", "c-2", "other-kept"]);
  expect(question).not.toBeNull();
  expect(seen).toContain("other-kept");
  expect(seen).not.toContain("c-1");
});

test("pickByType returns null when the type has no questions at all", () => {
  const { question } = pickByType([q({ id: "a", type: "algo" })], "behavioral", []);
  expect(question).toBeNull();
});

test("pickDiagram picks only questions that carry a diagram_url", () => {
  const questions = [
    q({ id: "plain-sd", type: "system-design" }),
    q({ id: "diag-sd", type: "system-design", diagram_url: "https://assets.bytebytego.com/diagrams/x.png" }),
  ];
  const { question } = pickDiagram(questions, []);
  expect(question?.id).toBe("diag-sd");
});

test("pickPattern picks only questions with a pattern field", () => {
  const questions = [q({ id: "no-pat" }), q({ id: "with-pat", pattern: "sliding-window" })];
  const { question } = pickPattern(questions, []);
  expect(question?.id).toBe("with-pat");
});

test("markSeen appends and caps at 500 ids", () => {
  const seen = Array.from({ length: 500 }, (_, i) => `old-${i}`);
  const next = markSeen(seen, "new-id");
  expect(next.length).toBe(500);
  expect(next[next.length - 1]).toBe("new-id");
  expect(next).not.toContain("old-0");
});

// --- formatting -------------------------------------------------------------------

test("formatQuestion renders Hebrew UI around English content with the commands line", () => {
  const text = formatQuestion(q({ difficulty: "medium", lc_description: "Given an array..." }));
  expect(text).toContain("Two Sum");
  expect(text).toContain("Solve: Two Sum");
  expect(text).toContain("/hint");
  expect(text).toContain("/reveal");
  expect(text).toContain("/skip");
  expect(text).toContain("שאלת תרגול");
});

test("formatQuestion for a diagram flashcard omits the answer commands", () => {
  const text = formatQuestion(
    q({ type: "system-design", diagram_url: "https://assets.bytebytego.com/d.png" }),
  );
  expect(text).not.toContain("/hint");
  expect(text).toContain("Two Sum");
});

test("splitForCaption keeps short text as the caption", () => {
  const { caption, extra } = splitForCaption("short text");
  expect(caption).toBe("short text");
  expect(extra).toBeUndefined();
});

test("splitForCaption moves long text to a follow-up message", () => {
  const long = "x".repeat(1100);
  const { caption, extra } = splitForCaption(long);
  expect(caption).toBeUndefined();
  expect(extra).toBe(long);
});

// --- callbacks ---------------------------------------------------------------------

test("qz callbacks roundtrip and keyboards carry them", () => {
  expect(parseQzCallback("qz:start:yes")).toEqual({ kind: "start", choice: "yes" });
  expect(parseQzCallback("qz:start:no")).toEqual({ kind: "start", choice: "no" });
  expect(parseQzCallback("qz:next:pattern")).toEqual({ kind: "next", choice: "pattern" });
  expect(parseQzCallback("qz:next:diagram")).toEqual({ kind: "next", choice: "diagram" });
  expect(parseQzCallback("qz:next:normal")).toEqual({ kind: "next", choice: "normal" });
  const start = JSON.stringify(quizStartKeyboard());
  expect(start).toContain("qz:start:yes");
  expect(start).toContain("qz:start:no");
  const next = JSON.stringify(quizNextKeyboard());
  expect(next).toContain("qz:next:pattern");
  expect(next).toContain("qz:next:diagram");
  expect(next).toContain("qz:next:normal");
});

test("parseQzCallback ignores foreign namespaces and garbage", () => {
  expect(parseQzCallback("fu:done:abc")).toBeNull();
  expect(parseQzCallback("ch:1:2")).toBeNull();
  expect(parseQzCallback("qz:start:maybe")).toBeNull();
  expect(parseQzCallback("")).toBeNull();
});

// --- evaluation directive -------------------------------------------------------------

test("quizEvalDirective carries the question, model answer, and an unrelated-escape clause", () => {
  const d = quizEvalDirective(q({ difficulty: "medium" }), 1);
  expect(d).toContain("Two Sum");
  expect(d).toContain("hash map");
  expect(d).toContain("לא קשורה");
});

test("quizEvalDirective applies a STAR rubric for behavioral questions", () => {
  const d = quizEvalDirective(q({ type: "behavioral", title: "Tell me about a conflict" }), 0);
  expect(d).toContain("STAR");
});

test("quizEvalDirective asks for complexity feedback on algo questions", () => {
  const d = quizEvalDirective(q({ type: "algo" }), 0);
  expect(d).toContain("סיבוכיות");
});

// --- commands -----------------------------------------------------------------------

test("parseQuizCommand recognizes the five commands, with optional bot mention", () => {
  expect(parseQuizCommand("/quiz", "mybot")).toBe("quiz");
  expect(parseQuizCommand("/quiz@mybot", "mybot")).toBe("quiz");
  expect(parseQuizCommand("/hint", "mybot")).toBe("hint");
  expect(parseQuizCommand("/reveal", "mybot")).toBe("reveal");
  expect(parseQuizCommand("/skip", "mybot")).toBe("skip");
  expect(parseQuizCommand("/quiz_reset", "mybot")).toBe("reset");
});

test("parseQuizCommand rejects other text and wrong mentions", () => {
  expect(parseQuizCommand("/quizzes", "mybot")).toBeNull();
  expect(parseQuizCommand("/quiz@otherbot", "mybot")).toBeNull();
  expect(parseQuizCommand("hint please", "mybot")).toBeNull();
  expect(parseQuizCommand("/stop", "mybot")).toBeNull();
});

// --- directive attachment window ---------------------------------------------------

test("shouldAttachQuizDirective is true only while awaiting within the eval window", () => {
  const nowS = 1_800_000_000;
  const state = { ...defaultQuizState(), awaitingAnswer: true, sentAtS: nowS - 3600 };
  expect(shouldAttachQuizDirective(state, nowS)).toBe(true);
  expect(shouldAttachQuizDirective({ ...state, awaitingAnswer: false }, nowS)).toBe(false);
  expect(shouldAttachQuizDirective({ ...state, sentAtS: nowS - 7 * 3600 }, nowS)).toBe(false);
});

// --- state persistence ----------------------------------------------------------------

test("quiz state round-trips through its JSON file", () => {
  process.env.QUIZ_STATE_FILE = join(mkdtempSync(join(tmpdir(), "qz-")), "quiz-state.json");
  const fresh = loadQuizState();
  expect(fresh.dayIndex).toBe(0);
  expect(fresh.awaitingAnswer).toBe(false);
  const changed = { ...fresh, dayIndex: 3, awaitingAnswer: true, seenIds: ["a"], lastSentDate: "2026-07-07" };
  saveQuizState(changed);
  expect(loadQuizState()).toEqual(changed);
});

// --- question loading -------------------------------------------------------------------

test("the shipped questions.json is valid and complete enough to run", () => {
  delete process.env.QUIZ_QUESTIONS_FILE;
  const qs = loadQuestions();
  expect(qs.length).toBeGreaterThanOrEqual(75);
  const types = new Set(qs.map((x) => x.type));
  expect(types).toEqual(new Set(["algo", "concept", "behavioral", "system-design"]));
  const ids = new Set(qs.map((x) => x.id));
  expect(ids.size).toBe(qs.length);
  for (const x of qs) {
    if (x.diagram_url) {
      expect(x.diagram_url.startsWith("https://assets.bytebytego.com/diagrams/")).toBe(true);
    }
    if (x.type === "algo") {
      expect(x.leetcode_url).toBeDefined();
      expect(splitHints(x.hint).length).toBe(3);
    }
  }
});

test("loadQuestions parses a JSON array and drops malformed entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "qzq-"));
  const file = join(dir, "questions.json");
  const good = q({ id: "ok-1" });
  require("node:fs").writeFileSync(
    file,
    JSON.stringify([good, { id: "broken", type: "algo" }, "not-an-object"]),
  );
  process.env.QUIZ_QUESTIONS_FILE = file;
  const loaded = loadQuestions();
  expect(loaded.map((x) => x.id)).toEqual(["ok-1"]);
});
