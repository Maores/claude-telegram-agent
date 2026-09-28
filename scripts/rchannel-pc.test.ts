import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RcRequest } from "../rchannel-schema";
import {
  REMOTE_CMD,
  at,
  readUpTo,
  safeStderr,
  sshArgs,
  channelHome,
  loadConfig,
  loadHandlers,
  loadState,
  openReport,
  parseFlags,
  parseHandlerOutput,
  runAnswer,
  runHandlerProcess,
  runSync,
  safeDetail,
  saveState,
  scanOutbox,
  takeLock,
  writeNotice,
  type RunHandler,
  type SshCall,
  type WorkItem,
} from "./rchannel-pc";

// All fixtures are synthetic: invented items, a documentation host name, a fake key path.

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function home(handlers: object = { map: { argv: ["handler"], timeout_s: 60 } }): string {
  const h = mkdtempSync(join(tmpdir(), "rchannel-pc-"));
  made.push(h);
  writeFileSync(join(h, "config.json"), JSON.stringify({ target: "bot@example.org", key: "K" }));
  writeFileSync(join(h, "handlers.json"), JSON.stringify(handlers));
  return h;
}
const card = (key: string) => ({ key, heading: `item-${key}`, body: `תיאור של ${key}.` });
const req = (id: string, extra: Partial<RcRequest> = {}): RcRequest => ({ v: 1, id, routine: "map", title: "מפת הסקילים", kind: "cards", text: "", supersedes: true, cards: [card("k1"), card("k2")], ...extra });
function drop(h: string, r: object, name = `${(r as any).id}.json`) {
  mkdirSync(at(h).outbox, { recursive: true });
  writeFileSync(join(at(h).outbox, name), JSON.stringify(r));
}
const NOW = new Date("2026-10-04T07:00:00Z");

/** A fake server: every payload is recorded; each call takes the next scripted reply, or by
 *  default takes every request and returns no answers. */
function fakeServer() {
  const calls: any[] = [];
  const replies: (((p: any) => object) | Error)[] = [];
  const ssh: SshCall = async (_cfg, payload) => {
    const p = JSON.parse(payload);
    calls.push(p);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return JSON.stringify(next ? next(p) : { v: 1, received: p.requests.map((r: RcRequest) => r.id), answers: [] });
  };
  return { ssh, calls, then: (r: ((p: any) => object) | Error) => replies.push(r) };
}
const takeAll = (answers: object[]) => (p: any) => ({ v: 1, received: p.requests.map((r: RcRequest) => r.id), answers });

/** A fake handler: records each work file, answers every item with `outcome` and exits `code`. */
function fakeHandler(code: number | null = 0, outcome = "approved", detail?: string) {
  const runs: WorkItem[][] = [];
  const run: RunHandler = async (_h, file) => {
    const items: WorkItem[] = JSON.parse(readFileSync(file, "utf8"));
    runs.push(items);
    return { code, out: ["backup C:\\somewhere\\data.json.bak", ...items.map((i) => JSON.stringify({ id: i.id, card: i.card, outcome, ...(detail ? { detail } : {}) }))].join("\n") };
  };
  return { run, runs };
}
function deps(h: string, ssh: SshCall, runHandler: RunHandler) {
  const logs: string[] = [];
  return { d: { home: h, now: () => NOW, ssh, runHandler, log: (m: string) => logs.push(m) }, logs };
}
const answer = (id: string, card: string, verdict = "approve", text?: string) => ({ id, request: "map-1", card, verdict, ...(text ? { text } : {}) });

// --- settings -------------------------------------------------------------------------

