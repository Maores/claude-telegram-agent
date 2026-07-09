# Voice notes for a Telegram + Claude agent — install guide

A self-contained guide for adding voice-note support to a `claude -p`-style
Telegram bot: the user sends a voice bubble, the bot transcribes it, and answers
as if it had been typed. Hebrew and English both work well. It was built and run
in production on a sister project; everything you need is in this file, so your
Claude Code session does not need access to the original repo.

Voice replies *out* (text-to-speech) are not covered here. This is voice in only.

## How to use this file with Claude Code

Drop this file into your repo and prompt your Claude Code with something like:

> Read docs/VOICE-NOTES-INSTALL-GUIDE.md. Inspect my bot's code, tell me which
> prerequisites I already have and which are missing, then implement voice notes
> following the guide. Write the transcription logic behind tests where the guide
> marks it testable, and run the guide's "verify" checklist before telling me it
> works.

Conventions:
- Reference code is TypeScript using Web-standard APIs (`fetch`, `FormData`,
  `File`), which run on Bun, Node 20+ (the `File` global is stable from Node 20),
  and Deno. Python versions of the two calls that matter (the Groq request and
  the confidence math) are included too; the remaining helpers are one-liners to
  port. If your stack differs, treat the code as precise pseudocode: the logic
  and the HTTP shape are what matter.
- Example user-facing strings are written in Hebrew because that is the original
  bot's language. Translate them to whatever your bot speaks.
- The sections marked "the part that bit us" are bugs found the hard way in
  production. Read them before you code, not after.

## What you are building

Claude cannot take audio as input, so the only route is transcribe-then-inject:
turn the audio into text first, then feed that text into your normal message
pipeline as if the user had typed it. Nothing downstream (model routing, history,
memory, skills) needs to know it came from a voice note.

The whole feature is one small module plus about a dozen lines wired into your
message handler.

## Prerequisites

Your bot should already have these. If it does not, add them first:

1. A long-poll loop that receives Telegram messages and, per allowlisted user,
   produces a reply (the baseline `claude -p` bot).
2. A way to download a Telegram file by `file_id`. Voice reuses this. The shape
   is: call `getFile` to get a `file_path`, then GET
   `https://api.telegram.org/file/bot<TOKEN>/<file_path>` and save the bytes to a
   local temp file. If you already support photos or documents, you have this.
3. Plain-text replies back to the chat.

Helpful but optional:
- Streaming replies (a placeholder bubble you edit as the answer arrives). The
  low-confidence echo (below) is cleanest when prepended to a streamed reply, but
  it works fine as a one-shot prefix too.
- Reactions and a typing indicator, for acknowledging the message early.
- Secret redaction on outgoing text and logs (covered in step 9).

## The backend: Groq's free hosted Whisper

Use Groq's hosted `whisper-large-v3-turbo` through their OpenAI-compatible
transcription endpoint. Reasons:
- It is free and the limits are far beyond personal use (at the time of writing,
  2,000 requests/day and 7,200 audio-seconds/hour).
- Hebrew transcription is genuinely good, which local models small enough to run
  on a 1 GB VPS are not.
- The Telegram audio uploads as-is. No `ffmpeg`, no audio conversion on this path.

Get a free key at console.groq.com.

Keep the backend behind a tiny interface so you can swap in a local, keyless
transcriber later without touching the rest of the bot:

```ts
export interface Transcript {
  text: string;
  confidence: number | null; // null means "no idea", used by the echo logic
}
```

A keyless local backend (whisper.cpp) is sketched at the end as an optional
extra.

## Configuration

Put these in your existing env file. The only required one is `GROQ_API_KEY`.

| var | default | meaning |
|---|---|---|
| `GROQ_API_KEY` | (none) | free key from console.groq.com |
| `TRANSCRIBE_BACKEND` | auto | `groq` / `local` / `off`; auto-resolves (see below) |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | hosted Whisper variant |
| `VOICE_MAX_SEC` | 300 | reject voice notes longer than this, before downloading |
| `VOICE_ECHO_BELOW` | 0.6 | echo the transcript when confidence is under this; `0` disables echo |
| `VOICE_TIMEOUT_MS` | 45000 | give up on a transcription after this long |

Backend resolution: an explicit `TRANSCRIBE_BACKEND` wins; otherwise `groq` if a
`GROQ_API_KEY` is present, otherwise `local` if a local command is configured,
otherwise `off` (feature politely disabled).

