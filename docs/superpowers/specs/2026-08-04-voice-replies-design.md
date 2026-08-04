# Voice replies — design

**Date:** 2026-08-04
**Status:** awaiting Maor's review
**Supersedes:** the version shipped in PR #74 the same evening, which was built without this design

## Why this document exists

PR #74 went from a one-paragraph pitch to merged and deployed in a single stretch. Behaviours nobody asked for were invented along the way: a `/voice off` command, a length cap, and the choice to load the speech models on every reply. Maor's verdict after using it: *"we moved too fast with the development of this voice responding feature, without really thinking this through (talking about scenarios, outcomes, etc)."*

This is that thinking, done properly and driven by his answers rather than by guesses.

## What the live run actually taught us

Five voice notes on 2026-08-04 between 20:52 and 20:56.

| time | transcript | confidence | spoke? |
|---|---|---|---|
| 20:52:21 | "תזכיר לי ביום החמישי... השיעור" | 0.76 | no — sent 34s before the feature deployed |
| 20:53:55 | "Okay." | **0.58** | yes, 16s later |
| 20:54:17 | "Hola, ¿qué te pasa?" | **0.40** | yes, 20s later |
| 20:54:37 | "אמרתי להקליט לי, מה אתה חושב לי בספרדית" | 0.79 | yes, 44s later |
| 20:55:21 | "לא אמרתי משהו בספרדית, מה יש לך?" | 0.85 | yes, 20s later |

Three findings:

1. **The speech engine never failed.** Four of four attempts after deployment produced audio. The one with no audio ran on the old code.
2. **Transcription was the real failure.** Rows 2 and 3 are Hebrew speech turned into English and Spanish. The agent answered the invented Spanish, which is why row 4 is Maor asking why it is speaking Spanish at him. The engine then read that nonsense aloud, which made the *speech* feature look broken when it was working perfectly on bad input.
3. **The delay is real:** 16, 20, 44 and 20 seconds end to end. Roughly half is producing the answer (6–34s) and half is speech (11–19s), of which **9.3s is loading models on every single reply**.

Maor speaks Hebrew with English words mixed in and nothing else, so a third language in a transcript is always a failure signal, never input worth answering.

## Purpose

Maor's own framing: **phone in hand, typing is just annoying.** He is looking at the screen. This rules out designing for hands-free use and makes the text reply primary for now.

## Two phases

Phase 2 is recorded here so phase 1 doesn't build toward the wrong shape. Only phase 1 gets implemented from this document.

**Phase 1 — the trust-building phase (build this).** Text stays the answer, audio rides alongside, and a 4-second limit on Maor's recordings keeps exchanges cheap while he learns whether the audio is worth trusting.

**Phase 2 — once the audio is trustworthy (not now).** Any recording, no length limit, gets an audio reply as the primary response, with a button to reveal the text when he didn't catch it or the answer is long. Long answers get a short spoken version with the full written answer behind the button. This requires the agent to write two versions of an answer, which is why it waits.

## Section 1: when the agent speaks

Phase 1 rules, in order:

| input | result |
|---|---|
| typed message | text only, always — nothing about typing changes |
| recording longer than 4s | text only |
| recording of 4s or less | text reply, then a spoken copy |
| answer longer than `TTS_MAX_CHARS` (1200 chars, ~90s of speech) | text only, whatever the recording was |
| `/voice off` in effect | text only |
| speech engine unavailable | text only, silently |

The 4-second gate is deliberate scaffolding and comes out in phase 2.

**The tension to keep in view:** both of tonight's failures were the shortest recordings. This gate therefore aims the feature at Maor's least reliable input. That is only acceptable because of section 2, which stops bad transcripts from becoming answers at all. **If section 2 is not built, this gate must not ship** — it would increase how often he hears nonsense rather than reduce it.

## Section 2: when it isn't sure it heard him

Two independent triggers, because tonight's failure had two separate tells:

1. **Low confidence** — below `VOICE_CONFIRM_BELOW`, default **0.65**. A backend that reports no confidence at all (`null`) does **not** trigger confirmation, matching how the existing echo treats unknown confidence: an absent number is not evidence of a problem. Such a transcript is still subject to trigger 2.
2. **Impossible language** — the transcript contains a character outside this set: Hebrew letters and points, ASCII letters and digits, whitespace, and the punctuation `. , ! ? : ; ' " ( ) - – — / % + = & @ # ₪ $`. Anything else (`¿`, `é`, `ñ`, Arabic or Cyrillic script) means the backend produced a language Maor does not speak, and that is a transcription failure regardless of how confident it claims to be.

Either trigger produces the same thing: the transcript is sent back with ✓/✗ buttons and **no answer is generated**.

- **✓** — the turn proceeds normally, including speech if the section 1 gates allow.
- **✗** — dropped, nothing further happens, Maor resends.

Maor chose this over a plain "say it again" because a tap is cheaper than re-recording: when the transcript is close enough he confirms instead of repeating himself.

**This replaces the existing transcript echo for voice notes.** `VOICE_ECHO_BELOW` is 0.6 today and a confirm gate at 0.65 would swallow it entirely, leaving two overlapping mechanisms and a dead code path. The confirm gate shows the transcript anyway, so it subsumes the echo. The echo stays only for paths the confirm gate does not cover.

**On the 0.65 threshold:** tonight's five samples split cleanly (0.40 and 0.58 wrong, 0.76 to 0.85 right), so 0.65 sits in the gap with margin on both sides. Five samples is not a calibration, so it is an environment variable, and it should be revisited once there is real data on how often confirmation fires.

