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
 *      curl|sh). Applies in every session, even full-permission ones. Any tool
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
 * Fail-closed: if a guard rule throws on a real tool call, the hook denies
 * rather than allows. A payload it cannot parse at all is passed through (exit
 * 0) so a malformed hook event can never brick the bot.
 *
 * This file is wired via the untracked .claude/settings.local.json on the
 * droplet — see hooks/README.md.
 * It is intentionally NOT registered automatically by the PR that adds it.
 */
import { checkCommand, checkAutoSession, checkFileWrite, checkInboxAccess, commandOf } from "../guard";

function block(reason: string): never {
  console.error(`[guard] ${reason}`);
  process.exit(2);
}

const raw = await Bun.stdin.text();

let input: any;
try {
  input = JSON.parse(raw);
} catch {
  // Unparseable payload — we can't identify a tool call, so don't block.
  process.exit(0);
}

const toolName: string = typeof input?.tool_name === "string" ? input.tool_name : "";
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
