# Server hardening: agent turns as a separate, weaker user

Date: 2026-10-07. Status: approved section by section with the owner; revision 4 folds three plan-review rounds (three reviewers each) and the owner's decisions on new automatic jobs and skills.

## Goal

A Claude turn that injected content has steered (a web page, a forwarded message, a file) must not be able to take over the server, switch off the guard, read the phone inbox, read the bot's own secrets, change what the poller runs, or plant an unattended job that runs again later without the owner's approval. Today the guard (`guard.ts` plus the PreToolUse hook) is the only barrier, and it is a pattern fence: every turn runs as the same Linux user as the poller, and that user has passwordless sudo.

Four walls, in the order they were agreed:

1. Agent turns run as a separate Linux user without sudo, which cannot read the inbox or write the code.
2. The guard hook is wired in Claude Code's managed settings file, which only root can change and no lower settings level can switch off; the hook fails closed.
3. An integrity check, run nightly by the poller and by the PC health sweep.
4. Claude Code's own `permissions.deny` rules, only if a live test shows they apply in the bot's permission mode.

Plus two product changes the owner chose: a new `[AUTO]` job runs, and a new or changed skill is offered to turns, only after the owner taps ✓ on a card; the existing jobs and skills are approved once at rollout.

Non-goals: narrowing the main user's own sudo (deploys and sweeps use it; the turn no longer runs as it), taking out of the turn's reach the secrets it needs for its work (the Claude login and the calendar credentials; see the private residual-risk notes), and rebuilding the guard's command patterns.

## Current state (measured on the droplet, 2026-10-06/07, read-only)

- The service `telegram-agent` runs `bun run poller.ts` as `claudebot`, with `EnvironmentFile` holding the bot token, the iCloud credentials, the Groq key, the Claude OAuth token and tuning values. Service `UMask` is 0022, `KillMode=mixed`.
- `claudebot` has administrative rights on the server, and turns run as `claudebot`.
- Every Claude spawn passes the whole poller environment to the child, plus per-turn values (`TELEGRAM_CHAT_ID`, `TELEGRAM_TURN_ID`, `CLAUDE_AUTO_SESSION`); the button flows (`confirm.ts`, `ask.ts`, `rchannel.ts propose`) match their stores on `TELEGRAM_TURN_ID`.
- In the transcripts of the last month (462 sessions, 955 Bash calls) no turn ran sudo, committed, or edited a code file.
- Runtime state lives in the repo root and is written by tmp-then-rename with fixed `.tmp` names (`reminders.json`, `followups.json`, `choices.json`, `pending.json`, ...), plus `memory/bot.db` (SQLite, WAL), `skills/`, `uploads/`, `history/`, `data/*-state.json`. `openDb` does not create its folder.
- `/home/claudebot` is 0750; `claude-bot`, `inbox`, `rchannel`, `cc-journal`, `.claude` and `.bun` are 0775. `.ssh` is 0700.
- Claude Code is `/usr/bin/claude` (root-owned npm install), version 2.1.162, with `--setting-sources`, `--settings` and `--strict-mcp-config`. The hook is wired in the untracked `~/claude-bot/.claude/settings.local.json`. `/etc/claude-code` does not exist.
- `authorized_keys` holds the PC's main key (unrestricted) and the phone inbox key (`restrict`, forced `inbox.ts gate` with `--no-env-file`). Root also logs in (likely the provider's console).
- `/etc/pam.d/sudo` loads `pam_limits`; iptables is present, ufw inactive.

What the Claude Code docs say (fetched 2026-10-07): hooks may be defined in managed settings; `disableAllHooks` below managed cannot disable managed hooks; `allowManagedHooksOnly` (managed only) blocks user, project, local and plugin hooks; a settings `env` block reaches hook processes and Bash commands; a hook exit code other than 2 does not block the tool call. The docs do not say whether `permissions.deny` applies under `--dangerously-skip-permissions`.

## Design

### 1. Users, and how a turn starts and ends

