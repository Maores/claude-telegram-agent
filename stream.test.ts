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

// --- pre-tool narration must not reach the reply (2026-08-04) --------------

test("a tool call drops the narration the model wrote before it", () => {
  const p = new StreamParser();
  p.push(textDelta("I'll check current pricing before answering."));
  p.push(toolStart("WebSearch"));
  expect(displayText(p.state())).toBe("🔍 searching the web…"); // narration off screen
  p.push(textDelta("יש כיוון שפספסתי קודם."));
  expect(p.finalText()).toBe("יש כיוון שפספסתי קודם.");
});

test("pre-tool text is never welded onto the answer that follows it", () => {
  const p = new StreamParser();
  p.push(textDelta("I'll check the file now."));
  p.push(toolStart("Read"));
  p.push(textDelta("הקובץ ריק."));
  const out = p.finalText();
  expect(out).not.toContain("I'll check");
  expect(out).not.toContain("now.הקובץ"); // the exact glued shape Maor saw
});

test("only the last segment survives across several tool rounds", () => {
  const p = new StreamParser();
  p.push(textDelta("Let me look."));
  p.push(toolStart("Read"));
  p.push(textDelta("Now searching."));
  p.push(toolStart("WebSearch"));
  p.push(textDelta("final answer"));
  expect(p.finalText()).toBe("final answer");
});

test("text before the only tool call survives when nothing streams after it", () => {
  const p = new StreamParser();
  p.push(textDelta("הנה התשובה."));
  p.push(toolStart("Bash"));
  p.push(JSON.stringify({ type: "result", result: "" }));
  expect(p.finalText()).toBe("הנה התשובה."); // fallback beats an empty reply
});

test("tool_use seen only in the assistant event also resets the segment", () => {
  const p = new StreamParser();
  p.push(textDelta("narration"));
  p.push(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
  );
  p.push(textDelta("answer"));
  expect(p.finalText()).toBe("answer");
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
