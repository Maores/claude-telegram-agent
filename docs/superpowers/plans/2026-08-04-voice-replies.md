# Voice Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make voice replies safe and fast enough to trust: stop them from being able to crash the bot, stop them from speaking words Maor never said, and hide the 9.3-second model load inside time he is already waiting.

**Architecture:** Synthesis is serialised behind a promise-chain lock so speech memory is bounded at one process (668 MB) no matter how many recordings arrive. Transcripts that are low-confidence or contain impossible characters are held in a small pending store and confirmed with inline buttons before any answer is generated; a confirmed transcript becomes a fresh turn through the same path a choice-button tap already uses. The Python synthesizer loads its models before reading stdin, so the poller can start it the moment a qualifying recording arrives and feed it the answer later.

**Tech Stack:** Bun + TypeScript, `bun:test`, Telegram Bot API inline keyboards, Python 3.12 in a uv venv (phonikud-tts, piper-onnx, soundfile).

## Global Constraints

- Failure is always silent and always text-only. No models, a crash, a timeout, a rejected upload, an over-long answer: each ends in text only, logged, never surfaced. The text reply must never be at risk from anything the speech path does.
- Maor speaks **Hebrew with English words mixed in and nothing else**. A third language in a transcript is a failure signal, never input to answer.
- `TTS_MAX_CHARS` stays 1200. `/voice on|off|status` stays as built. Silent failure stays as built.
- Voice replies are **disabled on the droplet** via `voice-replies-off.flag` and must only be re-enabled after Task 1 ships.
- Tasks 2, 3 and 4 ship together: the 4-second gate without the confirmation flow would aim the feature at Maor's least reliable input.
- The droplet has 1,968 MB and **no swap**. One synthesis peaks at 668 MB.

---

### Task 1: Serialise synthesis behind a lock

The live crash fix. Two concurrent syntheses reach ~1,751 MB of 1,968 with no swap; three are a guaranteed OOM, and the kernel kills the largest process, which is the bot.

**Files:**
- Modify: `tts.ts`
- Test: `tts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `withSynthLock<T>(fn: () => Promise<T>): Promise<T>` — runs `fn` only when no other locked call is in flight; `synthesize()` is wrapped in it.

- [ ] **Step 1: Write the failing tests**

```ts
test("withSynthLock runs one at a time", async () => {
  const order: string[] = [];
  const slow = () => withSynthLock(async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 30));
    order.push("a-end");
  });
  const fast = () => withSynthLock(async () => {
    order.push("b-start");
    order.push("b-end");
  });
  await Promise.all([slow(), fast()]);
  expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
});

test("a failed synthesis releases the lock instead of wedging it forever", async () => {
  await withSynthLock(async () => {
    throw new Error("boom");
  }).catch(() => {});
  const ran = await withSynthLock(async () => "second ran");
  expect(ran).toBe("second ran");
});

