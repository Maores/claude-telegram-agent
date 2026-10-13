import { test, expect } from "bun:test";
import { join } from "node:path";
import { judge, probeTurnArgv, parseProbeArgs, runProbe, evidenceBlock, type Want } from "./probe-turn";
import { AUTO_DISALLOWED_TOOLS } from "../poller";

// All fixtures are synthetic: an invented chat id, invented folders and invented tokens.

const REPO = join(import.meta.dir, "..");
const line = (o: unknown) => JSON.stringify(o);
const init = line({ type: "system", subtype: "init", cwd: "/home/someone/tmp", tools: ["Bash"] });
const assistantText = (text: string) => line({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolUse = (command: string) =>
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command } }] } });
const toolResult = (content: unknown, is_error = false) =>
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content, is_error }] } });
const inputDelta = (partial_json: string) =>
  line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json } } });
const result = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: "result", subtype: "success", is_error: false, result: text, ...extra });
const stream = (...lines: string[]) => lines.join("\n") + "\n";
const expectW = (text: string): Want => ({ mode: "expect", text });
const rejectW = (text: string): Want => ({ mode: "reject", text });
const outputW = (text: string): Want => ({ mode: "expect-output", text });

// --- the argv: the real turn spawn, as the turn user ---------------------------------------

test("the probe argv runs through sudo as the turn user even when the caller's env has no TURN_USER", () => {
  const { argv, env } = probeTurnArgv({ cwd: "/home/someone/tmp", auto: false, env: { TELEGRAM_CHAT_ID: "12345", PATH: "/usr/bin:/bin" } });
  expect(argv[0]).toBe("/usr/bin/sudo");
  expect(argv.slice(0, 5)).toEqual(["/usr/bin/sudo", "-n", "-u", "agentturn", "--"]);
  expect(argv).toContain("--setting-sources");
  expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("project,local");
  expect(argv).toContain("--strict-mcp-config");
  expect(argv).toContain("TELEGRAM_CHAT_ID=12345");
  expect(argv.some((a) => /^TELEGRAM_TURN_ID=probe-\d+$/.test(a))).toBe(true);
  // The cwd wrapper: the turn's own shell changes into the folder, then execs claude.
  const w = argv.indexOf('cd "$0" && exec "$@"');
  expect(w).toBeGreaterThan(0);
  expect(argv[w - 2]).toBe("/bin/sh");
  expect(argv[w - 1]).toBe("-c");
  expect(argv[w + 1]).toBe("/home/someone/tmp");
  expect(argv[w + 3]).toBe("-p");
  // Not an [AUTO] turn: no auto flag and none of the [AUTO]-only disallowed tools.
  expect(argv).not.toContain("CLAUDE_AUTO_SESSION=1");
  for (const t of AUTO_DISALLOWED_TOOLS) expect(argv).not.toContain(t);
  // The turn user's name never travels as a variable, and the spawn env is only secrets + PATH.
  expect(argv.some((a) => a.startsWith("TURN_USER="))).toBe(false);
  expect(Object.keys(env).sort()).toEqual(["PATH"]);
});

test("an --auto probe carries CLAUDE_AUTO_SESSION=1 and the [AUTO] disallowed tools", () => {
  const { argv } = probeTurnArgv({ cwd: "/home/someone/repo", auto: true, env: { TELEGRAM_CHAT_ID: "12345" } });
  expect(argv[0]).toBe("/usr/bin/sudo");
  expect(argv).toContain("CLAUDE_AUTO_SESSION=1");
  expect(argv).toContain("--disallowedTools");
  for (const t of AUTO_DISALLOWED_TOOLS) expect(argv).toContain(t);
  expect(argv).toContain("--setting-sources");
  expect(argv).toContain("TELEGRAM_CHAT_ID=12345");
});

