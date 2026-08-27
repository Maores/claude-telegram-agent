# State of the project, 2026-07-07

A snapshot of the Telegram agent taken the morning after the daily quiz system (PR #41) deployed. Sources: three parallel read-only code sweeps of the repo, a live SSH inspection of the droplet, the agent's own telemetry (memory/bot.db), and the docs tree. This report is deliberately descriptive, not judgmental: it is the input for the next two sessions (strengths/gaps audit, then the upgraded-features roadmap).

## TL;DR

Five weeks in (first commit 2026-06-04), the project is a working, tested, deployed product: 221 commits, PR numbers up to #41, about 8,000 lines of TypeScript source with 566 passing tests, a layered safety model, and accurate operator docs. The live droplet is healthy: 32 days of uptime, zero crash restarts, deployed exactly at origin/main, and the only errors in the past week were two transient Telegram 502s. Real usage costs about $0.85/day API-equivalent, essentially all Sonnet. The loose ends are mostly cosmetic or process-level: a bare GitHub storefront (public repo with no description, topics, or license), a stale ROADMAP.md, unpruned merged branches, the friend's 554-question quiz bank still pending drop-in, and a short list of code-level fragilities collected below for the audit.

## The numbers at a glance

| Metric | Value | Source |
|---|---|---|
| Age | 33 days (first commit 2026-06-04) | git log |
| Commits on main | 221 | git rev-list |
| Pull requests | numbered to #41 (a few superseded/closed, rest merged) | gh |
| TypeScript source | 7,995 lines across ~32 files | git ls-files + wc |
| Test code | 4,982 lines, 24 files | git ls-files + wc |
| Tests passing | 566 pass, 0 fail, 4.9s (run locally 2026-07-07) | bun test |
| Runtime dependencies | 2 (node-ical, tsdav) | package.json |
| Droplet uptime | 32 days; service restarts only at deploys | uptime, systemd |
| Journal errors, last 7 days | 2 (transient Telegram 502, self-recovered) | journalctl |
| Cost since 2026-06-16 | $17.74 API-equivalent, 156 calls | usage_log |
| Cost, last 7 days | $6.27 (46 calls; build days spike) | usage_log |
| Messages archived | 523 | bot.db |
| Active memory facts | 21 (16 user + 5 agent), 6 archived | bot.db |
| Self-written skills | 5 active | bot.db |
| Active monitors | 1 (USD/ILS threshold 3.93) | bot.db |
| Quiz questions live | 80 | data/questions.json on droplet |

## What it is

A personal AI assistant for Maor on Telegram (@maores_assistant_bot). A Bun/TypeScript poller long-polls Telegram; each incoming message spawns a fresh `claude -p` process (subscription auth, no API key) with long-term memory, keyword-recalled history, and skill suggestions injected into the prompt, and streams the answer back. It runs 24/7 on a DigitalOcean droplet as the systemd service `telegram-agent`. The repo is public at github.com/Maores/claude-telegram-agent and doubles as a portfolio piece.

## Codebase

### Layout

Flat repo root: ~32 source .ts files, 24 co-located .test.ts files, docs/ tree, two shell scripts (deploy.sh, start.sh), and minimal config. Zero framework; the only runtime packages are the two CalDAV/iCal libraries. Runtime state (bot.db, json state files, uploads/, history/, skills/) is gitignored and survives deploys.

### Core runtime

| Component | Lines | Role |
|---|---|---|
| poller.ts | 2,177 | The hub: long-poll loop, per-chat FIFO queues, attachment/voice handling, prompt assembly, claude spawn + streaming, callbacks, quiz commands, reminder/monitor/calendar scheduling, usage logging, graceful drain |
| dispatch.ts | 101 | Update triage; /stop outranks the queue; strict per-chat ordering, parallel across chats |
| guard.ts + hooks/pretooluse-guard.ts | 281 | Fail-closed PreToolUse safety floor (see safety model) |
| db.ts | 341 | SQLite (WAL) + FTS5: messages, memory, skills, monitors, usage_log, journal |
| stream.ts / model.ts / net.ts | ~300 | stream-json parsing, model routing (Sonnet default, /opus or "think hard" escalates), hardened fetch |
| transcribe.ts | 305 | Voice notes via Groq Whisper (swappable backend); audio deleted after transcription |
| review.ts | ~100 | Post-reply self-improvement pass, 15-min cooldown, allowlisted to mem.ts/skill.ts only |

Message lifecycle in one line: getUpdates -> allowlist check -> triage/queue -> attachments/voice -> prompt assembly (memory core + FTS recall + skills + last exchanges + any quiz/dev-intent directive) -> route model -> spawn `claude -p` -> stream edits to Telegram (1.5s throttle, 4096-char splits) -> persist turn + usage -> optional review pass.

### Feature surface

All ten user-facing features documented in CLAUDE.md exist in code, each with a tested core library; no documented command is missing, and no significant dead code or TODO/FIXME markers were found anywhere.

| Feature | Entry point | Storage | Write gate |
|---|---|---|---|
| Calendar (iCloud CalDAV) | cal.ts | remote + cal_notified.json | confirm.ts buttons, mandatory |
| Tasks (Apple Reminders) | todo.ts | remote (VTODO) | delete confirm-gated only |
| Telegram reminders + [AUTO] jobs | remind.ts | reminders.json | none (runs immediately) |
| Confirm buttons (frozen argv) | confirm.ts | pending.json | whitelisted argv, 24h expiry |
| Choice buttons | ask.ts | choices.json | blocked for [AUTO] sessions |
| Monitors (webpage/threshold) | monitor.ts | monitors table | https-only, SSRF-guarded, [AUTO] cannot create |
| Long-term memory | mem.ts | memory table + mirror/*.md | threat-scan, derived quarantined |
| Skills | skill.ts | skills table + skills/*.md | threat-scan, lifecycle curation |
| History search (BM25) | history.ts | messages_fts | read-only |
| Daily quiz | quiz.ts (library; poller owns /quiz commands) | data/questions.json + quiz-state.json | scheduler in poller; 6h eval-directive window |

Non-CLI capabilities in the same vein: voice notes, photo/document uploads (persisted since PR #40, size-based eviction, 500MB cap), reply-context awareness, reactions and typing indicators, mid-answer /stop, dev-intent interview directive, usage heads-up pings, nightly [AUTO] summary.

### Safety model

Layered, and every layer has tests:

1. Access allowlist per message and per button press.
2. guard.ts hardline floor via a PreToolUse hook, fail-closed: blocks rm -rf /, mkfs, fork bombs, shutdown, ~/.ssh writes, telegram .env writes, edits to guard.ts/hooks, git push --force main, curl-pipe-sh.
3. Protected-file rule: Edit/Write tools cannot touch guard.ts, hook files, or the .env.
4. [AUTO] least-privilege, enforced twice (disallowed-tools list at spawn + hook re-check): scheduled sessions cannot create reminders/monitors (self-replication), drafts, confirms, or choice questions.
5. Threat scanning + provenance quarantine on memory and skill writes; derived content held until Maor promotes.
6. Confirm-before-write buttons for calendar/task mutations with frozen argv (no shell).
7. Secret redaction at the single Telegram send chokepoint.
8. Monitors: https-only, private/metadata IPs blocked, size/time caps, content threat-scanned.
9. CLAUDE_TIMEOUT_MS hard kill (raised to 480s on 2026-07-06) and graceful SIGTERM drain (KillMode=mixed, 90s) so deploys lose no messages.

## Live droplet

Inspected over SSH on 2026-07-07 ~09:00 IDT.

| Check | State |
|---|---|
| Service | active; started 06:42:11 today (the PR #41 deploy); NRestarts=0 |
| Deployed commit | 1001fcc, identical to origin/main; working tree clean apart from the two expected untracked files (cal_check.sh, followups.json) |
| Host | up 32 days, load ~0.16, disk 3.3G/48G (7%), RAM 414M used of 1.9G (peak 567M during the Jul-6 instance) |
| Versions | bun 1.3.14, claude CLI 2.1.162, Ubuntu 24.04 |
| Journal, 7 days | clean; only two Telegram getUpdates 502s on Jul 4, self-recovered |
| Graceful drain | observed working in the log (SIGTERM -> "drained" -> clean restart) at both recent deploys (Jul 6 21:33, Jul 7 06:42) |
| Quiz | 80 questions live, no quiz-paused.flag, first auto-offer due 18:00 today |
| Leftovers | git stash@{0} from 2026-06-10 (the ported hot-patch, droppable); legacy cal_check.sh cron at 20:00 daily alongside the poller's built-in calendar nudges; start.sh kept for foreground debugging |
| SQLite | bot.db 606KB with a 4.1MB WAL (no explicit checkpointing; harmless at this scale) |
| State files | reminders.json, followups.json, choices.json, pending.json, cal_notified.json all present and fresh; uploads/ holds 2 persisted files |

## Telemetry

Cost (usage_log, API-equivalent prices, logging since 2026-06-16):

- Total: $17.74 over 156 calls in 21 days, ~$0.85/day, ~$25/month run rate.
- Last 7 days: $6.27 over 46 calls; the spike is build days (Jul 6: $3.48/19 calls; quiet days run $0.20-0.70).
- Models: 155 calls sonnet ($17.22), 1 call opus ($0.52). The /opus escalation is almost never used.

Activity (journal, last 7 days): 34 user messages, 17 button taps, 6 voice notes (confidence ~0.8 observed), 39 reminder fires (includes the daily [AUTO] jobs: nightly summary, the @AIPOST channel digest, the Sunday skill curator), 18 self-review passes, all exit 0.

Stores: 523 archived messages (FTS-indexed), 21 active memory facts (16 user + 5 agent; 6 archived; 33 journal audit entries), 5 active skills with honest use counts (hebrew-bidi-formatting 12, fetch-telegram-channel 12, image-to-pdf 2, read-any-website 2, calendar-event-check 0), 1 active monitor ("דולר מעל 3.93", threshold type, 15-min interval, currently above the line).

## Docs

| Doc | State |
|---|---|
| CLAUDE.md | fresh (2026-07-07) and verified accurate: every documented command exists in code |
| README.md | current (2026-06-12); matches layout and deploy story |
| DEPLOY.md | current runbook; matches the systemd unit, .env path, drop-in override |
| docs/quiz-system-guide.md | current design doc; note it describes the 554-question target while 80 are live |
| docs/ROADMAP.md | stale (2026-06-11): predates monitors, choice buttons, reply-context, quiz |
| docs/FEATURES-INSTALL-GUIDE.md | current to Jun 12; written for porting features to other bots |
| docs/MIGRATION-azure-student.md | orphaned; the Jun-15 hosting decision (stay on DigitalOcean) shelved Azure |
| docs/VOICE-NOTES-INSTALL-GUIDE.md | untracked on the Windows machine, never committed |
| docs/superpowers/ | 15 design specs + 9 implementation plans, the build history; useful archive, not maintained docs |
| Env vars | DEPLOY.md documents GROQ_STT_MODEL and VOICE_LANGS which the code sweep could not find being read; minor doc drift to verify |

## Repo hygiene and the GitHub storefront

- The public repo has no description, no topics, no homepage, and no LICENSE file. README exists but this is the storefront of a portfolio project.
- No CI: tests run only when someone runs them (they pass locally today). No .github/ directory.
- Branch clutter: ~10 stale local branches on the Windows machine and ~28 merged remote branches never deleted.
- Working tree on the Windows machine: clean except the untracked voice-notes guide (and now this report).
- .gitignore is tight; no secret has ever been committed; .env on the droplet is mode 600.

## Loose ends observed (input for the task-2 audit)

Code-level, from the read-only sweep (unverified beyond reading):

1. Silent FTS failures: if the skills FTS query throws, the skills block is silently empty (poller.ts ~1186 and again in the [AUTO] path ~1852); the agent loses its skills for that turn with no signal. Same swallow-and-continue pattern on quiz state loading.
2. No schema versioning/migration system in db.ts; changes so far were additive columns done by hand.
3. The Telegram offset is saved after processing, so a crash mid-message replays that update on restart (acceptable-by-design, but worth noting).
4. usage_log recording is wrapped in a swallow-all try/catch (deliberately, to never block replies), so spend tracking can undercount silently.
5. File downloads have no retry at the file layer (a transient non-200 fails the attachment; only the Telegram API layer retries).
6. Voice confidence can be null and relies on downstream null handling for the echo decision.
7. The legacy flat-file memory fallback path still exists after the DB migration; the merge semantics if both exist are unclear.
8. /stop kills whichever turn is in flight; when an [AUTO] job and an interactive turn overlap, last-one-wins.
9. The PreToolUse guard hook is wired manually in the droplet's untracked .claude/settings.local.json; a fresh clone does not get the hook automatically (DEPLOY.md covers it, but it is a manual step that reset --hard cannot repair if lost).
10. model.ts default-routes everything to Sonnet; there is no cheap-model tier in actual use (haiku lever identified in the Jul-3 billing research but not implemented).

Process/behavioral:

11. The friend's 554-question quiz bank is still pending drop-in (schema-compatible, guarded by a data-sanity test).
12. The nightly summary came out in Spanish once (2026-07-06); watch whether it recurs.
13. ROADMAP.md staleness means there is currently no single up-to-date "what's next" doc (this report + task 3 will replace it).

## Watch items (external)

- Anthropic billing: the headless claude -p credit-split is announced but paused (re-verified 2026-07-03). Measured run rate $15-25/mo is comfortably inside the announced Max credit. Prepared fallback exists on paper (env-flip runbook, API-key test, haiku lever, OpenRouter plan B) but is not yet a committed runbook in the repo.
- Hosting: DigitalOcean Student credits expire 2026-07-31; card is on file, so billing just starts (~$12-14/mo). Decision made 2026-06-15 to stay.
- OAuth token: the droplet's long-lived CLAUDE_CODE_OAUTH_TOKEN expired once (2026-06-20, ~28h outage); recovery runbook known (claude setup-token + restart).

## Environment reference

Droplet <YOUR_SERVER_IP> (claudebot@, hostname claude-bot), repo at ~/claude-bot, service telegram-agent, TZ Asia/Jerusalem, deploys via ./deploy.sh (autosaves dirty tracked edits to droplet-autosave/* branches; note the droplet cannot push, so autosave branches stay local until fetched over SSH). Local dev on Windows 11, bun 1.3.11 (droplet 1.3.14).

## How this was gathered

Three parallel read-only Explore agents over the repo (core runtime, feature surface, tests/docs/ops); local `bun test` run; `git`/`gh` history and metadata; SSH inspection of the droplet (systemd, journalctl, git state, file census) plus two short read-only bun scripts against bot.db (table counts, usage aggregates, monitor/skill/memory stats). No source files, live state, or settings were modified anywhere.