One trap when reading numeric env vars: an empty string must fall back to the
default, not become `0`. `Number("") === 0`, so a blank `VOICE_ECHO_BELOW=` in
your env file would silently disable the echo. Parse defensively:

```ts
export function envNum(raw: string | undefined, def: number): number {
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}
```

## Build it, step by step

### 1. Detect the voice message and read its metadata before downloading

A Telegram voice bubble arrives as `msg.voice` with `file_id`, `duration`
(seconds), `mime_type`, and `file_size`. Read these without downloading anything
yet, so you can reject oversized notes cheaply.

```ts
interface TgVoice { file_id: string; duration?: number; mime_type?: string; file_size?: number; }
// msg.voice?: TgVoice
```

Also remove `voice` from whatever "unsupported media" decline you currently send,
and update your "what I can read" copy to mention voice notes.

### 2. Gate on duration and size, and handle "not configured"

Before downloading:
- If no backend is configured (`off`), decline gracefully, for example
  `"עוד לא מחובר אצלי תמלול קולי"` ("voice transcription is not connected yet").
- If `duration > VOICE_MAX_SEC`, decline and state the cap, for example
  `"ההקלטה ארוכה מדי בשבילי — אני מתמלל עד 5 דקות."`
- If `file_size` is over your normal attachment limit (around 20 MB is plenty for
  a 5-minute Opus note), decline. The Telegram Bot API can only download files up
  to 20 MB through `getFile` anyway, so that is a natural ceiling.

None of these should spawn the model. They are cheap, honest declines.

### 3. Acknowledge early (optional but recommended)

Transcription adds a second or two before any reply text exists. If you have
reactions and a typing indicator, fire them at the very top of the voice branch
(earlier than your photo/document flow does), so the user knows you heard them.

### 4. Download the audio

Use your existing download helper to save the file to a temp path, for example
`uploads/<timestamp>-voice.oga`. Telegram serves voice notes as an Ogg/Opus
container, and the filename it gives you ends in `.oga`. Remember that extension;
it matters in the next step.

### 5. Transcribe it (the part that bit us)

Two bugs live in this one call. Read both before writing it.

Bug 1: Groq validates the uploaded file by its filename extension, and it
rejects `.oga` even though `.ogg` (the exact same Ogg/Opus container) is on its
accepted list. So you must send the bytes under a name like `voice.ogg`, not the
`.oga` name Telegram used. (Live error seen:
`file must be one of [... ogg opus ...]`.) Groq accepts the common audio formats
(for example mp3, m4a, wav, ogg, opus, webm); the rule is simply that the
filename extension must be one it recognizes, and `.oga` is not.

Bug 2: some lazy file-streaming wrappers ignore the explicit filename you pass
and send the local file path as the multipart filename instead. (Bun's
`FormData` does this with a lazy `Bun.file` blob: the whole path went out as the
name.) The reliable fix on any stack is to read the bytes into memory and attach
them with an explicit `File`/filename. Voice notes are a couple of MB at most, so
holding them in memory is fine.

TypeScript reference:

```ts
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

export async function groqTranscribe(filePath: string, apiKey: string): Promise<Transcript> {
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  // Read bytes eagerly, attach under a Groq-accepted filename. See bugs 1 and 2.
  const bytes = await readFileBytes(filePath);            // fs.readFile, or Bun.file(path).arrayBuffer()
  const audio = new File([bytes], "voice.ogg", { type: "audio/ogg" });

  const form = new FormData();
  form.append("file", audio);
  form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");        // gives per-segment avg_logprob

  const timeoutMs = envNum(process.env.VOICE_TIMEOUT_MS, 45_000);
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  if (typeof data?.text !== "string") throw new Error("groq response has no text field");

  return { text: data.text.trim(), confidence: deriveConfidence(data.segments) };
}
```

Python equivalent of the same call (note the `("voice.ogg", ...)` filename, which
is the whole point of bug 1):