- New system user `agentturn`: no sudo, member only of its own group and `agentdata`. Home `/home/agentturn` is owned by root (0711) with root-owned skeleton shell files and root-owned, empty `.claude`, `.config`, `.cache`, `.bun` and `.local`, so a turn cannot leave a shell file, a Claude Code setting, native skill, agent or auto-memory file, or a git config that later turns would load. Only `tmp`, `dev` (the self-dev copy) and `outbox` (group `agentdata`, 2750) are writable by `agentturn`. Each turn runs inside a small wrapper that creates a fresh folder under `tmp/` for its Claude config, XDG config and cache, and removes it when the turn ends; the sweep removes stale ones.
- Group `agentdata`: `claudebot` and `agentturn`.
- One sudoers drop-in lets `claudebot` run commands as `agentturn` without a password. Only the three secrets a turn needs cross through sudo's kept environment (`CLAUDE_CODE_OAUTH_TOKEN`, `ICLOUD_USER`, `ICLOUD_APP_PASSWORD`), never on a command line. The drop-in also sets the turns' umask (0007).
- `turnuser.ts` builds every child argv and environment:
  - `TURN_USER` unset (the PC, the tests, the rollback state): exactly as today.
  - `TURN_USER=agentturn`: `sudo -n -u agentturn -- /usr/bin/env PATH=... HOME=/home/agentturn TMPDIR=... <every non-secret variable> /bin/sh -c <per-turn wrapper> <argv>`. Non-secret variables (per-turn values such as `TELEGRAM_TURN_ID`, `TELEGRAM_CHAT_ID`, `CLAUDE_AUTO_SESSION`, tuning values) go on the `env` command line, chosen by a denylist of secret-shaped names and values, so a variable added later still crosses. `STATE_DIR` does not cross (the turn's CLIs find the state through the repo's marker file); the wrapper sets `CLAUDE_CONFIG_DIR` to the per-turn folder. Secrets go in the environment and the sudoers list. The bot token and the Groq key never reach a turn.
  - At startup with `TURN_USER` set, the poller runs one sentinel `sudo -u agentturn env` and refuses to start turns (one Hebrew error reply per message) if a secret does not cross; it logs which user turns run as.