test("secrets from the caller's env travel in the spawn env, never on the command line; bot-only secrets not at all", () => {
  const { argv, env } = probeTurnArgv({
    cwd: "/home/someone/tmp",
    auto: false,
    env: { TELEGRAM_CHAT_ID: "12345", CLAUDE_CODE_OAUTH_TOKEN: "tok-test", TELEGRAM_BOT_TOKEN: "tok-bot-test", TURN_USER: "someoneelse" },
  });
  expect(argv.join(" ")).not.toContain("tok-test");
  expect(argv.join(" ")).not.toContain("tok-bot-test");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok-test");
  expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  // The probe always runs as agentturn, whatever the caller's TURN_USER says.
  expect(argv.slice(0, 5)).toEqual(["/usr/bin/sudo", "-n", "-u", "agentturn", "--"]);
});

test("a non-auto probe never carries an inherited CLAUDE_AUTO_SESSION", () => {
  const { argv } = probeTurnArgv({ cwd: "/home/someone/tmp", auto: false, env: { TELEGRAM_CHAT_ID: "12345", CLAUDE_AUTO_SESSION: "1" } });
  expect(argv.some((a) => a.startsWith("CLAUDE_AUTO_SESSION="))).toBe(false);
  for (const t of AUTO_DISALLOWED_TOOLS) expect(argv).not.toContain(t);
});

test("no SSH_* variable from the caller's env reaches the turn", () => {
  const { argv, env } = probeTurnArgv({
    cwd: "/home/someone/tmp",
    auto: false,
    env: { TELEGRAM_CHAT_ID: "12345", SSH_AUTH_SOCK: "/tmp/ssh-someone/agent.1", SSH_CONNECTION: "192.0.2.1 5 192.0.2.2 22", SSH_CLIENT: "192.0.2.1 5 22", SSH_TTY: "/dev/pts/1" },
  });
  expect(argv.some((a) => a.startsWith("SSH_"))).toBe(false);
  expect(Object.keys(env).some((k) => k.startsWith("SSH_"))).toBe(false);
  expect(argv).toContain("TELEGRAM_CHAT_ID=12345");
});

// --- judge -----------------------------------------------------------------------------------

test("judge --expect: OK when the final result holds the text", () => {
  expect(judge(stream(init, assistantText("working"), result("first line: r1 at 09:00")), expectW("r1 at 09:00"))).toBe("OK");
});

test("judge --expect: OK when only a tool_result holds the text (a hook refusal fed back to the model)", () => {
  const s = stream(init, toolUse("echo x > /home/someone/tmp/guard.ts"), toolResult("PreToolUse:Bash hook error: refused: editing guard.ts", true), result("The command was blocked."));
  expect(judge(s, expectW("refused: editing guard.ts"))).toBe("OK");
});

test("judge --expect: OK when a tool_result's content is a list of text blocks", () => {
  const s = stream(init, toolResult([{ type: "text", text: "PLANT42ED" }]), result("done"));
  expect(judge(s, expectW("PLANT42ED"))).toBe("OK");
});

test("judge --expect: OK when only the assistant's text holds the text", () => {
  expect(judge(stream(init, assistantText("DONE"), result("")), expectW("DONE"))).toBe("OK");
});

test("judge --expect: a token that appears only in a tool_use input does not count", () => {
  const s = stream(
    init,
    inputDelta('{"command":"echo SECRET-TOKEN-1'),
    toolUse("echo SECRET-TOKEN-1 > /home/someone/tmp/guard.ts"),
    toolResult("refused by a rule", true),
    result("I could not run it."),
  );
  expect(judge(s, expectW("SECRET-TOKEN-1"))).toBe("FAILED");
});

test("judge --expect: the init line's cwd does not count", () => {
  expect(judge(stream(init, result("hello")), expectW("/home/someone/tmp"))).toBe("FAILED");
});

test("judge --expect: FAILED when the text is nowhere searched", () => {
  expect(judge(stream(init, assistantText("hello"), result("hello")), expectW("refused: editing guard.ts"))).toBe("FAILED");
});

test("judge --reject: OK when the text is absent from the result and the assistant's text", () => {
  expect(judge(stream(init, assistantText("Hello!"), result("Hello!")), rejectW("ZEBRA"))).toBe("OK");
});

test("judge --reject: FAILED when the final result holds the text", () => {
  expect(judge(stream(init, result("ZEBRA. Hello!")), rejectW("ZEBRA"))).toBe("FAILED");
});

