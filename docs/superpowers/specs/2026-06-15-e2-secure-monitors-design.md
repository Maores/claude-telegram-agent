# E2: secure monitors — design spec

Date: 2026-06-15
Status: approved (brainstorming complete), ready for writing-plans
Feature slot: built live this session (supervised)
Roadmap origin: E2 "smart monitoring / cron upgrades" + folds in A4 "SSRF / malicious-site guard"

## Summary

A *monitor* is a typed, recurring, cheap check that pings Maor on Telegram **only when
something changes or crosses a threshold**. Most checks cost zero LLM calls. Claude is
invoked only when a monitor both fires *and* that monitor opted into a summary.

Two monitor types ship in v1, both fetch-based:

- **`webpage`** — fetch a URL, strip to text, normalize whitespace, hash it, compare to
  the last stored snapshot. Fires when the content hash changes. Optional `keyword` /
  `selector` narrows what counts as "changed" (cuts false fires from ads/timestamps).
- **`threshold`** — fetch a URL (HTML number or JSON field), read a number, compare to a
  condition (`lt` / `gt` / `cross` a value). Edge-detected: fires once *on crossing*, not
  every tick while the condition holds; re-arms when it crosses back.

## Goals

- Watch webpages/feeds for content change and numbers/prices for threshold crossings.
- Spend an LLM call only on a real fire, and only when summaries are requested.
- Be **secure against prompt injection and malicious sites by design** (Maor's explicit
  first-class requirement). This is the architectural driver, not an afterthought.

## Non-goals (v1)

- No arbitrary user-supplied check scripts (this was the rejected Approach B — it runs
  full-shell, outside the sandbox; structurally absent here).
- No "semantic / meaningful-change" detection beyond hash-diff + optional keyword.
- No multi-step monitor chaining, no `[SILENT]` reply marker (those E2-survey extras are
  deferred; not needed for the two chosen use cases).

## Decisions locked in brainstorming

1. **Check model: Approach A — typed built-in monitors.** No arbitrary shell. (Approved.)
2. **On fire: per-monitor, default plain.** Default = plain alert (untrusted content never
   reaches the model). A monitor may opt into a Claude summary. (Approved.)
3. **Storage = SQLite** `monitors` table (durable, queryable, auditable). (Default, approved.)
4. **Cadence:** per-monitor interval, default 15 min, floor 5 min. (Default, approved.)
5. **`remove` runs directly** (no confirm tap; benign GET requests, like `remind.ts cancel`).
6. **Webpage v1 = hash-diff + optional keyword**; deeper change detection deferred.

## Architecture

### Data model — new SQLite table `monitors`

Added to the single idempotent `initSchema()` CREATE block in `db.ts:31` (pattern: every
table is `CREATE TABLE IF NOT EXISTS`; `openDb()` re-runs it on every open; there is NO
migration framework, so this is additive and safe on the live droplet DB).

Columns:

- `id` TEXT PRIMARY KEY — e.g. `m` + counter, or short random (see `genId` in `reminders.ts:96`).
- `chat_id` INTEGER NOT NULL
- `name` TEXT NOT NULL — user-meaningful label.
- `type` TEXT NOT NULL — `'webpage'` | `'threshold'`.
- `url` TEXT NOT NULL
- `config` TEXT — JSON. For `threshold`: `{ jsonPath?: string, regex?: string, op: 'lt'|'gt'|'cross', value: number }`. For `webpage`: `{ selector?: string, keyword?: string }`.
- `interval_s` INTEGER NOT NULL — per-monitor cadence; floored at 300.
- `on_fire` TEXT NOT NULL DEFAULT `'notify'` — `'notify'` | `'summarize'`.
- `last_checked_ts` INTEGER
- `last_value` TEXT — last content hash (webpage) or last numeric value as text (threshold).
- `last_state` TEXT — threshold edge state: `'above'` | `'below'` | NULL.
- `consecutive_failures` INTEGER NOT NULL DEFAULT 0
- `status` TEXT NOT NULL DEFAULT `'active'` — `'active'` | `'paused'` | `'disabled'`.
- `created_ts` INTEGER NOT NULL

Index: `CREATE INDEX IF NOT EXISTS idx_monitors_active ON monitors(status, last_checked_ts)`.

### Logic module — new `monitors.ts`

Pure module mirroring `memory.ts`: every function takes `db: Database` as its first arg, no
I/O beyond the passed db (the fetch lives in `net.ts`, see below). Exports:

