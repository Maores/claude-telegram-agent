/**
 * stream.ts — parses `claude -p --output-format stream-json --include-partial-messages`
 * NDJSON into a simple render state: a one-line status (thinking / using a tool) and
 * the answer text accumulated so far.
 *
 * Pure logic, no I/O — the poller feeds it lines and renders the state to Telegram.
 */

export interface RenderState {
  status: string | null; // e.g. "💭 thinking…" / "🔍 searching the web…", or null once text flows
  text: string; // answer text so far
  done: boolean;
}

const TOOL_LABELS: Record<string, string> = {
  WebSearch: "🔍 searching the web…",
  WebFetch: "🌐 reading a page…",
  Bash: "⚙️ working…",
  Read: "📄 reading…",
  Write: "✍️ writing…",
  Edit: "✍️ editing…",
};

/** Map a tool name (built-in or MCP) to a friendly status line. */
export function toolLabel(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  const n = name.toLowerCase();
  if (n.includes("gmail") || n.includes("mail")) return "📧 checking email…";
  if (n.includes("drive")) return "📁 looking in Drive…";
  if (n.includes("calendar")) return "📅 checking the calendar…";
  if (n.includes("search")) return "🔍 searching…";
  return "🔧 working…";
}

export class StreamParser {
  status: string | null = "💭 thinking…";
  /** The segment being streamed right now (since the last tool call). */
  text = "";
  done = false;
  private result: string | null = null;
  /** Completed segments after the first tool call, oldest first. */
  private segments: string[] = [];
  /** Whether a tool has been called yet this turn. */
  private sawTool = false;
  /** Narration dropped from before the first tool call. Fallback only, for a
   *  turn that produces nothing else at all. */
  private opening = "";
  // Usage from the terminal result event (agenda #5). Null when claude -p doesn't
  // report them or the format changes — callers must treat these as optional.
  costUsd: number | null = null;
  inputTokens: number | null = null;
  outputTokens: number | null = null;

  /** A tool call closes the current answer segment.
   *
   *  Only the segment before the FIRST tool call is dropped. That one is the
   *  model announcing what it is about to do ("I'll check the calendar…"), which
   *  used to ship to Telegram welded onto the Hebrew answer with no separator,
   *  in about one reply in eleven. Every later segment is kept and joined with a
   *  blank line, because by then the model is answering, not announcing.
   *
   *  The first attempt at this (PR #71, reverted) kept only the segment after
   *  the LAST tool call, which also threw away real answers: archive reply 962
   *  went narration, tool, the actual answer, tool, a trailing note, and would
   *  have shipped the trailing note alone. Dropping an answer is worse than
   *  printing a stray English line, so the rule stays narrow on purpose. */
  private beginTool(name: string): void {
    this.status = toolLabel(name);
    const seg = this.text.trim();
    this.text = "";
    if (!this.sawTool) {
      this.sawTool = true;
      this.opening = seg; // dropped from the answer, kept only as a last resort
      return;
    }
    if (seg) this.segments.push(seg);
  }

  /** Every kept segment joined — what the reply should show, live and final. */
  private keptText(): string {
    return [...this.segments, this.text.trim()].filter(Boolean).join("\n\n");
  }

  /** Feed one NDJSON line. Malformed/unknown lines are ignored. */
  push(line: string): void {
    const s = line.trim();
    if (!s) return;
    let o: any;
    try {
      o = JSON.parse(s);
    } catch {
      return;
    }

    if (o.type === "result") {
      if (typeof o.result === "string") this.result = o.result;
      if (typeof o.total_cost_usd === "number") this.costUsd = o.total_cost_usd;
      const u = o.usage;
      if (u && typeof u === "object") {
        if (typeof u.input_tokens === "number") this.inputTokens = u.input_tokens;
        if (typeof u.output_tokens === "number") this.outputTokens = u.output_tokens;
      }
      this.done = true;
      this.status = null;
      return;
    }
    if (o.type === "assistant") {
      for (const b of o.message?.content ?? []) {
        if (b?.type === "tool_use" && b.name) this.beginTool(b.name);
      }
      return;
    }
    if (o.type === "stream_event") {
      const ev = o.event;
      if (!ev) return;
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        this.beginTool(ev.content_block.name ?? "");
      } else if (ev.type === "content_block_delta") {
        const d = ev.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          this.text += d.text;
          this.status = null; // the answer is flowing — drop the status line
        } else if (d?.type === "thinking_delta" && !this.text) {
          this.status = "💭 thinking…";
        }
      }
    }
  }

  /** Best final answer: every kept segment, falling back to the result event's
   *  text, and last of all to the dropped opening (a turn that said nothing but
   *  narration should still say something rather than arrive empty). */
  finalText(): string {
    return this.keptText() || (this.result ?? "").trim() || this.opening;
  }

  /** Cost + token usage from the result event, or nulls if not reported. */
  usage(): { costUsd: number | null; inputTokens: number | null; outputTokens: number | null } {
    return { costUsd: this.costUsd, inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }

  state(): RenderState {
    return { status: this.status, text: this.keptText(), done: this.done };
  }
}

/** What a Telegram message should show for the given state. */
export function displayText(s: RenderState): string {
  if (s.text) return s.text;
  return s.status ?? "…";
}