test("judge --reject: FAILED when the assistant's text holds the text", () => {
  expect(judge(stream(init, assistantText("ZEBRA"), result("Hello")), rejectW("ZEBRA"))).toBe("FAILED");
});

test("judge --reject: a token only in a tool_use input or the init line does not fail it", () => {
  const s = stream(init, toolUse("cd /home/someone/tmp && printenv HOME"), toolResult("Permission denied by a rule", true), result("It was refused."));
  expect(judge(s, rejectW("/home/someone/tmp"))).toBe("OK");
});

test("judge --reject: FAILED when only a tool_result holds the text (the command ran, the model did not repeat it)", () => {
  const s = stream(init, toolUse("printenv HOME"), toolResult("/home/agentturn\n"), result("Done."));
  expect(judge(s, rejectW("/home/agentturn"))).toBe("FAILED");
  expect(judge(stream(init, toolResult([{ type: "text", text: "# Agent identity" }]), result("ok")), rejectW("# Agent identity"))).toBe("FAILED");
});

test("judge --expect-output: only tool output counts, never the model's own words", () => {
  // A paraphrase or a prediction in the assistant's text or the result does not satisfy it.
  expect(judge(stream(init, assistantText("This would print PLANT42ED."), result("PLANT42ED")), outputW("PLANT42ED"))).toBe("FAILED");
  // The same token in a tool_result does.
  expect(judge(stream(init, toolUse('echo "PLANT$((6*7))ED"'), toolResult("PLANT42ED\n"), result("PLANT42ED")), outputW("PLANT42ED"))).toBe("OK");
  expect(judge(stream(init, toolResult([{ type: "text", text: "hook error: refused: editing guard.ts" }], true), result("blocked")), outputW("refused: editing guard.ts"))).toBe("OK");
  // A tool_use input still does not count.
  expect(judge(stream(init, toolUse("echo PLANT42ED"), toolResult("refused", true), result("no")), outputW("PLANT42ED"))).toBe("FAILED");
  // No result line, or a failed turn without the token: INCONCLUSIVE.
  expect(judge(stream(init, toolResult("PLANT42ED")), outputW("PLANT42ED"))).toBe("INCONCLUSIVE");
  expect(judge(stream(init, result("stopped", { is_error: true })), outputW("PLANT42ED"))).toBe("INCONCLUSIVE");
});

test("judge: an upstream error delivered as the answer is INCONCLUSIVE in every mode", () => {
  for (const text of ["API Error: 529 Overloaded", "You've hit your session limit · resets 4:40am"]) {
    const s = stream(init, result(text)); // is_error false, subtype success
    expect(judge(s, rejectW("ZEBRA"))).toBe("INCONCLUSIVE");
    expect(judge(s, expectW("DONE"))).toBe("INCONCLUSIVE");
    expect(judge(s, outputW("DONE"))).toBe("INCONCLUSIVE");
  }
});

test("judge: INCONCLUSIVE when no result line arrived, in both modes", () => {
  const s = stream(init, assistantText("ZEBRA PLANT42ED"));
  expect(judge(s, expectW("PLANT42ED"))).toBe("INCONCLUSIVE");
  expect(judge(s, rejectW("ZEBRA"))).toBe("INCONCLUSIVE");
  expect(judge("", rejectW("ZEBRA"))).toBe("INCONCLUSIVE");
});

test("judge: a result-shaped string inside other content is not a result line", () => {
  const s = stream(init, toolResult('{"type":"result","result":"x"}'));
  expect(judge(s, rejectW("ZEBRA"))).toBe("INCONCLUSIVE");
});

test("judge: a failed turn (an error result) is INCONCLUSIVE unless the text already decides", () => {
  const failed = (t: string) => result(t, { is_error: true });
  // A turn that never ran cannot prove an absence.
  expect(judge(stream(init, failed("Invalid authentication credentials")), rejectW("ZEBRA"))).toBe("INCONCLUSIVE");
  expect(judge(stream(init, line({ type: "result", subtype: "error_max_turns", is_error: true })), rejectW("ZEBRA"))).toBe("INCONCLUSIVE");
  // Nor fail an expectation it never got to meet.
  expect(judge(stream(init, failed("Invalid authentication credentials")), expectW("DONE"))).toBe("INCONCLUSIVE");
  // But text it did produce still counts.
  expect(judge(stream(init, toolResult("refused: editing guard.ts", true), failed("stopped")), expectW("refused: editing guard.ts"))).toBe("OK");
  expect(judge(stream(init, assistantText("ZEBRA"), failed("stopped")), rejectW("ZEBRA"))).toBe("FAILED");
});

