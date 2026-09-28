import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RcCard, RcRequest } from "./rchannel-schema";
import {
  applySync,
  applyTap,
  loadStore,
  mutateStore,
  parseRcCallback,
  performEdits,
  registerProposal,
  RcGone,
  runRchannelTick,
  sendRcProposals,
  takeOther,
  viewOf,
  type TickDeps,
  type View,
} from "./rchannel";

// The card follows the conversation: once he has written in an "אחר" window, the request's next
// view goes out as a new message at the bottom of the chat, and the old one becomes a short line.
// A proposal whose card stopped waiting loses its buttons. All fixtures are synthetic.

const made: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "rchannel-follow-"));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const NOW = Math.floor(Date.parse("2026-10-04T07:00:00Z") / 1000); // Sunday 10:00 local
const card = (key: string): RcCard => ({ key, heading: `item-${key}`, body: `תיאור של ${key}.` });
const req = (id: string, extra: Partial<RcRequest> = {}): RcRequest => ({
  v: 1,
  id,
  routine: "map",
  title: "מפת הסקילים",
  kind: "cards",
  text: "",
  supersedes: true,
  cards: [card("k1"), card("k2"), card("k3")],
  ...extra,
});
const payload = (extra: object = {}) => ({ v: 1 as const, requests: [] as RcRequest[], acks: [] as string[], results: [] as any[], closes: [] as any[], ...extra });
const MOVED: View = { text: "מפת הסקילים: המשך בהודעה למטה.", keyboard: null };

function fakeTelegram(dir: string) {
  const sends: { chatId: number; view: View }[] = [];
  const edits: { chatId: number; messageId: number; view: View }[] = [];
  const logs: string[] = [];
  let nextId = 1000;
  let failSends = 0;
  let goneEdits = 0;
  const deps: TickDeps = {
    now: () => new Date(NOW * 1000),
    dir,
    targetChat: () => 42,
    send: async (chatId, view) => {
      if (failSends > 0) {
        failSends--;
        throw new Error("Telegram sendMessage failed: 500");
      }
      sends.push({ chatId, view });
      return nextId++;
    },
    edit: async (chatId, messageId, view) => {
      if (goneEdits > 0) {
        goneEdits--;
        throw new RcGone("Telegram editMessageText failed: 400 Bad Request: message to edit not found");
      }
      edits.push({ chatId, messageId, view });
    },
    log: (l) => logs.push(l),
  };
  return { deps, sends, edits, logs, failSend: (n: number) => (failSends = n), goneEdit: (n: number) => (goneEdits = n) };
}

const tapIn = (dir: string, data: string, messageId: number, nowS = NOW) =>
  mutateStore(dir, (s) => applyTap(s, parseRcCallback(data)!, 42, messageId, nowS));
const first = (v: View) => v.text.split("\n")[0];

/** A request on show as message 1000, "אחר" tapped on card 1, and one message of his taken. */
async function afterHeWrote(dir: string, tg: ReturnType<typeof fakeTelegram>) {
  mutateStore(dir, (s) => applySync(s, payload({ requests: [req("map-1")] }), NOW));
  await runRchannelTick(tg.deps);
  await performEdits(tg.deps, tapIn(dir, "rc:q1:1:o", 1000).edits);
  expect(mutateStore(dir, (s) => takeOther(s, 42, NOW + 5))).toContain("<routine-card-other>");
}

test("after he wrote in the window, ✓ on the proposal sends the next card at the bottom and shortens the old message", async () => {
  const dir = scratch();
  const tg = fakeTelegram(dir);
  await afterHeWrote(dir, tg);
  mutateStore(dir, (s) => registerProposal(s, { short: "q1", card: 1, text: "תיאור קצר.", chatId: 42, turnId: "t1" }, NOW + 10));
  await sendRcProposals(tg.deps, 42, "t1"); // message 1001
  const r = tapIn(dir, "rc:q1:1:ok", 1001, NOW + 20);
  await performEdits(tg.deps, r.edits);
  expect(first(tg.sends.at(-1)!.view)).toBe("מפת הסקילים · פריט 2 מתוך 3");
  expect(tg.edits).toContainEqual({ chatId: 42, messageId: 1000, view: MOVED });
  const stored = loadStore(dir).requests[0];
  expect(stored.messageId).toBe(1002);
  expect(stored.shown).toBe(JSON.stringify(viewOf(stored)));
  // the old message's buttons no longer act; the new message's do, and edit in place again
  expect(tapIn(dir, "rc:q1:2:a", 1000).toast).toBe("כבר טופל");
  const sendsBefore = tg.sends.length;
  await performEdits(tg.deps, tapIn(dir, "rc:q1:2:a", 1002).edits);
  expect(tg.sends.length).toBe(sendsBefore);
  expect(tg.edits.at(-1)).toMatchObject({ messageId: 1002 });
  expect(first(tg.edits.at(-1)!.view)).toBe("מפת הסקילים · פריט 3 מתוך 3");
});

