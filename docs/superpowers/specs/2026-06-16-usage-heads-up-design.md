# Usage heads-up & limit-hit clarity — design spec (self-contained)

Date: 2026-06-16
Status: approved (brainstorming complete), ready for writing-plans
Agenda origin: post-compact agenda item #5 (see memory `agent-dev-agenda.md`)

> This spec is written to be implemented by a fresh agent with **no memory of the design
> conversation**. Everything needed is below, with file:line anchors. Read the anchors in the
> live code before editing — line numbers may have drifted.

## Context for an implementer who is new to this repo

Headless personal-assistant Telegram agent. Each Telegram message spawns a **fresh `claude -p`
session** in the repo dir; stdout is the reply. Bun + TypeScript + SQLite. `poller.ts` is the
single long-running process. `stream.ts` wraps the `claude -p` invocation: it parses the
`stream-json` event stream and returns the final reply text to `poller.ts`.

`claude -p` is invoked with `--output-format stream-json` ([poller.ts:701](../../../poller.ts)).
The stream emits a terminal `result` event that includes `total_cost_usd` and a `usage` object
(input/output token counts). **Today the bot reads only the result text and discards cost +
usage** (around [stream.ts](../../../stream.ts) lines 52-57). When a call fails, `poller.ts`
throws a generic error / sends a fixed warning (around [poller.ts:1056](../../../poller.ts)),
so a quota/limit exit is indistinguishable from any other failure.

### Hard constraints (verified during brainstorming — do not design against false hopes)

- **A Pro/Max subscription's *remaining quota* is NOT queryable** from `claude -p` output. No CLI
  surface exposes "you have X% of your window left."
- **`total_cost_usd` is an API-pricing *equivalent*, not a plan balance.** It is the only
  cost signal available, so it is used as a *proxy*, clearly labelled as such to the user.
- **The exact stderr wording of a real limit-hit is UNVERIFIED.** The classifier (Component C)
  must be built after observing a real limit-hit's error text (or from whatever the Anthropic
  CLI/SDK change documents). Until then, retry-time extraction is best-effort.

## Summary

Two user-facing capabilities on a shared tracking substrate:

- **B. "Burning a lot lately" heads-up** — the bot pings Maor when its *own* `claude -p` spend
  over a rolling window crosses a self-set threshold. A proxy for "ease off", not a real cap.
- **C. Limit-hit clarity** — when a `claude -p` call fails by hitting the usage limit, send a
  clear message ("hit the usage limit, try again later") instead of today's generic error.

Both read data the bot already receives but throws away. **Neither may ever crash the core reply
loop** — if the data is missing or the format changed, the bot replies as normal and simply
skips the usage logic.

## Scope decisions locked in brainstorming

1. **Two capabilities only (B + C).** No periodic report, no per-feature cost attribution, no
   real-quota reading.
2. **Metric = cost in USD** (not Opus-call count, not raw tokens) — the only metric that fairly
   weighs an Opus call against a Sonnet one.
3. **Thresholds are self-set env vars with conservative defaults**, tuned later once real data
   exists. The default is explicitly a guess until tracking produces numbers.
4. **Fail-safe is mandatory.** All capture/parse is defensive; a `claude -p` output-format change
   (the looming Anthropic CLI/SDK change) must degrade to "no usage data", never to a broken bot.
5. **Review-loop (Haiku) cost is NOT tracked** — `review.ts` spawns detached with stdout ignored,
   so its `result` event is unavailable. It is cheap; accepted gap.

## Components

### A. Usage-tracking substrate

**A1. Capture in `stream.ts`.** Where the `result` event is parsed (today discards cost/usage),
also read `total_cost_usd` and `usage.input_tokens` / `usage.output_tokens`. Extend
`streamClaude`'s return value to include an optional `usage` field:
`{ costUsd?: number, inputTokens?: number, outputTokens?: number }`. If the fields are absent or
the event shape is unexpected, leave them `undefined` — **do not throw**.

**A2. New SQLite table `usage_log`** (idempotent `CREATE TABLE IF NOT EXISTS` in `db.ts`
`initSchema`, matching the no-migration-framework convention used by the `monitors` table):

```
usage_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,            -- unix seconds
  chat_id TEXT NOT NULL,
  model TEXT NOT NULL,            -- 'sonnet' | 'opus' (the model that ran)
  kind TEXT NOT NULL,             -- 'interactive' | 'auto'
  cost_usd REAL,                  -- nullable (capture may fail)
  input_tokens INTEGER,
  output_tokens INTEGER
)
```

**A3. Record after each call** in `poller.ts`, on the paths that have the parsed result
(interactive path around [poller.ts:954](../../../poller.ts); `[AUTO]` path around
[poller.ts:1618](../../../poller.ts)). Insert one `usage_log` row. Wrap in try/catch — a logging
failure must not affect the reply.

A small module (e.g. `usage.ts`) owns the pure logic so it is unit-testable:
- `recordUsage(db, row)` — insert (caller wraps in try/catch).
- `windowSpendUsd(db, sinceTs)` — sum `cost_usd` for `ts >= sinceTs` (ignores NULLs).