test("judge skips lines that are not JSON", () => {
  expect(judge("not json\n" + stream(result("DONE")), expectW("DONE"))).toBe("OK");
});

// --- the command line ------------------------------------------------------------------------

test("parseProbeArgs reads --cwd, exactly one of --expect/--reject, and --auto", () => {
  expect(parseProbeArgs(["--cwd", "/home/someone/tmp", "--expect", "DONE"])).toEqual({ cwd: "/home/someone/tmp", want: expectW("DONE"), auto: false });
  expect(parseProbeArgs(["--cwd", "/home/someone/tmp", "--reject", "ZEBRA", "--auto"])).toEqual({ cwd: "/home/someone/tmp", want: rejectW("ZEBRA"), auto: true });
  expect(parseProbeArgs(["--cwd", "/home/someone/tmp", "--expect-output", "PLANT42ED"])).toEqual({ cwd: "/home/someone/tmp", want: outputW("PLANT42ED"), auto: false });
  for (const bad of [
    ["--cwd", "/home/someone/tmp", "--expect-output", "A", "--expect", "B"],
    ["--cwd", "/home/someone/tmp", "--expect-output", ""],
    [],
    ["--cwd", "/home/someone/tmp"],
    ["--expect", "DONE"],
    ["--cwd", "/home/someone/tmp", "--expect", "DONE", "--reject", "ZEBRA"],
    ["--cwd", "/home/someone/tmp", "--expect", ""],
    ["--cwd", "", "--expect", "DONE"],
    ["--cwd", "/home/someone/tmp", "--expect"],
    ["--cwd", "/home/someone/tmp", "--expect", "DONE", "--bogus"],
  ]) {
    expect(typeof parseProbeArgs(bad)).toBe("string");
  }
});

function harness(out: string) {
  const printed: string[] = [];
  const errors: string[] = [];
  const calls: { argv: string[]; env: Record<string, string>; prompt: string }[] = [];
  return {
    printed,
    errors,
    calls,
    deps: {
      env: { TELEGRAM_CHAT_ID: "12345" } as Record<string, string | undefined>,
      readPrompt: async () => "Say hello\n",
      run: async (argv: string[], env: Record<string, string>, prompt: string) => {
        calls.push({ argv, env, prompt });
        return out;
      },
      print: (s: string) => void printed.push(s),
      err: (s: string) => void errors.push(s),
    },
  };
}

test("runProbe: OK prints the verdict line and the evidence, no tail, and exits 0; the prompt goes in on stdin", async () => {
  const h = harness(stream(init, result("DONE")));
  expect(await runProbe(["--cwd", "/home/someone/tmp", "--expect", "DONE"], h.deps)).toBe(0);
  expect(h.printed).toEqual(["probe-turn: OK", "evidence: no tool results"]);
  expect(h.calls[0].prompt).toBe("Say hello\n");
  expect(h.calls[0].argv[0]).toBe("/usr/bin/sudo");
  expect(h.calls[0].argv).toContain("TELEGRAM_CHAT_ID=12345");
});

test("runProbe: OK with tool output prints each tool result as evidence", async () => {
  const h = harness(stream(init, toolResult("Permission to use Read has been denied.", true), result("I cannot read it.")));
  expect(await runProbe(["--cwd", "/home/someone/tmp", "--reject", "# Agent identity"], h.deps)).toBe(0);
  expect(h.printed).toEqual(["probe-turn: OK", 'evidence: 1 tool result\n  [1] "Permission to use Read has been denied."']);
});

