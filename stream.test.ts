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
