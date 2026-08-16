import { test, expect } from "bun:test";
import { StreamParser, toolLabel, displayText } from "./stream.ts";

// helper: wrap an Anthropic stream event the way claude -p does
const ev = (event: any) => JSON.stringify({ type: "stream_event", event });
const textDelta = (t: string) => ev({ type: "content_block_delta", delta: { type: "text_delta", text: t } });
const thinkingDelta = () => ev({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "…" } });
const toolStart = (name: string) =>
  ev({ type: "content_block_start", content_block: { type: "tool_use", name } });

test("accumulates text_delta into the answer and clears status", () => {
  const p = new StreamParser();
  p.push(textDelta("Hello "));
  p.push(textDelta("world"));
  expect(p.text).toBe("Hello world");
  expect(p.status).toBeNull();
});

test("starts in a thinking state and stays there while only thinking", () => {
  const p = new StreamParser();
  expect(p.status).toBe("💭 thinking…");
  p.push(thinkingDelta());
  expect(p.status).toBe("💭 thinking…");
  expect(p.text).toBe("");
});

test("tool_use start sets a friendly status", () => {
  const p = new StreamParser();
  p.push(toolStart("WebSearch"));
  expect(p.status).toBe("🔍 searching the web…");
});

test("result marks done and supplies a final-text fallback", () => {
  const p = new StreamParser();
  p.push(JSON.stringify({ type: "result", subtype: "success", result: "final answer" }));
  expect(p.done).toBe(true);
  expect(p.status).toBeNull();
  expect(p.finalText()).toBe("final answer");
});

test("captures cost + token usage from the result event (#5)", () => {
  const p = new StreamParser();
  p.push(
    JSON.stringify({
      type: "result",
      result: "ok",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 1500, output_tokens: 200 },
    }),
  );
  expect(p.usage()).toEqual({ costUsd: 0.0123, inputTokens: 1500, outputTokens: 200 });
});

test("usage stays null when the result event omits cost/usage (fail-safe)", () => {
  const p = new StreamParser();
  p.push(JSON.stringify({ type: "result", result: "ok" }));
  expect(p.usage()).toEqual({ costUsd: null, inputTokens: null, outputTokens: null });
});

test("finalText prefers streamed text over the result event", () => {
  const p = new StreamParser();
  p.push(textDelta("streamed answer"));
  p.push(JSON.stringify({ type: "result", result: "ignored" }));
  expect(p.finalText()).toBe("streamed answer");
});

test("ignores malformed, empty, and unknown lines", () => {
  const p = new StreamParser();
  p.push("not json");
  p.push("   ");
  p.push(JSON.stringify({ type: "system", subtype: "init" }));
  p.push(JSON.stringify({ type: "rate_limit_event" }));
  expect(p.text).toBe("");
  expect(p.done).toBe(false);
});

test("full sequence thinking -> tool -> text -> done", () => {
  const p = new StreamParser();
  p.push(thinkingDelta());
  expect(displayText(p.state())).toBe("💭 thinking…");
  p.push(toolStart("WebSearch"));
  expect(displayText(p.state())).toBe("🔍 searching the web…");
  p.push(textDelta("Here "));
  p.push(textDelta("it is."));
  expect(displayText(p.state())).toBe("Here it is.");
  p.push(JSON.stringify({ type: "result", result: "Here it is." }));
  expect(p.done).toBe(true);
  expect(p.finalText()).toBe("Here it is.");
});

// --- opening narration must not reach the reply (2026-08-04) ---------------
// Only the segment before the FIRST tool call is dropped. The earlier attempt
// (PR #71, reverted) kept only the segment after the LAST tool call and threw
// away real answers — archive reply 962 is the shape that caught it.

test("the narration before the first tool call is dropped", () => {
  const p = new StreamParser();
  p.push(textDelta("I'll check current pricing before answering."));
  p.push(toolStart("WebSearch"));
  expect(displayText(p.state())).toBe("🔍 searching the web…"); // narration off screen
  p.push(textDelta("יש כיוון שפספסתי קודם."));
  expect(p.finalText()).toBe("יש כיוון שפספסתי קודם.");
});

test("opening narration is never welded onto the answer that follows", () => {
  const p = new StreamParser();
  p.push(textDelta("I'll check the file now."));
  p.push(toolStart("Read"));
  p.push(textDelta("הקובץ ריק."));
  const out = p.finalText();
  expect(out).not.toContain("I'll check");
  expect(out).not.toContain("now.הקובץ"); // the exact glued shape Maor saw
});

