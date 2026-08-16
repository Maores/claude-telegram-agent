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

// --- English self-narration scrub (2026-08-16) ------------------------------
//
// The first-tool drop above only catches narration BEFORE the first tool call.
// A 120-reply archive scan found ~9 replies still opening in English inside a
// Hebrew conversation, all one of two shapes the position rule cannot see:
// a turn that calls no tools at all ("Popcorn direct question, no need for
// tools. עוצמה 10…", #1286), and narration in a KEPT segment between tool
// calls ("Found it, it's an Apple Reminders task. I'll add eggs and milk to
// it. עדכנתי…", #1348).
//
// The rule here is content-based but built so it can never repeat PR #71's
// mistake (dropping a real answer):
//   - it does nothing unless the reply contains Hebrew, so an all-English
//     conversation is untouched;
//   - it only ever removes English text, sentence by sentence, and only
//     sentences matching the narration patterns below — Hebrew can never be
//     dropped, so the reply can never come out empty;
//   - patterns are announce-shaped ("Let me…", "I'll check…", "Found it",
//     "no need for tools", "tell Maor") rather than topical, so an English
//     DELIVERABLE inside a Hebrew reply (a video prompt, a source list)
//     survives — its lines don't announce process.
// Known limit, deliberate: a mixed sentence ("Merged את הגרסה…") and a bare
// "Now the unit tests:" are left alone — both patterns also appear in real
// English deliverables, and a stray word is cheaper than a lost answer.

const HEBREW_RE = /[֐-׿]/;

const NARRATION_RES: RegExp[] = [
  // announcing the next step: "Let me propose…", "Now let me look at…"
  /^(?:now[,\s]+)?(?:let me|let['’]s)\s+(?!know\b)\w+/i,
  // "I'll add…", "Now I will check…" — process verbs only, so an English
  // sentence that happens to start with "I'll" but isn't about tooling stays
  /^(?:now\s+)?i['’]?(?:ll|\s+will|['’]m\s+(?:going|about)\s+to)\s+(?:check|look|read|load|verify|propose|create|write|run|search|add|register|show|make|start|test|tell|see|find|use|open|fetch|grab|pull|update|answer|handle|edit|save|delete|remove|list|query|scan|review|compare|merge)\b/i,
  // progress mutters: "Found it — …", "Loaded the structure.", "Got it."
  /^(?:found it|got it|loaded|done|ok(?:ay)?)\b/i,
  // classifying the request instead of answering it
  /^this is (?:a|an)\b.{0,60}\b(?:question|task|request)\b/i,
  /\b(?:direct|simple|factual|quick|casual|straightforward)\s+(?:question|answer|explanation)\b/i,
  /\bno need for (?:tools|buttons|a tool)\b/i,
  // talking ABOUT Maor in third person is never talking TO him
  /\b(?:tell|telling|ask|asking)\s+maor\b/i,
];

const isNarrationFragment = (f: string): boolean => NARRATION_RES.some((re) => re.test(f.trim()));

// A leading English sentence: no Hebrew, ends with punctuation, and is
// followed by whitespace, end-of-line, or (the welded case, reply 962's
// "…while I wait."לשמוע…") a Hebrew letter, possibly behind an opening quote.
// The quote is looked past, never consumed — in the welded case it belongs to
// the Hebrew answer, and eating it would ship the answer missing its quote.
const LEAD_SENTENCE_RE = /^([^֐-׿]{2,300}?[.!?:])(?:\s+|(?=["'”’)]*[֐-׿])|$)/;

/** Remove English self-narration sentences from a reply that is otherwise
 *  Hebrew. Pure; idempotent; returns the input unchanged when the reply has
 *  no Hebrew at all (an English conversation is indistinguishable from
 *  narration, so it is left alone). */
export function stripNarration(text: string): string {
  if (!HEBREW_RE.test(text)) return text;

  const lines = text.split("\n").map((line) => {
    let s = line;
    // leading narration sentences, one at a time, stop at the first real one
    for (;;) {
      const m = s.match(LEAD_SENTENCE_RE);
      if (!m || !isNarrationFragment(m[1])) break;
      s = s.slice(m[0].length);
    }
    // trailing narration sentences ("…40/א). Let me propose the event."):
    // take the tail after the last sentence boundary; cut it if it announces
    for (;;) {
      const b = [...s.matchAll(/[.!?:]["'”’)]*\s+(?=\S)/g)];
      if (!b.length) break;
      const last = b[b.length - 1];
      const tail = s.slice(last.index! + last[0].length);
      if (HEBREW_RE.test(tail) || !tail.trim() || !isNarrationFragment(tail)) break;
      s = s.slice(0, last.index! + last[0].length).trimEnd();
    }
    // a line that was narration through and through drops entirely
    return isNarrationFragment(s) && !HEBREW_RE.test(s) ? "" : s;
  });

  // collapse the blank runs left where whole lines were dropped
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
   *  narration should still say something rather than arrive empty). The
   *  narration scrub runs on whichever wins; it is a no-op on Hebrew-free text,
   *  so the opening fallback (which IS narration, kept deliberately) survives. */
  finalText(): string {
    return stripNarration(this.keptText() || (this.result ?? "").trim() || this.opening);
  }

  /** Cost + token usage from the result event, or nulls if not reported. */
  usage(): { costUsd: number | null; inputTokens: number | null; outputTokens: number | null } {
    return { costUsd: this.costUsd, inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }

  state(): RenderState {
    // Scrubbed live too, so a narration line vanishes from the Telegram edit
    // stream the same way pre-tool narration always has, instead of showing
    // until the final edit and then blinking away.
    return { status: this.status, text: stripNarration(this.keptText()), done: this.done };
  }
}

/** What a Telegram message should show for the given state. */
export function displayText(s: RenderState): string {
  if (s.text) return s.text;
  return s.status ?? "…";
}