test("the caller still sees its own rejection", async () => {
  await expect(withSynthLock(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tts.test.ts`
Expected: FAIL, `withSynthLock is not a function` / import error.

- [ ] **Step 3: Implement**

In `tts.ts`:

```ts
/** Serialises synthesis. One process peaks at 668MB on a 1968MB droplet with
 *  no swap, so two at once leaves ~200MB of margin and three is an OOM that
 *  takes the bot down with it (the kernel picks the largest process). The
 *  poller handles messages concurrently, so nothing else bounds this.
 *
 *  The chain swallows outcomes so a failed synthesis can never wedge the lock
 *  shut — a leaked lock would silence voice replies permanently, which is
 *  worse than the bug it fixes. */
let synthChain: Promise<unknown> = Promise.resolve();

export function withSynthLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = synthChain.then(fn, fn);
  synthChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
```

Wrap the body of `synthesize()`: rename the existing implementation to `synthesizeUnlocked` and add

```ts
export async function synthesize(text: string, outPath: string): Promise<Spoken | null> {
  return withSynthLock(() => synthesizeUnlocked(text, outPath));
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test tts.test.ts` → PASS. Then `bun test` → all green.

- [ ] **Step 5: Commit**

```bash
git add tts.ts tts.test.ts
git commit -m "fix(voice): serialise synthesis so concurrent replies cannot OOM the bot"
```

---

### Task 2: Detect a transcript that cannot be trusted

Pure logic, no I/O. Two independent triggers.

**Files:**
- Modify: `transcribe.ts`
- Test: `transcribe.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `VOICE_CONFIRM_BELOW: number` (env `VOICE_CONFIRM_BELOW`, default `0.65`)
  - `hasImpossibleChars(text: string): boolean`
  - `needsConfirmation(text: string, confidence: number | null): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
test("hasImpossibleChars accepts Hebrew, English and a mix of both", () => {
  expect(hasImpossibleChars("שלום מאור")).toBe(false);
  expect(hasImpossibleChars("Okay.")).toBe(false);
  expect(hasImpossibleChars("תריץ לי bun run cal.ts list בבקשה")).toBe(false);
  expect(hasImpossibleChars("יש לי פגישה ב-10:30, נכון? (כן!)")).toBe(false);
  expect(hasImpossibleChars("עולה 50₪ או $12 + 5%")).toBe(false);
});

test("hasImpossibleChars rejects languages Maor does not speak", () => {
  expect(hasImpossibleChars("Hola, ¿qué te pasa?")).toBe(true); // the real 2026-08-04 failure
  expect(hasImpossibleChars("مرحبا كيف حالك")).toBe(true);
  expect(hasImpossibleChars("Привет")).toBe(true);
  expect(hasImpossibleChars("señor")).toBe(true);
});

test("needsConfirmation fires below the threshold", () => {
  expect(needsConfirmation("שלום", 0.4)).toBe(true);
  expect(needsConfirmation("שלום", 0.58)).toBe(true);
  expect(needsConfirmation("שלום", 0.76)).toBe(false);
  expect(needsConfirmation("שלום", 0.85)).toBe(false);
});

test("needsConfirmation fires on impossible characters at any confidence", () => {
  expect(needsConfirmation("Hola, ¿qué te pasa?", 0.99)).toBe(true);
});

test("an unknown confidence does not by itself demand confirmation", () => {
  expect(needsConfirmation("שלום מאור", null)).toBe(false);
  expect(needsConfirmation("¿qué?", null)).toBe(true); // but the language check still applies
});

test("an empty transcript never asks for confirmation", () => {
  expect(needsConfirmation("", 0.1)).toBe(false);
  expect(needsConfirmation("   ", null)).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test transcribe.test.ts` → FAIL, functions not exported.

- [ ] **Step 3: Implement**

In `transcribe.ts`, beside `VOICE_ECHO_BELOW`:

```ts
/** Below this, ask Maor to confirm the transcript before answering it.
 *  Calibrated on 2026-08-04: the two wrong transcripts scored 0.40 and 0.58,
 *  the three right ones 0.76 to 0.85, so 0.65 sits in the gap. Five samples is
 *  not a calibration — hence the env override. */
export const VOICE_CONFIRM_BELOW = envNum(process.env.VOICE_CONFIRM_BELOW, 0.65);

/** Everything Maor's speech can legitimately produce: Hebrew letters and
 *  points, ASCII letters and digits, whitespace, and ordinary punctuation. */
const POSSIBLE_CHARS = /^[֐-׿‏‎A-Za-z0-9\s.,!?:;'"()\[\]\-–—/%+=&@#₪$*]*$/;

/** True when the transcript contains a character Maor's speech cannot produce.
 *  He speaks Hebrew with English words mixed in and nothing else, so anything
 *  outside that set means the backend invented a language — on 2026-08-04 his
 *  Hebrew came back as "Hola, ¿qué te pasa?" and the agent answered it. */
export function hasImpossibleChars(text: string): boolean {
  return !POSSIBLE_CHARS.test(text);
}

/** Whether to show Maor the transcript and wait for a tap before answering. */
export function needsConfirmation(text: string, confidence: number | null): boolean {
  if (!text.trim()) return false; // nothing to confirm; the empty path handles it
  if (hasImpossibleChars(text)) return true;
  return confidence !== null && confidence < VOICE_CONFIRM_BELOW;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test transcribe.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add transcribe.ts transcribe.test.ts
git commit -m "feat(voice): detect transcripts that cannot be trusted"
```

---

### Task 3: Store a transcript awaiting confirmation

**Files:**
- Create: `voice-confirm.ts`
- Test: `voice-confirm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface PendingVoice { id: string; chatId: number; text: string; kind: "voice" | "audio"; createdAt: number }`
  - `addPending(chatId: number, text: string, kind: "voice" | "audio", nowEpoch?: number): PendingVoice`
  - `consumePending(id: string, nowEpoch?: number): { outcome: "ok"; pending: PendingVoice } | { outcome: "stale" } | { outcome: "expired" }`
  - `parseVcCallback(data: string): { id: string; ok: boolean } | null`
  - `vcKeyboard(id: string): { inline_keyboard: { text: string; callback_data: string }[][] }`

- [ ] **Step 1: Write the failing tests**

```ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPending, consumePending, parseVcCallback, vcKeyboard } from "./voice-confirm.ts";

const T0 = 1_786_000_000;
function freshFile() {
  process.env.VOICE_PENDING_FILE = join(mkdtempSync(join(tmpdir(), "vc-")), "pending.json");
}

test("a pending transcript can be consumed exactly once", () => {
  freshFile();
  const p = addPending(7, "תזכיר לי מחר", "voice", T0);
  const first = consumePending(p.id, T0 + 5);
  expect(first.outcome).toBe("ok");
  if (first.outcome === "ok") expect(first.pending.text).toBe("תזכיר לי מחר");
  expect(consumePending(p.id, T0 + 6).outcome).toBe("stale");
});

test("a pending transcript expires after an hour", () => {
  freshFile();
  const p = addPending(7, "שלום", "voice", T0);
  expect(consumePending(p.id, T0 + 3601).outcome).toBe("expired");
});

test("unknown ids are stale, never a crash", () => {
  freshFile();
  expect(consumePending("nope", T0).outcome).toBe("stale");
});

test("ids are unique even within the same millisecond", () => {
  freshFile();
  const a = addPending(7, "one", "voice", T0);
  const b = addPending(7, "two", "voice", T0);
  expect(a.id).not.toBe(b.id);
});

test("parseVcCallback reads both verdicts and rejects everything else", () => {
  expect(parseVcCallback("vc:abc:y")).toEqual({ id: "abc", ok: true });
  expect(parseVcCallback("vc:abc:n")).toEqual({ id: "abc", ok: false });
  expect(parseVcCallback("vc:abc:maybe")).toBeNull();
  expect(parseVcCallback("fu:done:abc")).toBeNull();
  expect(parseVcCallback("")).toBeNull();
});

test("the keyboard stays inside Telegram's 64-byte callback_data limit", () => {
  const kb = vcKeyboard("v1786000000000abc");
  for (const row of kb.inline_keyboard) {
    for (const btn of row) expect(btn.callback_data.length).toBeLessThanOrEqual(64);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test voice-confirm.test.ts` → FAIL, module not found.

- [ ] **Step 3: Implement `voice-confirm.ts`**

```ts
/**
 * voice-confirm.ts — transcripts held for Maor's confirmation.
 *
 * When a transcript is low-confidence or contains characters his speech cannot
 * produce, the poller shows it with ✓/✗ buttons and generates NO answer until
 * he taps. On 2026-08-04 his Hebrew came back as "Hola, ¿qué te pasa?" and the
 * agent answered the invented Spanish out loud; he chose a tap over re-recording
 * because when the transcript is close enough, confirming beats repeating.
 *
 * Same shape as the choice store: consume-once, expiring, file-backed.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PENDING_TTL_S = 3600;

export interface PendingVoice {
  id: string;
  chatId: number;
  text: string;
  kind: "voice" | "audio";
  createdAt: number;
}

function pendingPath(): string {
  return process.env.VOICE_PENDING_FILE || join(import.meta.dir, "voice-pending.json");
}

function load(): PendingVoice[] {
  try {
    const p = pendingPath();
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function save(list: PendingVoice[]): void {
  try {
    writeFileSync(pendingPath(), JSON.stringify(list, null, 2));
  } catch {
    // A pending transcript that cannot be persisted just means the buttons go
    // stale — never worth failing the turn over.
  }
}

export function addPending(
  chatId: number,
  text: string,
  kind: "voice" | "audio",
  nowEpoch = Math.floor(Date.now() / 1000),
): PendingVoice {
  const list = load().filter((p) => p.createdAt + PENDING_TTL_S > nowEpoch);
  const taken = new Set(list.map((p) => p.id));
  let id = `v${Date.now()}`;
  while (taken.has(id)) id += "x";
  const pending: PendingVoice = { id, chatId, text, kind, createdAt: nowEpoch };
  list.push(pending);
  save(list);
  return pending;
}

export function consumePending(
  id: string,
  nowEpoch = Math.floor(Date.now() / 1000),
):
  | { outcome: "ok"; pending: PendingVoice }
  | { outcome: "stale" }
  | { outcome: "expired" } {
  const list = load();
  const found = list.find((p) => p.id === id);
  if (!found) return { outcome: "stale" };
  save(list.filter((p) => p.id !== id));
  if (found.createdAt + PENDING_TTL_S <= nowEpoch) return { outcome: "expired" };
  return { outcome: "ok", pending: found };
}

/** callback_data protocol (≤64 bytes): "vc:<pendingId>:<y|n>".
 *  Disjoint from fu:/fuu:/qz:/pa:/ch:. */
export function parseVcCallback(data: string): { id: string; ok: boolean } | null {
  const m = /^vc:([^:]+):(y|n)$/.exec(data ?? "");
  if (!m) return null;
  return { id: m[1]!, ok: m[2] === "y" };
}

export function vcKeyboard(id: string) {
  return {
    inline_keyboard: [
      [
        { text: "✓ כן, זה מה שאמרתי", callback_data: `vc:${id}:y` },
        { text: "✗ לא", callback_data: `vc:${id}:n` },
      ],
    ],
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `bun test voice-confirm.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add voice-confirm.ts voice-confirm.test.ts
git commit -m "feat(voice): store transcripts awaiting Maor's confirmation"
```

---

### Task 4: Wire the gate and the confirmation into the poller

Ships with Tasks 2 and 3. The 4-second gate alone would aim speech at the least reliable input.

**Files:**
- Modify: `poller.ts`
- Modify: `.gitignore` (add `voice-pending.json`)
- Test: `tts.test.ts` (the gate predicate)

**Interfaces:**
- Consumes: `needsConfirmation`, `hasImpossibleChars` (Task 2); `addPending`, `consumePending`, `parseVcCallback`, `vcKeyboard` (Task 3); `withSynthLock` (Task 1).
- Produces: `VOICE_REPLY_MAX_INPUT_SEC`, `shouldSpeakForInput(durationSec: number | null): boolean`.

- [ ] **Step 1: Write the failing test for the input gate**

In `tts.test.ts`:

```ts
test("only short recordings earn a spoken reply during the test phase", () => {
  expect(shouldSpeakForInput(3)).toBe(true);
  expect(shouldSpeakForInput(4)).toBe(true);
  expect(shouldSpeakForInput(5)).toBe(false);
  expect(shouldSpeakForInput(60)).toBe(false);
  expect(shouldSpeakForInput(null)).toBe(false); // unknown duration stays quiet
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tts.test.ts` → FAIL, `shouldSpeakForInput is not a function`.

- [ ] **Step 3: Add the gate to `tts.ts`**

```ts
/** Phase-1 scaffolding: only a short recording earns a spoken reply, so trust
 *  gets built on cheap exchanges. Removed in phase 2 (see the design doc).
 *  An unknown duration stays quiet — silence beats a surprise voice note. */
export const VOICE_REPLY_MAX_INPUT_SEC = Number(process.env.VOICE_REPLY_MAX_INPUT_SEC) || 4;

export function shouldSpeakForInput(durationSec: number | null): boolean {
  return durationSec !== null && durationSec > 0 && durationSec <= VOICE_REPLY_MAX_INPUT_SEC;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tts.test.ts` → PASS.

- [ ] **Step 5: Add the confirmation branch in `poller.ts`**

In the voice branch, immediately after the transcript is produced and logged, before the turn is built:

```ts
    // A transcript we cannot trust never becomes an answer. Show it, wait for a
    // tap. (2026-08-04: his Hebrew became "Hola, ¿qué te pasa?" at 0.40 and the
    // agent answered the invented Spanish out loud.)
    if (needsConfirmation(tr.text, tr.confidence)) {
      const pending = addPending(chatId, tr.text, voice.kind);
      console.log(
        `[VOICE] confirm ${pending.id} conf=${tr.confidence?.toFixed(3) ?? "n/a"} impossible=${hasImpossibleChars(tr.text)}`,
      );
      await tg("sendMessage", {
        chat_id: chatId,
        text: `לא בטוח שהבנתי נכון. זה מה ששמעתי:\n\n🎤 «${tr.text}»`,
        reply_markup: vcKeyboard(pending.id),
      }).catch(() => {});
      if (placeholderId) await tg("deleteMessage", { chat_id: chatId, message_id: placeholderId }).catch(() => {});
      return;
    }
```

- [ ] **Step 6: Route the `vc:` namespace in `handleCallback`**

Add alongside the other parsers, before `parseFuCallback` (which must stay last):

```ts
  const vc = qz || pa || ch || fuu ? null : parseVcCallback(cq.data ?? "");
```

Include `vc` in the null-guard and the `[CB]` log line, then:

```ts
  if (vc) {
    await handleVcCallback(cq, vc, chatId, messageId, ack);
    return;
  }
```

- [ ] **Step 7: Implement `handleVcCallback` and `answerConfirmedVoice`**

Modelled directly on `handleChCallback` / `answerChoice`:

```ts
async function handleVcCallback(
  cq: NonNullable<TgUpdate["callback_query"]>,
  parsed: { id: string; ok: boolean },
  chatId: number,
  messageId: number,
  ack: (text?: string) => Promise<unknown>,
) {
  const r = consumePending(parsed.id, Math.floor(Date.now() / 1000));
  if (r.outcome === "stale") {
    await ack("הכפתור הזה כבר טופל");
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return;
  }
  if (r.outcome === "expired") {
    await ack("פג תוקף — תשלח שוב");
    await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    return;
  }
  const pending = r.pending;
  if (pending.chatId !== chatId) {
    console.error(`[VOICE] chat mismatch ${pending.id}: entry ${pending.chatId} vs tap ${chatId}`);
    await ack("הכפתור הזה כבר טופל");
    return;
  }
  await ack();
  if (!parsed.ok) {
    console.log(`[VOICE] rejected ${pending.id}`);
    await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: "בסדר, לא עניתי על זה. תשלח שוב 🎤" }).catch(() => {});
    return;
  }
  console.log(redact(`[VOICE] confirmed ${pending.id}`));
  await tg("editMessageText", { chat_id: chatId, message_id: messageId, text: `🎤 «${pending.text}»` }).catch(() => {});
  chatQueues.enqueue(chatId, () => answerConfirmedVoice(chatId, pending));
}
```

`answerConfirmedVoice` is a trimmed copy of `answerChoice` (NOT a refactor of it), with two differences: the user message it persists and answers is `voicePromptText(pending.text, pending.kind)`, and after `[DONE]` it calls `speakReply(chatId, answer)` because the original input was a recording. It does **not** re-check `shouldSpeakForInput`: duration is not carried on the pending record, and a confirmed transcript is by definition one Maor already engaged with.

- [ ] **Step 8: Run the full suite**

Run: `bun test` → all green. Then `bun run typecheck` → exit 0.

- [ ] **Step 9: Commit**

```bash
git add poller.ts tts.ts tts.test.ts .gitignore
git commit -m "feat(voice): confirm untrusted transcripts, and gate speech on short recordings"
```

---

### Task 5: Load the models while the answer is being written

**Files:**
- Modify: `tts_synth.py`
- Modify: `tts.ts`
- Modify: `poller.ts`
- Test: `tts.test.ts`

**Interfaces:**
- Consumes: `withSynthLock` (Task 1).
- Produces: `startEngine(): TtsEngine | null`, `speakWith(engine: TtsEngine, text: string, outPath: string): Promise<Spoken | null>`, `interface TtsEngine { proc: Bun.Subprocess; kill(): void }`.

- [ ] **Step 1: Reorder `tts_synth.py` to load before reading stdin**

Today it reads stdin first, then imports and loads, so the 9.3-second load can only start once the answer exists. Move the imports and both model constructions above `sys.stdin.read()`, and print a single `{"ok": true, "ready": true}` line once loaded so the parent knows the load finished.

- [ ] **Step 2: Write the failing test for the ready handshake**

```ts
test("parseSynthOutput ignores the ready line and returns the audio result", () => {
  const stdout = ['{"ok": true, "ready": true}', '{"ok": true, "path": "/tmp/a.ogg", "seconds": 3.2}'].join("\n");
  expect(parseSynthOutput(stdout)).toEqual({ path: "/tmp/a.ogg", seconds: 3.2 });
});

test("parseSynthOutput returns null when only the ready line arrived (engine died mid-turn)", () => {
  expect(parseSynthOutput('{"ok": true, "ready": true}')).toBeNull();
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `bun test tts.test.ts` → the second FAILS (today the ready line parses as a result with missing fields → already null, but the first FAILS because the last JSON line wins and `ready` has no `path`).

- [ ] **Step 4: Fix `parseSynthOutput` to skip ready lines**

Scan bottom-up as today, but skip any object with `ready === true`, and require `path` and `seconds`.

- [ ] **Step 5: Add `startEngine` / `speakWith` to `tts.ts`**

`startEngine()` spawns the Python child with stdin/stdout piped and returns immediately without writing anything; the child loads models and blocks on stdin. `speakWith()` writes the text, closes stdin, and reads the result — wrapped in `withSynthLock`. `kill()` is called when the answer turns out not to qualify.

- [ ] **Step 6: Wire the pre-warm in `poller.ts`**

Start the engine right after the transcript passes `needsConfirmation` **and** `shouldSpeakForInput`, and only when `voiceRepliesEnabled() && ttsAvailable()`. Hold it in a local, feed it after `[DONE]`, and `kill()` it in a `finally` if the answer failed `shouldSpeak` or the turn threw. A low-confidence transcript never pre-warms, because it may never become an answer.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `bun test` → green. `bun run typecheck` → exit 0.

- [ ] **Step 8: Commit**

```bash
git add tts.ts tts_synth.py tts.test.ts poller.ts
git commit -m "perf(voice): load the speech models while the answer is being written"
```

---

### Task 6: Ship it and prove it on the droplet

**Files:** none (deployment).

- [ ] **Step 1: PR, merge, deploy**

```bash
gh pr create --title "Voice replies: safe, confirmed, and faster" --body "<per the spec>"
gh pr merge --merge --delete-branch
```

Then on the droplet: dirty-tree guard, `git fetch && git reset --hard origin/main`, `sudo systemctl restart telegram-agent`, confirm `[BOT] Poller started`.

- [ ] **Step 2: Re-enable voice replies**

```bash
rm -f ~/claude-bot/voice-replies-off.flag
```

Only after Task 1 is confirmed live (`grep -c withSynthLock tts.ts` on the droplet returns non-zero).

- [ ] **Step 3: Measure whether the parallel load slowed the answer**

Compare `[MSG]`→`[DONE]` durations for voice turns against the 2026-08-04 baseline (6, 8, 25, 34 seconds). If answers are consistently slower, the single core is contended and the pre-warm should move back to after the answer.

- [ ] **Step 4: Report to Maor how to verify each behaviour himself**

A short recording under 4s gets text then audio; a longer one gets text only; a mumbled one gets the transcript with ✓/✗; `/voice off` silences it.

---

## Self-review

**Spec coverage:** change 1 → Task 1; change 2 → Task 4 (gate); change 3 → Tasks 2, 3, 4; change 4 → Task 2; change 5 → Task 5; change 6 → untouched by construction, guarded by the existing suite. The spec's "items 2 and 3 ship together" is honoured because the gate lands in Task 4 alongside the confirmation branch.

**Placeholders:** none. Tasks 4 step 7 and Task 5 steps 5–6 describe shape rather than showing every line, because both are trimmed copies of named existing functions (`answerChoice`, `synthesize`) that the implementer will have open; the differences are stated exactly.

**Type consistency:** `PendingVoice.kind` is `"voice" | "audio"`, matching `voiceInfo().kind` and `voicePromptText`'s second parameter. `parseVcCallback` returns `{ id, ok }` and `handleVcCallback` consumes exactly that. `shouldSpeakForInput` takes `number | null`, matching `voiceInfo().duration`.