test("\"back\" before he wrote anything keeps the card where it is", async () => {
  const dir = scratch();
  const tg = fakeTelegram(dir);
  mutateStore(dir, (s) => applySync(s, payload({ requests: [req("map-1")] }), NOW));
  await runRchannelTick(tg.deps);
  await performEdits(tg.deps, tapIn(dir, "rc:q1:1:o", 1000).edits);
  await performEdits(tg.deps, tapIn(dir, "rc:q1:1:back", 1000).edits);
  expect(tg.sends.length).toBe(1);
  expect(tg.edits.at(-1)).toMatchObject({ messageId: 1000 });
  expect(tg.edits.at(-1)!.view.keyboard![0][0]).toEqual({ text: "✓ מאשר", callback_data: "rc:q1:1:a" });
});

test("a window that lapsed after he wrote brings the card down on the tick, once", async () => {
  const dir = scratch();
  const tg = fakeTelegram(dir);
  await afterHeWrote(dir, tg);
  const later = { ...tg.deps, now: () => new Date((NOW + 5 + 601) * 1000) };
  await runRchannelTick(later);
  expect(first(tg.sends.at(-1)!.view)).toBe("מפת הסקילים · פריט 1 מתוך 3");
  expect(tg.sends.at(-1)!.view.keyboard![0][0]).toEqual({ text: "✓ מאשר", callback_data: "rc:q1:1:a" });
  expect(tg.edits.at(-1)).toEqual({ chatId: 42, messageId: 1000, view: MOVED });
  const sends = tg.sends.length;
  await runRchannelTick(later);
  expect(tg.sends.length).toBe(sends); // moved once; nothing more to do
});

test("✗ on the proposal brings the card down with its prompt, so he sees where to write", async () => {
  const dir = scratch();
  const tg = fakeTelegram(dir);
  await afterHeWrote(dir, tg);
  mutateStore(dir, (s) => registerProposal(s, { short: "q1", card: 1, text: "תיאור קצר.", chatId: 42, turnId: "t1" }, NOW + 10));
  await sendRcProposals(tg.deps, 42, "t1");
  // the window is still open, so ✗ only keeps it; nothing on the card changes and nothing moves
  await performEdits(tg.deps, tapIn(dir, "rc:q1:1:no", 1001, NOW + 20).edits);
  expect(tg.sends.length).toBe(2);
  // after the window lapsed, ✗ opens it again: the card and its prompt come down
  mutateStore(dir, (s) => registerProposal(s, { short: "q1", card: 1, text: "תיאור אחר.", chatId: 42, turnId: "t2" }, NOW + 30));
  await sendRcProposals(tg.deps, 42, "t2"); // message 1002
  await runRchannelTick({ ...tg.deps, now: () => new Date((NOW + 700) * 1000) }); // lapsed: the card comes down as 1003
  await performEdits(tg.deps, tapIn(dir, "rc:q1:1:no", 1002, NOW + 710).edits);
  const stored = loadStore(dir).requests[0];
  expect(stored.mode).toBe("other");
  expect(tg.edits.at(-1)).toMatchObject({ messageId: stored.messageId! });
  expect(tg.edits.at(-1)!.view.keyboard).toEqual([[{ text: "חזרה לכרטיס", callback_data: "rc:q1:1:back" }]]);
});