test("the home folder sits under the profile's .claude (never redirected), and settings are checked", () => {
  expect(channelHome({ USERPROFILE: "C:\\Users\\someone" })).toBe(join("C:\\Users\\someone", ".claude", "tools", "routine-channel"));
  expect(channelHome({ RCHANNEL_HOME: "X" })).toBe("X");
  expect(REMOTE_CMD).toBe("cd $HOME/claude-bot && $HOME/.bun/bin/bun run rchannel.ts sync");
  expect(REMOTE_CMD.includes('"') || REMOTE_CMD.includes("'")).toBe(false); // it crosses Windows' quoting on its way to ssh
  const h = home();
  expect(loadConfig(h)).toEqual({ target: "bot@example.org", key: "K" });
  writeFileSync(join(h, "config.json"), String.fromCharCode(0xfeff) + JSON.stringify({ target: "<user>@<YOUR_SERVER_IP>", key: "K" }));
  expect(loadConfig(h)).toEqual({ error: "config.json: target must be user@host (the committed placeholder is refused)" });
  expect(loadHandlers(h)).toEqual({ map: { argv: ["handler"], timeout_s: 60 } });
  writeFileSync(join(h, "handlers.json"), JSON.stringify({ map: { argv: "python x.py", timeout_s: 60 } }));
  expect(loadHandlers(h)).toEqual({ error: "handlers.json: map needs argv (a list of text) and timeout_s 1..150" });
  writeFileSync(join(h, "handlers.json"), JSON.stringify({ map: { argv: ["x"], timeout_s: 151 } })); // would not fit the task's 5 minutes
  expect(loadHandlers(h)).toMatchObject({ error: expect.stringContaining("timeout_s 1..150") });
});

// --- outbox, notices --------------------------------------------------------------------

test("notice writes a checked request to the outbox, and refuses what the schema refuses", () => {
  const h = home();
  const r = writeNotice(h, { routine: "audit", title: "תזכורת חודשית", text: "הגיע הזמן לבדיקה. האחרונה: 22/9." }, NOW);
  expect("id" in r && r.id).toMatch(/^audit-202610041000-\d{4}$/);
  const scan = scanOutbox(h, {});
  expect(scan.valid.map((v) => v.request)).toEqual([{ v: 1, id: (r as any).id, routine: "audit", title: "תזכורת חודשית", kind: "notice", text: "הגיע הזמן לבדיקה. האחרונה: 22/9.", supersedes: false, cards: [] }]);
  expect(writeNotice(h, { routine: "Audit!", title: "x", text: "y" }, NOW)).toMatchObject({ error: expect.stringContaining("routine must be") });
  expect(writeNotice(h, { routine: "audit", title: "x", text: "" }, NOW)).toMatchObject({ error: expect.stringContaining("text is empty") });
});

test("scanOutbox refuses bad files and cards for a routine with no handler", () => {
  const h = home();
  drop(h, req("map-1"));
  drop(h, req("other-1", { routine: "other" }));
  drop(h, { v: 1, id: "BAD" }, "bad.json");
  mkdirSync(at(h).outbox, { recursive: true });
  writeFileSync(join(at(h).outbox, "broken.json"), "{");
  writeFileSync(join(at(h).outbox, "notes.txt"), "not a request");
  const scan = scanOutbox(h, loadHandlers(h) as any);
  expect(scan.valid.map((v) => v.request.id)).toEqual(["map-1"]);
  expect(scan.rejected.map((r) => [r.file.split(/[\\/]/).pop(), r.reason])).toEqual([
    ["bad.json", "id must be 1 to 60 of a-z, 0-9 and -"],
    ["broken.json", "not JSON"],
    ["other-1.json", "no handler is registered for routine other"],
  ]);
});

// --- sync ---------------------------------------------------------------------------

test("sync hands the outbox to the server, files what it took, and marks the exchange", async () => {
  const h = home();
  drop(h, req("map-1"));
  drop(h, { v: 1, id: "BAD" }, "bad.json");
  const srv = fakeServer();
  const { d, logs } = deps(h, srv.ssh, fakeHandler().run);
  expect(await runSync(d)).toBe(0);
  expect(srv.calls).toEqual([{ v: 1, requests: [req("map-1")], acks: [], results: [], closes: [] }]);
  expect(readdirSync(at(h).outbox).filter((f) => f.endsWith(".json"))).toEqual([]);
  expect(readdirSync(at(h).sent)).toEqual(["map-1.json"]);
  expect(readdirSync(at(h).rejected)).toEqual(["bad.json"]);
  expect(loadState(h).requests.map((r) => [r.id, r.sentAt])).toEqual([["map-1", Math.floor(NOW.getTime() / 1000)]]);
  expect(existsSync(at(h).ok)).toBe(true);
  expect(logs).toEqual(["rejected bad.json: id must be 1 to 60 of a-z, 0-9 and -", "sent map-1"]);
  // nothing new: one quiet call, no log line
  expect(await runSync(d)).toBe(0);
  expect(srv.calls.length).toBe(2);
  expect(logs.length).toBe(2);
});

