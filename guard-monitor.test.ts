import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ALWAYS_DISALLOWED_TOOLS,
  checkAutoSession,
  checkCommand,
  commandOf,
  withAlwaysDisallowed,
} from "./guard";

// A shell command reaches the guard through any tool that carries one (Bash, Monitor, a namespaced
// variant, a tool added later), not only through the tool named Bash.

const HARDLINE = "rm -rf /";
const INBOX_READ = "cat ~/inbox/items.json";
const INBOX_REASON = checkCommand(INBOX_READ).reason!;
const HARDLINE_REASON = checkCommand(HARDLINE).reason!;

describe("commandOf", () => {
  test("returns the command of any tool whose input carries a string command", () => {
    expect(commandOf({ command: "ls" })).toBe("ls");
    expect(commandOf({ command: "tail -f x.log", description: "watch" })).toBe("tail -f x.log");
    expect(commandOf({ command: "" })).toBe("");
  });

  test("returns null when there is no string command", () => {
    expect(commandOf({ file_path: "/tmp/x" })).toBeNull();
    expect(commandOf({ command: ["rm", "-rf", "/"] })).toBeNull();
    expect(commandOf({ command: 7 })).toBeNull();
    expect(commandOf(undefined)).toBeNull();
    expect(commandOf(null)).toBeNull();
    expect(commandOf("rm -rf /")).toBeNull();
  });
});

describe("checkAutoSession applies to a command from any tool", () => {
  test("a Monitor command in an [AUTO] session meets the hardline floor", () => {
    expect(checkAutoSession("Monitor", HARDLINE)).toEqual({ verdict: "block", reason: HARDLINE_REASON });
  });

  test("a Monitor command in an [AUTO] session may not schedule reminders or approve", () => {
    expect(checkAutoSession("Monitor", "bun run remind.ts add-once 1 2 'x'").verdict).toBe("block");
    expect(checkAutoSession("Monitor", "bun run monitor.ts add --name x").verdict).toBe("block");
    expect(checkAutoSession("Monitor", "bun run confirm.ts approve pa1").verdict).toBe("block");
    expect(checkAutoSession("mcp__x__Monitor", "bun run ask.ts choice --question q").verdict).toBe("block");
  });

  test("a harmless Monitor command in an [AUTO] session is allowed", () => {
    expect(checkAutoSession("Monitor", "tail -f poller.log").verdict).toBe("allow");
  });

  test("a tool without a command is unaffected", () => {
    expect(checkAutoSession("Read", undefined).verdict).toBe("allow");
  });
});

describe("withAlwaysDisallowed", () => {
  test("Monitor is always denied", () => {
    expect(ALWAYS_DISALLOWED_TOOLS).toEqual(["Monitor"]);
  });

  test("appends one --disallowedTools list at the end when there is none", () => {
    expect(withAlwaysDisallowed(["-p", "--model", "m"])).toEqual(["-p", "--model", "m", "--disallowedTools", "Monitor"]);
    expect(withAlwaysDisallowed([])).toEqual(["--disallowedTools", "Monitor"]);
  });

  test("joins an existing --disallowedTools list instead of adding a second flag", () => {
    const out = withAlwaysDisallowed(["-p", "--disallowedTools", "Bash(a *)", "Bash(b *)", "--tools", "", "--strict-mcp-config"]);
    expect(out).toEqual(["-p", "--disallowedTools", "Monitor", "Bash(a *)", "Bash(b *)", "--tools", "", "--strict-mcp-config"]);
    expect(out.filter((a) => a === "--disallowedTools").length).toBe(1);
  });

  test("the kebab spelling of the flag is joined too", () => {
    const out = withAlwaysDisallowed(["--disallowed-tools", "Bash(a *)"]);
    expect(out).toEqual(["--disallowed-tools", "Monitor", "Bash(a *)"]);
  });

  test("does not change its input", () => {
    const input = ["-p", "--disallowedTools", "Bash(a *)"];
    withAlwaysDisallowed(input);
    expect(input).toEqual(["-p", "--disallowedTools", "Bash(a *)"]);
  });
});

// The hook script itself, end to end: a payload on stdin, the verdict as the exit code and stderr.
const HOOK = join(import.meta.dir, "hooks", "pretooluse-guard.ts");

async function runHook(payload: unknown, env: Record<string, string> = {}): Promise<{ code: number; err: string }> {
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.CLAUDE_AUTO_SESSION;
  const proc = Bun.spawn([process.execPath, HOOK], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...base, ...env },
  });
  proc.stdin!.write(JSON.stringify(payload));
  proc.stdin!.end();
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, err };
}

const call = (tool_name: string, tool_input: Record<string, unknown>) => ({
  tool_name,
  tool_input,
  cwd: "/home/u/claude-bot",
});

describe("the PreToolUse hook checks a command from any tool", () => {
  test("Bash with the hardline example is refused (baseline)", async () => {
    const r = await runHook(call("Bash", { command: HARDLINE }));
    expect(r.code).toBe(2);
    expect(r.err).toContain(HARDLINE_REASON);
  });

  test("Monitor with the hardline example is refused with the same reason as Bash", async () => {
    const r = await runHook(call("Monitor", { command: HARDLINE, description: "x" }));
    expect(r.code).toBe(2);
    expect(r.err).toContain(HARDLINE_REASON);
  });

  test("Monitor reading the inbox store is refused with the inbox reason", async () => {
    const r = await runHook(call("Monitor", { command: INBOX_READ }));
    expect(r.code).toBe(2);
    expect(r.err).toContain(INBOX_REASON);
  });

  test("a namespaced tool carrying a command is checked too", async () => {
    const r = await runHook(call("mcp__some-server__run_shell", { command: HARDLINE }));
    expect(r.code).toBe(2);
    expect(r.err).toContain(HARDLINE_REASON);
  });

  test("Monitor with a harmless command is allowed", async () => {
    const r = await runHook(call("Monitor", { command: "tail -f poller.log" }));
    expect(r.code).toBe(0);
  });

  test("a tool without a command field is unaffected", async () => {
    const r = await runHook(call("Read", { file_path: "/home/u/claude-bot/README.md" }));
    expect(r.code).toBe(0);
  });

  test("in an [AUTO] session a Monitor command may not schedule a reminder", async () => {
    const r = await runHook(call("Monitor", { command: "bun run remind.ts add-once 1 2 'x'" }), { CLAUDE_AUTO_SESSION: "1" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("may not schedule reminders");
  });
});
