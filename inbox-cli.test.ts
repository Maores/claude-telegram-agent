import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  HARD_CAP_S, KEEP_S, MAX_GET_BYTES, WARN_AFTER_S, WARN_STANDS_S,
  inboxWarningText, loadInbox, mutateInbox, runInboxCli, runInboxTick, sweepLeftovers, type InboxItem,
} from "./inbox.ts";

// All fixtures are synthetic.
let root: string;
let dir: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "inbox-cli-"));
  dir = join(root, "inbox");
  outside = join(root, "outside");
  mkdirSync(outside, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const NOW = new Date(2026, 9, 12, 18, 0);
const nowS = Math.floor(NOW.getTime() / 1000);
const item = (id: string, ageS: number, extra: Partial<InboxItem> = {}): InboxItem => ({ id, messageId: Number.parseInt(id.slice(-4), 16), receivedAt: nowS - ageS, kind: "text", text: "x", ...extra });
const ago = (p: string, s: number) => utimesSync(p, new Date(NOW.getTime() - s * 1000), new Date(NOW.getTime() - s * 1000));

async function run(argv: string[], env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const bytes: Uint8Array[] = [];
  const code = await runInboxCli(argv, {
    out: (s) => void out.push(s),
    outBytes: (b) => void bytes.push(b),
    err: (s) => void err.push(s),
    env: { INBOX_DIR: dir, ...env },
    now: () => NOW,
  });
  return { code, err: err.join("\n"), json: out.length ? JSON.parse(out.join("")) : null, bytes };
}

function seed(items: InboxItem[]) {
  mutateInbox(dir, (s) => void s.items.push(...items));
  mkdirSync(join(dir, "files"), { recursive: true });
  for (const i of items) if (i.file) writeFileSync(join(dir, i.file), "x");
}

test("list on an empty inbox prints an empty list", async () => {
  expect(await run(["list"])).toMatchObject({ code: 0, json: { v: 1, items: [] } });
});

test("list shows every item oldest first; ack deletes items with their files and reports unknown ids", async () => {
  seed([item("261012-bbbb", 10), item("261012-aaaa", 20, { kind: "photo", file: "files/261012-aaaa.jpg" })]);
  expect((await run(["list"])).json.items.map((i: InboxItem) => i.id)).toEqual(["261012-aaaa", "261012-bbbb"]);
  expect((await run(["ack", "261012-aaaa", "261012-ffff"])).json).toEqual({ v: 1, acked: ["261012-aaaa"], unknown: ["261012-ffff"] });
  expect(existsSync(join(dir, "files", "261012-aaaa.jpg"))).toBe(false);
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261012-bbbb"]);
  expect((await run(["ack", "261012-aaaa"])).json).toEqual({ v: 1, acked: [], unknown: ["261012-aaaa"] }); // a resumed ack is harmless
});

test("list keeps the chat's order inside one second (an album shares its second)", async () => {
  seed([item("261012-ffff", 5, { messageId: 101 }), item("261012-0000", 5, { messageId: 103 }), item("261012-8888", 5, { messageId: 102 })]);
  expect((await run(["list"])).json.items.map((i: InboxItem) => i.messageId)).toEqual([101, 102, 103]);
});

test("ack refuses anything that is not an item id, and changes nothing", async () => {
  seed([item("261012-aaaa", 1)]);
  for (const bad of [["ack"], ["ack", "261012-aaaa", "../x"], ["ack", "261012-AAAA"]]) {
    const r = await run(bad);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage");
  }
  expect(loadInbox(dir).items).toHaveLength(1);
});

test("get returns a stored file's bytes and refuses anything else", async () => {
  seed([item("261012-aaaa", 5, { kind: "photo", file: "files/261012-aaaa.jpg" }), item("261012-bbbb", 5)]);
  writeFileSync(join(dir, "files", "261012-aaaa.jpg"), "JPEGBYTES");
  const ok = await run(["get", "261012-aaaa"]);
  expect(ok.code).toBe(0);
  expect(Buffer.concat(ok.bytes).toString()).toBe("JPEGBYTES");
  for (const bad of [["get"], ["get", "261012-bbbb"], ["get", "261012-ffff"], ["get", "../x"], ["get", "261012-aaaa", "261012-bbbb"]]) {
    const r = await run(bad);
    expect(r.code).toBe(2);
    expect(r.bytes).toEqual([]);
  }
});

test("get refuses a file over the cap", async () => {
  seed([item("261012-aaaa", 5, { kind: "video", file: "files/261012-aaaa.mp4" })]);
  writeFileSync(join(dir, "files", "261012-aaaa.mp4"), new Uint8Array(MAX_GET_BYTES + 1));
  const r = await run(["get", "261012-aaaa"]);
  expect(r.code).toBe(2);
  expect(r.bytes).toEqual([]);
});

test("the gate admits exactly list, ack with ids, and get with one id", async () => {
  seed([item("261012-aaaa", 5, { kind: "photo", file: "files/261012-aaaa.jpg" }), item("261012-bbbb", 5)]);
  writeFileSync(join(dir, "files", "261012-aaaa.jpg"), "J");
  const gate = (cmd: string | undefined) => run(["gate"], { SSH_ORIGINAL_COMMAND: cmd });
  expect((await gate("list")).json.items).toHaveLength(2);
  expect(Buffer.concat((await gate("get 261012-aaaa")).bytes).toString()).toBe("J");
  for (const bad of [undefined, "", "ls", "status", "purge", "gate", "list extra", "list; rm -rf ~", "ack", "ack ../x", "ack 261012-aaaa  261012-bbbb", "get", "get 261012-aaaa 261012-bbbb", "get $(id)", "LIST", "list\n"]) {
    const r = await gate(bad);
    expect(r.code).toBe(2);
    expect(r.err).toContain("refused");
  }
  expect((await gate("ack 261012-bbbb")).json.acked).toEqual(["261012-bbbb"]);
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261012-aaaa"]);
});

test("list never deletes; purge takes a warned item after its week, and an unwarned one waits", async () => {
  seed([
    item("261005-aaaa", KEEP_S + 1, { kind: "photo", file: "files/261005-aaaa.jpg", warnedAt: nowS - WARN_STANDS_S - 1 }),
    item("261005-bbbb", KEEP_S + 1, { warnedAt: nowS - 3600 }), // warned an hour ago: waits
    item("261005-cccc", KEEP_S + 1), // never warned (held by quiet time): waits
    item("261011-dddd", 3600),
  ]);
  expect((await run(["list"])).json.items.map((i: InboxItem) => i.id)).toEqual(["261005-aaaa", "261005-bbbb", "261005-cccc", "261011-dddd"]);
  expect(existsSync(join(dir, "files", "261005-aaaa.jpg"))).toBe(true);
  expect((await run(["purge"])).json).toEqual({ v: 1, purged: 1 });
  expect(existsSync(join(dir, "files", "261005-aaaa.jpg"))).toBe(false);
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261005-bbbb", "261005-cccc", "261011-dddd"]);
});

test("a file path outside files/ is never deleted, by ack or by the week", async () => {
  const victim = join(outside, "keep.txt");
  writeFileSync(victim, "keep");
  const escape = `files/../../${basename(outside)}/keep.txt`; // resolves to the victim without the check
  mutateInbox(dir, (s) => void s.items.push(item("261005-aaaa", KEEP_S + 1, { file: escape, warnedAt: 1 }), item("261012-bbbb", 1, { file: escape })));
  expect((await run(["purge"])).json).toEqual({ v: 1, purged: 1 });
  expect((await run(["ack", "261012-bbbb"])).json.acked).toEqual(["261012-bbbb"]);
  expect(existsSync(victim)).toBe(true);
});

test("status counts what waits, the files and their bytes, and the oldest item's age", async () => {
  seed([item("261012-aaaa", 300, { kind: "photo", file: "files/261012-aaaa.jpg" }), item("261012-bbbb", 100)]);
  expect((await run(["status"])).json).toEqual({ v: 1, waiting: 2, files: 1, bytes: 1, oldestAgeS: 300 });
  rmSync(dir, { recursive: true, force: true });
  expect((await run(["status"])).json).toEqual({ v: 1, waiting: 0, files: 0, bytes: 0, oldestAgeS: null });
});

test("every printed answer is awaited before the CLI returns, so exit never cuts it short", async () => {
  seed([item("261012-aaaa", 10)]);
  for (const argv of [["list"], ["ack", "261012-ffff"], ["purge"], ["status"]]) {
    let landed = false;
    const code = await runInboxCli(argv, {
      out: () => new Promise<void>((res) => setTimeout(() => ((landed = true), res()), 5)),
      outBytes: () => {},
      err: () => {},
      env: { INBOX_DIR: dir },
      now: () => NOW,
    });
    expect(code).toBe(0);
    expect(landed).toBe(true);
  }
});

test("an unknown command prints the usage", async () => {
  const r = await run(["delete"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("usage: inbox.ts list | ack <id>... | get <id> | purge | status | gate");
});

test("the tick warns once, a day ahead, in one message, and deletes after the warning stood", async () => {
  seed([item("261006-aaaa", WARN_AFTER_S + 60), item("261006-bbbb", WARN_AFTER_S + 30), item("261012-cccc", 60)]);
  const sent: string[] = [];
  const clock = { at: -Infinity };
  const tick = (at: number) => runInboxTick({ dir, nowS: at, quietAt: () => false, send: async (t) => void sent.push(t), log: () => {}, errClock: clock });
  await tick(nowS);
  expect(sent).toEqual([inboxWarningText(2)]);
  await tick(nowS + 60);
  expect(sent).toHaveLength(1);
  await tick(nowS + WARN_STANDS_S + 120);
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261012-cccc"]);
});

test("a warning that cannot be sent never blocks a deletion, and is logged at most once an hour", async () => {
  seed([item("261005-aaaa", KEEP_S + 10, { warnedAt: nowS - WARN_STANDS_S - 1 }), item("261006-bbbb", WARN_AFTER_S + 60)]);
  const logs: string[] = [];
  const clock = { at: -Infinity };
  const failing = (at: number) => runInboxTick({ dir, nowS: at, quietAt: () => false, send: async () => { throw new Error("chat not found"); }, log: (l) => void logs.push(l), errClock: clock });
  await failing(nowS);
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261006-bbbb"]);
  expect(loadInbox(dir).items[0].warnedAt).toBeUndefined();
  await failing(nowS + 30);
  await failing(nowS + 60);
  expect(logs.filter((l) => l.includes("could not be sent"))).toHaveLength(1);
  await failing(nowS + 3600);
  expect(logs.filter((l) => l.includes("could not be sent"))).toHaveLength(2);
});

test("no warning while quiet time is on or starts within a day, and no warned deletion inside it", async () => {
  seed([item("261006-aaaa", WARN_AFTER_S + 60), item("261005-bbbb", KEEP_S + 10, { warnedAt: nowS - WARN_STANDS_S - 1 })]);
  const sent: string[] = [];
  const clock = { at: -Infinity };
  const startsIn20h = (ms: number) => ms >= nowS * 1000 + 20 * 3600_000;
  await runInboxTick({ dir, nowS, quietAt: startsIn20h, send: async (t) => void sent.push(t), log: () => {}, errClock: clock });
  expect(sent).toEqual([]); // held: quiet time starts within a day
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261006-aaaa"]); // not quiet yet: the warned item went
  mutateInbox(dir, (s) => void s.items.push(item("261005-cccc", KEEP_S + 10, { warnedAt: nowS - WARN_STANDS_S - 1 })));
  await runInboxTick({ dir, nowS, quietAt: () => true, send: async (t) => void sent.push(t), log: () => {}, errClock: clock });
  expect(loadInbox(dir).items.map((i) => i.id).sort()).toEqual(["261005-cccc", "261006-aaaa"]); // inside quiet time: waits
  expect(sent).toEqual([]);
});

test("a store that cannot be written sends no warning at all, instead of one every 30 seconds", async () => {
  seed([item("261006-aaaa", WARN_AFTER_S + 60)]);
  mkdirSync(join(dir, "items.json.tmp")); // the store can be read but not written
  let sends = 0;
  const clock = { at: -Infinity };
  for (const at of [nowS, nowS + 30, nowS + 60]) {
    await runInboxTick({ dir, nowS: at, quietAt: () => false, send: async () => void sends++, log: () => {}, errClock: clock });
  }
  expect(sends).toBe(0);
});

test("a store that cannot be written while an item is due never makes the tick reject; the failure is logged once and the sweep still runs", async () => {
  seed([item("261002-aaaa", HARD_CAP_S + 1), item("261006-bbbb", WARN_AFTER_S + 60)]);
  writeFileSync(join(dir, "files", "261011-dead.jpg"), "x"); // a leftover no item names
  ago(join(dir, "files", "261011-dead.jpg"), 2 * 3600);
  mkdirSync(join(dir, "items.json.tmp")); // the store can be read but not written
  let sends = 0;
  const logs: string[] = [];
  const clock = { at: -Infinity };
  for (const at of [nowS, nowS + 30]) {
    await runInboxTick({ dir, nowS: at, quietAt: () => false, send: async () => void sends++, log: (l) => void logs.push(l), errClock: clock });
  }
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261002-aaaa", "261006-bbbb"]); // could not be deleted
  const failures = logs.filter((l) => l.includes("could not"));
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("could not delete the items due");
  expect(sends).toBe(0); // the warning's marks could not be written, so nothing was sent
  expect(existsSync(join(dir, "files", "261011-dead.jpg"))).toBe(false); // the store is readable: the sweep ran
});

test("a burst sent together gets one warning, counting every warned item", async () => {
  seed([item("261006-aaaa", WARN_AFTER_S + 60), item("261006-bbbb", WARN_AFTER_S - 3600), item("261011-cccc", 3600)]);
  const sent: string[] = [];
  const clock = { at: -Infinity };
  await runInboxTick({ dir, nowS, quietAt: () => false, send: async (t) => void sent.push(t), log: () => {}, errClock: clock });
  expect(sent).toEqual([inboxWarningText(2)]);
  await runInboxTick({ dir, nowS: nowS + 3600, quietAt: () => false, send: async (t) => void sent.push(t), log: () => {}, errClock: clock });
  expect(sent).toHaveLength(1); // the second item was covered by the first warning
});

test("with the setting unset nothing is sent, and items still go", async () => {
  seed([item("261002-aaaa", HARD_CAP_S + 1), item("261005-bbbb", KEEP_S + 10, { warnedAt: nowS - WARN_STANDS_S - 1 }), item("261006-cccc", WARN_AFTER_S + 60)]);
  await runInboxTick({ dir, nowS, quietAt: () => false, send: null, log: () => {}, errClock: { at: -Infinity } });
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261006-cccc"]);
  expect(loadInbox(dir).items[0].warnedAt).toBeUndefined();
});

test("an unreadable store never turns stored files into leftovers, nor does the store rebuilt after it", () => {
  seed([item("261012-aaaa", 10, { kind: "photo", file: "files/261012-aaaa.jpg" })]);
  ago(join(dir, "files", "261012-aaaa.jpg"), 2 * 3600);
  writeFileSync(join(dir, "items.json"), "{not json");
  expect(sweepLeftovers(dir, NOW.getTime(), () => {})).toBe(0);
  expect(existsSync(join(dir, "files", "261012-aaaa.jpg"))).toBe(true);
  // the next write sets the broken store aside and starts a fresh one holding only a new item
  mutateInbox(dir, (s) => void s.items.push(item("261012-bbbb", 5)), () => {});
  for (const n of readdirSync(dir)) if (n.startsWith("items.json.corrupt-")) ago(join(dir, n), 3600);
  expect(sweepLeftovers(dir, NOW.getTime(), () => {})).toBe(0);
  expect(existsSync(join(dir, "files", "261012-aaaa.jpg"))).toBe(true);
});

test("after ten days an item goes whatever happened: never warned, quiet time, a dead group", async () => {
  seed([item("261002-aaaa", HARD_CAP_S + 1), item("261003-bbbb", HARD_CAP_S - 3600)]);
  await runInboxTick({ dir, nowS, quietAt: () => true, send: async () => { throw new Error("x"); }, log: () => {}, errClock: { at: -Infinity } });
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261003-bbbb"]);
});

test("leftovers are swept: files no item names after an hour, part files, old set-aside stores", () => {
  seed([item("261012-aaaa", 10, { kind: "photo", file: "files/261012-aaaa.jpg" })]);
  ago(join(dir, "files", "261012-aaaa.jpg"), 2 * 3600); // named by an item: kept, however old
  for (const n of ["261011-dead.jpg", "261012-beef.jpg.part"]) {
    writeFileSync(join(dir, "files", n), "x");
    ago(join(dir, "files", n), 2 * 3600);
  }
  writeFileSync(join(dir, "files", "261012-f00d.jpg"), "x"); // its item is about to be stored
  ago(join(dir, "files", "261012-f00d.jpg"), 600);
  writeFileSync(join(dir, "items.json.corrupt-1"), "{");
  ago(join(dir, "items.json.corrupt-1"), 8 * 24 * 3600);
  expect(sweepLeftovers(dir, NOW.getTime(), () => {})).toBe(3);
  for (const kept of ["files/261012-aaaa.jpg", "files/261012-f00d.jpg", "items.json"]) expect(existsSync(join(dir, kept))).toBe(true);
  // a set-aside copy younger than a week is kept (and, while it exists, so are unnamed files)
  writeFileSync(join(dir, "items.json.corrupt-2"), "{");
  ago(join(dir, "items.json.corrupt-2"), 24 * 3600);
  expect(sweepLeftovers(dir, NOW.getTime(), () => {})).toBe(0);
  expect(existsSync(join(dir, "items.json.corrupt-2"))).toBe(true);
});

test("the warning is pure Hebrew and says how many", () => {
  expect(inboxWarningText(1)).toBe("בתיבה יש פריט אחד שעוד לא נמשך למחשב. מחר הוא יימחק מהשרת, והמקור נשאר כאן בקבוצה.");
  expect(inboxWarningText(3)).toBe("בתיבה יש 3 פריטים שעוד לא נמשכו למחשב. מחר הם יימחקו מהשרת, והמקור נשאר כאן בקבוצה.");
  expect(/[A-Za-z]/.test(inboxWarningText(3))).toBe(false);
});
