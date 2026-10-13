#!/usr/bin/env bun
/**
 * pretooluse-guard.ts — Claude Code PreToolUse hook for the Telegram bot.
 *
 * Claude Code runs this once before every tool call it is registered for. It
 * reads the hook payload as JSON on stdin, applies guard.ts, and:
 *   - exits 2 (with the reason on stderr) to BLOCK the tool call, or
 *   - exits 0 to allow it.
 *
 * What it enforces:
 *   1. The hardline floor (guard.checkCommand) on every shell command — refuses
 *      the handful of catastrophic commands (rm -rf /, mkfs, dd to a device,
 *      fork bombs, shutdown, ssh/.env/self tampering, force-push to main,
 *      curl|sh, sudo). Applies in every session, even full-permission ones. Any tool
 *      whose input has a string `command` is checked the same way as Bash
 *      (Monitor, a namespaced variant, a tool added later): guard.commandOf.
 *   2. Extra least-privilege denials (guard.checkAutoSession) ONLY when the
 *      spawning process set CLAUDE_AUTO_SESSION=1 — i.e. unattended [AUTO]
 *      reminder runs. Those sessions additionally may not schedule reminders
 *      (self-replication guard) or create Gmail drafts.
 *   3. Protected-file edits (guard.checkFileWrite) and the phone inbox
 *      (guard.checkInboxAccess: the file tools never reach an inbox/ folder or
 *      search from above it), in every session.
 *
 * Gmail's create_draft is blocked only inside an [AUTO] session.
 *
 * On Linux every refusal is also written to the system journal (logger tag agent-guard).
 *
 * Fail-closed: if a guard rule throws on a real tool call, the hook denies
 * rather than allows, and a payload it cannot parse at all is refused too (exit
 * 2): a call the guard cannot read is a call it cannot clear.
 *
 * Wiring on the droplet (see hooks/README.md): from the hardening rollout's part
 * R5 on, /etc/claude-code/managed-settings.json (tracked copy in deploy/) runs
 * it and fails closed; until then the untracked .claude/settings.local.json
 * wires it. No PR registers it automatically.
 */
import { checkCommand, checkAutoSession, checkFileWrite, checkInboxAccess, commandOf, refusalLogArgv } from "../guard";

const raw = await Bun.stdin.text();

// Set once the payload parses; block() names it in the journal line ("?" before that).
let toolName = "";

// Every refusal also goes to the system journal (Linux only, tag agent-guard). The write never
// decides the verdict: its failure is ignored, a timeout keeps it from holding the hook, and the
// exit 2 always follows.
function block(reason: string): never {
  console.error(`[guard] ${reason}`);
  if (process.platform === "linux") {
    try {
      Bun.spawnSync(refusalLogArgv(`${toolName || "?"}: ${reason}`), {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 2000,
      });
    } catch {
      // logging is best effort; the refusal stands
    }
  }
  process.exit(2);
}

let input: any;
try {
  input = JSON.parse(raw);
} catch {
  // A payload that does not parse cannot be checked, so it is not allowed.
  block("unparseable hook payload (failing closed)");
}
toolName = typeof input?.tool_name === "string" ? input.tool_name : "";

const filePath: string | undefined =
  typeof input?.tool_input?.file_path === "string" ? input.tool_input.file_path : undefined;
const isAuto = process.env.CLAUDE_AUTO_SESSION === "1";

try {
  // The shell command of this call, whatever the tool is called (Bash, Monitor, ...). Inside the
  // try, so a surprise here denies rather than allows.
  const command: string | undefined = commandOf(input?.tool_input) ?? undefined;
  if (isAuto) {
    const a = checkAutoSession(toolName, command);
    if (a.verdict === "block") block(a.reason ?? "blocked by [AUTO] least-privilege policy");
  }
  if (typeof command === "string") {
    const v = checkCommand(command);
    if (v.verdict === "block") block(v.reason ?? "blocked by the hardline guard");
  }
  // Protect the safety files from the Edit/Write tools, in EVERY session — the
  // bash floor above never sees tool-based file writes.
  const fw = checkFileWrite(toolName, filePath);
  if (fw.verdict === "block") block(fw.reason ?? "blocked: edit to a protected safety file");
  // The phone inbox: the file tools (Read/Grep/Glob as well as the editors) never reach it.
  const ia = checkInboxAccess(toolName, input?.tool_input ?? {}, input?.cwd);
  if (ia.verdict === "block") block(ia.reason ?? "blocked: the phone inbox");
} catch (e: any) {
  // Deny on error — the hardline layer fails closed (see the survey's
  // "don't regress" note on fail-open scanners).
  block(`guard error (failing closed): ${e?.message ?? e}`);
}

process.exit(0);
