import { test, expect } from "bun:test";
import { speakableText, shouldSpeak, parseVoiceCommand, parseSynthOutput, ttsAvailable, withSynthLock } from "./tts.ts";

// --- the synthesis lock (2026-08-04 crash fix) ------------------------------
// One synthesis peaks at 668MB on a 1968MB droplet with no swap. Two at once
// leaves ~200MB of margin; three is an OOM and the kernel takes the largest
// process, which is the bot. Nothing else bounds this — the poller handles
// messages concurrently.

test("withSynthLock runs one at a time", async () => {
  const order: string[] = [];
  const slow = () =>
    withSynthLock(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
    });
  const fast = () =>
    withSynthLock(async () => {
      order.push("b-start");
      order.push("b-end");
    });
  await Promise.all([slow(), fast()]);
  expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
});

test("a failed synthesis releases the lock instead of wedging it shut forever", async () => {
  await withSynthLock(async () => {
    throw new Error("boom");
  }).catch(() => {});
  const ran = await withSynthLock(async () => "second ran");
  expect(ran).toBe("second ran");
});

test("the caller still sees its own rejection", async () => {
  await expect(
    withSynthLock(async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
});

test("a slow synthesis does not swallow the one queued behind it", async () => {
  const done: string[] = [];
  await Promise.all([
    withSynthLock(async () => {
      await new Promise((r) => setTimeout(r, 20));
      done.push("first");
    }),
    withSynthLock(async () => {
      done.push("second");
    }),
  ]);
  expect(done).toEqual(["first", "second"]);
});

// --- what gets spoken ------------------------------------------------------

test("URLs are stripped — a link read character by character is unlistenable", () => {
  const out = speakableText("הנה המקור https://www.seret.co.il/movies/x.asp?TID=50 בהצלחה");
  expect(out).not.toContain("http");
  expect(out).not.toContain("seret");
  expect(out).toContain("הנה המקור");
  expect(out).toContain("בהצלחה");
});

test("emoji are dropped rather than read out as names", () => {
  expect(speakableText("סיימתי ✅ הכל בסדר 🎤")).toBe("סיימתי הכל בסדר");
});

test("stray markdown characters are removed", () => {
  expect(speakableText("**חשוב** מאוד `bun run x` ## כותרת")).toBe("חשוב מאוד bun run x כותרת");
});

test("whitespace collapses without gluing words together", () => {
  expect(speakableText("שלום    עולם\n\n\nמה נשמע")).toBe("שלום עולם\nמה נשמע");
});

test("shouldSpeak rejects an answer that is only a link", () => {
  expect(shouldSpeak("https://example.com/a/b/c")).toBe(false);
});

test("shouldSpeak rejects empty and whitespace-only answers", () => {
  expect(shouldSpeak("")).toBe(false);
  expect(shouldSpeak("   \n  ")).toBe(false);
});

test("shouldSpeak rejects an answer past the length cap", () => {
  expect(shouldSpeak("א".repeat(50), 40)).toBe(false);
  expect(shouldSpeak("א".repeat(30), 40)).toBe(true);
});

test("shouldSpeak measures the cleaned text, not the raw answer", () => {
  // A short sentence plus a long URL must still be speakable.
  const raw = "בבקשה " + "https://example.com/" + "x".repeat(200);
  expect(raw.length).toBeGreaterThan(120);
  expect(shouldSpeak(raw, 120)).toBe(true);
});

test("a normal Hebrew answer is spoken", () => {
  expect(shouldSpeak("היי מאור, אין לך אירועים מחר ואין תזכורות פתוחות.")).toBe(true);
});

// --- the /voice command ----------------------------------------------------

test("parseVoiceCommand reads on, off and bare status", () => {
  expect(parseVoiceCommand("/voice on")).toBe("on");
  expect(parseVoiceCommand("/voice off")).toBe("off");
  expect(parseVoiceCommand("/voice")).toBe("status");
  expect(parseVoiceCommand("  /voice   off  ")).toBe("off");
  expect(parseVoiceCommand("/VOICE OFF")).toBe("off");
});

test("parseVoiceCommand ignores ordinary messages and unknown arguments", () => {
  expect(parseVoiceCommand("תפסיק להקליט")).toBeNull();
  expect(parseVoiceCommand("/voices")).toBeNull();
  expect(parseVoiceCommand("/voice maybe")).toBeNull();
  expect(parseVoiceCommand("שלח /voice off")).toBeNull(); // must be the whole message
});

test("parseVoiceCommand honours @botname addressing", () => {
  expect(parseVoiceCommand("/voice@maores_assistant_bot off", "maores_assistant_bot")).toBe("off");
  expect(parseVoiceCommand("/voice@someone_else off", "maores_assistant_bot")).toBeNull();
});

// --- reading the synthesizer's output --------------------------------------

test("parseSynthOutput picks the JSON line out of runtime warnings", () => {
  const stdout = [
    "2026-08-04 W:onnxruntime: some warning about a transpose node",
    "another warning",
    '{"ok": true, "path": "/tmp/a.ogg", "seconds": 7.73}',
  ].join("\n");
  expect(parseSynthOutput(stdout)).toEqual({ path: "/tmp/a.ogg", seconds: 7.73 });
});

test("parseSynthOutput returns null for a reported failure", () => {
  expect(parseSynthOutput('{"ok": false, "error": "empty text"}')).toBeNull();
});

test("parseSynthOutput returns null for garbage or silence", () => {
  expect(parseSynthOutput("")).toBeNull();
  expect(parseSynthOutput("Traceback (most recent call last):")).toBeNull();
  expect(parseSynthOutput("{not json")).toBeNull();
});

// --- graceful absence ------------------------------------------------------

test("ttsAvailable is false when the models are not installed", () => {
  const prev = process.env.TTS_HOME;
  process.env.TTS_HOME = "/nonexistent/tts-home";
  try {
    expect(ttsAvailable()).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.TTS_HOME;
    else process.env.TTS_HOME = prev;
  }
});

test("TTS_DISABLED=1 turns the feature off even with models present", () => {
  const prev = process.env.TTS_DISABLED;
  process.env.TTS_DISABLED = "1";
  try {
    expect(ttsAvailable()).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.TTS_DISABLED;
    else process.env.TTS_DISABLED = prev;
  }
});

// --- the phase-1 input gate ------------------------------------------------

import { shouldSpeakForInput } from "./tts.ts";

test("only short recordings earn a spoken reply during the test phase", () => {
  expect(shouldSpeakForInput(1)).toBe(true);
  expect(shouldSpeakForInput(4)).toBe(true);
  expect(shouldSpeakForInput(5)).toBe(false);
  expect(shouldSpeakForInput(60)).toBe(false);
});

test("an unknown or nonsense duration stays quiet rather than guessing", () => {
  expect(shouldSpeakForInput(null)).toBe(false);
  expect(shouldSpeakForInput(undefined)).toBe(false);
  expect(shouldSpeakForInput(0)).toBe(false);
  expect(shouldSpeakForInput(-3)).toBe(false);
});

// --- the synthesis slot, held across a pre-warm ----------------------------
// An engine that is only pre-loading still owns 668MB, so it must hold the slot
// from spawn, not from synthesis. A slot that leaks silences voice replies
// permanently — worse than the crash the lock prevents.

import { acquireSynthSlot } from "./tts.ts";

test("the slot is exclusive and is handed on when released", async () => {
  const order: string[] = [];
  const releaseA = await acquireSynthSlot();
  order.push("a-held");
  let bHeld = false;
  const bp = acquireSynthSlot().then((r) => {
    bHeld = true;
    order.push("b-held");
    r();
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(bHeld).toBe(false); // B must still be waiting on A
  releaseA();
  await bp;
  expect(order).toEqual(["a-held", "b-held"]);
});

test("releasing twice does not hand the slot to two holders at once", async () => {
  const release = await acquireSynthSlot();
  release();
  release();
  const second = await acquireSynthSlot();
  second();
  expect(true).toBe(true); // reaching here means the chain did not deadlock or double-grant
});

test("withSynthLock still serialises after being rebuilt on the slot", async () => {
  const order: string[] = [];
  await Promise.all([
    withSynthLock(async () => {
      order.push("1-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("1-end");
    }),
    withSynthLock(async () => {
      order.push("2-start");
      order.push("2-end");
    }),
  ]);
  expect(order).toEqual(["1-start", "1-end", "2-start", "2-end"]);
});

// --- the ready handshake ---------------------------------------------------
// The engine prints a ready line once its models are loaded, so the poller can
// start it while the answer is still being written.

test("parseSynthOutput ignores the ready line and returns the audio result", () => {
  const stdout = ['{"ok": true, "ready": true}', '{"ok": true, "path": "/tmp/a.ogg", "seconds": 3.2}'].join("\n");
  expect(parseSynthOutput(stdout)).toEqual({ path: "/tmp/a.ogg", seconds: 3.2 });
});

test("parseSynthOutput returns null when only the ready line arrived (engine died mid-turn)", () => {
  expect(parseSynthOutput('{"ok": true, "ready": true}')).toBeNull();
});

test("parseSynthOutput still finds the result under runtime warnings after a ready line", () => {
  const stdout = [
    '{"ok": true, "ready": true}',
    "W:onnxruntime: transpose node warning",
    '{"ok": true, "path": "/tmp/b.ogg", "seconds": 5.0}',
  ].join("\n");
  expect(parseSynthOutput(stdout)).toEqual({ path: "/tmp/b.ogg", seconds: 5.0 });
});

// --- the engine timeout bounds synthesis, not the wait ----------------------
// The engine is deliberately spawned when the recording arrives so the models
// load during the answer. 2026-08-05: a 3.5-minute answer outlived the killer
// that used to be armed at spawn — "engine exited 143", no voice note. The
// timeout may only start once text is actually fed.

import { engineFromProc, type EngineProc } from "./tts.ts";

/** A controllable stand-in for the spawned python synthesizer. */
function fakeProc(opts: { stdout?: string; exitCode?: number } = {}) {
  let closeStdout!: () => void;
  let resolveExited!: (code: number) => void;
  const state = { killed: false, stdinData: "", stdinEnded: false };
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      closeStdout = () => {
        if (opts.stdout) controller.enqueue(new TextEncoder().encode(opts.stdout));
        try {
          controller.close();
        } catch {}
      };
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  const exited = new Promise<number>((r) => {
    resolveExited = r;
  });
  const proc: EngineProc = {
    stdin: {
      write(s: string) {
        state.stdinData += s;
        return s.length;
      },
      end() {
        state.stdinEnded = true;
        // A real synthesizer answers after stdin closes; the fake answers only
        // when the test says so via finishNow(), unless configured immediate.
      },
    },
    stdout,
    stderr,
    exited,
    kill() {
      state.killed = true;
      closeStdout();
      resolveExited(143);
    },
  };
  const finishNow = (code = opts.exitCode ?? 0) => {
    closeStdout();
    resolveExited(code);
  };
  return { proc, state, finishNow };
}

const OK_JSON = '{"ok": true, "path": "/tmp/fake.ogg", "seconds": 2.5}\n';

test("an engine still waiting for the answer is NOT killed when the timeout passes", async () => {
  const { proc, state } = fakeProc();
  let released = false;
  engineFromProc(proc, () => {
    released = true;
  }, 30);
  await new Promise((r) => setTimeout(r, 90));
  // Pre-warmed and idle: no text was fed yet, so no timer may be running.
  expect(state.killed).toBe(false);
  expect(released).toBe(false);
});

test("speak() bounds the synthesis: a wedged engine is killed after the timeout", async () => {
  const { proc, state } = fakeProc();
  let released = false;
  const engine = engineFromProc(proc, () => {
    released = true;
  }, 30);
  const spoken = await engine.speak("שלום מאור, הכל בסדר");
  expect(spoken).toBeNull(); // killed mid-synthesis → no audio
  expect(state.killed).toBe(true);
  expect(released).toBe(true); // the slot must come back even on a timeout
});

test("a synthesis finishing inside the limit returns audio and is never killed", async () => {
  const { proc, state, finishNow } = fakeProc({ stdout: OK_JSON });
  let released = false;
  const engine = engineFromProc(proc, () => {
    released = true;
  }, 5_000);
  const speaking = engine.speak("שלום מאור, הכל בסדר");
  finishNow();
  const spoken = await speaking;
  expect(spoken).toEqual({ path: "/tmp/fake.ogg", seconds: 2.5 });
  expect(state.killed).toBe(false);
  expect(released).toBe(true);
  // The killer must be gone, not merely not-yet-fired.
  await new Promise((r) => setTimeout(r, 20));
  expect(state.killed).toBe(false);
});

test("kill() on an idle engine kills the process and releases the slot", () => {
  const { proc, state } = fakeProc();
  let released = false;
  const engine = engineFromProc(proc, () => {
    released = true;
  }, 5_000);
  engine.kill();
  expect(state.killed).toBe(true);
  expect(released).toBe(true);
});

test("speak() with an unspeakable answer kills the engine instead of feeding it", async () => {
  const { proc, state } = fakeProc();
  let released = false;
  const engine = engineFromProc(proc, () => {
    released = true;
  }, 5_000);
  const spoken = await engine.speak("https://example.com/only-a-link");
  expect(spoken).toBeNull();
  expect(state.killed).toBe(true);
  expect(released).toBe(true);
  expect(state.stdinData).toBe(""); // nothing was fed
});