```python
import os
import requests

def groq_transcribe(path: str, api_key: str) -> dict:
    if not api_key:
        raise ValueError("GROQ_API_KEY is not set")
    with open(path, "rb") as f:
        audio = f.read()
    files = {"file": ("voice.ogg", audio, "audio/ogg")}   # NOT the .oga name Telegram gave you
    data = {"model": "whisper-large-v3-turbo", "response_format": "verbose_json"}
    timeout_s = int(os.environ.get("VOICE_TIMEOUT_MS") or 45000) / 1000
    r = requests.post(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        headers={"Authorization": f"Bearer {api_key}"},
        files=files, data=data, timeout=timeout_s,
    )
    r.raise_for_status()
    j = r.json()
    text = j.get("text")
    if not isinstance(text, str):
        raise ValueError("groq response has no text field")
    return {"text": text.strip(), "confidence": derive_confidence(j.get("segments"))}
```

Retry policy: retry exactly once on a network error or a 5xx. Never retry a 4xx
(a bad key or a rate limit is not going to fix itself on an immediate retry, and
hammering it makes the rate limit worse). The reference above omits the retry for
clarity; add a single-retry loop around the `fetch` for production.

### 6. Derive a confidence score

`verbose_json` returns `segments`, each with an `avg_logprob`. Turn those into a
single 0-to-1 confidence: the duration-weighted mean of `exp(avg_logprob)`,
clamped to `[0, 1]`. Return `null` when there is nothing to judge by, which makes
the echo logic stay quiet rather than guess.

```ts
interface Segment { avg_logprob?: number; start?: number; end?: number; }

export function deriveConfidence(segments: Segment[] | undefined): number | null {
  if (!segments?.length) return null;
  let weighted = 0, total = 0;
  for (const s of segments) {
    // Guard against non-finite: typeof NaN === "number", so a plain typeof check is not enough.
    if (typeof s.avg_logprob !== "number" || !Number.isFinite(s.avg_logprob)) continue;
    const dur = Math.max((s.end ?? 0) - (s.start ?? 0), 0.01);
    weighted += Math.exp(s.avg_logprob) * dur;
    total += dur;
  }
  if (total === 0) return null;
  return Math.min(1, Math.max(0, weighted / total));
}
```

Python equivalent:

```python
import math

def derive_confidence(segments):
    if not segments:
        return None
    weighted = total = 0.0
    for s in segments:
        lp = s.get("avg_logprob")
        if not isinstance(lp, (int, float)) or not math.isfinite(lp):
            continue
        dur = max((s.get("end", 0) or 0) - (s.get("start", 0) or 0), 0.01)
        weighted += math.exp(lp) * dur
        total += dur
    if total == 0:
        return None
    return min(1.0, max(0.0, weighted / total))
```

This score does not need to be precise. It only decides whether to show the user
what you heard. Calibrate the threshold later with real notes (see step 8).

### 7. Handle the empty and failure cases honestly

Each of these replies and then stops. None of them should spawn the model, and
all of them should delete the temp audio file afterward (a `finally` block):

- Empty or whitespace-only transcript: reply `"לא קלטתי מילים בהקלטה 🎤"`
  ("I didn't catch any words"), stop.
- Transcription threw, timed out, or hit a rate limit: reply something honest
  like `"⚠️ לא הצלחתי לתמלל את ההקלטה הפעם"` ("couldn't transcribe this time"),
  optionally add a 👎 reaction, log the specific cause, stop.

Not spawning the model on these paths matters: it avoids burning a model call on
nothing, and it keeps failures fast and cheap.

### 8. Inject the transcript as a normal user message

On success, the transcript flows through your normal pipeline exactly like typed
text: same model routing, same history, same recall, same skills. Concretely,
wherever your handler currently turns a typed message into a reply (say
`reply = await runClaude(typedText)`), call that same path with the transcript as
its input. Two small touches:

- Mark the medium in the prompt so the model reads mishearings charitably:

  ```
  [The user sent a voice note; this is its transcript — answer it like a typed message.]
  <the transcript>
  ```

- Store it in history with a marker, for example `[voice] <transcript>`, so your
  recall/search later knows it was spoken and still matches on the content.

Log a line like `[VOICE] confidence=0.83 chars=42` on every transcription. You
will use these logs to pick a good `VOICE_ECHO_BELOW` once you see real
clean-versus-mumbled numbers.

### 9. Echo what you heard, only when confidence is low

When (and only when) `confidence !== null && confidence < VOICE_ECHO_BELOW`,
prepend one quoted line to the reply so the user can see a mishearing:

```
🎤 «<transcript>»

<the normal answer>
```

```ts
export function shouldEchoTranscript(confidence: number | null, threshold: number): boolean {
  return confidence !== null && confidence < threshold;
}
```