test("answers run the registered handler once, with what the owner saw, and a second call reports them", async () => {
  const h = home();
  drop(h, req("map-1"));
  const srv = fakeServer();
  const hd = fakeHandler(0, "approved");
  const { d, logs } = deps(h, srv.ssh, hd.run);
  await runSync(d);
  srv.then(takeAll([answer("s1-1", "k1"), answer("s1-2", "k2", "correct", "תיאור חדש.")]));
  expect(await runSync(d)).toBe(0);
  expect(hd.runs).toEqual([[
    { id: "s1-1", card: "k1", verdict: "approve", shown: "תיאור של k1." },
    { id: "s1-2", card: "k2", verdict: "correct", text: "תיאור חדש.", shown: "תיאור של k2." },
  ]]);
  expect(srv.calls[2]).toEqual({ v: 1, requests: [], acks: ["s1-1", "s1-2"], results: [
    { request: "map-1", card: "k1", outcome: "approved" },
    { request: "map-1", card: "k2", outcome: "approved" },
  ], closes: [] });
  const s = loadState(h);
  expect(s.queue).toEqual({ acks: [], results: [], closes: [] });
  expect(Object.keys(s.ledger)).toEqual(["s1-1", "s1-2"]);
  expect(s.requests[0].cards.every((c) => c.handled)).toBe(true);
  expect(logs.at(-1)).toBe("answers: 2 approved");
});

test("an answer already carried out is acked again but never run twice", async () => {
  const h = home();
  drop(h, req("map-1"));
  const srv = fakeServer();
  const hd = fakeHandler();
  const { d } = deps(h, srv.ssh, hd.run);
  await runSync(d);
  srv.then(takeAll([answer("s1-1", "k1")]));
  srv.then(new Error("ssh exited 255: Connection timed out")); // the report is lost
  await runSync(d);
  expect(loadState(h).queue.acks).toEqual(["s1-1"]);
  srv.then(new Error("ssh exited 255: Connection timed out")); // and the next cycle cannot connect
  expect(await runSync(d)).toBe(1);
  expect(loadState(h).queue.acks).toEqual(["s1-1"]); // still queued: nothing was delivered
  await runSync(d);
  expect(srv.calls.at(-1).acks).toEqual(["s1-1"]); // delivered with the next cycle's first call
  expect(loadState(h).queue.acks).toEqual([]);
  // the server lost that ack and offers the answer once more: acked again, not run again
  srv.then(takeAll([answer("s1-1", "k1")]));
  await runSync(d);
  expect(hd.runs.length).toBe(1);
  expect(srv.calls.at(-1)).toMatchObject({ requests: [], acks: ["s1-1"], results: [] });
  expect(loadState(h).queue.acks).toEqual([]);
});

test("a busy handler leaves the answers for the next cycle; a crash or a missing line reads as failed", async () => {
  const h = home();
  drop(h, req("map-1"));
  const srv = fakeServer();
  let hd = fakeHandler(3);
  const box = { run: hd.run };
  const { d, logs } = deps(h, srv.ssh, (x, f) => box.run(x, f));
  await runSync(d);
  srv.then(takeAll([answer("s1-1", "k1")]));
  await runSync(d);
  expect(loadState(h).ledger).toEqual({});
  expect(srv.calls.length).toBe(2); // nothing to report, so no second call
  expect(logs.at(-1)).toBe("1 answer(s) wait: the handler was busy");
  hd = fakeHandler(1);
  box.run = hd.run;
  srv.then(takeAll([answer("s1-1", "k1")]));
  await runSync(d);
  expect(srv.calls.at(-1).results).toEqual([{ request: "map-1", card: "k1", outcome: "failed", detail: "התוכנית המטפלת נכשלה" }]);
  box.run = async () => ({ code: 0, out: "nothing useful" });
  srv.then(takeAll([answer("s1-2", "k2")]));
  await runSync(d);
  expect(srv.calls.at(-1).results).toEqual([{ request: "map-1", card: "k2", outcome: "failed", detail: "התוכנית המטפלת לא ענתה על הכרטיס" }]);
});

