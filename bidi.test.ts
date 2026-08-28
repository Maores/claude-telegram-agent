import { test, expect } from "bun:test";
import { isolateLatin, stripIsolates, FSI, PDI } from "./bidi.ts";

test("pure Hebrew text is left untouched", () => {
  const t = "תזכורת: לקנות חלב ומכונת אספרסו מחר בבוקר";
  expect(isolateLatin(t)).toBe(t);
});

test("pure English text is left untouched (nothing to scramble)", () => {
  const t = "Reminder: buy espresso machine tomorrow";
  expect(isolateLatin(t)).toBe(t);
});

test("wraps a mid-sentence English word inside a Hebrew line", () => {
  const t = "פיצ'ר ה-streaming מאפשר קריאה חלקה";
  const out = isolateLatin(t);
  expect(out).toContain(FSI + "streaming" + PDI);
  expect(stripIsolates(out)).toBe(t);
});

test("wraps a command embedded in a Hebrew line", () => {
  const t = "הרץ את bun run cal.ts list כדי לראות";
  const out = isolateLatin(t);
  expect(out).toContain(FSI + "bun run cal.ts list" + PDI);
});

test("wraps a URL embedded in a Hebrew line", () => {
  const t = "המקור: https://a.co/b?c=1 לפרטים נוספים";
  const out = isolateLatin(t);
  expect(out).toContain(FSI + "https://a.co/b?c=1" + PDI);
});

test("digit-only runs (dates, times) are not wrapped", () => {
  const t = "ניפגש ב-23/12 בשעה 08:30-11:30";
  const out = isolateLatin(t);
  expect(out).toBe(t);
});

test("a URL alone on its own line is untouched (no RTL char on that line)", () => {
  const t = "המקור בקישור הבא:\nhttps://a.co/b?c=1";
  const out = isolateLatin(t);
  const lines = out.split("\n");
  expect(lines[1]).toBe("https://a.co/b?c=1");
});

test("each line is isolated independently, other lines with no RTL are untouched", () => {
  const t = "שורה עברית עם streaming\nEnglish only line here";
  const out = isolateLatin(t);
  const lines = out.split("\n");
  expect(lines[0]).toContain(FSI + "streaming" + PDI);
  expect(lines[1]).toBe("English only line here");
});

test("text that already carries isolate controls is left alone (no double-wrap)", () => {
  const t = `כבר עטוף: ${FSI}streaming${PDI} כאן`;
  expect(isolateLatin(t)).toBe(t);
});

test("empty string is returned as-is", () => {
  expect(isolateLatin("")).toBe("");
});

test("maxLength guard: falls back to original when wrapping would exceed the limit", () => {
  const t = "שורה עברית עם streaming ועוד טקסט";
  const wrapped = isolateLatin(t);
  expect(wrapped.length).toBeGreaterThan(t.length);
  // A limit set below the wrapped length must return the untouched original.
  const out = isolateLatin(t, t.length);
  expect(out).toBe(t);
});

test("maxLength guard: does not trigger when the wrapped text fits", () => {
  const t = "שורה עברית עם streaming ועוד טקסט";
  const out = isolateLatin(t, 4096);
  expect(out).not.toBe(t);
});

test("stripIsolates removes all four isolate control characters", () => {
  const LRI = String.fromCharCode(0x2066);
  const RLI = String.fromCharCode(0x2067);
  const t = `כבר עטוף: ${LRI}bidi${PDI} ו ${RLI}FSI${PDI} כאן`;
  const out = stripIsolates(t);
  expect(out).toBe("כבר עטוף: bidi ו FSI כאן");
});