test("reply 962: a mid-turn answer survives a later tool call", () => {
  const p = new StreamParser();
  p.push(textDelta('Found it — "pending" is the open status. Now let me tell Maor…'));
  p.push(toolStart("Bash")); // reopens the follow-up
  p.push(textDelta('"לשמוע את ההקלטה של מתן" חזר לפתוח אצלי.'));
  p.push(toolStart("Bash")); // checks whether to offer buttons
  p.push(textDelta("כבר שאלתי בטקסט - אין צורך בכפתורים כאן."));

  const out = p.finalText();
  expect(out).toContain("חזר לפתוח אצלי"); // the answer itself, the part #71 lost
  expect(out).not.toContain("Found it"); // opening narration still dropped
  expect(out).toBe('"לשמוע את ההקלטה של מתן" חזר לפתוח אצלי.\n\nכבר שאלתי בטקסט - אין צורך בכפתורים כאן.');
});

test("segments after the first tool are joined with a blank line, never glued", () => {
  const p = new StreamParser();
  p.push(textDelta("narration"));
  p.push(toolStart("Read"));
  p.push(textDelta("first part."));
  p.push(toolStart("Bash"));
  p.push(textDelta("second part."));
  expect(p.finalText()).toBe("first part.\n\nsecond part.");
});

test("live view shows every kept segment, not just the newest", () => {
  const p = new StreamParser();
  p.push(textDelta("narration"));
  p.push(toolStart("Read"));
  p.push(textDelta("first part."));
  p.push(toolStart("Bash"));
  p.push(textDelta("second part."));
  expect(displayText(p.state())).toBe("first part.\n\nsecond part.");
});

test("a turn that only narrates still sends something rather than nothing", () => {
  const p = new StreamParser();
  p.push(textDelta("הנה התשובה."));
  p.push(toolStart("Bash"));
  p.push(JSON.stringify({ type: "result", result: "" }));
  expect(p.finalText()).toBe("הנה התשובה."); // last-resort fallback
});

test("text with no tool call at all is untouched", () => {
  const p = new StreamParser();
  p.push(textDelta("שלום, "));
  p.push(textDelta("מה נשמע?"));
  expect(p.finalText()).toBe("שלום, מה נשמע?");
});

test("seeing the same tool twice (block start, then assistant event) is harmless", () => {
  const p = new StreamParser();
  p.push(textDelta("narration"));
  p.push(toolStart("Bash"));
  p.push(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
  );
  p.push(textDelta("answer"));
  expect(p.finalText()).toBe("answer"); // not "narration\n\nanswer"
});

test("tool_use in a complete assistant event also sets status", () => {
  const p = new StreamParser();
  p.push(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "mcp__claude_ai_Gmail__search" }] },
    }),
  );
  expect(p.status).toBe("📧 checking email…");
});

test("toolLabel maps known tools and falls back", () => {
  expect(toolLabel("WebSearch")).toContain("searching");
  expect(toolLabel("WebFetch")).toContain("reading");
  expect(toolLabel("mcp__x_Gmail__list")).toContain("email");
  expect(toolLabel("mcp__x_Google_Drive__list")).toContain("Drive");
  expect(toolLabel("mcp__x_Google_Calendar__events")).toContain("calendar");
  expect(toolLabel("Bash")).toBe("⚙️ working…");
  expect(toolLabel("MysteryTool")).toBe("🔧 working…");
});

test("displayText: text wins, else status, else ellipsis", () => {
  expect(displayText({ status: "💭 thinking…", text: "", done: false })).toBe("💭 thinking…");
  expect(displayText({ status: null, text: "", done: false })).toBe("…");
  expect(displayText({ status: "🔍 …", text: "answer", done: true })).toBe("answer");
});

// --- English self-narration scrub (2026-08-16) ------------------------------
// Every MATCH case below is a real reply from the archive that shipped to
// Maor with narration in it; the scrub must clean it. Every KEEP case is a
// shape the scrub must never touch — above all, English deliverables inside
// Hebrew replies and genuinely English conversations.

import { stripNarration } from "./stream.ts";

test("archive #1286: no-tool turn, English classification before the answer", () => {
  const out = stripNarration("Popcorn direct question, no need for tools.\nעוצמה 10 (מקסימום) זה נכון לפופקורן.");
  expect(out).toBe("עוצמה 10 (מקסימום) זה נכון לפופקורן.");
});

