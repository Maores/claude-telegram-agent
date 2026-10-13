/**
 * scripts/probe-turn.ts: one Claude turn through the real turn spawn, as the turn user, for the
 * rollout's proofs (deploy/proofs-r5.sh and the R7 probes).
 *
 *   bun run scripts/probe-turn.ts --cwd <dir> (--expect <text> | --expect-output <text> | --reject <text>) [--auto] < prompt
 *
 * Run as claudebot after sourcing the service env file. The turn's argv is the poller's own
 * (claudeTurnArgv under turnSpawn) with TURN_USER forced to agentturn, so a probe runs as the turn
 * user whatever the env file says, and a shell wrapper changes into <dir> before claude starts.
 * TELEGRAM_CHAT_ID and every other non-secret variable pass through from the caller's env as a
 * real turn's do, except SSH_* (the operator's ssh session) and an inherited CLAUDE_AUTO_SESSION.
 * --auto adds the [AUTO] session's flags (its --disallowedTools list and CLAUDE_AUTO_SESSION=1).
 *
 * Prints one verdict line ("probe-turn: OK", "probe-turn: FAILED" or "probe-turn: INCONCLUSIVE"),
 * then on every verdict an "evidence:" block (each tool result of the turn, redacted, one line,
 * capped), then, unless OK, the stream's last 2,000 characters (redacted). Exit 0 OK, 1 FAILED,
 * 3 INCONCLUSIVE, 2 bad arguments or an empty prompt. A turn still running after PROBE_TIMEOUT_MS
 * (default 300000) is stopped and reads INCONCLUSIVE (no result line).
 *
 * Importing poller.ts starts no poller: its main() runs only under import.meta.main. Loading it
 * does register its SIGTERM/SIGINT drain handlers, so the command line below replaces them with
 * its own (stop the turn, then exit).
 */
import { claudeTurnArgv, autoSessionSpawn, killTurnProc } from "../poller";
import { turnSpawn } from "../turnuser";
import { detectUpstreamError } from "../usage";
import { redact } from "../redact";

export const PROBE_USER = "agentturn";
export const TAIL_CHARS = 2000;
export const EVIDENCE_CHARS = 300;
export const EVIDENCE_MAX = 10;

export type Want = { mode: "expect" | "expect-output" | "reject"; text: string };
export type Verdict = "OK" | "FAILED" | "INCONCLUSIVE";
type Env = Record<string, string | undefined>;

export function probeTurnArgv(o: { cwd: string; auto: boolean; env: Env }): { argv: string[]; env: Record<string, string> } {
  // The operator's ssh session (agent socket, client address) has no business in a turn.
  const base = Object.fromEntries(Object.entries(o.env).filter(([k]) => !k.startsWith("SSH_")));
  return turnSpawn(
    ["/bin/sh", "-c", 'cd "$0" && exec "$@"', o.cwd, ...claudeTurnArgv("sonnet", o.auto ? autoSessionSpawn().extraArgs : [], { TURN_USER: PROBE_USER })],
    // undefined is dropped by turnSpawn, so a non-auto probe never passes an inherited value on.
    { ...base, TURN_USER: PROBE_USER, TELEGRAM_TURN_ID: "probe-" + Date.now(), CLAUDE_AUTO_SESSION: o.auto ? "1" : undefined },
  );
}

function contentBlocks(o: any): any[] {
  const c = o?.message?.content;
  return Array.isArray(c) ? c : [];
}

function toolResultTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text as string);
}

type Parsed = { sawResult: boolean; errored: boolean; said: string[]; toolOut: string[] };

/** The searchable parts of one turn's stream-json output (see judge). */
function parseStream(stream: string): Parsed {
  const p: Parsed = { sawResult: false, errored: false, said: [], toolOut: [] };
  for (const raw of stream.split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    let o: any;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    if (o.type === "result") {
      p.sawResult = true;
      if (o.is_error === true || (typeof o.subtype === "string" && o.subtype !== "success")) p.errored = true;
      if (typeof o.result === "string") {
        // An upstream error or an exhausted limit can arrive as an ordinary-looking answer.
        if (detectUpstreamError(o.result)) p.errored = true;
        p.said.push(o.result);
      }
    } else if (o.type === "assistant") {
      for (const b of contentBlocks(o)) if (b?.type === "text" && typeof b.text === "string") p.said.push(b.text);
    } else if (o.type === "user") {
      for (const b of contentBlocks(o)) if (b?.type === "tool_result") p.toolOut.push(...toolResultTexts(b.content));
    }
  }
  return p;
}

/**
 * The verdict on one turn's stream-json output. Each line is parsed as JSON (other lines are
 * skipped), and only these fields are searched, as plain substrings:
 *   - the result line ({"type":"result"}): its `result` string (--expect, --reject);
 *   - assistant messages ({"type":"assistant"}): their `text` blocks (--expect, --reject);
 *   - user messages ({"type":"user"}): the content of their `tool_result` blocks, which is where
 *     a command's output and a hook's or a rule's refusal come back to the model (all modes;
 *     --expect-output searches these only, so the model's own words can never satisfy it).
 * Never searched: tool_use inputs (so a token that only appears in a command the model was asked
 * to run cannot satisfy an expectation, and the command itself cannot fail --reject),
 * stream_event partial deltas (they repeat the text and carry tool inputs as input_json_delta),
 * thinking blocks, user text, and the init line (it names the cwd).
 *
 * No result line (the turn was cut off or never started): INCONCLUSIVE. Otherwise found text
 * decides (an expectation found: OK; --reject found: FAILED); absent text decides only for a
 * turn that ended well (an expectation: FAILED, --reject: OK), and is INCONCLUSIVE after an
 * error result (is_error, a subtype other than "success", or a result text that usage.ts's
 * detectUpstreamError recognises), since a turn that failed proves no absence.
 */