## Section 3: speed

The 9.3-second model load currently happens *after* the answer is written, in series. But the moment a qualifying recording arrives we know speech is coming, and producing the answer takes 6–34 seconds, most of it waiting on the network rather than using the CPU.

**So: start loading the models when the recording arrives, in parallel with the answer.** The Python side loads, then blocks on stdin. When the answer is ready it is written to stdin and the audio comes back. Remaining added latency is the synthesis itself, roughly 2–3 seconds.

Details:

- **A low-confidence recording does not pre-warm.** It might never become an answer, and a process left waiting on a tap is waste.
- **If the answer turns out not to qualify** (over the length cap, `/voice off` flipped mid-turn), the waiting process is killed.
- **Fast answers get partial benefit.** A 6-second answer will not hide a 9.3-second load, so 2–3 extra seconds remain. Slower answers hide it entirely.

### Synthesis must be one-at-a-time — this is a crash fix, not an optimisation

**One synthesis peaks at 668 MB** (measured with `/usr/bin/time -v`, not estimated). The droplet has **1,968 MB and no swap**. Nothing in the shipped code limits how many syntheses run at once, and the poller handles messages concurrently:

| concurrent syntheses | memory | outcome |
|---|---|---|
| 1 | ~1,083 MB | fine — and this matches the observed peak of 1,076 MB exactly |
| 2 | ~1,751 MB | ~200 MB margin, with no swap to absorb any spike |
| 3 | ~2,419 MB | out of memory; the kernel kills the largest process, which is the bot |

On 2026-08-04 Maor sent five recordings in a row and survived only because the replies happened to serialise. Nothing guaranteed that.

**Therefore: a hard lock allowing exactly one synthesis at a time, queued behind it.** This bounds speech memory at 668 MB no matter what arrives. It is required for correctness regardless of which loading strategy is chosen, and it is why voice replies are currently disabled on the droplet (`voice-replies-off.flag`, set 2026-08-04).

### Always-on was reconsidered and still rejected

Once synthesis is serialised, both designs peak identically at ~1,083 MB. The only difference is whether the 668 MB is resident forever or released between recordings.

Rejected because a third of the machine held permanently buys 1–2 seconds on fast answers, and it leaves the bot running with a permanently smaller margin on a box that cannot swap. Load-while-thinking gives the same peak and the same speed benefit on slower answers, frees the memory in between, and needs no second service.

*(An earlier draft of this document rejected always-on using a 350 MB figure and reasoning that double-counted the peak. Maor pushed back, the process was measured properly at 668 MB, and the measurement is what surfaced the concurrency bug above. The conclusion survived; the reasoning behind it did not.)*

**Must be measured, not assumed:** whether the parallel load slows the answer on that single core. The assumption is that a claude turn is mostly network wait and leaves CPU idle. If measurement contradicts that, fall back to loading after the answer and accept the slower path.

## Section 4: controls, failure, testing

**Controls.** `/voice on`, `/voice off`, `/voice` for status. Handled in the poller before any claude session spawns, like `/stop` and `/quiz`, so silencing audio never depends on the model reading the request correctly. This matches Maor's standing preference for invoking features by explicit slash command rather than having the agent infer intent. It exists for the case where he is somewhere audio is not acceptable.

**Failure is always silent and always text-only.** No models, a crashed synthesizer, a rejected upload, an over-long answer, a timeout: each ends in text only, logged and never surfaced as an error. The text reply is the product and must never be at risk from anything the speech path does.

**Testing.** Unit-testable pure logic, no live calls:

- The section 1 gate table: every row above, including a typed message never producing audio.
- The confidence threshold boundary, and that an unknown (`null`) confidence does not trigger confirmation.
- The impossible-language check: Hebrew passes, mixed Hebrew and English passes, `"Hola, ¿qué te pasa?"` fails, Arabic fails.
- Both confirm outcomes, including that ✗ generates no answer.
- Text cleanup before speech (URLs, emoji, markdown), which already exists and stays.

Plus one measurement that is not a unit test: parallel-load impact on answer latency, taken from real turns on the droplet.

## Deliberately not in scope

- Phase 2 in any form: no transcript button, no dual-length answers, no removal of the 4-second gate.
- Any change to how transcription itself works beyond the language and confidence gates. Improving Whisper's accuracy on short Hebrew clips is a separate problem.
- Replacing the voice model. If Maor dislikes the "shaul" voice specifically, that is a checkpoint swap, not a design change.
- An always-on speech process, rejected above on measured grounds.

## What changes in the shipped code

The current implementation (PR #74) survives in outline. Changes required, most urgent first:

1. **Serialise synthesis behind a one-at-a-time lock.** Fixes a live crash risk, not a nicety. Voice replies stay disabled on the droplet until this ships.
2. Add the 4-second input gate.
3. Add the confirmation flow, and retire the now-unreachable echo path for voice notes.
4. Add the impossible-language check.
5. Move model loading to run in parallel with the answer.
6. Keep `/voice`, the length cap, and silent failure exactly as they are.

Item 1 stands alone and could ship before the rest. Items 2 and 3 must ship together, per section 1.

## Testing note on the memory limit

The one-at-a-time lock is testable without synthesising anything: assert that a second request while one is in flight waits rather than starting, and that the lock is released when a synthesis fails or times out (a lock that leaks on the error path would silence voice replies permanently, which is worse than the bug it fixes).
