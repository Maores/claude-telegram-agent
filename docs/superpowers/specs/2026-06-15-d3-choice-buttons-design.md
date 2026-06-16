# D3: choice buttons — design spec (self-contained)

Date: 2026-06-15
Status: approved (brainstorming complete), ready for writing-plans
Feature slot: built UNATTENDED by a scheduled routine ~3h after creation
Roadmap origin: D3 "clarify with structured choices"

> This spec is written to be implemented by a fresh agent with **no memory of the design
> conversation**. Everything needed is below, with file:line anchors. Read the anchors in the
> live code before editing — line numbers may have drifted.

## Context for an implementer who is new to this repo

This is a headless personal-assistant Telegram agent. Each incoming Telegram message spawns a
**fresh `claude -p` session** in the repo dir; its stdout is sent back as the reply. Sessions
are **stateless between messages** — continuity comes only from per-chat history/recall that
`buildPrompt` injects. Stack: Bun + TypeScript + SQLite. `poller.ts` is the single
long-running process: it long-polls Telegram, spawns `claude -p`, streams replies, fires
reminders, and handles inline-button taps.

The bot already has a full inline-button loop (confirm ✓/✗ and reminder done/snooze). A
`claude -p` turn never acts on a button itself — it **registers a record via a CLI**, and after
the reply streams, the poller picks up that record and renders buttons. Taps arrive as
`callback_query` updates and are routed by a `callback_data` namespace prefix.

## Summary

Give the agent a way to ask **Maor** a multiple-choice question rendered as inline Telegram
buttons. Maor taps an option; the chosen option becomes the **next turn** to a fresh `claude -p`
session. This is the generic "clarify with buttons" capability. It does **not** modify the
existing confirm (✓/✗) flow.

## Decisions locked in brainstorming

1. **Signal = a new CLI (`ask.ts`), not stdout parsing.** Mirrors `confirm.ts` exactly. The
   model calls it to register a question. No output-parsing, no Markdown/redaction pitfalls.
2. **Render = post-turn pickup** — a `sendPendingChoices()` beside `sendPendingProposals()`.
3. **`callback_data` = index-encoded** `ch:<choiceId>:<optionIndex>` (and `:o` for Other), to
   respect Telegram's 64-byte limit; option text resolved server-side.
4. **Store = a JSON sibling `choices.json`** mirroring `pending.ts`: turn-tagged, once-only
   consume, 1-hour expiry, `withFileLock`. Quiet expiry, no nudge.
5. **No `validateArgv`** — a clarify question runs nothing; the tapped option is treated as
   untrusted user text on the next turn, like any typed message.
6. **`[AUTO]`/unattended sessions cannot ask** (no human at fire time) — block `ask.ts` in
   `[AUTO]`.
7. **Answer delivery = self-contained handler** (`answerChoice()`), NOT a refactor of
   `handleMessage`. ~15 lines of overlap is acceptable; do not touch the central message
   handler. (This minimizes regression risk for an unattended build and merge-conflict risk
   with the parallel E2 branch, which also edits `poller.ts`.)

## Existing infrastructure to reuse (read these first)

- `confirm.ts:67-87` — the propose CLI pattern `ask.ts` copies (reads `TELEGRAM_CHAT_ID` +
  `TELEGRAM_TURN_ID` from env, validates, writes to store, prints a "buttons will appear"
  line, never acts directly).
- `pending.ts` — `PendingAction` (`pending.ts:15-23`), `proposeAction`/`takePending`/
  `consumeAction` (`pending.ts:86/114/122`), `withFileLock`, once-only + stale/expired
  semantics, `PENDING_FILE` env override for tests. `choices.ts` mirrors this with a
  different payload (question + options instead of argv).
- `poller.ts:1031` `handleCallback` — top callback router; parses `pa:`/`fu:` namespaces,
  ACKs fast (`poller.ts:1037`), allowlist-checks (`poller.ts:1039`), dispatches. **Add a third
  `ch:` branch here** and update the unknown-namespace guard at `poller.ts:1045`.
- `poller.ts:1120` `handlePaCallback` — the structural template: consume once-only →
  cross-chat fail-safe (`poller.ts:1141`) → act → `editMessageText` receipt. `handleChCallback`
  follows this shape but its terminal action is "enqueue a new turn", not "run frozen argv".