export function judge(stream: string, want: Want): Verdict {
  const p = parseStream(stream);
  if (!p.sawResult) return "INCONCLUSIVE";
  const haystack = want.mode === "expect-output" ? p.toolOut : [...p.said, ...p.toolOut];
  const found = haystack.some((t) => t.includes(want.text));
  if (want.mode === "reject") return found ? "FAILED" : p.errored ? "INCONCLUSIVE" : "OK";
  return found ? "OK" : p.errored ? "INCONCLUSIVE" : "FAILED";
}

/** Every tool result of the turn, for the operator to read the decision from: each redacted,
 *  capped at EVIDENCE_CHARS and printed as one JSON string, at most EVIDENCE_MAX of them. */
export function evidenceBlock(toolOut: string[]): string {
  if (!toolOut.length) return "evidence: no tool results";
  const lines = [`evidence: ${toolOut.length} tool result${toolOut.length === 1 ? "" : "s"}`];
  toolOut.slice(0, EVIDENCE_MAX).forEach((t, i) => lines.push(`  [${i + 1}] ${JSON.stringify(redact(t).slice(0, EVIDENCE_CHARS))}`));
  if (toolOut.length > EVIDENCE_MAX) lines.push(`  (${toolOut.length - EVIDENCE_MAX} more not shown)`);
  return lines.join("\n");
}

const USAGE = "usage: bun run scripts/probe-turn.ts --cwd <dir> (--expect <text> | --expect-output <text> | --reject <text>) [--auto] < prompt";
const MODES: Record<string, Want["mode"]> = { "--expect": "expect", "--expect-output": "expect-output", "--reject": "reject" };

/** The parsed command line, or a message saying what is wrong with it. */
export function parseProbeArgs(args: string[]): { cwd: string; want: Want; auto: boolean } | string {
  let cwd: string | null = null;
  let want: Want | null = null;
  let auto = false;
  const one = "give exactly one of --expect, --expect-output and --reject";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--auto") {
      auto = true;
      continue;
    }
    if (a !== "--cwd" && !MODES[a]) return `unknown argument: ${a}`;
    const v = args[++i];
    if (v === undefined || v === "") return `${a} needs a non-empty value`;
    if (a === "--cwd") {
      if (cwd !== null) return "--cwd given twice";
      cwd = v;
    } else {
      if (want) return one;
      want = { mode: MODES[a], text: v };
    }
  }
  if (cwd === null) return "--cwd is required";
  if (!want) return one;
  return { cwd, want, auto };
}

export interface ProbeDeps {
  env: Env;
  readPrompt: () => Promise<string>;
  /** Runs the turn with the prompt on stdin and returns its stdout. */
  run: (argv: string[], env: Record<string, string>, prompt: string) => Promise<string>;
  print: (s: string) => void;
  err: (s: string) => void;
}

/** The whole command: returns the exit code. */
export async function runProbe(args: string[], deps: ProbeDeps): Promise<number> {
  const p = parseProbeArgs(args);
  if (typeof p === "string") {
    deps.err(`probe-turn: ${p}\n${USAGE}`);
    return 2;
  }
  const prompt = await deps.readPrompt();
  if (!prompt.trim()) {
    deps.err(`probe-turn: the prompt on stdin is empty\n${USAGE}`);
    return 2;
  }
  const ts = probeTurnArgv({ cwd: p.cwd, auto: p.auto, env: deps.env });
  const out = await deps.run(ts.argv, ts.env, prompt);
  const v = judge(out, p.want);
  deps.print(`probe-turn: ${v}`);
  deps.print(evidenceBlock(parseStream(out).toolOut));
  // Redacted before slicing, so a secret cut by the slice is still masked whole.
  if (v !== "OK") deps.print(redact(out).slice(-TAIL_CHARS));
  return v === "OK" ? 0 : v === "FAILED" ? 1 : 3;
}

// --- the real run ------------------------------------------------------------------------------

const STOP_ENV = { TURN_USER: PROBE_USER }; // killTurnProc signals the turn's processes as this user
let current: import("bun").Subprocess | null = null;

async function spawnTurn(argv: string[], env: Record<string, string>, prompt: string): Promise<string> {
  const ms = Number(process.env.PROBE_TIMEOUT_MS) || 300_000;
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "inherit", env });
  current = proc;
  proc.stdin.write(prompt);
  proc.stdin.end();
  let out = "";
  const dec = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of proc.stdout) out += dec.decode(chunk, { stream: true });
    out += dec.decode();
  })();
  const finished = Promise.all([reading, proc.exited]).then(() => true);
  if (!(await Promise.race([finished, Bun.sleep(ms).then(() => false)]))) {
    console.error(`probe-turn: the turn ran past ${ms} ms; stopping it`);
    await killTurnProc(proc, undefined, STOP_ENV);
    await Promise.race([finished, Bun.sleep(15_000)]);
  }
  current = null;
  return out;
}

if (import.meta.main) {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.removeAllListeners(sig); // poller.ts's drain handlers would keep this process alive
    process.on(sig, () => {
      const proc = current;
      void (proc ? killTurnProc(proc, undefined, STOP_ENV) : Promise.resolve()).finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
    });
  }
  const code = await runProbe(process.argv.slice(2), {
    env: process.env,
    readPrompt: () => Bun.stdin.text(),
    run: spawnTurn,
    print: (s) => console.log(s),
    err: (s) => console.error(s),
  });
  process.exit(code);
}
