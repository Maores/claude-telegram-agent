import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPending, consumePending, parseVcCallback, vcKeyboard, loadPending } from "./voice-confirm.ts";

const T0 = 1_786_000_000;

function freshFile() {
  process.env.VOICE_PENDING_FILE = join(mkdtempSync(join(tmpdir(), "vc-")), "pending.json");
}

test("a pending transcript can be consumed exactly once", () => {
  freshFile();
  const p = addPending(7, "תזכיר לי מחר בבוקר", "voice", T0);
  const first = consumePending(p.id, T0 + 5);
  expect(first.outcome).toBe("ok");
  if (first.outcome === "ok") {
    expect(first.pending.text).toBe("תזכיר לי מחר בבוקר");
    expect(first.pending.kind).toBe("voice");
    expect(first.pending.chatId).toBe(7);
  }
  expect(consumePending(p.id, T0 + 6).outcome).toBe("stale");
});

test("a pending transcript expires after an hour", () => {
  freshFile();
  const p = addPending(7, "שלום", "voice", T0);
  expect(consumePending(p.id, T0 + 3601).outcome).toBe("expired");
});

test("an expired transcript is still removed, so it cannot be replayed", () => {
  freshFile();
  const p = addPending(7, "שלום", "voice", T0);
  consumePending(p.id, T0 + 3601);
  expect(consumePending(p.id, T0 + 3602).outcome).toBe("stale");
});

test("unknown ids are stale rather than a crash", () => {
  freshFile();
  expect(consumePending("nope", T0).outcome).toBe("stale");
});

test("ids stay unique even within the same millisecond", () => {
  freshFile();
  const a = addPending(7, "one", "voice", T0);
  const b = addPending(7, "two", "voice", T0);
  expect(a.id).not.toBe(b.id);
  expect(consumePending(a.id, T0).outcome).toBe("ok");
  expect(consumePending(b.id, T0).outcome).toBe("ok");
});

test("adding prunes entries that already expired, so the file cannot grow forever", () => {
  freshFile();
  addPending(7, "old", "voice", T0);
  addPending(7, "new", "voice", T0 + 7200);
  const left = loadPending();
  expect(left.length).toBe(1);
  expect(left[0]!.text).toBe("new");
});

test("an audio file keeps its kind, so the reply reads as one", () => {
  freshFile();
  const p = addPending(7, "הקלטה מוואטסאפ", "audio", T0);
  const r = consumePending(p.id, T0);
  if (r.outcome === "ok") expect(r.pending.kind).toBe("audio");
});

test("parseVcCallback reads both verdicts and rejects everything else", () => {
  expect(parseVcCallback("vc:abc:y")).toEqual({ id: "abc", ok: true });
  expect(parseVcCallback("vc:abc:n")).toEqual({ id: "abc", ok: false });
  expect(parseVcCallback("vc:abc:maybe")).toBeNull();
  expect(parseVcCallback("vc:abc")).toBeNull();
  expect(parseVcCallback("")).toBeNull();
});

test("parseVcCallback stays disjoint from the other button namespaces", () => {
  // A collision here would route another feature's taps into this handler.
  expect(parseVcCallback("fu:done:f123")).toBeNull();
  expect(parseVcCallback("fuu:f123:r4")).toBeNull();
  expect(parseVcCallback("qz:start:1")).toBeNull();
  expect(parseVcCallback("pa:ok:a1")).toBeNull();
  expect(parseVcCallback("ch:c1:2")).toBeNull();
});

test("the keyboard stays inside Telegram's 64-byte callback_data limit", () => {
  const kb = vcKeyboard("v1786000000000xxx");
  for (const row of kb.inline_keyboard) {
    for (const btn of row) expect(btn.callback_data.length).toBeLessThanOrEqual(64);
  }
});

test("the keyboard offers exactly one yes and one no", () => {
  const kb = vcKeyboard("v1");
  const all = kb.inline_keyboard.flat();
  expect(all.length).toBe(2);
  expect(all.filter((b) => b.callback_data.endsWith(":y")).length).toBe(1);
  expect(all.filter((b) => b.callback_data.endsWith(":n")).length).toBe(1);
});
