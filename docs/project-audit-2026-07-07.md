# Project audit, 2026-07-07

Task 2 of the July plan: judgments on top of the facts in docs/state-of-project-2026-07-07.md. Every claim below was verified this session by reading the code, the live droplet config, or the telemetry (not inherited from the earlier report; several of its concerns were downgraded or corrected after verification, see "Corrections" at the end). The quality bar applied is the one Maor set: does each area hold up to the standard the strongest parts of this project establish.

## The verdict

The engineering core is genuinely strong: disciplined tests, a layered and honestly documented safety model, clean module boundaries around a single large hub, deliberate cost engineering, and code comments that explain why, not what. The weak axis is continuity: everything lives on one droplet with no database backup, no external "is it alive" check, and a fresh-install runbook that would silently produce a bot without its safety hook. None of those are hard to fix, and none undermine the daily product today. The portfolio storefront is the most visible gap relative to the project-goal (CV-worthy): the repo's engineering story is excellent but invisible from the GitHub landing page.

## Scorecard

| Area | Verdict | Headline |
|---|---|---|
| Code quality and tests | Above the bar | 566 tests, TDD culture visible, 0 reverts, healthy 16% fix ratio |
| Safety model | Above the bar | Layered, fail-closed, honestly documented; best-in-class for a hobby agent |
| Product/UX | At the bar | Features Maor uses daily work well; a few shipped features sit unused |
| Cost engineering | At the bar | $0.85/day all-in; but scheduled jobs run Sonnet and the review loop is unmetered |
| Operations | At the bar | systemd + graceful drain + lossless deploys work; verified at two deploys this week |
| Continuity/DR | Below the bar | No bot.db backup, no external liveness alerting, OAuth single point with a 28h outage precedent |
| Fresh-install reproducibility | Below the bar | DEPLOY.md omits the guard hook; hooks/README contradicts the live wiring |
| Portfolio presentation | Below the bar | Public repo with no description, topics, license, CI badge, diagram, or demo |

## What works great

1. Test discipline. 566 tests across 24 files, co-located with source, run in ~5s. The pattern of extracting pure logic (quiz.ts, guard.ts, pending.ts, selfdev.ts) out of the I/O hub specifically so it can be tested is applied consistently. History shows 0 reverts and a 16% fix-commit ratio, healthy for a project shipping this fast.
2. The safety architecture. Fail-closed PreToolUse floor, least-privilege [AUTO] sessions enforced twice (spawn args + hook re-check), provenance quarantine on memory/skills, confirm-gated calendar writes with frozen argv, redaction at the single send chokepoint, SSRF-guarded monitors. hooks/README.md explains the threat model and includes a manual verification script. This is the strongest part of the codebase and a real differentiator.
3. Deliberate cost design, with reasons written down. Keyword routing instead of an LLM classifier (model.ts:2-7 explains the latency/cost tradeoff), the review pass on haiku with a two-command tool whitelist and no permission skip (review.ts:11-13), quiz evaluation riding the normal turn instead of a second call. The overall run rate ($0.85/day API-equivalent) proves it works.
4. Self-observability. The agent meters its own spend (usage_log), edge-detects overspend and pings Maor in Hebrew, classifies limit-hit errors conservatively (usage.ts:66-69 even documents that the error wording is unverified and errs toward the generic message). Few hobby projects instrument themselves like this.
5. Operational recovery patterns that have been exercised for real: graceful drain observed at both deploys this week, deploy.sh autosave rescuing the agent's own hot-patches, the uploads-loop incident ending in a self-authored fix merged as PR #40. The incident history is a strength, not a blemish; each one produced a durable mechanism.
6. Documentation accuracy where it counts: every command CLAUDE.md promises exists; DEPLOY.md matches the live systemd unit; the specs/plans archive (24 documents) records why each feature is shaped the way it is.
7. The trust-boundary thinking: outside content (email, web, monitor fetches) is fenced as data, quarantined on write, and threat-scanned. The rule "only Maor's Telegram messages are commands" is enforced in code paths, not just stated.

## What lacks, ranked

### Tier 1: real risks, cheap to fix