- Every place that starts Claude on content from outside goes through it: normal turns, `[AUTO]` turns, the evening digest (all `streamClaude`) and the review loop. Each turn gets `--setting-sources project,local` (`agentturn`'s own settings file is never loaded) and `--strict-mcp-config` (no MCP server from any file the turn can write). The confirm-button executor goes through it too, so an approved command runs as `agentturn`. The cron health probe (fixed prompt, no outside input) stays as it is.
- Ending a turn: `claudebot` cannot signal a process sudo runs as another user, so `/stop`, the turn timeout and the approved-command timeout signal every `agentturn` process that descends from the turn's sudo pid, as `agentturn` (`sudo -u agentturn kill -TERM`, then `-KILL` after 10 s), so no other user's process can ever be hit.
- No process of `agentturn` outlives the work: every 60 seconds the poller lists processes and ends, as `agentturn`, each `agentturn` process whose nearest non-`agentturn` ancestor is pid 1: a double-forked daemon dies within a minute even when turns run back to back, while a running turn (under its sudo) and a hand-run probe (under a claudebot shell) are never touched. `TURN_SWEEP=0` turns this off.
- Monitor summaries run with no tools, like the evening digest.
- A send whose chat comes from a store a turn can write (reminders, follow-up nudges, monitors, the spool notice) goes only to an allowlisted chat; anything else is logged and dropped.
- A process cap for `agentturn` (`pam_limits`), the poller's private `TMPDIR`, and a firewall rule refusing the cloud metadata address to `agentturn`.

### 2. The state folder

- `STATE_DIR=/var/lib/telegram-agent`, chosen by `STATE_DIR` in the environment or, when that is unset, by an untracked marker file `~/claude-bot/.state-dir` holding the path (so a hand-run command or a sweep that does not load the environment still finds the one real state). With neither, the repo folder: the PC and the tests keep today's layout.
- The rule: every folder the poller lists, reads or writes in sits in a parent folder the turn cannot write, so a turn can never rename, replace or link a folder the poller trusts by path. Layout (all owned by `claudebot`, group `agentdata`):
  - `STATE_DIR` (2750) and its poller-only content the turn may read: `heartbeat`, `health-state.json`, `cal_notified.json`, `voice-pending.json`, `data/` (2750: `quiz-state.json`), `history/` (2750), `uploads/` (2750), `inbox-status.json`, `cc-digest/` (2750: status snapshot, last digest), `approvals.json`.
  - `STATE_DIR/shared` (2750, so no entry in it can be added, removed or renamed by a turn) holding fixed folders the turn writes inside: `stores/` (2770: `reminders.json`, `followups.json`, `choices.json`, `pending.json`, `quiz-paused.flag`), `memory/` (3770, sticky: the database files `claudebot` keeps open can be neither replaced nor removed; `mirror/` inside it 2770), `skills/` (3770 with `.archive/` 3770; skill files owned by `agentturn`), `data/` (2770: `avot-state.json`), `cc-digest/` (2770: pause and resume request), `rchannel-proposals/` (2770: the routine channel's spool).
- File modes are part of the rule: files outside `shared/` are 0640 (the service runs with `UMask=0027`, and the write helper sets the mode explicitly), files in `shared/` 0660; so a turn can read the poller-only files it needs and write none of them, including `approvals.json`.
- `claudebot` writes inside those folders only through one helper (a random-named temp file created exclusively, then renamed; it creates no folder a turn could pre-empt) and reads without following links and without blocking (regular files only, size-capped), so a link or a FIFO a turn plants can never make `claudebot` write, read, copy another file or hang. Skill bodies are read from the skills folder by name, never from a path stored in the database the turn can write. Uploads are created exclusively. `openDb` creates its folder.
- The poller refuses to start when `STATE_DIR` is in use and the shared database is missing (a half-done move must not start the bot on empty state), unless `STATE_INIT=1`.
- Units and files: the service gets `UMask=0027` (the backup unit too); `STATE_DIR` goes in the service's environment file (read by the poller and the cron jobs); the backup unit gets it in a drop-in; `backup.ts` reads both levels into the same archive names as today.
- Summaries for closed places: `inbox-status.json` (counts only) for `inbox.ts status`; the digest's status snapshot and last text for `ccdigest.ts status|last`, with pause and resume as files in `shared/cc-digest` that the poller applies.
- The routine channel: `rchannel.ts propose` in a turn writes one file into `shared/rchannel-proposals`; the poller validates it with the existing proposal rules and moves it into `~/rchannel` (closed to the turn) before it sends the ✓/✗ for that turn.

### 3. Approval for new automatic jobs and new skills

- The poller keeps `approvals.json` (poller-only level, readable by the turn, writable only by the poller).
- `[AUTO]` jobs, keyed by the reminder id, its chat, once-or-repeat and its text (a one-time approval is used up when the job runs): on each tick the poller sends one card per unapproved job (its text and schedule, ✓/✗). A due `[AUTO]` job without an approval does not run; a one-time job is kept until the owner decides. ✓ approves it and runs a due job now; ✗ removes it. Changing a job's text needs a new approval; changing its time does not. Each card's buttons carry a random per-card token, recorded with the exact full key the card showed (and, for a job, its reminder id); a tap applies only to that key and only while the item still has it, so a job or skill changed after its card is never approved by it.
- Skills, keyed by the skill name and a hash of its description and file: an active skill whose current hash is not approved is never offered in a prompt, and `skill.ts view`, `search` and `list` (as a turn runs them) do not surface it; the poller sends one card per new hash. ✓ approves it; ✗ marks that version rejected (it is never offered, and no new card comes for it). Editing an approved skill needs a new approval. Memory facts are not gated (a stated residual; the nightly summary lists what was learned).
- What a card shows is what the owner approves. Default-ignorable and format characters (tag characters, variation selectors, zero-width and bidi controls, ZWJ) show as a visible marker; an item whose text holds any is never carded: it stays held, is logged, and the owner gets one notice naming it. A card clipped to fit sends its item's full text first, in at most five plain parts; a longer text gets a card with only ✗, and a ✓ on such a card is never applied. At most ten cards wait unanswered; beyond that, one line an hour counts the rest. Each round forgets approvals and cards that match no current item.
- The existing jobs and the active skills are approved once at rollout, on the owner's word: `approvals.ts list --keys <file>` shows each item in full (hidden characters as the marker) and writes its key lines; after the owner checks the list against the pre-rollout record, `approvals.ts seed --expect <file>` approves exactly those keys, refuses with nothing written when the store differs from the file in any way, leaves an item with hidden characters unapproved, and replaces `approvals.json` rather than merging into it. The gates are switched on by `AUTO_APPROVAL=1` and `SKILL_APPROVAL=1` only after that.

- Instructions that hold only after the rollout (approval cards, the private dev copy) reach the turn in a `<server-mode>` prompt block the poller adds only when the matching switch is set; `CLAUDE.md` points at the block in neutral words, so it is true before and after.

### 4. Lockdown of the main user's home

- `/home/claudebot` becomes 0711 and every top-level entry except `claude-bot` and `.bun` loses all "other" permissions; `inbox`, `rchannel`, `cc-journal`, `backups`, `.claude` and `.ssh` become 0700. `claude-bot` stays readable (the turn reads and runs the code, writes none of it); `.bun` stays readable, not writable by others.
- Unchanged: deploys (`deploy.sh` runs as `claudebot`), the PC's ssh routes (all as `claudebot`), the backup timer.

### 5. Self-development in a private copy

- `agentturn` keeps a clone in `/home/agentturn/dev`; development requests are done there and committed to a branch. Handover is a `git bundle` in `/home/agentturn/outbox`; the PC copies it and fetches it locally for the owner's review. Nobody runs git inside `agentturn`'s repository as `claudebot`, and the PC never runs code from a fetched branch before the owner reviews the diff.

### 6. Sealing the weaker user

- sshd `DenyUsers agentturn` (root's logins stay as they are). `cron.deny` and `at.deny` list it.
- The guard refuses `sudo` in command position; every refusal also goes to the system journal (`agent-guard`).

### 7. Wall 2: the hook in managed settings

- `/etc/claude-code/managed-settings.json`, root-owned, holds the PreToolUse hook (same matcher as today) and `allowManagedHooksOnly: true`; a tracked copy lives in `deploy/`.
- The hook command is sealed (fixed folder, emptied environment except `PATH` and `CLAUDE_AUTO_SESSION`, a `HOME` the turn cannot write, `bun --no-env-file` with an explicit empty config) and fails closed: any exit other than 0 becomes 2.
- The managed hook alone is proven before turns move to `agentturn`, with the local hook set aside for the proof.

### 8. Wall 3: the integrity check

`integrity.ts`, read-only, run as `claudebot`: guard files equal git; managed settings and sudoers equal the tracked copies; no hooks, `disableAllHooks` or `env` in the local or the turn user's settings; no `bunfig.toml` where any bot process would load one; no `.env*` in the repo or the state folder; no stray state in the repo; no links anywhere under `STATE_DIR` (searched as root, so a folder a turn closes cannot hide one), every folder of the layout with its owner and mode, and the database files owned by `claudebot`; the inbox key's line unchanged; `agentturn` sealed (no sudo, groups, cron/at deny, sshd deny, home and rc files root-owned, no `CLAUDE.md`, `skills`, `agents`, `commands` or `output-styles` in its Claude config folder); the closed folders' modes, nothing in the repo or `~/.bun` writable by others or by group `agentdata`, and `agentturn` unable to write `guard.ts`, `poller.ts` or the `bun` binary; the firewall rule present and the first rule of `OUTPUT` (the unit inserts it at position 1, so no earlier `ACCEPT` can make it dead); `TURN_USER`, `STATE_DIR`, `AUTO_APPROVAL`, `SKILL_APPROVAL` and `INTEGRITY_NIGHTLY` set in the service's environment with the expected values, `TURN_SWEEP` not `0`, and the repo's `.state-dir` marker equal to `STATE_DIR`; refusals in the last 48 hours (reported); the database's schema exactly what `db.ts` creates (opened read-only, without following a link, with `trusted_schema` off; a planted or redefined trigger, view or table is a finding, counted, never named). Every opener of the database sets `trusted_schema=OFF`, `cell_size_check=ON` and `mmap_size=0`, and the poller reports schema drift to the owner at startup. The poller runs it nightly at 04:15 (held over Shabbat and holidays) and sends a Hebrew message on findings or when the run does not complete; `health.ts` alerts when no run has completed for 96 hours outside a quiet window; the PC sweep runs it too. Every read under the turn user's home runs as that user with a timeout, and every check has a time budget, so a planted FIFO or link cannot blind or hang it.

### 9. Wall 4: Claude Code deny rules (conditional)

A live test with the bot's exact flags in a scratch folder. If deny rules apply, a short list joins the managed file; if not, wall 4 is dropped and the reason recorded.

### 10. Guard gaps found earlier, after these walls

Pattern rules are a fence, not a wall: once turns run as `agentturn`, the protected files, the keys and the inbox are closed by file permissions, whatever command spelling a turn tries. The approval gates cover the self-renewing cases (planted jobs and planted skills); the turn's direct writes to the stores it legitimately writes (reminders, memory, the chat history in the database) stay, contained to `agentturn`. The confirm-button executor runs an approved command without the hook; its allowlist (`pending.ts` `validateArgv`) is therefore a security boundary and must only ever name scripts that run no shell.

## Rollout (each droplet step on the owner's explicit word, with a backup and a written way back)

R1 read-only pre-checks and a record of every mode, file and rule a way back restores; R2 the Linux-only tests on the droplet in a clone, then merge and deploy with every switch unset; R3 the state folder and marker (one tracked script with preflight and postflight checks, and its rollback script; the PC health skill updated in the same step); R4 user, group, sudoers, home, seals (tracked script and rollback); R5 managed settings, proven alone with a probe script built on the real turn spawn; R6 turns as `agentturn`, live checks with the owner at the phone; R7 the deny-rule test (service stopped); R8 seed and switch on both approval gates, nightly integrity, remove the local hook, docs.

## Testing

Test-first for every code change (paths and the marker, the write and read helpers, backup, turnuser argv/env/kill/sweep, every spawn site, the inbox and digest summaries, the rchannel spool, the approval gate, the guard rule, the hook wrapper, integrity checks against passing and failing fixtures). The droplet behaviours are proven live by a tracked probe script with an expected line per proof.