- `addMonitor(db, args): Monitor`
- `listMonitors(db, chatId?): Monitor[]`
- `getMonitor(db, id): Monitor | null`
- `setStatus(db, id, status)`, `removeMonitor(db, id)`
- `dueMonitors(db, nowS): Monitor[]` — `status='active' AND nowS - last_checked_ts >= interval_s`. **Pure/unit-testable.**
- `recordCheck(db, id, { lastValue, lastState, fired, failure })` — updates state + failure counter, auto-pauses at 5 consecutive failures.
- `evalThreshold(value, op, target, lastState): { fired: boolean, newState }` — **pure edge-detection state machine, unit-tested directly.**
- `Monitor`, `MonitorArgs` types; a `MonitorError` class (mirror `MemoryError`).

### Hardened fetch + SSRF guard — new `net.ts`

Pure guard helpers + one hardened fetch. The guard helpers are exported and table-tested
without network (the repo never mocks network; it tests pure helpers — see `poller.test.ts`).

- `isBlockedDestination(urlOrHost): { blocked: boolean, reason?: string }` — **pure, unit-tested.**
  Blocks: non-https schemes (https-only by default; http only if a future flag allows),
  hosts that resolve to private (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`, `::1`),
  link-local (`169.254/16`, `fe80::/10`) ranges, the cloud-metadata IP `169.254.169.254` and
  `metadata.google.internal`, and non-80/443 ports.
- `safeFetch(url): { ok, status, contentType, text } | { error }` — applies `isBlockedDestination`
  (incl. re-checking **every redirect hop**, max 3 redirects), a 10s timeout (AbortController,
  mirror `CLAUDE_TIMEOUT_MS` style in `poller.ts:41`), a ~1.5 MB response cap (abort the stream
  past the cap), a content-type allowlist (`text/html`, `application/json`, `text/plain`), a
  fixed User-Agent, and no cookies/auth.
- `extractText(html): string` + `normalize(text): string` + `hashContent(text): string` —
  **pure, unit-tested.** HTML→text, collapse whitespace, stable hash (e.g. SHA-256 via
  `crypto`).

### Scheduling — `checkMonitors()` in `poller.ts`

- New `checkMonitors()` called from inside the existing 30s reminder tick (the tick is
  `checkReminders()` at `poller.ts:1229`, registered via `setInterval(..., 30_000)` at
  `poller.ts:1393`). Piggybacking reuses the existing pruning cadence and avoids a 2nd timer.
- Each tick: `dueMonitors(getDb(), nowS)`; for each due monitor run its check **with the 10s
  fetch timeout and a small concurrency cap (e.g. `Promise.allSettled` over batches of ~4)** so
  a slow site never stalls reminder firing. (The map's key warning: work in the awaited tick
  must not block; we control the fetch so we bound it strictly.)

### The barrier stack (security core)

Applied in order on every fetch + fire:

1. **SSRF / destination guard** — `isBlockedDestination` on the URL and every redirect target.
2. **Fetch hardening** — timeout, size cap, content-type allowlist, capped redirects, no
   cookies/auth (all in `safeFetch`).
3. **`scanThreats(text, 'strict')`** — `threats.ts:103`, already pure/importable, callable on
   any string today. If it trips: never summarize — downgrade to a plain "changed (content
   flagged by safety scan, not summarized)" alert; log the block.
4. **Untrusted-data fence** (summary path only) — wrap fetched text in the inert-DATA fence
   convention used by `renderRecall` (`db.ts:318-331`); the summary prompt states the content
   is read-only external data, never instructions, and asks only "what changed?".
5. **Least-privilege summary turn** — reuse `autoSessionSpawn()` (`poller.ts:762`) →
   `--disallowedTools` + `CLAUDE_AUTO_SESSION=1`. The summary turn cannot email, schedule,
   write calendar/tasks, approve, or self-replicate; it can only read and reply.
6. **No arbitrary shell** — Approach A; structurally absent.

Net: even a malicious page that beats the scanner reaches only a sandboxed, read-only,
least-privilege turn whose sole output is a Telegram message — no exfil, no persistence, no action.

### Fire actions

- **`notify`** (default): templated plain message via `tg()` (`poller.ts:151`, which already
  runs `redact()`). Webpage: `"🔔 <name> changed: <url>"`. Threshold: `"🔔 <name>: <value>
  crossed your <op> <target>"`. Untrusted content is NOT included beyond a short, escaped
  excerpt if needed — prefer not to echo page content on the notify path.
- **`summarize`**: send a `⏳` placeholder, run a least-privilege `claude -p` via `streamClaude`
  (`poller.ts:653`) with the fenced+scanned content, stream the reply. Reuses the existing
  `[AUTO]` spawn shape (`poller.ts:1239-1257`) but with monitor content as fenced data.

### Failure handling

- On fetch/parse failure: increment `consecutive_failures`, log `[MON]`.
- Notify Maor **once** on the first failure (`"⚠️ monitor <name> couldn't fetch: <reason>"`).
- After 5 consecutive failures: auto-pause (`status='paused'`) and notify
  (`"⏸️ paused monitor <name> after repeated failures"`). A successful check resets the counter.

### Creation & management UX

New `monitor.ts` CLI (mirrors `mem.ts` / `remind.ts`: `const [cmd,...rest] = process.argv.slice(2)`,
`die()`, `parseFlags()` from `mem.ts:34`, `switch(cmd)`, `console.log` the human result):

- `add --name --type webpage|threshold --url [--interval 15m] [--on-fire notify|summarize] [--selector] [--keyword] [--op lt|gt|cross --value N] [--json-path] [--regex]`
- `list` | `show <id>` | `pause <id>` | `resume <id>` | `remove <id>` | `check <id>` (run once now, for testing)

Maor creates/manages monitors in plain language over Telegram ("watch this page, ping me if
it changes"; "tell me if BTC drops below 40k"); the agent translates to the CLI. Creation
runs without a confirm tap (benign, like `remind.ts add`). CLAUDE.md gets a "Monitors"
section documenting the CLI + routing (monitor vs reminder vs task).

### Least-privilege guard

`[AUTO]` / scheduled sessions must NOT create monitors (self-replication guard, same as
`remind.ts add`):

- Add `Bash(bun run monitor.ts add *)` to `AUTO_DISALLOWED_TOOLS` (`poller.ts:750`).
- Add a `monitor.ts add` denial to `checkAutoSession` (`guard.ts:140`) and a golden case in
  `guard.test.ts`.

## Testing (TDD, network-free per repo convention)

Pure exported helpers get full coverage; live fetch + Telegram send stay untested but are
assembled from tested pieces.

- `net.test.ts` — `isBlockedDestination` table (private ranges, metadata IP, loopback,
  link-local, schemes, ports, redirect targets); `extractText`/`normalize`/`hashContent`
  determinism.
- `monitors.test.ts` — `evalThreshold` edge state machine (below→above fires once, holding
  doesn't re-fire, re-arm on cross-back; `lt`/`gt`/`cross`); `dueMonitors` selection;
  `recordCheck` failure counter + auto-pause at 5; store CRUD via `openDb(':memory:')`.
- `db.test.ts` additions — `monitors` table appears in `sqlite_master`; `initSchema`
  idempotent.
- `guard.test.ts` additions — `monitor.ts add` blocked under `[AUTO]`.
- `monitor.ts` CLI flag parsing (if logic is extracted to a pure helper).
- `scanThreats` fence-path behavior reuses `threats.test.ts` patterns.

## File-by-file change list

- `db.ts` — add `monitors` table + index to `initSchema` (`db.ts:31`).
- `net.ts` — NEW: SSRF guard + `safeFetch` + text/hash helpers.
- `monitors.ts` — NEW: pure logic module (`db:Database` first arg).
- `monitor.ts` — NEW: CLI.
- `poller.ts` — add `checkMonitors()` + call it inside `checkReminders` (`poller.ts:1229`);
  implement notify + summarize fire paths (reuse `streamClaude` `poller.ts:653`,
  `autoSessionSpawn` `poller.ts:762`, `tg()` `poller.ts:151`); add `monitor.ts add` to
  `AUTO_DISALLOWED_TOOLS` (`poller.ts:750`).
- `guard.ts` — add `monitor.ts add` denial to `checkAutoSession` (`guard.ts:140`).
- `CLAUDE.md` — new "Monitors" section (CLI usage + routing rules).
- Tests as above.

## Out of scope / follow-ups

- Broader agent hardening Maor mentioned (A6 supply-chain OSV gate; Hebrew-language injection
  patterns in `threats.ts` — the current patterns are English/ASCII-anchored and would miss a
  Hebrew-phrased injection) — note as follow-ups; E2 itself ships secure.
- `[SILENT]` reply marker, job chaining, arbitrary scripts — deferred.