- `poller.ts:1100` `sendPendingProposals` — post-turn pickup (`takePending(chatId,turnId)` →
  `sendMessage` + keyboard). Clone as `sendPendingChoices`; call beside the existing site at
  `poller.ts:988` (interactive turn). Do NOT add it to the `[AUTO]` site (`poller.ts:1257`)
  since `[AUTO]` may not ask.
- `poller.ts:280-321` — keyboard builders + callback parsers (`paKeyboard` `:314`,
  `parsePaCallback` `:309`, `fuKeyboard` `:280`). Add `choiceKeyboard` + `parseChCallback`
  beside them as **exported pure functions** (so they're unit-testable without network).
- `dispatch.ts` — `classifyUpdate` (`:33`), `ChatQueues` per-chat FIFO (`:43`), `SerialChain`
  global callback chain (`:89`). Callbacks run on the single `cbChain`; a tap that spawns a
  turn must hop to `chatQueues.enqueue(chatId, ...)` so it doesn't block the callback chain.
- `poller.ts:773` `handleMessage` and its tail (`poller.ts:949-987`): compute history/recall/
  skills from PRIOR messages → `buildPrompt` (`poller.ts:551`/call at `:973`) → `streamClaude`
  (`poller.ts:653`) → persist both messages via `insertMessage` (`poller.ts:982-983`) →
  `sendPendingProposals` (`poller.ts:988`). `answerChoice` reuses these pieces.
- `tg()` `poller.ts:151` — the single outbound chokepoint (runs `redact()` at `:154`). All
  sends/edits go through it. Plain text only (no `parse_mode`; Markdown shows literally).

## Architecture

### `ask.ts` (new CLI)

`ask.ts choice --question "..." --option "A" --option "B" [--option "C"] [--option "D"] [--allow-other]`

- 2–4 options (Telegram row limits + 64-byte budget); reject <2 or >4.
- Reads `TELEGRAM_CHAT_ID` + `TELEGRAM_TURN_ID` from env (set by `streamClaude` at
  `poller.ts:668` and the per-turn env at `poller.ts:977`).
- Writes a `Choice` record to `choices.json` via `choices.ts`; prints a confirmation like
  `"(choice buttons will appear after this reply)"`. Never sends anything itself.
- Document in `CLAUDE.md` so the model calls `ask.ts` instead of asking free-text when a
  small set of discrete options is the natural UX.

### `choices.ts` (new JSON store, mirrors `pending.ts`)

`Choice` record:

```
{ id: string;            // 'ch' + ts + rand, like pending's 'pa'+...
  chatId: number;
  question: string;
  options: string[];      // 2-4
  allowOther: boolean;
  createdAt: number;
  status: 'pending' | 'answered' | 'expired';
  turnId: string }
```

Exports (mirror `pending.ts`): `proposeChoice`, `takePendingChoices(chatId, turnId)`,
`consumeChoice(id) -> { outcome: 'ok'|'stale'|'expired', choice? }` (once-only flip
pending→answered, idempotent on repeat taps), `pruneChoices(nowS)` (1-hour expiry). All
mutations under `withFileLock`. `CHOICES_FILE` env override for tests (copy the `PENDING_FILE`
pattern). No `validateArgv` — this store executes nothing.

### Callback protocol (exported pure helpers in `poller.ts`)

- `choiceKeyboard(id, options, allowOther)` → `{ inline_keyboard: [[{text,callback_data}], ...] }`,
  one button per option (rows of 1–2), `callback_data = 'ch:<id>:<idx>'`, plus an
  `'ch:<id>:o'` Other button when `allowOther`. Labels are plain text.
- `parseChCallback(data)` → `{ id, idx: number | 'o' } | null` from `/^ch:([\w-]+):(\d+|o)$/`.
  Must reject malformed data and (when resolving) an `idx` out of range against the stored
  record.

### `handleChCallback` (new, modeled on `handlePaCallback` `poller.ts:1120`)

1. `parseChCallback`; if null, ignore (unknown/forged).
2. `answerCallbackQuery` ACK immediately (`poller.ts:1037` pattern) — before any slow work.
3. Allowlist check (`poller.ts:1039`); `consumeChoice(id)` once-only; cross-chat fail-safe
   (verify `choice.chatId === tap.chatId`, `poller.ts:1141`). On stale/expired, edit the
   message to "(this question already answered / expired)" and stop.
4. Resolve `idx` → option text. For `:o` (Other): edit the message to "Type your answer below"
   and stop — Maor's next normal typed message flows through the existing `handleMessage` path
   unchanged (no special capture needed).
5. `editMessageText` the question message into a receipt: `"✓ You chose: <option>"`.
6. **Hop to the per-chat queue**: `chatQueues.enqueue(chatId, () => answerChoice(chatId, choice, option))`
   so the new turn preserves per-chat ordering and does NOT block the global `cbChain`
   (detach like `handlePaCallback` does at `poller.ts:1162-1182`).

Wire all this into `handleCallback` (`poller.ts:1031`) as a third namespace branch alongside
`pa:`/`fu:`, and update the `(!pa && !parsed)` unknown-namespace guard (`poller.ts:1045`).

### `answerChoice(chatId, choice, option)` (new, self-contained turn)

A trimmed copy of the `handleMessage` tail (`poller.ts:949-988`) — deliberately self-contained,
NOT a refactor of `handleMessage`:

1. Persist the question to history as an assistant message and the chosen option as a user
   message via `insertMessage` (`poller.ts:982-983`), so the fresh next session sees
   "[assistant asked X] → [user chose Y]" naturally (no faked in-prompt context needed).
2. Send a `⏳` placeholder via `tg()`.
3. Compute history + recall + skills from PRIOR messages (mirror `poller.ts:949-965`).
4. `buildPrompt(history, name, option, recall, memory, skills)` (`poller.ts:551`).
5. `streamClaude(...)` with **normal interactive privileges** (this is a real user-driven turn,
   not `[AUTO]`).
6. Persist the assistant reply; call `sendPendingProposals` AND `sendPendingChoices` for this
   new turn (the answer turn may itself propose a confirm or ask a follow-up choice).
7. Reactions (👀/👍) are skipped here — there is no source user message to react to.

### Housekeeping

Add `pruneChoices(nowS)` beside `pruneActions(nowS)` on the reminder tick (`poller.ts:1316`).

### `[AUTO]` guard

Block `ask.ts` in unattended sessions: add `Bash(bun run ask.ts *)` to `AUTO_DISALLOWED_TOOLS`
(`poller.ts:750`) and a denial in `checkAutoSession` (`guard.ts:140`), with a `guard.test.ts`
case.

## Testing (TDD, network-free per repo convention)

Telegram is never mocked; all logic lives in exported pure helpers tested directly.

- `choices.test.ts` — modeled on `pending.test.ts`: set `CHOICES_FILE` to a pid-suffixed temp
  file, `beforeEach` rm the file + `.lock`; assert propose → `takePendingChoices` by turnId →
  `consumeChoice` once-only (second consume returns `stale`), 1-hour expiry, `pruneChoices`.
- `poller.test.ts` additions — `parseChCallback` (valid parse, malformed reject, `idx`
  out-of-range reject, `:o` Other), `choiceKeyboard` shape + `callback_data` ≤64 bytes for the
  longest id + 4 options + Other.
- `guard.test.ts` addition — `ask.ts` blocked under `[AUTO]`.

## File-by-file change list

- `ask.ts` — NEW: the choice-signal CLI.
- `choices.ts` — NEW: JSON store (mirror `pending.ts`).
- `poller.ts` — add `choiceKeyboard` + `parseChCallback` (exported, beside `poller.ts:280-321`);
  `sendPendingChoices` (beside `sendPendingProposals` `poller.ts:1100`; call at `poller.ts:988`
  only); `handleChCallback` + the `ch:` branch in `handleCallback` (`poller.ts:1031`/`1045`);
  `answerChoice`; `pruneChoices` call on the tick (`poller.ts:1316`); `ask.ts` in
  `AUTO_DISALLOWED_TOOLS` (`poller.ts:750`).
- `guard.ts` — `ask.ts` denial in `checkAutoSession` (`guard.ts:140`).
- `CLAUDE.md` — document `ask.ts` so the model uses it for discrete-option clarifications.
- Tests as above.

## Routine execution instructions (for the scheduled run)

- Branch off the **current `origin/main`** at fire time (E2 may or may not be merged by then;
  D3 is independent — both touch `poller.ts` in different functions).
- Follow TDD: write the failing tests first, then implement.
- Run the full suite with `bun test` and confirm all green before finishing.
- **Open a PR; do NOT merge to main.** Leave it for Maor to review.
- If any anchor in this spec doesn't match the live code, prefer the live code and note the
  drift in the PR description.

## Out of scope (v1)

- Free-text capture inside the button UI (the Other path just asks Maor to type).
- More than 4 options; auto-cancelling a pending choice when Maor types something else.
- Using D3 to re-skin the existing confirm (✓/✗) flow.