test("an answer for a card the PC never sent reaches no handler, and an oversized reply is refused", async () => {
  const h = home();
  drop(h, req("map-1"));
  const srv = fakeServer();
  const hd = fakeHandler();
  const { d, logs } = deps(h, srv.ssh, hd.run);
  await runSync(d);
  srv.then(takeAll([answer("s1-1", "k9"), answer("s1-2", "k1")])); // k9 is in no card the PC sent
  await runSync(d);
  expect(hd.runs).toEqual([[{ id: "s1-2", card: "k1", verdict: "approve", shown: "תיאור של k1." }]]);
  expect(srv.calls.at(-1).results[0]).toEqual({ request: "map-1", card: "k9", outcome: "failed", detail: "הכרטיס הזה לא נשלח מהמחשב" });
  const huge: SshCall = async () => JSON.stringify({ v: 1, received: [], answers: [], pad: "x".repeat(1_000_001) });
  expect(await runSync({ ...d, ssh: huge })).toBe(1);
  expect(logs.at(-1)).toBe("FAILED: the server's reply is over 1 MB");
});

test("answers for an unknown request or a routine with no handler fail without running anything", async () => {
  const h = home({});
  const srv = fakeServer();
  const hd = fakeHandler();
  const { d } = deps(h, srv.ssh, hd.run);
  const s = loadState(h);
  s.requests.push({ id: "map-1", routine: "map", title: "t", kind: "cards", supersedes: true, cards: [{ ...card("k1"), handled: false }], sentAt: 1, superseded: false, recordedAt: Math.floor(NOW.getTime() / 1000) });
  writeFileSync(at(h).state, JSON.stringify(s));
  srv.then(takeAll([answer("s1-1", "k1"), { id: "s1-2", request: "gone-1", card: "k1", verdict: "approve" }]));
  await runSync(d);
  expect(hd.runs).toEqual([]);
  expect(srv.calls.at(-1).results).toEqual([
    { request: "gone-1", card: "k1", outcome: "failed", detail: "אין רישום של הבקשה במחשב" },
    { request: "map-1", card: "k1", outcome: "failed", detail: "אין תוכנית מטפלת לרוטינה" },
  ]);
});

test("a failed call keeps the outbox and the queue, and writes no success marker", async () => {
  const h = home();
  drop(h, req("map-1"));
  const srv = fakeServer();
  srv.then(new Error("ssh exited 255: Connection refused"));
  const { d, logs } = deps(h, srv.ssh, fakeHandler().run);
  expect(await runSync(d)).toBe(1);
  expect(logs).toEqual(["FAILED: ssh exited 255: Connection refused"]);
  expect(readdirSync(at(h).outbox)).toContain("map-1.json");
  expect(existsSync(at(h).ok)).toBe(false);
  srv.then(() => ({ v: 1, received: "all", answers: [] }));
  expect(await runSync(d)).toBe(1);
  expect(logs.at(-1)).toBe("FAILED: the server's reply was refused: received must be a list of request ids");
  srv.then(() => ({ v: 1, received: [], answers: [{ id: "x-1", request: "map-1", card: "k1", verdict: "delete" }] }));
  expect(await runSync(d)).toBe(1);
  expect(logs.at(-1)).toContain("bad verdict");
});

