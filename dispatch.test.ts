import { test, expect } from "bun:test";
import { isStopCommand, classifyUpdate, ChatQueues, SerialChain, Debouncer } from "./dispatch";

test("classifyUpdate triages callback > stop > message > ignore", () => {
  expect(classifyUpdate({ update_id: 1, callback_query: {} }, "bot")).toBe("callback");
  expect(classifyUpdate({ update_id: 2, message: { chat: { id: 5 }, text: "/stop" } }, "bot")).toBe("stop");
  expect(classifyUpdate({ update_id: 3, message: { chat: { id: 5 }, text: "/stop@MyBot" } }, "mybot")).toBe("stop");
  expect(classifyUpdate({ update_id: 4, message: { chat: { id: 5 }, text: "hello /stop" } }, "bot")).toBe("message");
  // voice/photo messages have no text — they are messages, not stops
  expect(classifyUpdate({ update_id: 5, message: { chat: { id: 5 } } }, "bot")).toBe("message");
  // update kinds we don't handle (edited_message etc.) are ignored
  expect(classifyUpdate({ update_id: 6 }, "bot")).toBe("ignore");
});

test("isStopCommand exact-match semantics survive the move", () => {
  expect(isStopCommand("/stop", "maores_assistant_bot")).toBe(true);
  expect(isStopCommand("/STOP", "")).toBe(true);
  expect(isStopCommand("/stop@maores_assistant_bot", "maores_assistant_bot")).toBe(true);
  expect(isStopCommand("/stop@otherbot", "maores_assistant_bot")).toBe(false);
  expect(isStopCommand("/stopwatch", "x")).toBe(false);
  expect(isStopCommand("please /stop", "x")).toBe(false);
});

// test helpers: a manually-opened gate + a microtask/timer flush
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { open, p };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("ChatQueues runs jobs of one chat strictly in order", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g1 = gate();
  q.enqueue(7, async () => { await g1.p; ran.push("a"); });
  q.enqueue(7, async () => { ran.push("b"); });
  await tick();
  expect(ran).toEqual([]); // b must wait for a
  g1.open();
  await tick(); await tick();
  expect(ran).toEqual(["a", "b"]);
});

test("ChatQueues isolates chats from each other", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g = gate();
  q.enqueue(1, async () => { await g.p; ran.push("slow-chat1"); });
  q.enqueue(2, async () => { ran.push("fast-chat2"); });
  await tick();
  expect(ran).toEqual(["fast-chat2"]); // chat 2 never waited on chat 1
  g.open();
  await tick();
});

test("a throwing job does not break its chat's chain", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  q.enqueue(3, async () => { throw new Error("boom"); });
  q.enqueue(3, async () => { ran.push("after-boom"); });
  await tick(); await tick();
  expect(ran).toEqual(["after-boom"]);
});

test("drop() skips queued-but-unstarted jobs, not the running one; queue stays usable", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g = gate();
  q.enqueue(9, async () => { await g.p; ran.push("running"); });
  q.enqueue(9, async () => { ran.push("queued-1"); });
  q.enqueue(9, async () => { ran.push("queued-2"); });
  await tick();
  expect(q.pending(9)).toBe(2);
  expect(q.drop(9)).toBe(2);
  g.open();
  await tick(); await tick(); await tick();
  expect(ran).toEqual(["running"]); // queued-1/2 were dropped
  q.enqueue(9, async () => { ran.push("post-drop"); });
  await tick(); await tick();
  expect(ran).toEqual(["running", "post-drop"]);
  await tick();
  expect(q.pending(9)).toBe(0); // counter is cleared by drop and never goes negative
});

test("a second drop() before the chain drains reports 0, not the same jobs again", async () => {
  const q = new ChatQueues();
  const g = gate();
  q.enqueue(4, async () => { await g.p; });
  q.enqueue(4, async () => {});
  q.enqueue(4, async () => {});
  await tick();
  expect(q.drop(4)).toBe(2);
  expect(q.drop(4)).toBe(0); // rapid double-/stop must not double-count
  g.open();
  await tick(); await tick();
  expect(q.pending(4)).toBe(0);
});

test("SerialChain runs jobs one at a time, surviving errors", async () => {
  const c = new SerialChain();
  const ran: string[] = [];
  const g = gate();
  c.enqueue(async () => { await g.p; ran.push("first"); });
  c.enqueue(async () => { throw new Error("mid"); });
  c.enqueue(async () => { ran.push("third"); });
  await tick();
  expect(ran).toEqual([]);
  g.open();
  await tick(); await tick(); await tick();
  expect(ran).toEqual(["first", "third"]);
});

