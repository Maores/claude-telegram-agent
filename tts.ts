/**
 * tts.ts — Hebrew speech for voice replies.
 *
 * When Maor sends a voice note he gets the text answer first and a spoken one a
 * few seconds later. The synthesis itself is Python (Phonikud for Hebrew
 * grapheme-to-phoneme, Piper for the voice, both ONNX on CPU), driven here as a
 * short-lived child process.
 *
 * Nothing is installed system-wide: the venv and the ~355MB of models live in
 * TTS_HOME, deliberately OUTSIDE the git repo so a deploy's `git reset --hard`
 * never touches them. On a machine without them (Maor's Windows box, tests)
 * ttsAvailable() is false and every caller quietly skips the voice reply.
 *
 * Measured on the live droplet (1 vCPU) 2026-08-04: 9.3s to load the models,
 * then 3.2s to produce 7.7s of speech. Cold start per reply is the accepted
 * trade for not running a resident 350MB process.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** Longer answers make unbearable voice notes; past this we send text only. */
export const TTS_MAX_CHARS = Number(process.env.TTS_MAX_CHARS) || 1200;

/** Phase-1 scaffolding: only a SHORT recording earns a spoken reply, so trust
 *  is built on cheap exchanges first. Comes out in phase 2, when any recording
 *  gets audio with the text behind a button (see the design doc).
 *
 *  This only ships alongside the confirmation flow. On its own it would aim
 *  speech squarely at Maor's least reliable input — both 2026-08-04 failures
 *  were his shortest recordings. */
export const VOICE_REPLY_MAX_INPUT_SEC = Number(process.env.VOICE_REPLY_MAX_INPUT_SEC) || 4;

/** Whether a recording of this length earns a spoken reply. An unknown duration
 *  stays quiet: silence beats a surprise voice note. */
export function shouldSpeakForInput(durationSec: number | null | undefined): boolean {
  return typeof durationSec === "number" && durationSec > 0 && durationSec <= VOICE_REPLY_MAX_INPUT_SEC;
}
/** Hard ceiling on one synthesis, so a wedged child can't stall the poller. */
export const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS) || 120_000;

export function ttsHome(): string {
  return process.env.TTS_HOME || join(process.env.HOME ?? "", "tts");
}

export function ttsPython(): string {
  return process.env.TTS_PYTHON || join(ttsHome(), ".venv", "bin", "python");
}

/** Whether speech can actually be produced here. Checked before every use so a
 *  missing model turns the feature off rather than throwing mid-turn. */
export function ttsAvailable(): boolean {
  if (process.env.TTS_DISABLED === "1") return false;
  const home = ttsHome();
  return (
    existsSync(ttsPython()) &&
    existsSync(join(home, "phonikud-1.0.int8.onnx")) &&
    existsSync(join(home, "tts-model.onnx")) &&
    existsSync(join(home, "tts-model.config.json"))
  );
}

const URL_RE = /https?:\/\/\S+/g;
// Emoji and pictographs. Read aloud they become noise or a literal name.
const EMOJI_RE =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}]/gu;

/**
 * Strip what should never be spoken. A URL read character by character is
 * unlistenable, and the model still emits the odd markdown character despite
 * CLAUDE.md asking for plain text.
 */