test("the lock keeps a second run out, and a lock left by a dead run is taken after 10 minutes", async () => {
  const h = home();
  const release = takeLock(h)!;
  expect(takeLock(h)).toBeNull();
  const srv = fakeServer();
  const { d, logs } = deps(h, srv.ssh, fakeHandler().run);
  expect(await runSync(d)).toBe(0);
  expect(srv.calls).toEqual([]);
  expect(logs).toEqual([]);
  release();
  writeFileSync(at(h).lock, "4242");
  const old = new Date(Date.now() - 11 * 60_000);
  utimesSync(at(h).lock, old, old);
  expect(await runSync({ ...d, now: () => new Date() })).toBe(0);
  expect(srv.calls.length).toBe(1);
  expect(existsSync(at(h).lock)).toBe(false);
});

test("a newer request of the same routine retires the older one on the PC too", async () => {
  const h = home();
  const srv = fakeServer();
  const { d } = deps(h, srv.ssh, fakeHandler().run);
  drop(h, req("map-1"));
  await runSync(d);
  drop(h, req("map-2"));
  await runSync(d);
  expect(loadState(h).requests.map((r) => [r.id, r.superseded])).toEqual([["map-1", true], ["map-2", false]]);
  expect(openReport(h, loadHandlers(h) as any)).toBe(
    ["request map-2 (מפת הסקילים), handed to the server: 2 of 2 waiting", "  1. item-k1", "     תיאור של k1.", "  2. item-k2", "     תיאור של k2."].join("\n"),
  );
});

// --- open and answer --------------------------------------------------------------------

test("open lists what waits, including a request not on the phone yet", async () => {
  const h = home();
  expect(openReport(h, {})).toBe("nothing is waiting");
  drop(h, req("map-1", { cards: [{ ...card("k1"), note: "לא נבדק" }] }));
  expect(openReport(h, loadHandlers(h) as any)).toBe(["request map-1 (מפת הסקילים), not on the phone yet: 1 of 1 waiting", "  1. item-k1 [לא נבדק]", "     תיאור של k1."].join("\n"));
});

function answerDeps(h: string, run: RunHandler, waitMs = 0) {
  const printed: string[] = [];
  return { d: { home: h, now: () => NOW, runHandler: run, print: (x: string) => printed.push(x), sleep: async () => {}, waitMs }, printed };
}

test("answer runs the handler at once, queues a close for the phone, and says what happened", async () => {
  const h = home();
  const srv = fakeServer();
  drop(h, req("map-1", { cards: [card("k1"), card("k2"), card("k3")] }));
  await runSync(deps(h, srv.ssh, fakeHandler().run).d);
  const hd = fakeHandler(0, "approved");
  const { d, printed } = answerDeps(h, hd.run);
  expect(await runAnswer(d, { request: "map-1", card: 2, verdict: "approve" })).toBe(0);
  expect(hd.runs[0]).toEqual([{ id: "local-20261004100000-1", card: "k2", verdict: "approve", shown: "תיאור של k2." }]);
  expect(printed).toEqual(["card 2 (item-k2): approved"]);
  expect(await runAnswer(d, { request: "map-1", all: true, verdict: "reject" })).toBe(0);
  expect(hd.runs[1].map((i) => i.card)).toEqual(["k1", "k3"]);
  const s = loadState(h);
  expect(s.queue.closes).toEqual([{ request: "map-1", card: "k2" }, { request: "map-1", card: "k1" }, { request: "map-1", card: "k3" }]);
  expect(await runAnswer(d, { request: "map-1", card: 2, verdict: "approve" })).toBe(0);
  expect(printed.at(-1)).toBe("card 2 was already handled (approved)");
  await runSync(deps(h, srv.ssh, fakeHandler().run).d);
  expect(srv.calls.at(-1).closes.length).toBe(3); // the next sync tells the phone
});

