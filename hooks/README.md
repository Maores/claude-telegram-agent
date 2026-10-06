# Hooks — the protection floor

This directory holds the Claude Code PreToolUse hook that enforces the Phase 4
"protection floor" (see `docs/ROADMAP.md`). The rule logic lives in `guard.ts`
at the repo root and is unit-tested in `guard.test.ts`; the hook script here is
the thin adapter that Claude Code runs.

## What `pretooluse-guard.ts` does

Claude Code runs the script once before each tool call it's registered for. The
script reads the hook payload from stdin, applies the guard, and exits `2` to
block (printing the reason to stderr, which Claude sees) or `0` to allow.

It enforces four layers:

1. **Hardline floor** — `guard.checkCommand` runs on every shell command in
   every session, even full-permission ones. Any tool whose input has a string
   `command` is checked like `Bash` (`Monitor`, which runs its command in the
   background, a namespaced variant, or a tool added later; see
   `guard.commandOf`). It refuses only the unambiguously
   catastrophic: `rm -rf /` / `~` / `$HOME`, `mkfs`, `dd` to a block device,
   fork bombs, `shutdown`/`reboot`/`halt`/`poweroff`, recursive `chmod`/`chown`
   on `/`, writes to `~/.ssh`, writes to the telegram `.env`, writes to
   `guard.ts`, `inbox.ts` or the hook files themselves, `git push --force` to `main`, and
   `curl`/`wget` piped straight into a shell. Commands that merely *mention*
   these as text (`echo "shutdown"`, `grep "rm -rf"`) are left alone.

2. **Least-privilege `[AUTO]` denials** — `guard.checkAutoSession` runs only
   when the spawning process set `CLAUDE_AUTO_SESSION=1` (unattended `[AUTO]`
   reminder runs; the poller sets this). Those sessions additionally may not
   schedule reminders (`remind.ts add*` — a self-replication guard) or create
   Gmail drafts (`create_draft`, matched on the action suffix so the
   per-deployment MCP server id doesn't matter).

3. **Protected-file edits** — `guard.checkFileWrite` runs on the file-editing
   tools (`Edit`/`Write`/`MultiEdit`/`NotebookEdit`) in every session and refuses
   writes to the safety files themselves — `guard.ts`, `inbox.ts` (the PC key's
   forced command), the hook files, and the telegram `.env`. The bash floor (layer 1) only sees shell commands, so this is
   the layer that stops the bot from disabling its own guard via the Edit tool.
   Every other file stays editable, so the bot keeps improving its own code.

4. **The phone inbox** — `guard.checkInboxAccess` runs on the file tools
   (`Read`/`Grep`/`Glob` as well as the editors) in every session and refuses any
   path under an `inbox/` folder, and any search rooted at or above the home
   folder. The `inbox-store` and `inbox-pull` rules in layer 1 refuse the same
   folder to `Bash`, and every `inbox.ts` command but `status` (also spelled
   `inbox` or `inbox.js`, which Bun runs as `inbox.ts`). A turn may run only
   `bun run inbox.ts status`, and runs the inbox tests by their full file names
   (`bun test inbox.test.ts`); the code itself (`inbox.ts`) stays readable, and
   layer 3 refuses edits to it.

**Fail-closed:** if a guard rule throws on a real tool call, the hook denies
rather than allows. A payload it can't parse at all is passed through (exit 0)
so a malformed hook event can never brick the bot.

## How this pairs with the poller's `--disallowedTools`

The poller (`poller.ts`) also passes `--disallowedTools` on the `[AUTO]` spawn,
which blocks `remind.ts add-once` / `add-repeat` at Claude Code's own tool layer
— a first line of defense that doesn't depend on this hook being wired. The hook
is the verified, deployment-independent enforcement: it re-checks reminders
(defense in depth against quoting/whitespace evasion) and is the **only** layer
that reliably blocks Gmail `create_draft`, because that tool's full name is
`mcp__<server-uuid>__create_draft` and the UUID differs per deployment, so it
can't be named in a static `--disallowedTools` value.

Every `claude -p` the code starts (each turn, `[AUTO]` jobs, the review pass,
the health probe) is also started without the `Monitor` tool
(`guard.ALWAYS_DISALLOWED_TOOLS`, added by `guard.withAlwaysDisallowed`). An
`[AUTO]` turn gets it inside its own `--disallowedTools` list, so there is one flag.

## Wiring it on the droplet — NOT applied automatically

> **This PR does not register the hook.** Adding it changes how every `claude -p`
> spawn behaves, so it is left for a deliberate deploy step. Nothing here edits
> `settings.json`.

Merge the following into the bot's Claude Code settings. On the server the
wiring lives in the untracked `~/claude-bot/.claude/settings.local.json` (the
nightly `backup.ts` copies it), never in the tracked `.claude/settings.json`,
which a deploy would autosave and reset:

```json
{
  "permissions": {
    "allow": ["Bash(*)", "Read", "Write", "Edit"]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Monitor|Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob|LS|create_draft",
        "hooks": [
          {
            "type": "command",
            "command": "/home/claudebot/.bun/bin/bun run /home/claudebot/claude-bot/hooks/pretooluse-guard.ts"
          }
        ]
      }
    ]
  }
}
```

Notes:

- **`matcher`** is a regex against the tool name.
  `Bash|Monitor|Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob|LS|create_draft` fires the hook
  for every `Bash` and `Monitor` command (the hardline floor + the `[AUTO]` reminder block), for the
  file-editing tools (the protected-file block), for Gmail's `create_draft` (the
  `[AUTO]` draft block), and for nothing else. The reading tools (`Read|Grep|Glob|LS`)
  are matched only for the phone inbox's refusal (`checkInboxAccess`). The
  `Edit|Write|MultiEdit` part is REQUIRED for the protected-file layer
  (`checkFileWrite`) to fire; with just `"Bash"` the bot could still edit `guard.ts`
  through the Edit tool.
- **Absolute paths.** Hook commands don't inherit the interactive `PATH`, so
  point at the real `bun` (confirm with `which bun`; it's usually
  `~/.bun/bin/bun`) and at the absolute hook path. Adjust both if the repo or
  user lives elsewhere.
- **Restart required.** Restart the poller (`sudo systemctl restart telegram-agent`)
  for the new spawns to pick up the settings.
- **Verify after wiring:** in the chat, ask the bot to run `rm -rf /tmp/x`
  (should succeed) and `rm -rf /` (should be refused with the guard reason). Also
  confirm the protected-file layer: ask it to edit `guard.ts` (refused) and to edit
  an ordinary file like `tasks.ts` (allowed).

## Tests

The rules are covered by `guard.test.ts` (golden block/allow table), with the
routine channel's and the phone inbox's rules in `guard-rchannel.test.ts` and
`guard-inbox.test.ts`; `guard-monitor.test.ts` covers commands from tools other
than `Bash` and runs the hook script itself end to end. Run:

```
bun test guard.test.ts guard-rchannel.test.ts guard-inbox.test.ts guard-monitor.test.ts
```