export function speakableText(raw: string): string {
  return raw
    .replace(URL_RE, " ")
    .replace(EMOJI_RE, " ")
    .replace(/[*_`#>|~]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Whether this answer is worth speaking at all. */
export function shouldSpeak(raw: string, maxChars = TTS_MAX_CHARS): boolean {
  const t = speakableText(raw);
  if (!t) return false;
  if (t.length > maxChars) return false;
  // Nothing pronounceable left once symbols and Latin punctuation are gone
  // (e.g. an answer that was only a link).
  return /[֐-׿]|[A-Za-z]|[0-9]/.test(t);
}

export interface Spoken {
  /** Path to an OGG/Opus file, ready for Telegram's sendVoice. */
  path: string;
  /** Duration of the audio in seconds, as reported by the synthesizer. */
  seconds: number;
}

/** Parsed stdout of the Python side. Exported for tests. */
export function parseSynthOutput(stdout: string): Spoken | null {
  // The ONNX runtime prints warnings; the JSON is the last non-empty line.
  const lines = stdout.trim().split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const o = JSON.parse(line);
      if (o?.ok && typeof o.path === "string" && typeof o.seconds === "number") {
        return { path: o.path, seconds: o.seconds };
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Serialises synthesis. One process peaks at 668MB (measured 2026-08-04) on a
 * 1968MB droplet with NO SWAP, so two at once leaves ~200MB of margin and three
 * is an OOM — and the kernel kills the largest process, which is the bot. The
 * poller handles messages concurrently and nothing else bounds this, so five
 * recordings in a row survived that evening purely by luck of scheduling.
 *
 * The chain deliberately swallows outcomes so a failed synthesis can never
 * wedge the lock shut: a leaked lock would silence voice replies permanently,
 * which is worse than the crash it prevents. The caller still sees its own
 * rejection.
 */
let synthChain: Promise<unknown> = Promise.resolve();

/**
 * Take the single synthesis slot; resolves with the function that gives it back.
 *
 * Everything holding a loaded model must hold this — including a process that is
 * only PRE-loading, since 668MB is owned from the moment it starts reading
 * weights, not from the moment it speaks. Two pre-warmed engines would blow the
 * exact budget this exists to protect.
 *
 * Release is idempotent, and callers must release in a `finally`: a leaked slot
 * silences voice replies permanently, which is worse than the crash it prevents.
 */
export function acquireSynthSlot(): Promise<() => void> {
  let release!: () => void;
  let released = false;
  const held = new Promise<void>((resolve) => {
    release = () => {
      if (released) return;
      released = true;
      resolve();
    };
  });
  const myTurn = synthChain.then(
    () => undefined,
    () => undefined,
  );
  synthChain = myTurn.then(() => held);
  return myTurn.then(() => release);
}

export async function withSynthLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireSynthSlot();
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Speak `text` into `outPath` (an .ogg). Returns null on anything going wrong —
 * a voice reply is a bonus on top of a text answer already delivered, so it
 * must never turn into an error the user sees.
 *
 * Serialised: only one synthesis runs at a time, the rest queue behind it.
 */
export async function synthesize(text: string, outPath: string): Promise<Spoken | null> {
  return withSynthLock(() => synthesizeUnlocked(text, outPath));
}

async function synthesizeUnlocked(text: string, outPath: string): Promise<Spoken | null> {
  if (!ttsAvailable()) return null;
  const speech = speakableText(text);
  if (!shouldSpeak(text)) return null;

  const script = join(import.meta.dir, "tts_synth.py");
  try {
    const proc = Bun.spawn([ttsPython(), script, outPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TTS_HOME: ttsHome() },
    });
    const killer = setTimeout(() => {
      try {
        proc.kill();
      } catch {}
    }, TTS_TIMEOUT_MS);

    proc.stdin!.write(speech);
    proc.stdin!.end();
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(killer);

    if (code !== 0) {
      const err = await new Response(proc.stderr).text().catch(() => "");
      console.error(`[TTS] synth exited ${code}: ${err.trim().split("\n").slice(-2).join(" | ")}`);
      return null;
    }
    return parseSynthOutput(stdout);
  } catch (e: any) {
    console.error(`[TTS] synth failed: ${e?.message ?? e}`);
    return null;
  }
}

/** A synthesizer already loading its models, waiting to be handed text. */
export interface TtsEngine {
  /** Feed the answer and get the audio. Releases the slot however it ends. */
  speak(text: string): Promise<Spoken | null>;
  /** Abandon it — the answer didn't qualify, or the turn failed. Releases too. */
  kill(): void;
}

/**
 * Start the synthesizer NOW, so its ~9.3s model load runs while the answer is
 * still being written rather than after it. Measured 2026-08-04: loading is
 * 9.3s of the 11–19s a voice reply used to take, and a claude turn spends
 * 6–34s mostly waiting on the network, leaving the single core idle.
 *
 * Holds the synthesis slot from spawn, because a process that is merely
 * pre-loading already owns 668MB. Returns null when speech isn't possible here,
 * which keeps every caller's happy path unchanged.
 */
export async function startEngine(outPath: string): Promise<TtsEngine | null> {
  if (!ttsAvailable()) return null;
  const release = await acquireSynthSlot();
  const script = join(import.meta.dir, "tts_synth.py");
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    proc = Bun.spawn([ttsPython(), script, outPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, TTS_HOME: ttsHome() },
    });
  } catch (e: any) {
    release(); // never strand the slot on a failed spawn
    console.error(`[TTS] engine spawn failed: ${e?.message ?? e}`);
    return null;
  }
  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, TTS_TIMEOUT_MS);
  const finish = () => {
    clearTimeout(killer);
    release();
  };
  const kill = () => {
    try {
      proc.kill();
    } catch {}
    finish();
  };
  return {
    kill,
    async speak(text: string): Promise<Spoken | null> {
      if (!shouldSpeak(text)) {
        kill();
        return null;
      }
      try {
        proc.stdin.write(speakableText(text));
        proc.stdin.end();
        const stdout = await new Response(proc.stdout).text();
        const code = await proc.exited;
        if (code !== 0) {
          const err = await new Response(proc.stderr).text().catch(() => "");
          console.error(`[TTS] engine exited ${code}: ${err.trim().split("\n").slice(-2).join(" | ")}`);
          return null;
        }
        return parseSynthOutput(stdout);
      } catch (e: any) {
        console.error(`[TTS] engine speak failed: ${e?.message ?? e}`);
        return null;
      } finally {
        finish();
      }
    },
  };
}

// --- the /voice command ----------------------------------------------------

export type VoiceCommand = "on" | "off" | "status";

/**
 * Parse `/voice`, `/voice on`, `/voice off` (with an optional @botname).
 * Handled in the poller before a claude session spawns, like /stop and /quiz,
 * so turning speech off never depends on the model behaving.
 */
export function parseVoiceCommand(text: string, botUsername?: string): VoiceCommand | null {
  const m = /^\/voice(?:@(\S+))?(?:\s+(\S+))?\s*$/i.exec((text ?? "").trim());
  if (!m) return null;
  if (m[1] && botUsername && m[1].toLowerCase() !== botUsername.toLowerCase()) return null;
  const arg = (m[2] ?? "").toLowerCase();
  if (!arg) return "status";
  if (arg === "on") return "on";
  if (arg === "off") return "off";
  return null;
}
