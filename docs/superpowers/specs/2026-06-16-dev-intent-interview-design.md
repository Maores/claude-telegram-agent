# Dev-intent interview & model recommendation — design spec (self-contained)

Date: 2026-06-16
Status: approved (brainstorming complete), ready for writing-plans
Agenda origin: post-compact agenda item #4 (see memory `agent-dev-agenda.md`)

> This spec is written to be implemented by a fresh agent with **no memory of the design
> conversation**. Everything needed is below, with file:line anchors. Read the anchors in the
> live code before editing — line numbers may have drifted.

## Context for an implementer who is new to this repo

This is a headless personal-assistant Telegram agent (@maores_assistant_bot). Each incoming
Telegram message spawns a **fresh `claude -p` session** in the repo dir; its stdout is sent
back as the reply. Sessions are **stateless between messages** — continuity comes only from
per-chat history/recall that `buildPrompt` injects. Stack: Bun + TypeScript + SQLite. `poller.ts`
is the single long-running process: it long-polls Telegram, spawns `claude -p`, streams replies,
fires reminders, and handles inline-button taps.

**Model routing** is done in `model.ts` by `pickModel(text)` ([model.ts:21](../../../model.ts)),
which runs in `poller.ts` *before* the `claude -p` session is spawned. It returns
`{ model: "sonnet" | "opus", prompt }`. Default is Sonnet; it escalates to Opus on a `/opus`
prefix, on `OPUS_KEYWORDS` ("think hard", "use opus", "ultrathink", "deep dive", "reason
carefully"), or on a ``` code fence. It is deliberately **not** an LLM classifier — a per-message
routing call would re-pay the `claude -p` startup cost on every message.

A running `claude -p` session **cannot change its own model** — the model is fixed by `pickModel`
at spawn time. So "recommend a model" can only manifest as a follow-up turn that re-enters on the
chosen model.

**The bot already has a multiple-choice button mechanism (D3 / `ask.ts`).** A turn registers a
question via `ask.ts`; after the reply streams, the poller renders inline buttons; tapping an
option feeds that option's text back as the **next turn's** message. Crucially, a tapped option
is routed through `pickModel` ([poller.ts:1321](../../../poller.ts)) — so an option whose text
begins with `/opus` launches the next turn on Opus. This is the launch mechanism this feature
reuses; **no new launch plumbing is needed.**

`[AUTO]`/unattended sessions are least-privilege and may NOT call `ask.ts` (no human present at
fire time). This feature is therefore inert under `[AUTO]`.

## Summary

When Maor sends a **build request** ("develop / implement / build X", and Hebrew equivalents),
the bot should not silently run it on the default model. Instead it runs a short **interview**
(1–3 clarifying questions via D3 buttons), then **recommends a model + effort tier** and offers
**tap-to-launch** buttons that re-enter the next turn on the chosen model with the gathered
context already in chat history.

This replaces the current behaviour where "develop/build/implement" are not routing keywords at
all, so such requests quietly run on Sonnet with no scoping.

**Out of scope (decided in brainstorming):** no usage/quota awareness in this feature — all
usage/cap logic lives in agenda item #5. No LLM classifier for detection. No auto-launch.

## Decisions locked in brainstorming

1. **Lives in the Telegram bot** (not Claude Code). It modifies how dev-intent messages are
   handled in `poller.ts` + `model.ts`.
2. **Hand-off = tap-to-launch buttons** (D3), reusing the existing `ask.ts` + `pickModel`-on-
   option path. One tap launches the build on the recommended model. Not advisory-only, not
   auto-launch.
3. **No usage-awareness** — recommendation is based on task size/complexity only. Usage/cap is
   #5's job. A clean future hook is acceptable but unbuilt here.
4. **Trigger = keyword detection in code + an injected directive (playbook).** A new detector
   (parallel to `pickModel`) matches dev-intent words; when it fires, `poller.ts` injects a
   directive block into the prompt that forces Claude to run the interview-and-recommend
   playbook for this message. This in-context injection is deliberately stronger than a
   passively-suggested skill, which the model can overlook (the failure mode under investigation
   in agenda item #3.1).
5. **The interview runs on the default (Sonnet) model** — dev-intent words are NOT added to
   `OPUS_KEYWORDS`. Escalation to Opus happens only at launch, via the chosen button.
6. **Three effort tiers:** *Quick* (Sonnet), *Standard* (Opus), *Deep* (Opus + a "think hard"
   directive baked into the launched task text). Claude recommends one; buttons let Maor override.
7. **Interview is capped at 1–3 questions**, one at a time, buttons for discrete choices and
   plain text for open ones. No long preambles (Telegram chat).

## Components

### 1. `detectDevIntent(text): boolean` — new pure function in `model.ts`

- Matches dev-intent keywords, English + Hebrew, case-insensitive:
  - English: `develop`, `implement`, `build`, `add a feature`, `write code`, `code up`,
    `refactor`, `fix the bug` (tune the list during implementation; keep it small).
  - Hebrew: `בנה`, `תבנה`, `תפתח`, `יישם`, `תוסיף פיצ'ר`, `תכתוב קוד`, `תממש`.
- Returns `true` if any keyword is present. Deliberately permissive — false positives are
  absorbed by the directive's escape clause (see below), so precision is not critical.
- Does **not** affect `pickModel`'s return value (the interview stays on Sonnet).
- Fully unit-testable: a table of true/false cases incl. casual false positives
  ("build me a sandwich" → true, but the directive handles it gracefully).

### 2. Directive injection — in `poller.ts`'s prompt builder

- When `detectDevIntent(userMsg)` is true on the **interactive** path (NOT `[AUTO]`), inject a
  directive block into the prompt, alongside the existing recall/skills/confirm blocks.
- The directive text (final wording during implementation) instructs Claude:
  > This message looks like a software build/feature request for this agent's own codebase.
  > Before building anything, run the dev-intent playbook: ask Maor 1–3 short clarifying
  > questions (scope + acceptance criteria + any hard constraint), one at a time, using
  > `ask.ts` choice buttons where the answer is a small discrete set. Once you have enough,
  > recommend a model + effort tier and present tap-to-launch buttons (see playbook). Do NOT
  > start building in this turn. **If this is not actually a build request for the codebase,
  > ignore this and just answer normally.**
- The escape clause is what absorbs false positives from the permissive detector.
- Inject point: mirror how `skillsIndexBlock` is injected into `buildPrompt` (search/grep for
  the recall/skills block insertion in `poller.ts`; place the dev directive near it).

### 3. The playbook — a skill (via `skill.ts`) the directive points to

- Store the full interview-and-recommend procedure as an **active skill** (created with
  `skill.ts create --source maor`), so the steps are versioned and improvable, and so the
  directive can stay short.
- Playbook steps:
  1. Ask 1–3 clarifying questions, one per turn, via `ask.ts` (buttons) or plain text.
     Continue across turns by reading the recent chat history (the dev keyword is only in the
     first message; on answer-turns, the in-progress interview is visible in history — the
     playbook says "if the recent history shows an in-progress dev interview, continue it").
  2. When enough is known, judge task size and choose a recommended tier.
  3. Register the launch buttons via `ask.ts` with option text that encodes the model:
     - `[בנה מעמיק — Opus]` → option text begins `/opus ` + the concrete build instruction +
       a "think hard" cue (Deep tier).
     - `[בנה — Opus]` → `/opus ` + build instruction (Standard tier).
     - `[טיוטה מהירה — Sonnet]` → build instruction with no prefix (Quick tier, default Sonnet).
     - `[בטל]` → a cancel option.
  4. The reply text states the recommendation and why, then the buttons appear (post-turn
     pickup, as all D3 buttons do).

### 4. Launch — no new code

Tapping a launch button feeds the option text back as the next message. `pickModel` on that text
([poller.ts:1321](../../../poller.ts)) routes `/opus …` → Opus, else Sonnet. The launched session
sees the full interview in chat history and proceeds to build. **This path already exists.**

## Data flow

```
Maor: "תפתח לי פיצ'ר X"
  → poller: detectDevIntent = true (interactive, not AUTO)
  → poller injects dev-intent directive into prompt
  → claude -p (Sonnet): runs playbook → asks clarifying Q via ask.ts → replies
  → poller renders question buttons
Maor: taps an answer (or types)
  → next fresh claude -p (Sonnet): history shows in-progress interview → continues
  → enough info → registers launch buttons via ask.ts → reply states recommendation
  → poller renders [Opus deep] [Opus] [Sonnet] [cancel]
Maor: taps [בנה מעמיק — Opus]
  → option text "/opus <build task> (think hard)" becomes next message
  → pickModel → opus  → claude -p (Opus): sees full interview in history → BUILDS
       (build itself goes to a branch + PR — enforced by agenda item #2)
```

## Integration points

- **#2 (self-dev safety):** the *launched* build must run on a branch and open a PR, never
  hot-patch the live droplet. #4 hands off at the launch; #2 enforces the safety. They meet at
  the launched build instruction — the playbook's launch option text should phrase the build as
  "on a branch, open a PR" once #2 lands. Until #2 lands, note this as a known gap.
- **#5 (usage/cap):** intentionally absent here. When #5's cost/token tracking exists, the
  recommendation step *may* later consult it ("heavy usage lately → recommend Sonnet"). Leave a
  comment marking the hook; do not build it.
- **#3.1 (skill non-use):** this feature's reliability depends on the directive being injected by
  code (deterministic) rather than relying on the model to notice a skill. That is the whole
  point of decision #4 above.

## Error handling & edge cases

- **`[AUTO]` sessions:** `detectDevIntent` may match, but `ask.ts` is already blocked under
  `[AUTO]` (`guard.ts`). The directive must be injected ONLY on the interactive path — gate it on
  the same not-`[AUTO]` condition the interactive handler already uses. An `[AUTO]` job that says
  "build X" should just proceed as today, not attempt an impossible interview.
- **False positive:** directive escape clause → Claude answers normally. No harm.
- **Maor ignores the buttons / they expire:** D3 choices expire quietly (1h, per `choices.ts`).
  No nudge. Next message proceeds normally.
- **Interview continuity:** because each turn is a fresh session, the playbook continues the
  interview by reading recent history; the directive is only present on the first (keyword) turn.
  This is acceptable — history injection already carries the thread.

## Testing (TDD)

Pure/unit-testable units (mirror existing `poller.test.ts` / `model` test patterns):

1. `detectDevIntent(text)` — table of English + Hebrew positives and negatives, incl. casual
   false positives.
2. **Directive injection** — given a dev-intent message on the interactive path, the prompt
   built by `buildPrompt` contains the directive block; given `[AUTO]` or a non-dev message, it
   does not. (Mirror the skills-block injection test.)
3. **Launch-option encoding** — the option text produced for the Opus tiers, when passed through
   `pickModel`, returns `model: "opus"`; the Sonnet tier returns `"sonnet"`. (Reuse D3 option
   tests.)
4. `pickModel` is unchanged — existing routing tests must still pass (regression guard that
   dev-intent words did NOT leak into `OPUS_KEYWORDS`).

## Non-goals

- No LLM classifier for dev-intent detection (preserves `model.ts`'s no-extra-call rule).
- No auto-launch (Maor always taps).
- No reading of real subscription quota (not possible; see #5).
- No change to the existing confirm (✓/✗) or reminder button flows.
