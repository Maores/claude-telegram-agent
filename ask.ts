/**
 * ask.ts — register a multiple-choice clarify question (D3 choice buttons).
 *   bun run ask.ts choice --question "..." --option "A" --option "B" [--option "C"] [--option "D"] [--allow-other]
 *
 * The model calls this to ASK Maor something with a small set of discrete
 * answers. Chat id comes from $TELEGRAM_CHAT_ID, turn id from $TELEGRAM_TURN_ID
 * (both injected by the poller). After this runs, the poller renders one inline
 * button per option AFTER the reply streams; tapping one feeds that option to a
 * fresh claude turn. This NEVER sends anything itself.
 *
 * A clarify question runs nothing, so there is no argv gate (unlike confirm.ts);
 * the tapped option is treated as untrusted user text on the next turn.
 */
import { proposeChoice } from "./choices.ts";
import { newTurnId } from "./pending.ts";

function envChat(): number {
  const n = Number(process.env.TELEGRAM_CHAT_ID);
  if (!Number.isFinite(n) || n === 0) throw new Error("TELEGRAM_CHAT_ID is not set");
  return n;
}

/** Parse flags, collecting REPEATED --option into an array (confirm.ts's
 *  single-value parser can't, so this is hand-rolled). */
function parse(args: string[]): { question?: string; options: string[]; allowOther: boolean } {
  let question: string | undefined;
  const options: string[] = [];
  let allowOther = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--question") question = args[++i];
    else if (a === "--option") {
      const v = args[++i];
      if (v !== undefined) options.push(v);
    } else if (a === "--allow-other") allowOther = true;
  }
  return { question, options, allowOther };
}

const nowS = () => Math.floor(Date.now() / 1000);
const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "choice") {
    // Defense in depth: an unattended [AUTO] run has no human to tap a button.
    // (Also blocked at the tool layer via AUTO_DISALLOWED_TOOLS + the guard hook.)
    if (process.env.CLAUDE_AUTO_SESSION === "1") {
      throw new Error("[AUTO] sessions may not ask choice questions — there is no human to tap a button");
    }
    const { question, options, allowOther } = parse(rest);
    if (!question) {
      throw new Error('usage: ask.ts choice --question "..." --option "A" --option "B" [--option ...] [--allow-other]');
    }
    if (options.length < 2 || options.length > 4) {
      throw new Error("a choice needs between 2 and 4 --option values");
    }
    const turnId = process.env.TELEGRAM_TURN_ID ?? newTurnId();
    const c = proposeChoice(
      envChat(),
      question.slice(0, 1000),
      options.map((o) => o.slice(0, 100)),
      allowOther,
      turnId,
      nowS(),
    );
    console.log(`(choice buttons will appear after this reply) — registered ${c.id}`);
  } else {
    throw new Error('usage: ask.ts choice --question "..." --option "A" --option "B" [--option ...] [--allow-other]');
  }
} catch (e: any) {
  console.error(`ask error: ${e?.message ?? e}`);
  process.exit(1);
}
