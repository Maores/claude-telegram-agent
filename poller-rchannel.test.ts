import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rcParams, isNotModified, parseFuCallback, parseFuuCallback, parsePaCallback, parseChCallback, sanitizeOutgoing } from "./poller.ts";
import { parseRcCallback, cardView, emptyStore, applySync, beginSend } from "./rchannel.ts";
import { parseQzCallback } from "./quiz";
import { parseVcCallback } from "./voice-confirm.ts";
import { stripIsolates } from "./bidi.ts";

// All fixtures are synthetic.

test("rcParams sends the keyboard when there is one and leaves reply_markup out when there is none", () => {
  const kb = [[{ text: "✓", callback_data: "rc:q1:1:ok" }]];
  expect(rcParams({ text: "א", keyboard: kb })).toEqual({ text: "א", reply_markup: { inline_keyboard: kb } });
  expect(rcParams({ text: "א", keyboard: null })).toEqual({ text: "א" });
});

test("isNotModified recognizes only Telegram's no-change refusal", () => {
  expect(isNotModified(new Error("Telegram editMessageText failed: 400 Bad Request: message is not modified: specified new message content and reply markup are exactly the same"))).toBe(true);
  expect(isNotModified(new Error("Telegram editMessageText failed: 400 Bad Request: message to edit not found"))).toBe(false);
  expect(isNotModified("boom")).toBe(false);
});

test("the rc: namespace and the older ones never read each other's buttons", () => {
  for (const data of ["rc:q1:1:a", "rc:q12:3:all", "rc:q1:2:ok"]) {
    expect(parseFuCallback(data)).toBeNull();
    expect(parseFuuCallback(data)).toBeNull();
    expect(parsePaCallback(data)).toBeNull();
    expect(parseChCallback(data)).toBeNull();
    expect(parseQzCallback(data)).toBeNull();
    expect(parseVcCallback(data)).toBeNull();
  }
  for (const data of ["fu:done:f1", "fuu:f1:r2", "pa:ok:pa1", "ch:c1:0", "vc:v1:y"]) expect(parseRcCallback(data)).toBeNull();
});

test("a card goes out through tg()'s filter isolated for BiDi, within Telegram's limit", () => {
  const s = emptyStore();
  const body = "בודק קבצים עם Opus בכמה שלבים. ".repeat(19).trim(); // 588 characters, under the 600 limit
  applySync(s, { v: 1, requests: [{ v: 1, id: "map-1", routine: "map", title: "מפת הסקילים", kind: "cards", text: "", supersedes: true, cards: [{ key: "k", heading: "sample-tool", body }] }], acks: [], results: [], closes: [] }, 0);
  beginSend(s, "map-1", 0, "4/10");
  const view = cardView(s.requests[0]);
  const out = sanitizeOutgoing("sendMessage", { chat_id: 42, ...rcParams(view) }) as { text: string };
  expect(out.text.length).toBeLessThanOrEqual(4096);
  expect(out.text).not.toBe(view.text); // the Latin word inside the Hebrew body got its isolates
  expect(out.text.split("\n")[1]).toBe("sample-tool"); // a line with no Hebrew is left alone
  expect(stripIsolates(out.text)).toBe(view.text);
});

// --- the wiring in poller.ts ----------------------------------------------------------
// poller.ts calls Telegram directly, with nothing to inject, so its turn paths cannot run in a
// test. The channel's logic is tested in rchannel.test.ts; these checks pin the few lines that
// connect it, so deleting or moving one of them fails here (each was broken on purpose once).

const SRC = readFileSync(join(import.meta.dir, "poller.ts"), "utf8");

/** A top-level function of poller.ts, from its declaration to the next top-level declaration. */
function body(name: string): string {
  const start = SRC.search(new RegExp(`^(?:export )?(?:async )?function ${name}[(]`, "m"));
  if (start < 0) throw new Error(`no function ${name} in poller.ts`);
  const next = SRC.slice(start + 1).search(/^(?:export |async |function |const |let |\/\/ -{10})/m);
  return SRC.slice(start, next < 0 ? SRC.length : start + 1 + next);
}

test("every turn path takes the other directive and sends the turn's routine proposals", () => {
  for (const name of ["handleMessage", "handleMessageBatch", "answerConfirmedVoice"]) {
    const b = body(name);
    expect(b).toContain("const rcDirective = takeRcOtherDirective(chatId);");
    expect(b).toContain("await sendRcProposalsAfter(chatId, turnId);");
  }
  expect(body("handleMessage")).toContain("[devDirective, quizDirective, snoozeDirective, rcDirective]");
  expect(body("handleMessageBatch")).toContain("[devDirective, quizDirective, snoozeDirective, rcDirective]");
  expect(body("answerConfirmedVoice")).toContain("loadMemory(), skills, rcDirective,");
  // the batch path takes it only after its voice-confirmation gate, so a held burst keeps it
  const batch = body("handleMessageBatch");
  expect(batch.indexOf("items.some((i) => i.needsConfirm)")).toBeLessThan(batch.indexOf("takeRcOtherDirective(chatId)"));
  // and so does the single-message path, after its own gate
  const single = body("handleMessage");
  expect(single.indexOf("needsConfirmation(voiceText, voiceConfidence)")).toBeGreaterThan(0);
  expect(single.indexOf("needsConfirmation(voiceText, voiceConfidence)")).toBeLessThan(single.indexOf("takeRcOtherDirective(chatId)"));
});

test("the tick runs every 30 seconds, rc: buttons are routed, and a restart's drain waits for a tick", () => {
  const main = body("main");
  expect(main).toMatch(/setInterval\(\(\) => \{[^}]*void checkRchannel\(\);[^}]*\}, 30_000\)/);
  expect(main).toContain("rchannelInFlight ?? Promise.resolve()");
  const cb = body("handleCallback");
  expect(cb).toContain("parseRcCallback(cq.data");
  expect(cb).toContain("await handleRcCallback(rc, chatId, messageId, ack);");
  expect(body("checkRchannel")).toContain("if (stopping) return Promise.resolve();");
});