### B. "Burning a lot lately" heads-up

- Config (env, with defaults; mirror `REVIEW_COOLDOWN_S` / monitor `MIN_INTERVAL_S` style):
  - `USAGE_WARN_USD` — threshold (conservative default, e.g. a few dollars).
  - `USAGE_WINDOW_S` — rolling window, default `18000` (5h).
- After recording a call, compute `windowSpendUsd(db, now - USAGE_WINDOW_S)`.
- **Edge-detected + cooldown**, reusing the E2 monitor `evalThreshold` pattern
  ([monitors.ts](../../../monitors.ts)): fire **once** when the rolling sum crosses
  `USAGE_WARN_USD` upward; do not fire again until it has dropped back below (re-arm). Track the
  armed/fired state in a tiny persisted spot (a `meta`/state row, or an in-memory flag that
  resets on restart — match how monitor state is stored). Optionally a minimum re-notify cooldown.
- On fire, send a plain-text Hebrew heads-up to `TELEGRAM_CHAT_ID`, e.g.:
  *"שים לב: הבוט צרך ~$X ב-{hours} השעות האחרונות, מעל הסף שהגדרת ($Y). זה אומדן עלות, לא המכסה האמיתית."*
  (The "estimate, not the real quota" clause is required honesty.)
- The check runs on the normal poller flow after a logged call; it does NOT spawn a model call.

### C. Limit-hit clarity

- A pure classifier `isLimitHitStderr(stderr: string): boolean` in `usage.ts` (or `stream.ts`):
  match known usage/limit patterns. **The pattern set must be derived from a real observed
  limit-hit error** (see Hard constraints) — until verified, keep it conservative and clearly
  TODO-marked so it errs toward the generic message rather than false-claiming a limit-hit.
- A best-effort `parseRetryAfter(stderr: string): string | null` — return a human phrase only if
  the error text carries a retry time; otherwise `null`.
- In `poller.ts`'s failure path (around [poller.ts:1056](../../../poller.ts)): if
  `isLimitHitStderr` matches, send a clear Hebrew message — *"נראה שהגעת למגבלת השימוש"* + the
  retry phrase if available, else *"נסה שוב מאוחר יותר"* — instead of the generic warning.
- If it does not match, behaviour is unchanged (generic error).

## Data flow

```
claude -p result event (cost + tokens)  ──► stream.ts captures (or leaves undefined)
   ──► streamClaude returns {text, usage?}
   ──► poller.ts: recordUsage(usage_log row)   [try/catch — never breaks reply]
   ──► windowSpendUsd(now-WINDOW) crosses WARN_USD upward (edge) ──► Hebrew heads-up to chat

claude -p FAILS  ──► poller.ts failure path
   ──► isLimitHitStderr(stderr)? ── yes ──► clear "hit the limit" + best-effort retry phrase
                                  └─ no ──► existing generic error (unchanged)
```

## Integration points

- **#4 (dev-intent):** #4 deliberately has no usage-awareness. Once this substrate exists, #4's
  recommendation *may* later read `windowSpendUsd` to bias toward Sonnet under heavy load. Leave a
  comment marking that hook in #4's code; do not wire it now.
- **Anthropic CLI/SDK change (PR #31 / todolist.md):** Components A1 and C read exactly the
  surfaces that change could alter (`result` event shape; error wording). The fail-safe rules
  above are the mitigation. When the change's specifics are known, re-verify A1's field reads and
  C's stderr patterns.

## Error handling & edge cases

- Missing/changed cost fields → `usage` undefined → no row logged, reply unaffected.
- `usage_log` insert fails → caught, logged, ignored.
- Threshold heads-up must not double-fire (edge-detect + re-arm).
- `[AUTO]` calls ARE logged (they consume budget too) and DO count toward the rolling sum; the
  heads-up may fire during an `[AUTO]` run — that is fine, it still pings the chat.
- Clock: all timestamps unix seconds, server clock (Asia/Jerusalem), consistent with the rest of
  the repo.

## Testing (TDD), all pure functions

1. `windowSpendUsd(db, sinceTs)` — sums only rows within the window, ignores NULL `cost_usd`.
2. Threshold edge-detector — crossing up fires once; must drop below `USAGE_WARN_USD` to re-arm;
   staying above does NOT re-fire. (Mirror the monitor `evalThreshold` tests.)
3. `isLimitHitStderr(stderr)` — limit/quota patterns → true; ordinary errors/timeouts → false.
4. `parseRetryAfter(stderr)` — extracts a phrase when present, returns null otherwise.
5. Regression: a `result` event missing cost/usage yields `usage: undefined` and `streamClaude`
   still returns the reply text (fail-safe).

## Non-goals

- No reading of real subscription quota (impossible).
- No periodic usage report, no per-feature attribution.
- No tracking of review-loop (Haiku) cost (stdout ignored; cheap).
- No change to confirm/reminder/choice button flows.