test("runProbe: FAILED exits 1 and prints the evidence, then the stream's last 2,000 characters", async () => {
  const out = stream(init, assistantText("x".repeat(3000)), result("Hello"));
  const h = harness(out);
  expect(await runProbe(["--cwd", "/home/someone/tmp", "--reject", "Hello"], h.deps)).toBe(1);
  expect(h.printed[0]).toBe("probe-turn: FAILED");
  expect(h.printed[1]).toBe("evidence: no tool results");
  expect(h.printed[2]).toBe(out.slice(-2000));
  expect(h.printed[2].length).toBe(2000);
});

test("runProbe: INCONCLUSIVE exits 3 and prints the evidence and the tail", async () => {
  const h = harness("partial output\n");
  expect(await runProbe(["--cwd", "/home/someone/tmp", "--expect", "DONE", "--auto"], h.deps)).toBe(3);
  expect(h.printed).toEqual(["probe-turn: INCONCLUSIVE", "evidence: no tool results", "partial output\n"]);
  expect(h.calls[0].argv).toContain("CLAUDE_AUTO_SESSION=1");
});

test("runProbe: the printed tail is redacted", async () => {
  const key = "sk-" + "A".repeat(30);
  const h = harness(stream(init, assistantText(`the key is ${key}`), result("ZEBRA")));
  expect(await runProbe(["--cwd", "/home/someone/tmp", "--reject", "ZEBRA"], h.deps)).toBe(1);
  expect(h.printed.join("\n")).not.toContain(key);
  expect(h.printed[2]).toContain("[REDACTED…AAAA]");
});

test("evidenceBlock: each tool result redacted, one line, capped at 300 characters, at most 10", () => {
  const key = "ghp_" + "B".repeat(36);
  const texts = [`line one\nline two ${key}`, "y".repeat(500), ...Array.from({ length: 10 }, (_, i) => `r${i + 3}`)];
  const lines = evidenceBlock(texts).split("\n");
  expect(lines[0]).toBe("evidence: 12 tool results");
  expect(lines[1]).toBe(`  [1] ${JSON.stringify("line one\nline two [REDACTED…BBBB]")}`);
  expect(lines[2]).toBe(`  [2] ${JSON.stringify("y".repeat(300))}`);
  expect(lines.filter((l) => /^  \[\d+\] /.test(l)).length).toBe(10);
  expect(lines[10]).toBe(`  [10] ${JSON.stringify("r10")}`);
  expect(lines[11]).toBe("  (2 more not shown)");
  expect(lines.length).toBe(12);
  expect(evidenceBlock([])).toBe("evidence: no tool results");
});

test("runProbe: evidence comes from the turn's tool results in order", async () => {
  const h = harness(stream(init, toolResult("first"), toolResult([{ type: "text", text: "second" }]), result("done")));
  expect(await runProbe(["--cwd", "/home/someone/tmp", "--expect-output", "second"], h.deps)).toBe(0);
  expect(h.printed[1]).toBe('evidence: 2 tool results\n  [1] "first"\n  [2] "second"');
});

test("runProbe: bad arguments or an empty prompt exit 2 without starting a turn", async () => {
  const h = harness(stream(result("DONE")));
  expect(await runProbe(["--cwd", "/home/someone/tmp"], h.deps)).toBe(2);
  const e = harness(stream(result("DONE")));
  e.deps.readPrompt = async () => "  \n";
  expect(await runProbe(["--cwd", "/home/someone/tmp", "--expect", "DONE"], e.deps)).toBe(2);
  expect(h.calls.length + e.calls.length).toBe(0);
  expect(h.errors.join("\n")).toContain("give exactly one of --expect, --expect-output and --reject");
  expect(e.errors.join("\n")).toContain("the prompt on stdin is empty");
  expect(h.printed.length + e.printed.length).toBe(0);
});

// --- importing poller.ts starts nothing --------------------------------------------------------

test("the script run with no arguments prints usage and exits 2 at once: loading poller.ts starts no poller", () => {
  // No bot token in the child's env: should the guard ever break, a started poller has nothing
  // to reach Telegram with.
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  const r = Bun.spawnSync([process.execPath, "run", "scripts/probe-turn.ts"], { cwd: REPO, stdin: "ignore", env, timeout: 30_000 });
  expect(r.exitCode).toBe(2);
  expect(r.stderr.toString()).toContain("usage");
  expect(r.stdout.toString()).not.toContain("[BOT]");
});