1. No backup of bot.db. Verified: nothing in the repo dumps or copies the database (the only "backup" hits are .bak edit snapshots for skills/memory files). bot.db holds ALL agent state: 523 messages, 21 memory facts, skills, monitors, usage history; reminders.json and uploads/ ride alongside, equally unprotected. A droplet loss erases the agent's accumulated identity. Fix is small: a nightly sqlite .backup + copy off-box (even scp to this Windows machine, or DO snapshots at ~20% of droplet cost). Maor confirmed 2026-07-07: no DO backups enabled as far as he knows, so this stands as the top Tier-1 risk and should lead the task-3 roadmap.
2. Nobody watches the watcher. If the droplet dies, the token expires (happened 2026-06-20, ~28h outage), or Telegram polling wedges, the failure mode is silence; Maor discovers it by noticing the agent stopped answering. There is no external liveness check. A free uptime pinger hitting a tiny health endpoint, or even a daily [AUTO] heartbeat with a dead-man rule, closes this.
3. Fresh-install gap on the safety floor. DEPLOY.md never mentions the guard hook (verified: the only "hook" matches in it are Telegram webhooks). hooks/README.md says to wire it into the tracked .claude/settings.json, but production actually carries it in the untracked settings.local.json (verified live this session). Consequence: a rebuild-from-runbook produces a bot with full Bash and no hardline floor, and the discrepancy would not be noticed because nothing verifies the hook at startup. Fix: a DEPLOY.md step + a startup self-check (poller warns if the hook isn't registered) + align the README with reality.

### Tier 2: quality and efficiency

4. The review loop is unmetered. review.ts spawns claude directly (Bun.spawn, stdout ignored), bypassing streamClaude, so its ~18 runs/week never reach usage_log. Haiku-cheap, but the meter that exists specifically to know what the agent costs has a permanent blind spot, and the usage-warning threshold operates on undercounted data.
5. Scheduled jobs all run Sonnet. Telemetry: kind=auto is 37 calls, $5.18, 29% of all spend, and produces more output tokens (92k) than the entire interactive history (84k), because the nightly summary and channel digest are long-form. These are formulaic summarization jobs; the haiku lever identified in the July-3 billing research would cut roughly a third of total spend with a one-line routing change per job. Worth doing before the Anthropic credit-split lands.
6. poller.ts is a 2,177-line god-file and getting bigger. 48 of 221 commits touch it, by far the highest churn. The extraction pattern (dispatch, stream, quiz, choices) works; it just hasn't been applied to the remaining big chunks (attachment pipeline, prompt assembly, callback routing, scheduler loops). Manageable today, the main scaling risk for tomorrow.
7. No schema migrations. db.ts hardcodes the schema; changes so far were hand-done additive columns. With one deployment this is tolerable, but the first breaking change (or the first restore-from-backup onto newer code) will hurt. A tiny meta-table version + ordered migration list is a half-day.
8. No CI. Tests only run when someone runs them. The suite is fast and green; a GitHub Actions workflow (bun test on push) costs nothing, guards the main branch, and produces the badge the portfolio wants anyway.

### Tier 3: polish and housekeeping

9. GitHub storefront: no description, no topics, no LICENSE, no CI badge, README a month old (predates monitors, choice buttons, reply-context, quiz), no architecture diagram, no demo GIF. For a portfolio piece this is the highest visibility-per-hour work available.
10. Stale docs: ROADMAP.md frozen at June 11; quiz-system-guide.md describes the 554-question target while 80 are live (the friend's bank is still pending drop-in); VOICE-NOTES-INSTALL-GUIDE.md sits untracked on the Windows machine; MIGRATION-azure-student.md is orphaned by the June-15 hosting decision.
11. Unused surface: the calendar-event-check skill has 0 uses, one monitor exists, /sonnet prefix and the opus keyword triggers are nearly never exercised (1 opus call in 156). Not harmful; worth knowing what earns its keep when task 3 prioritizes.
12. Housekeeping: ~10 stale local branches + ~28 unpruned merged remote branches, a June-10 stash still parked on the droplet, the legacy cal_check.sh cron (20:00 daily) overlapping the poller's built-in nudges, an empty finally block and a leftover "existing error path unchanged" comment in poller.ts (~1259, 1269), and the nightly summary that came out Spanish once (2026-07-06, unexplained, watch for recurrence).

## Corrections to the state report

Verification softened three of its loose ends: shouldEchoTranscript is null-safe (transcribe.ts:51-56), so the voice-confidence concern is void; the flat-file memory fallback is a documented deliberate cutover hedge (poller.ts:646-663), not an ambiguity, though a fallback would serve June-8 stale facts; and the "silent" FTS/recall/quiz failures all log [ERR] lines to the journal (poller.ts:1180-1208), so they are invisible in chat but fully debuggable. The offset-replay window and download no-retry stand as accepted design tradeoffs, not defects.

## What task 3 should take up

The roadmap session should weigh: the Tier-1 trio (backup, liveness, install-gap) as table stakes; the haiku rerouting of scheduled jobs; CI + storefront as the portfolio push; the 554-question quiz drop-in; and only then new capabilities, judged by the daily-usefulness x demo-value rule. The unused-feature data above should inform what NOT to build more of.