test("a correction reads its text from a file in the work folder, deleted only once the handler answered", async () => {
  const h = home();
  drop(h, req("map-1"));
  const { d, printed } = answerDeps(h, fakeHandler(0, "corrected").run);
  expect(await runAnswer(d, { request: "map-1", card: 1, verdict: "correct" })).toBe(2);
  expect(printed.at(-1)).toBe("refused: a correction is for one card and needs --text-file");
  // a file anywhere else is refused and left alone
  const elsewhere = join(h, "notes.json");
  writeFileSync(elsewhere, "{}");
  expect(await runAnswer(d, { request: "map-1", card: 1, verdict: "correct", textFile: elsewhere })).toBe(2);
  expect(printed.at(-1)).toContain("the text file must be in");
  expect(existsSync(elsewhere)).toBe(true);
  // a busy handler keeps the file for the retry
  mkdirSync(at(h).work, { recursive: true });
  const tf = join(at(h).work, "correction.txt");
  writeFileSync(tf, String.fromCharCode(0xfeff) + "תיאור חדש\nבשתי שורות.");
  const busy = answerDeps(h, fakeHandler(3).run);
  expect(await runAnswer(busy.d, { request: "map-1", card: 1, verdict: "correct", textFile: tf })).toBe(3);
  expect(existsSync(tf)).toBe(true);
  const hd = fakeHandler(0, "corrected");
  const ok = answerDeps(h, hd.run);
  expect(await runAnswer(ok.d, { request: "map-1", card: 1, verdict: "correct", textFile: tf })).toBe(0);
  expect(hd.runs[0][0]).toMatchObject({ verdict: "correct", text: "תיאור חדש בשתי שורות." });
  expect(existsSync(tf)).toBe(false);
  expect(loadState(h).requests[0].sentAt).toBeNull(); // answered here before any sync carried it
});

test("state is saved before any file moves or handler runs, and the save waits out a reader", async () => {
  const h = home();
  drop(h, req("map-1"));
  const srv = fakeServer();
  srv.then(takeAll([]));
  await runSync(deps(h, srv.ssh, fakeHandler().run).d);
  drop(h, req("map-2"));
  let seen: string[] = [];
  const peek: RunHandler = async (hh, file) => {
    seen = loadState(h).requests.map((r) => r.id); // what a run killed right here would leave
    return fakeHandler().run(hh, file);
  };
  srv.then(takeAll([answer("s1-1", "k1")]));
  await runSync(deps(h, srv.ssh, peek).d);
  expect(seen).toEqual(["map-1", "map-2"]);
  // another process holds state.json open for a moment: the rename waits instead of failing
  const holder = join(h, "hold.ts");
  const marker = join(h, "held");
  writeFileSync(holder, 'import { openSync, closeSync, writeFileSync } from "node:fs"; const fd = openSync(process.argv[2], "r"); writeFileSync(process.argv[3], "x"); await Bun.sleep(700); closeSync(fd);');
  const child = Bun.spawn([process.execPath, holder, at(h).state, marker]);
  for (let i = 0; i < 100 && !existsSync(marker); i++) await Bun.sleep(20);
  expect(() => saveState(h, loadState(h))).not.toThrow();
  await child.exited;
});

test("a handler busy for an hour stops being retried: its answers read failed", async () => {
  const h = home();
  drop(h, req("map-1"));
  const srv = fakeServer();
  await runSync(deps(h, srv.ssh, fakeHandler().run).d);
  const busy = fakeHandler(3);
  srv.then(takeAll([answer("s1-1", "k1")]));
  await runSync(deps(h, srv.ssh, busy.run).d);
  expect(loadState(h).busySince).toEqual({ "s1-1": Math.floor(NOW.getTime() / 1000) });
  const later = deps(h, srv.ssh, busy.run);
  later.d.now = () => new Date(NOW.getTime() + 3601 * 1000);
  srv.then(takeAll([answer("s1-1", "k1")]));
  await runSync(later.d);
  expect(srv.calls.at(-1).results).toEqual([{ request: "map-1", card: "k1", outcome: "failed", detail: "המחשב לא הצליח לשמור" }]);
  expect(loadState(h).busySince).toEqual({});
});

