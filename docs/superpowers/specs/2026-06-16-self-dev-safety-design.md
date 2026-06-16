# Self-dev safety — design spec (self-contained)

Date: 2026-06-16
Status: approved (brainstorming complete), ready for implementation
Agenda origin: post-compact agenda item #2 (see memory `agent-dev-agenda.md`)

> Self-contained for a fresh implementer. Read the file:line anchors in the live code before
> editing — line numbers drift.

## Context for an implementer who is new to this repo

Headless personal-assistant Telegram agent (Bun + TypeScript + SQLite). `poller.ts` is the single
long-running process on a DigitalOcean droplet (`157.230.112.96`, user `claudebot`, repo at
`/home/claudebot/claude-bot`, systemd service `telegram-agent`). Each Telegram message spawns a
fresh `claude -p` **with full permissions** (`--dangerously-skip-permissions`), so the bot can run
bash and edit files on its own server.

**The problem this solves.** The bot has hot-patched its own source live on the droplet more than
once (it invented the `[AUTO]` reminders feature mid-chat in 2026-06-10 and restarted itself; it
built a `create-list` feature into `tasks.ts`/`todo.ts` in 2026-06-14). Those edits live only in
the droplet's working tree, diverging from git. The redeploy procedure is
`git fetch && git reset --hard origin/main && systemctl restart` — and **`reset --hard` destroys
modified tracked files**. The create-list edits were nearly lost this way; they were rescued only
by a manual stash-before-reset. We want this to be impossible to lose, without killing the
(useful, and demo-worthy) ability of the bot to improve itself.

**Posture chosen in brainstorming:** *keep self-editing, make it safe.* No hard block on the bot
editing its own code. Safety comes from a deterministic **safety net** (mechanism a), a
best-effort **discipline** instruction (mechanism b), and a **light lock-down** that protects only
the safety mechanism itself (mechanism c).

### Key facts verified against current code

- `.gitignore` ignores all runtime data: `memory/` (= `bot.db`), `history/`, `uploads/`, `skills/`,
  `reminders/`, `reminders.json`, `pending.json`, `choices.json`, `cal_notified.json`, `.env`,
  `access.json`, `node_modules/`. So on the droplet `git status` is clean **except** for
  (1) modified tracked **code**, and (2) a couple of known untracked files (`cal_check.sh`,
  `followups.json`). A `reset --hard` wipes (1) but not (2). **The thing to protect = modified
  tracked files.**
- `guard.ts` is a fail-closed PreToolUse blocklist (enforced by `hooks/pretooluse-guard.ts`).
  `checkCommand(cmd)` blocks catastrophic **bash** commands; the `self-tamper` rule
  ([guard.ts:101-105](../../../guard.ts)) blocks **bash** write-intent against `guard.ts`/`hooks/*`.
  `checkAutoSession(toolName, command)` ([guard.ts:140](../../../guard.ts)) adds `[AUTO]`-only
  denials. **Gap:** none of this inspects the **Edit/Write/MultiEdit tools** — only Bash. So the
  bot can edit `guard.ts` (or any code) via the Edit tool unguarded.
- The bot can `git push` to any branch (only `git push --force` to `main` is blocked, rule
  `force-push-main`). It holds the GitHub key `id_ed25519_chatgpt_bot`, so it can push branches.
- Droplet SSH from the dev machine: `ssh -i ~/.ssh/id_ed25519_chatgpt_bot ...` (the authorized key
  has a non-standard name, so SSH won't auto-offer it). Non-interactive ssh has no `bun` on PATH —
  use `~/.bun/bin/bun`.

## Mechanism (a): the safety net — two layers

### a1. Deploy-time capture (the guarantee)

A tracked `deploy.sh` at the repo root that formalizes the lossless-deploy pattern. Pseudocode:

```
cd ~/claude-bot
modified=$(git status --porcelain | <tracked-modified only>)   # see filesToCapture
if modified non-empty:
    branch="droplet-autosave/$(date +%Y%m%d-%H%M%S)"
    git stash push -- <those files>            # or: git checkout -b, commit, push
    git checkout -b "$branch" && git stash pop && git add -A <those files>
    git commit -m "chore(autosave): capture droplet self-edits before deploy"
    git push -u origin "$branch"               # preserved on GitHub for review
    git checkout main
git fetch origin && git reset --hard origin/main
sudo systemctl restart telegram-agent
# verify: journalctl -u telegram-agent -n 5  shows "[BOT] Poller started"
echo "captured: $branch"   (if any)
```

The exact git choreography is the implementer's to get right (the goal: the modified tracked files
end up committed+pushed on an autosave branch, and `main` is then cleanly deployed). Untracked
files (`cal_check.sh`, `followups.json`) are intentionally left alone — they survive `reset --hard`.
After this lands, **all future deploys go through `deploy.sh`** (update DEPLOY.md +
`memory/live-deploy-access.md`).

### a2. Daily detector (early warning)