test("ChatQueues.idle resolves only after all queued jobs finish", async () => {
  const q = new ChatQueues();
  const ran: string[] = [];
  const g = gate();
  q.enqueue(1, async () => { await g.p; ran.push("a"); });
  q.enqueue(2, async () => { ran.push("b"); });
  let idle = false;
  void q.idle().then(() => { idle = true; });
  await tick();
  expect(idle).toBe(false); // chat 1 still gated
  g.open();
  await tick(); await tick();
  expect(idle).toBe(true);
  expect(ran.sort()).toEqual(["a", "b"]);
});

test("SerialChain.idle resolves after the tail job", async () => {
  const c = new SerialChain();
  const g = gate();
  let idle = false;
  c.enqueue(async () => { await g.p; });
  void c.idle().then(() => { idle = true; });
  await tick();
  expect(idle).toBe(false);
  g.open();
  await tick(); await tick();
  expect(idle).toBe(true);
});

// --- Debouncer (message-burst batching) --------------------------------------
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("Debouncer flushes a single message after the quiet period", async () => {
  const flushes: Array<[number, string[]]> = [];
  const d = new Debouncer<string>(30, (chat, items) => flushes.push([chat, items]));
  d.schedule(1, "a");
  expect(d.pending(1)).toBe(1);
  expect(flushes).toEqual([]); // not before the window closes
  await sleep(80);
  expect(flushes).toEqual([[1, ["a"]]]);
  expect(d.pending(1)).toBe(0);
});

test("Debouncer batches a burst into one flush, in arrival order", async () => {
  const flushes: string[][] = [];
  const d = new Debouncer<string>(30, (_c, items) => flushes.push(items));
  d.schedule(1, "a");
  d.schedule(1, "b");
  d.schedule(1, "c");
  await sleep(80);
  expect(flushes).toEqual([["a", "b", "c"]]);
});

test("Debouncer restarts the window on every arrival", async () => {
  const flushes: string[][] = [];
  const d = new Debouncer<string>(60, (_c, items) => flushes.push(items));
  d.schedule(1, "a");
  await sleep(30); // inside the window
  d.schedule(1, "b"); // resets the timer
  await sleep(30); // 60ms since "a" — would have flushed without the reset
  expect(flushes).toEqual([]);
  await sleep(80);
  expect(flushes).toEqual([["a", "b"]]);
});

test("Debouncer keeps chats independent", async () => {
  const flushes: Array<[number, string[]]> = [];
  const d = new Debouncer<string>(30, (chat, items) => flushes.push([chat, items]));
  d.schedule(1, "a1");
  d.schedule(2, "b1");
  d.schedule(1, "a2");
  await sleep(80);
  expect(flushes.sort((x, y) => x[0] - y[0])).toEqual([
    [1, ["a1", "a2"]],
    [2, ["b1"]],
  ]);
});

test("Debouncer clear() drops the buffer without flushing (the /stop path)", async () => {
  const flushes: string[][] = [];
  const d = new Debouncer<string>(30, (_c, items) => flushes.push(items));
  d.schedule(1, "a");
  d.schedule(1, "b");
  expect(d.clear(1)).toBe(2);
  expect(d.pending(1)).toBe(0);
  await sleep(80);
  expect(flushes).toEqual([]); // nothing resurrects after the window
  expect(d.clear(1)).toBe(0); // idempotent on an empty chat
});

test("Debouncer flushNow() dispatches immediately and cancels the timer", async () => {
  const flushes: string[][] = [];
  const d = new Debouncer<string>(1000, (_c, items) => flushes.push(items)); // window outlives the test
  d.schedule(1, "a");
  d.flushNow(1);
  expect(flushes).toEqual([["a"]]);
  await sleep(40);
  expect(flushes).toEqual([["a"]]); // no second flush when the old timer would have fired
  d.flushNow(2); // chat with nothing buffered: no-op
  expect(flushes).toEqual([["a"]]);
});

test("Debouncer flushAll() drains every chat at shutdown", () => {
  const flushes: Array<[number, string[]]> = [];
  const d = new Debouncer<string>(1000, (chat, items) => flushes.push([chat, items]));
  d.schedule(1, "a");
  d.schedule(2, "b");
  d.flushAll();
  expect(flushes.sort((x, y) => x[0] - y[0])).toEqual([
    [1, ["a"]],
    [2, ["b"]],
  ]);
  expect(d.pending(1)).toBe(0);
  expect(d.pending(2)).toBe(0);
});

test("a throwing onFlush does not break the debouncer", async () => {
  const flushes: string[][] = [];
  let first = true;
  const d = new Debouncer<string>(30, (_c, items) => {
    if (first) {
      first = false;
      throw new Error("boom");
    }
    flushes.push(items);
  });
  d.schedule(1, "a");
  await sleep(80); // first flush throws and is swallowed
  d.schedule(1, "b");
  await sleep(80);
  expect(flushes).toEqual([["b"]]);
});