test("a failed send leaves the old message alone and is tried again on the next tick", async () => {
  const dir = scratch();
  const tg = fakeTelegram(dir);
  await afterHeWrote(dir, tg);
  mutateStore(dir, (s) => registerProposal(s, { short: "q1", card: 1, text: "תיאור קצר.", chatId: 42, turnId: "t1" }, NOW + 10));
  await sendRcProposals(tg.deps, 42, "t1");
  tg.failSend(2);
  const editsBefore = tg.edits.length;
  await performEdits(tg.deps, tapIn(dir, "rc:q1:1:ok", 1001, NOW + 20).edits);
  expect(tg.edits.slice(editsBefore).some((e) => e.messageId === 1000)).toBe(false);
  expect(loadStore(dir).requests[0].messageId).toBe(1000);
  await runRchannelTick(tg.deps); // fails again: the same view is logged once
  expect(tg.logs.filter((l) => l.includes("move of map-1 to the bottom failed")).length).toBe(1);
  await runRchannelTick(tg.deps);
  expect(first(tg.sends.at(-1)!.view)).toBe("מפת הסקילים · פריט 2 מתוך 3");
  expect(tg.edits.at(-1)).toEqual({ chatId: 42, messageId: 1000, view: MOVED });
});

test("an old message that cannot be edited any more does not stop the move", async () => {
  const dir = scratch();
  const tg = fakeTelegram(dir);
  await afterHeWrote(dir, tg);
  const lapsed = { ...tg.deps, now: () => new Date((NOW + 700) * 1000) };
  tg.goneEdit(1);
  await runRchannelTick(lapsed);
  expect(loadStore(dir).requests[0].messageId).toBe(1001);
  expect(tg.logs.some((l) => l.includes("message 1000 of map-1"))).toBe(true);
});

test("a superseded request is edited where it is, even after he wrote about it", async () => {
  const dir = scratch();
  const tg = fakeTelegram(dir);
  await afterHeWrote(dir, tg);
  mutateStore(dir, (s) => applySync(s, payload({ requests: [req("map-2")] }), NOW + 10));
  await runRchannelTick({ ...tg.deps, now: () => new Date((NOW + 10) * 1000) });
  expect(tg.sends.map((x) => first(x.view))).toEqual(["מפת הסקילים · פריט 1 מתוך 3", "מפת הסקילים · פריט 1 מתוך 3"]);
  expect(tg.edits.at(-1)).toEqual({ chatId: 42, messageId: 1000, view: { text: "מפת הסקילים: הוחלף בעדכון של 4/10.", keyboard: null } });
});

test("a proposal whose card stopped waiting loses its buttons on the next tick", async () => {
  const dir = scratch();
  const tg = fakeTelegram(dir);
  await afterHeWrote(dir, tg);
  mutateStore(dir, (s) => registerProposal(s, { short: "q1", card: 1, text: "תיאור קצר.", chatId: 42, turnId: "t1" }, NOW + 10));
  await sendRcProposals(tg.deps, 42, "t1"); // message 1001
  // the card is handled on the PC meanwhile
  mutateStore(dir, (s) => applySync(s, payload({ closes: [{ request: "map-1", card: "k1" }] }), NOW + 20));
  await runRchannelTick({ ...tg.deps, now: () => new Date((NOW + 30) * 1000) });
  expect(tg.edits).toContainEqual({ chatId: 42, messageId: 1001, view: { text: "כבר טופל\nitem-k1", keyboard: null } });
  expect(loadStore(dir).proposals[0].status).toBe("cancelled");
  // a proposal still waiting for its open card keeps its buttons
  mutateStore(dir, (s) => registerProposal(s, { short: "q1", card: 2, text: "תיאור קצר.", chatId: 42, turnId: "t2" }, NOW + 40));
  await sendRcProposals(tg.deps, 42, "t2");
  const edits = tg.edits.length;
  await runRchannelTick({ ...tg.deps, now: () => new Date((NOW + 50) * 1000) });
  expect(tg.edits.slice(edits).some((e) => e.view.text.startsWith("כבר טופל"))).toBe(false);
  expect(loadStore(dir).proposals[1].status).toBe("sent");
});

test("the poller's tap path can send, so a card can come down right after a tap", () => {
  const src = readFileSync(join(import.meta.dir, "poller.ts"), "utf8");
  const handler = src.slice(src.indexOf("async function handleRcCallback"), src.indexOf("async function sendRcProposalsAfter"));
  expect(handler).toContain("performEdits({ dir: rchannelDir(), send: rcSend, edit: rcEdit, log: rcLog }, r.edits)");
});
