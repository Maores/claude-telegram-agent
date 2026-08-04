import { test, expect } from "bun:test";
import { speakableText, shouldSpeak, parseVoiceCommand, parseSynthOutput, ttsAvailable } from "./tts.ts";

// --- what gets spoken ------------------------------------------------------

test("URLs are stripped — a link read character by character is unlistenable", () => {
  const out = speakableText("הנה המקור https://www.seret.co.il/movies/x.asp?TID=50 בהצלחה");
  expect(out).not.toContain("http");
  expect(out).not.toContain("seret");
  expect(out).toContain("הנה המקור");
  expect(out).toContain("בהצלחה");
});

test("emoji are dropped rather than read out as names", () => {
  expect(speakableText("סיימתי ✅ הכל בסדר 🎤")).toBe("סיימתי הכל בסדר");
});

test("stray markdown characters are removed", () => {
  expect(speakableText("**חשוב** מאוד `bun run x` ## כותרת")).toBe("חשוב מאוד bun run x כותרת");
});

test("whitespace collapses without gluing words together", () => {
  expect(speakableText("שלום    עולם\n\n\nמה נשמע")).toBe("שלום עולם\nמה נשמע");
});

test("shouldSpeak rejects an answer that is only a link", () => {
  expect(shouldSpeak("https://example.com/a/b/c")).toBe(false);
});

test("shouldSpeak rejects empty and whitespace-only answers", () => {
  expect(shouldSpeak("")).toBe(false);
  expect(shouldSpeak("   \n  ")).toBe(false);
});

test("shouldSpeak rejects an answer past the length cap", () => {
  expect(shouldSpeak("א".repeat(50), 40)).toBe(false);
  expect(shouldSpeak("א".repeat(30), 40)).toBe(true);
});

test("shouldSpeak measures the cleaned text, not the raw answer", () => {
  // A short sentence plus a long URL must still be speakable.
  const raw = "בבקשה " + "https://example.com/" + "x".repeat(200);
  expect(raw.length).toBeGreaterThan(120);
  expect(shouldSpeak(raw, 120)).toBe(true);
});

test("a normal Hebrew answer is spoken", () => {
  expect(shouldSpeak("היי מאור, אין לך אירועים מחר ואין תזכורות פתוחות.")).toBe(true);
});

// --- the /voice command ----------------------------------------------------

test("parseVoiceCommand reads on, off and bare status", () => {
  expect(parseVoiceCommand("/voice on")).toBe("on");
  expect(parseVoiceCommand("/voice off")).toBe("off");
  expect(parseVoiceCommand("/voice")).toBe("status");
  expect(parseVoiceCommand("  /voice   off  ")).toBe("off");
  expect(parseVoiceCommand("/VOICE OFF")).toBe("off");
});

test("parseVoiceCommand ignores ordinary messages and unknown arguments", () => {
  expect(parseVoiceCommand("תפסיק להקליט")).toBeNull();
  expect(parseVoiceCommand("/voices")).toBeNull();
  expect(parseVoiceCommand("/voice maybe")).toBeNull();
  expect(parseVoiceCommand("שלח /voice off")).toBeNull(); // must be the whole message
});

test("parseVoiceCommand honours @botname addressing", () => {
  expect(parseVoiceCommand("/voice@maores_assistant_bot off", "maores_assistant_bot")).toBe("off");
  expect(parseVoiceCommand("/voice@someone_else off", "maores_assistant_bot")).toBeNull();
});

// --- reading the synthesizer's output --------------------------------------

test("parseSynthOutput picks the JSON line out of runtime warnings", () => {
  const stdout = [
    "2026-08-04 W:onnxruntime: some warning about a transpose node",
    "another warning",
    '{"ok": true, "path": "/tmp/a.ogg", "seconds": 7.73}',
  ].join("\n");
  expect(parseSynthOutput(stdout)).toEqual({ path: "/tmp/a.ogg", seconds: 7.73 });
});

test("parseSynthOutput returns null for a reported failure", () => {
  expect(parseSynthOutput('{"ok": false, "error": "empty text"}')).toBeNull();
});

test("parseSynthOutput returns null for garbage or silence", () => {
  expect(parseSynthOutput("")).toBeNull();
  expect(parseSynthOutput("Traceback (most recent call last):")).toBeNull();
  expect(parseSynthOutput("{not json")).toBeNull();
});

// --- graceful absence ------------------------------------------------------

test("ttsAvailable is false when the models are not installed", () => {
  const prev = process.env.TTS_HOME;
  process.env.TTS_HOME = "/nonexistent/tts-home";
  try {
    expect(ttsAvailable()).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.TTS_HOME;
    else process.env.TTS_HOME = prev;
  }
});

test("TTS_DISABLED=1 turns the feature off even with models present", () => {
  const prev = process.env.TTS_DISABLED;
  process.env.TTS_DISABLED = "1";
  try {
    expect(ttsAvailable()).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.TTS_DISABLED;
    else process.env.TTS_DISABLED = prev;
  }
});