test("an unreadable state.json is kept aside with a log line", async () => {
  const h = home();
  writeFileSync(at(h).state, "{cut short");
  const srv = fakeServer();
  const { d, logs } = deps(h, srv.ssh, fakeHandler().run);
  expect(await runSync(d)).toBe(0);
  expect(readdirSync(h).some((f) => f.startsWith("state.json.corrupt-"))).toBe(true);
  expect(logs[0]).toContain("state.json was unreadable; kept aside as state.json.corrupt-");
  expect(loadState(h).v).toBe(1);
});

test("a lock is released only by its holder, and a second routine waits once the run's time is spent", async () => {
  const h = home({ map: { argv: ["x"], timeout_s: 60 }, other: { argv: ["y"], timeout_s: 150 } });
  const first = takeLock(h)!;
  writeFileSync(at(h).lock, "someone-else"); // a run that slept was taken over meanwhile
  first();
  expect(readFileSync(at(h).lock, "utf8")).toBe("someone-else");
  rmSync(at(h).lock);
  drop(h, req("map-1"));
  drop(h, req("other-1", { routine: "other" }));
  const srv = fakeServer();
  const hd = fakeHandler();
  const { d, logs } = deps(h, srv.ssh, hd.run);
  await runSync(d);
  srv.then(takeAll([answer("s1-1", "k1"), { id: "s1-2", request: "other-1", card: "k1", verdict: "approve" }]));
  await runSync({ ...d, budgetMs: 200_000 }); // at once, but 150 s of handler and 60 s of ssh would pass 200 s
  expect(hd.runs.length).toBe(1); // the first routine ran; the second waits
  expect(loadState(h).ledger["s1-2"]).toBeUndefined();
  expect(logs.at(-1)).toContain("1 answer(s) wait for the next cycle");
  writeFileSync(join(h, "handlers.json"), JSON.stringify({ map: { argv: ["x"], timeout_s: 60 }, other: { argv: ["y"], timeout_s: 60 } }));
  srv.then(takeAll([answer("s1-3", "k2"), { id: "s1-2", request: "other-1", card: "k1", verdict: "approve" }]));
  await runSync({ ...d, budgetMs: 200_000 }); // with 60 s of handler it fits
  expect(hd.runs.length).toBe(3);
});

test("a state.json that cannot be read stops the cycle and is never written over", async () => {
  const h = home();
  drop(h, req("map-1"));
  mkdirSync(at(h).state, { recursive: true }); // a folder where the file should be: every read fails
  const srv = fakeServer();
  const { d, logs } = deps(h, srv.ssh, fakeHandler().run);
  expect(await runSync(d)).toBe(1);
  expect(srv.calls.length).toBe(0);
  expect(existsSync(join(at(h).outbox, "map-1.json"))).toBe(true);
  expect(logs.at(-1)).toMatch(/^FAILED: cannot read state\.json \(E[A-Z]+\); nothing done this cycle$/);
  expect(openReport(h, loadHandlers(h) as any)).toMatch(/^refused: cannot read state\.json \(E[A-Z]+\)$/);
  const a = answerDeps(h, fakeHandler().run);
  expect(await runAnswer(a.d, { request: "map-1", card: 1, verdict: "approve" })).toBe(1);
  expect(a.printed.join("")).toContain("cannot read state.json");
  expect(statSync(at(h).state).isDirectory()).toBe(true); // nothing wrote over it
});

test("open names files the channel refused, and a log line names the deployed copy", async () => {
  const h = home();
  drop(h, { v: 1, id: "BAD" }, "bad.json");
  const srv = fakeServer();
  const { d, logs } = deps(h, srv.ssh, fakeHandler().run);
  await runSync({ ...d, version: "abc1234" });
  expect(openReport(h, loadHandlers(h) as any)).toBe("refused by the channel, never on the phone (the reason is in sync.log): bad.json");
  drop(h, req("map-1"));
  await runSync({ ...d, version: "abc1234" });
  expect(logs.at(-1)).toBe("sent map-1; copy abc1234");
});