The existing 20:35 `[AUTO]` daily-summary reminder (`r8` on the droplet) also surfaces code
divergence. Implementation: a tiny tracked script `selfdev-check.ts` (CLI) that prints the list of
modified tracked files (empty → prints nothing / "clean"). The daily `[AUTO]` job's prompt gains a
line: *"Run `bun run selfdev-check.ts`; if it lists files, add a line to the summary: '⚠️ הבוט שינה
קוד שטרם נשמר: <files> — תריץ deploy.sh כדי לשמר ב-branch.'"* No new scheduler — reuses the daily
job. (Updating the r8 reminder text is a droplet runtime change, done at deploy time; document it.)

The shared, unit-tested core for both layers:

- `filesToCapture(porcelain: string): string[]` — parse `git status --porcelain -z`-style (or plain
  `--porcelain`) output and return paths of **modified/added/renamed/deleted TRACKED** files. Lines
  starting with `??` (untracked) and anything gitignored are excluded. This is the single source of
  truth for "what would a `reset --hard` destroy." Pure, no IO. Lives in a new `selfdev.ts`.

## Mechanism (b): discipline — instruction, net is the backstop

A new CLAUDE.md section (e.g. "## Editing your own code"):

> When you make non-trivial changes to your own source files, don't leave them as a live hot-patch
> on `main`. Commit them to a branch and open a PR (or tell Maor) so he can review and deploy. A
> `droplet-autosave/*` branch captures uncommitted edits at deploy time, but a clean PR is the right
> path. Trivial/runtime data (bot.db, *.json state) is fine to write freely — this is about source
> code.

Honest constraint documented in the spec (not in CLAUDE.md): the droplet has ONE shared working
tree tracking `main`, so a true "develop on a branch" workflow is awkward there. Therefore **(b) is
best-effort guidance; (a) is what actually guarantees safety.** This dovetails with agenda #4 (a
launched build should land as a PR). No code enforcement of branch state (impractical on the shared
tree, and unnecessary given (a)).

## Mechanism (c): light lock-down — protect the safety files only

Close the one real hole: the bot can currently edit `guard.ts`/hooks via the **Edit tool** (the
guard only checks bash). Extend the guard to also cover the file-editing tools, for the protected
set **only**.

- New pure function in `guard.ts`: `checkFileWrite(toolName: string, filePath: string | undefined):
  GuardVerdict`. Blocks when `toolName` ∈ {`Edit`, `Write`, `MultiEdit`} (case-insensitive, and
  tolerate namespaced variants) AND `filePath` resolves to a protected file: `guard.ts`,
  `hooks/pretooluse-guard.ts`, any `hooks/*.ts`, the telegram `.env`. Reuse/extend the existing
  `SELF_PATH`/`ENV_PATH` matchers. Normalize the path (basename + suffix match) so
  `/home/claudebot/claude-bot/guard.ts`, `./guard.ts`, and `guard.ts` all match; don't be fooled by
  a path that merely contains the name as a directory.
- Wire it into `hooks/pretooluse-guard.ts`: for Edit/Write/MultiEdit tool calls, pass the tool's
  `file_path` (MultiEdit also uses `file_path`) to `checkFileWrite`; block on a block verdict. Keep
  the existing bash path (`checkCommand`/`checkAutoSession`) unchanged. Fail closed if a rule throws.
- Everything else stays editable — `poller.ts`, `tasks.ts`, etc. are NOT protected. The bot keeps
  self-editing; it just can't quietly neuter its own guard or steal its token via the Edit tool.

## Testing (TDD)

All pure functions, mirroring `guard.test.ts` table style:

1. `filesToCapture(porcelain)`:
   - ` M poller.ts`, `M  tasks.ts`, `A  new.ts`, `R  a.ts -> b.ts`, `D  gone.ts` → included.
   - `?? cal_check.sh`, `?? followups.json` (untracked) → excluded.
   - gitignored paths never appear in `--porcelain` anyway; include a comment test.
   - empty input → `[]`.
2. `checkFileWrite(toolName, filePath)`:
   - `Edit guard.ts` / `Write hooks/pretooluse-guard.ts` / `MultiEdit .../hooks/x.ts` /
     `Edit .../.claude/channels/telegram/.env` → **block**.
   - `Edit poller.ts` / `Write tasks.ts` / `Edit docs/x.md` → **allow**.
   - non-edit tools (`Bash`, `Read`) → **allow** (handled by the bash path, not here).
   - missing/empty filePath → **allow** (nothing to match).
   - path-trickery: a directory literally named `guard.ts/` containing another file should not be
     mis-flagged if the target basename differs (document the chosen matcher's behavior).
3. Existing `guard.test.ts` cases must all still pass (no regression in the bash floor).

## Integration points

- **Deploy procedure:** after this lands, deploys use `deploy.sh`. Update `DEPLOY.md` and the
  `live-deploy-access` memory.
- **#4 (dev-intent):** a launched build should land as a PR — same discipline this spec encodes.
- **`[AUTO]` daily job (r8):** its prompt text gains the `selfdev-check.ts` line (runtime change on
  the droplet).

## Non-goals

- No hard block on the bot editing general code (`poller.ts` etc.) — posture is keep-and-protect.
- No code-enforced branch checkout (impractical on the shared working tree).
- No change to the existing catastrophic-command floor or the `[AUTO]` least-privilege denials.
- The safety guarantee rests on the deploy-time capture (a1), never on the bot obeying (b).