If you have streaming replies, make this prefix part of every edit of that reply
bubble, not a separate message, and do not store the prefix in history. Above the
threshold, send just the answer with no echo. Unknown confidence (`null`) never
echoes.

### 10. Keep the API key out of logs and replies

Add the Groq key shape to whatever secret-redaction you run on outgoing text and
log lines. Groq keys look like `gsk_` followed by token characters, so a pattern
like `gsk_[A-Za-z0-9]+` replaced with `[REDACTED]` is enough. If you do not have
redaction yet, at minimum make sure error messages you send to the chat never
include the raw request or headers.

Security notes worth keeping in mind:
- The transcript is untrusted user speech, but it is the bot owner's own command,
  same trust level as text they type. It is injected as the user message, never
  as system instructions, so it adds no new injection surface. Do not let the
  audio filename enter the prompt.
- The temp audio file should live only for the turn. Delete it in `finally`, and
  have your normal startup sweep clean up any crash leftovers.

## Optional: a keyless local backend later

If you ever want to drop the hosted dependency, keep the same `Transcript`
interface and add a `local` backend that shells out to a command template. Define
an env var like `TRANSCRIBE_CMD` holding a shell command with an `{input}`
placeholder; it must print `{"text": "...", "confidence": 0.0-1.0?}` JSON on
stdout. A typical pipeline is `ffmpeg` to a 16 kHz wav, then `whisper-cli` with
JSON output.

Treat `TRANSCRIBE_CMD` as operator-only config (same trust as the path to your
Claude binary). It must not be writable from chat or by the model in-session,
since it runs a shell command. When substituting the path into the template,
single-quote it and escape embedded quotes so a filename can never break out of
the quoting.

Reality check on hardware: a 1 GB VPS can only run Whisper's `small` model, whose
Hebrew is mediocre and which takes roughly 30 to 90 seconds per 30-second note.
The Hebrew-tuned GGML models that sound native are around 1.6 GB and will not
fit. That is exactly why the hosted Groq backend is the default and the local one
is optional.

## Refinement: re-force the language on misdetection (optional)

Whisper occasionally tags a Hebrew note as Arabic, after which the model answers
in the wrong language. If you keep a small allow-list of expected languages (for
example `he` and `en`), you can detect this and fix it: `verbose_json` returns a
`language` field, so if the detected language is outside your allow-list,
re-transcribe once with `language` forced to your primary language. Normalize the
field first, because some backends return an English name (`"hebrew"`) and others
an ISO code (`"he"`). This is a nicety, not required for a first version.

## Testing

Unit-test the pure logic (it is all separable from the network):
- `deriveConfidence`: normal segments, empty segments give `null`, non-finite
  `avg_logprob` values are skipped.
- backend resolution precedence (explicit > key present > command present > off).
- the Groq path with a mocked `fetch`: a normal `verbose_json` body parses; 4xx,
  5xx, timeout, and malformed-body all map to the right errors.
- `envNum` with empty string returning the default, not `0`.

Then verify live, because unit tests prove logic and only production proves
plumbing:
- a Hebrew note is answered correctly,
- a deliberately mumbled note shows the `🎤` echo,
- a 6-minute note is declined with the cap,
- the API key never appears in any log line.

## Deployment

1. Create the free Groq key at console.groq.com.
2. Add `GROQ_API_KEY=...` to your bot's env file (keep that file locked down, for
   example `chmod 600`).
3. Restart the bot.

That is the whole rollout. No new system packages, because the hosted path needs
no `ffmpeg` or local model.

## Gotchas, collected

1. Groq rejects the `.oga` filename Telegram uses. Send the bytes under a
   `.ogg` (or other accepted) filename. Same container, different extension, hard
   stop on the allow-list.
2. Lazy file wrappers can send the local path as the multipart filename. Read the
   bytes into memory and attach an explicit `File`/filename.
3. Empty-string env vars must not become `0`. Parse numeric config so a blank
   value falls back to the default.
4. `typeof NaN === "number"`. Filter segment scores with `Number.isFinite`, not a
   bare `typeof` check.
5. Never retry a 4xx. Retry once on network errors and 5xx only.
6. Do not spawn the model on empty or failed transcriptions. Reply honestly and
   stop, so a dud note never costs a model call.
7. Always delete the temp audio in a `finally` block.
8. Honest declines beat silent failures. Every rejected note (too long, backend
   off, transcription failed) gets a specific, friendly message.