test("answer waits for the task's lock and gives up busy; a busy handler, a gone or replaced request refuse", async () => {
  const h = home();
  drop(h, req("map-1"));
  const release = takeLock(h)!;
  const { d, printed } = answerDeps(h, fakeHandler().run, 4000);
  expect(await runAnswer(d, { request: "map-1", card: 1, verdict: "approve" })).toBe(3);
  expect(printed).toEqual(["busy: the sync task is running; try again in a minute"]);
  release();
  const busy = answerDeps(h, fakeHandler(3).run);
  expect(await runAnswer(busy.d, { request: "map-1", card: 1, verdict: "approve" })).toBe(3);
  const gone = answerDeps(h, fakeHandler().run);
  expect(await runAnswer(gone.d, { request: "map-9", card: 1, verdict: "approve" })).toBe(1);
  expect(await runAnswer(gone.d, { request: "map-1", card: 7, verdict: "approve" })).toBe(1);
  drop(h, req("map-2"));
  await runSync(deps(h, fakeServer().ssh, fakeHandler().run).d);
  expect(await runAnswer(gone.d, { request: "map-1", card: 1, verdict: "approve" })).toBe(1);
  expect(gone.printed.at(-1)).toBe("refused: request map-1 was replaced by a newer one; answer that one");
});

// --- handler output ---------------------------------------------------------------------

test("only a short Hebrew detail travels to the phone", () => {
  expect(safeDetail("הטיוטה השתנתה בינתיים")).toBe("הטיוטה השתנתה בינתיים");
  expect(safeDetail("  לא   טיוטה  ")).toBe("לא טיוטה");
  for (const bad of ["C:\\Users\\x", "see https://example.org", "token sk-abc", "ב".repeat(81), "", 5, null]) expect(safeDetail(bad)).toBeUndefined();
  const m = parseHandlerOutput(['backup C:\\x.bak', '{"id":"a1","card":"k1","outcome":"approved"}', '{"id":"a2","card":"k2","outcome":"refused","detail":"not Hebrew"}', '{"id":"a3","outcome":"deleted"}', "{broken"].join("\r\n"));
  expect([...m.entries()]).toEqual([["a1", { outcome: "approved" }], ["a2", { outcome: "refused" }]]);
});

test("the real handler runner passes the work file, returns stdout and the exit code, and kills at its timeout", async () => {
  const h = home();
  const script = join(h, "handler.ts");
  writeFileSync(script, 'const f = process.argv[2]; console.log(JSON.stringify({ id: "a1", card: "k1", outcome: "approved", file: f.endsWith(".json") })); process.exit(Number(process.env.CODE ?? 0));');
  const r = await runHandlerProcess({ argv: [process.execPath, script], timeout_s: 30 }, join(h, "w.json"));
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out.trim())).toMatchObject({ outcome: "approved", file: true });
  const slow = join(h, "slow.ts");
  writeFileSync(slow, "await Bun.sleep(5000);");
  const t = await runHandlerProcess({ argv: [process.execPath, slow], timeout_s: 1 }, join(h, "w.json"));
  expect(t.code).toBeNull();
});

test("parseFlags takes --all as a switch and refuses a stray word", () => {
  expect(parseFlags(["--request", "map-1", "--all", "--verdict", "approve"])).toEqual({ flags: new Map([["request", "map-1"], ["verdict", "approve"]]), switches: new Set(["all"]) });
  expect(parseFlags(["map-1"]).error).toBe("unexpected argument: map-1");
});

test("the ssh call forwards nothing, reads at most 1 MB, and logs only printable ssh words", async () => {
  const args = sshArgs({ target: "bot@example.org", key: "K" });
  for (const f of ["-a", "-x", "-T", "ClearAllForwardings=yes", "BatchMode=yes"]) expect(args).toContain(f);
  expect(args.slice(-2)).toEqual(["bot@example.org", REMOTE_CMD]);
  expect(await readUpTo(new Blob(["abc"]).stream(), 3)).toEqual({ text: "abc", over: false });
  expect((await readUpTo(new Blob([new Uint8Array(5_000_000)]).stream(), 1_000_000)).over).toBe(true);
  const esc = String.fromCharCode(27);
  expect(safeStderr(`ssh: connect${esc}[31m refused\r\nשגיאה`)).toBe("ssh: connect [31m refused");
});