test("archive #1340: 'this is a question, just answering' paragraph is dropped", () => {
  const out = stripNarration(
    "This is a factual/casual explanation question, not a task — just answering directly.\n\nMarketing naming, plain and simple: MagSafe זה תכונה בפועל.",
  );
  expect(out).toBe("Marketing naming, plain and simple: MagSafe זה תכונה בפועל.");
});

test("archive #1348: kept-segment narration welded to the Hebrew answer", () => {
  const out = stripNarration("Found it, it's an Apple Reminders task. I'll add eggs and milk to it.  עדכנתי את המשימה.");
  expect(out).toBe("עדכנתי את המשימה.");
});

test("archive #1196: interior 'Now let me / Now I'll' lines vanish", () => {
  const out = stripNarration(
    "Now let me look at guard.test.ts style for the test format to match conventions, then write the new module.\n\nNow I'll create the detection module.\n\nהמודול מוכן.",
  );
  expect(out).toBe("המודול מוכן.");
});

test("archive #1252: leading progress mutter on a mixed line", () => {
  const out = stripNarration("Loaded the structure. עכשיו רק תגיד לי את הרעיון של הסצנה.");
  expect(out).toBe("עכשיו רק תגיד לי את הרעיון של הסצנה.");
});

test("archive #1206: trailing 'Let me verify…' announce is cut, the answer stays", () => {
  const out = stripNarration("זה השלט של פרטנר, דגם JADE. This is the Partner TV JADE remote. Let me verify the exact steps for it.");
  expect(out).toBe("זה השלט של פרטנר, דגם JADE. This is the Partner TV JADE remote.");
});

test("reply 962's welded shape: narration peels off, the Hebrew answer survives", () => {
  const out = stripNarration('Found it — "pending" is the open status. Now let me tell Maor his voice note cut off while I wait."לשמוע את ההקלטה של מתן" חזר לפתוח אצלי.');
  expect(out).toBe('"לשמוע את ההקלטה של מתן" חזר לפתוח אצלי.');
});

test("an all-English reply is untouched — English conversations are not narration", () => {
  const t = "I'll check the calendar and get back to you.\nDone means done.";
  expect(stripNarration(t)).toBe(t);
});

test("archive #1266: an English deliverable inside a Hebrew turn survives whole", () => {
  const t = "הנה הפרומפט:\n\nTask: text-to-video with native audio (T2VA). 15s, 24fps, 16:9.\nMockumentary single-camera sitcom look. Flat fluorescent lighting.";
  expect(stripNarration(t)).toBe(t);
});

test("'Let me know' is an answer closer, never narration", () => {
  const t = "המחיר 727 שקל.\nLet me know if you want the link.";
  expect(stripNarration(t)).toBe(t);
});

test("a source URL line is never dropped", () => {
  const t = "השער 3.71 שקל.\nsource: https://api.frankfurter.dev/v1/latest";
  expect(stripNarration(t)).toBe(t);
});

test("scrub is idempotent", () => {
  const once = stripNarration("Loaded the structure. עכשיו תגיד לי.");
  expect(stripNarration(once)).toBe(once);
});

test("end-to-end: a no-tool turn arrives clean through finalText", () => {
  const p = new StreamParser();
  p.push(textDelta("Popcorn direct question, no need for tools.\n"));
  p.push(textDelta("עוצמה 10 זה נכון."));
  p.push(JSON.stringify({ type: "result", subtype: "success" }));
  expect(p.finalText()).toBe("עוצמה 10 זה נכון.");
});

test("end-to-end: kept-segment narration between tools is scrubbed", () => {
  const p = new StreamParser();
  p.push(textDelta("Checking the task list first."));
  p.push(toolStart("Bash"));
  p.push(textDelta("Found it, it's an Apple Reminders task. I'll add eggs and milk to it."));
  p.push(toolStart("Bash"));
  p.push(textDelta("עדכנתי את המשימה."));
  expect(p.finalText()).toBe("עדכנתי את המשימה.");
});

test("the never-empty guarantee holds: pure-narration turn falls back to the opening", () => {
  const p = new StreamParser();
  p.push(textDelta("I'll check the calendar now."));
  p.push(toolStart("Bash"));
  p.push(JSON.stringify({ type: "result", subtype: "success" }));
  // no Hebrew anywhere → scrub is a no-op → the opening fallback still shows
  expect(p.finalText()).toBe("I'll check the calendar now.");
});
