import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeInboxMessage,
  diskName,
  fileInboxMessage,
  foreignGroupNote,
  ID_RE,
  INBOX_DOWNLOAD_FAILED,
  INBOX_MOVED,
  INBOX_STORE_FAILED,
  INBOX_TOO_LARGE,
  INBOX_UNSUPPORTED,
  loadInbox,
  mutateInbox,
  newItemId,
  parseInboxChatId,
  resolveInboxChatId,
  writeMoved,
  type InboxDeps,
  type InboxMessage,
} from "./inbox.ts";

// All fixtures are synthetic.
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inbox-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DATE = Math.floor(new Date(2026, 9, 5, 18, 20).getTime() / 1000);
const base = { message_id: 10, date: DATE, chat: { id: -1001, type: "supergroup" }, from: { id: 7 } };

test("parseInboxChatId takes a negative integer (a group) and nothing else", () => {
  expect(parseInboxChatId("-1001")).toBe(-1001);
  expect(parseInboxChatId(" -100123 ")).toBe(-100123);
  for (const bad of [undefined, "", "0", "42", "abc", "-10.5", "1e5", "-", "--5"]) expect(parseInboxChatId(bad)).toBeNull();
});

test("newItemId is the local date plus four hex digits, and skips ids already taken", () => {
  const at = new Date(2026, 9, 5, 18, 20);
  const seq = ["aaaa", "aaaa", "b1c2"];
  expect(newItemId(at, new Set(["261005-aaaa"]), () => seq.shift()!)).toBe("261005-b1c2");
  expect(ID_RE.test(newItemId(at, new Set()))).toBe(true);
  expect(() => newItemId(at, new Set(["261005-aaaa"]), () => "aaaa")).toThrow();
});

test("diskName keeps only a safe ASCII extension", () => {
  expect(diskName("261005-a1b2", "document", "דוח שנתי.PDF")).toBe("261005-a1b2.pdf");
  expect(diskName("261005-a1b2", "document", "archive.tar.gz")).toBe("261005-a1b2.gz");
  expect(diskName("261005-a1b2", "photo", undefined, "photos/file_7.jpg")).toBe("261005-a1b2.jpg");
  expect(diskName("261005-a1b2", "document", "notes.verylongext", "documents/file_3")).toBe("261005-a1b2.bin");
  expect(diskName("261005-a1b2", "voice", undefined, "voice/file_3")).toBe("261005-a1b2.oga");
  expect(diskName("261005-a1b2", "video", "קליפ.ש")).toBe("261005-a1b2.mp4");
  for (const live of ["README.md", "x.markdown", "board.canvas", "view.base", "X.MD"]) {
    expect(diskName("261005-a1b2", "document", live)).toBe("261005-a1b2.txt");
  }
});

test("a text keeps its text and the entity fields that matter", () => {
  const msg: InboxMessage = {
    ...base,
    text: "כלי חדש",
    entities: [{ type: "text_link", offset: 0, length: 3, url: "https://example.com/tool" }, { type: "mention", offset: 4, length: 3, user: { id: 1 } } as any],
  };
  expect(describeInboxMessage(msg)).toEqual({
    kind: "text",
    text: "כלי חדש",
    entities: [{ type: "text_link", offset: 0, length: 3, url: "https://example.com/tool" }, { type: "mention", offset: 4, length: 3 }],
  });
});

test("only documented entity types survive, and a link keeps only an http(s) URL", () => {
  const msg: InboxMessage = {
    ...base,
    text: "abc def ghi",
    entities: [
      { type: "brand_new_type", offset: 0, length: 3 },
      { type: "text_link", offset: 0, length: 3, url: "tg://resolve?domain=x" },
      { type: "text_link", offset: 4, length: 3 } as any,
      { type: "bold", offset: -1, length: 3 },
      { type: "url", offset: 8, length: 3 },
    ],
  };
  expect(describeInboxMessage(msg)).toEqual({ kind: "text", text: "abc def ghi", entities: [{ type: "url", offset: 8, length: 3 }] });
});

test("a photo takes its largest size and keeps its caption, its entities and its album id", () => {
  const msg: InboxMessage = {
    ...base,
    media_group_id: "album-1",
    photo: [{ file_id: "small", file_size: 10 }, { file_id: "large", file_size: 900 }],
    caption: "3 חלקים",
    caption_entities: [{ type: "url", offset: 0, length: 5 }],
  };
  expect(describeInboxMessage(msg)).toEqual({
    kind: "photo",
    mediaGroupId: "album-1",
    caption: "3 חלקים",
    captionEntities: [{ type: "url", offset: 0, length: 5 }],
    file: { fileId: "large", size: 900 },
  });
});

test("documents, videos, voice and audio each become an item with their file", () => {
  expect(describeInboxMessage({ ...base, document: { file_id: "d", file_name: "a.pdf", file_size: 5 } })).toEqual({ kind: "document", file: { fileId: "d", name: "a.pdf", size: 5 } });
  expect(describeInboxMessage({ ...base, video: { file_id: "v", file_name: "clip.mp4", file_size: 6 } })).toEqual({ kind: "video", file: { fileId: "v", name: "clip.mp4", size: 6 } });
  expect(describeInboxMessage({ ...base, video_note: { file_id: "n", file_size: 7 } })).toEqual({ kind: "video", file: { fileId: "n", size: 7 } });
  // Telegram sends an animation with a document beside it; the animation wins
  expect(describeInboxMessage({ ...base, animation: { file_id: "g", file_name: "x.mp4" }, document: { file_id: "g", file_name: "x.mp4" } })).toEqual({ kind: "video", file: { fileId: "g", name: "x.mp4" } });
  expect(describeInboxMessage({ ...base, voice: { file_id: "o", file_size: 8 } })).toEqual({ kind: "voice", file: { fileId: "o", size: 8 } });
  expect(describeInboxMessage({ ...base, audio: { file_id: "m", file_name: "song.mp3" } })).toEqual({ kind: "audio", file: { fileId: "m", name: "song.mp3" } });
});

test("a command is stored as text, never run", () => {
  expect(describeInboxMessage({ ...base, text: "/stop" })).toEqual({ kind: "text", text: "/stop" });
});

test("service messages are nothing; every other kind is unsupported, including kinds not named", () => {
  for (const svc of [{ new_chat_members: [{ id: 9 }] }, { left_chat_member: { id: 9 } }, { new_chat_title: "x" }, { pinned_message: {} }, { group_chat_created: true }, { migrate_from_chat_id: -5 }]) {
    expect(describeInboxMessage({ ...base, ...svc } as any)).toBeNull();
  }
  for (const extra of [{ sticker: { file_id: "s" } }, { location: {} }, { contact: {} }, { poll: {} }, { venue: {} }, { dice: {} }, { story: {} }, { some_future_kind: {} }, {}]) {
    expect(describeInboxMessage({ ...base, ...extra } as any)).toBe("unsupported");
  }
});

test("the store starts empty, saves only on a change, and sets an unreadable file aside", () => {
  expect(loadInbox(dir).items).toEqual([]);
  mutateInbox(dir, () => {});
  expect(existsSync(join(dir, "items.json"))).toBe(false);
  mutateInbox(dir, (s) => void s.items.push({ id: "261005-a1b2", messageId: 1, receivedAt: 1, kind: "text", text: "x" }));
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261005-a1b2"]);
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);

  writeFileSync(join(dir, "items.json"), "{not json");
  const logs: string[] = [];
  mutateInbox(dir, (s) => void s.items.push({ id: "261005-c3d4", messageId: 2, receivedAt: 2, kind: "text", text: "y" }), (l) => logs.push(l));
  expect(loadInbox(dir).items.map((i) => i.id)).toEqual(["261005-c3d4"]);
  expect(readdirSync(dir).some((n) => n.startsWith("items.json.corrupt-"))).toBe(true);
  expect(logs.join("\n")).toContain("kept aside");
  expect(JSON.parse(readFileSync(join(dir, "items.json"), "utf8")).v).toBe(1);
});

test("an unreadable store set aside is replaced by a valid one even when nothing else changed", () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "items.json"), "{not json");
  mutateInbox(dir, () => {}, () => {});
  expect(readdirSync(dir).some((n) => n.startsWith("items.json.corrupt-"))).toBe(true);
  expect(existsSync(join(dir, "items.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, "items.json"), "utf8"))).toMatchObject({ v: 1, items: [] });
  expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
});

function fakeDeps(over: Partial<InboxDeps> = {}) {
  const calls = { reacts: [] as string[], replies: [] as string[], logs: [] as string[], fetched: [] as string[] };
  const d: InboxDeps = {
    dir,
    now: () => new Date(2026, 9, 9, 9, 0), // later than the messages' own date
    allowed: (id) => id === "7",
    fetchFile: async (fileId) => {
      calls.fetched.push(fileId);
      return { bytes: new TextEncoder().encode(`bytes of ${fileId}`), remotePath: "photos/file_1.jpg" };
    },
    react: async (e) => void calls.reacts.push(e),
    reply: async (t) => void calls.replies.push(t),
    log: (l) => void calls.logs.push(l),
    maxBytes: 1000,
    ...over,
  };
  return { d, calls };
}

test("a text is stored with the message's own date and id, gets 👍, and no words reach the journal", async () => {
  const { d, calls } = fakeDeps();
  expect(await fileInboxMessage({ ...base, text: "קישור", entities: [{ type: "url", offset: 0, length: 5 }] }, d)).toBe("stored");
  const [item] = loadInbox(dir).items;
  expect(item).toMatchObject({ kind: "text", text: "קישור", messageId: 10, receivedAt: DATE, entities: [{ type: "url", offset: 0, length: 5 }] });
  expect(item.id.startsWith("261005-")).toBe(true); // the message's date, not the processing time
  expect(calls.reacts).toEqual(["👍"]);
  expect(calls.replies).toEqual([]);
  expect(calls.logs.join("\n")).not.toContain("קישור");
});

test("a message without a date falls back to now", async () => {
  const { d } = fakeDeps();
  const { date, ...noDate } = base;
  await fileInboxMessage({ ...noDate, text: "x" }, d);
  expect(loadInbox(dir).items[0].receivedAt).toBe(Math.floor(new Date(2026, 9, 9, 9, 0).getTime() / 1000));
});

test("a photo's bytes land in files/ under an ASCII name, with its album id", async () => {
  const { d, calls } = fakeDeps();
  expect(await fileInboxMessage({ ...base, media_group_id: "album-1", photo: [{ file_id: "p1", file_size: 12 }], caption: "מסך" }, d)).toBe("stored");
  const [item] = loadInbox(dir).items;
  expect(item.file).toBe(`files/${item.id}.jpg`);
  expect(readFileSync(join(dir, item.file!), "utf8")).toBe("bytes of p1");
  expect(item.size).toBe("bytes of p1".length);
  expect(item).toMatchObject({ caption: "מסך", mediaGroupId: "album-1" });
  expect(readdirSync(join(dir, "files")).filter((n) => n.endsWith(".part"))).toEqual([]);
  expect(calls.reacts).toEqual(["👍"]);
});

test("a document keeps its Hebrew name for display only; a note-app file is stored as text", async () => {
  const { d } = fakeDeps({ fetchFile: async () => ({ bytes: new Uint8Array([1, 2, 3]), remotePath: "documents/file_9" }) });
  await fileInboxMessage({ ...base, document: { file_id: "d1", file_name: "סיכום פגישה.pdf", file_size: 3 } }, d);
  await fileInboxMessage({ ...base, message_id: 11, document: { file_id: "d2", file_name: "README.md", file_size: 3 } }, d);
  const [pdf, md] = loadInbox(dir).items;
  expect(pdf.fileName).toBe("סיכום פגישה.pdf");
  expect(pdf.file).toBe(`files/${pdf.id}.pdf`);
  expect(md.file).toBe(`files/${md.id}.txt`);
});

test("a voice note is stored as audio and nothing else happens to it", async () => {
  const { d, calls } = fakeDeps({ fetchFile: async () => ({ bytes: new Uint8Array([9]), remotePath: "voice/file_2.oga" }) });
  expect(await fileInboxMessage({ ...base, voice: { file_id: "v1", file_size: 1 } }, d)).toBe("stored");
  expect(loadInbox(dir).items[0]).toMatchObject({ kind: "voice" });
  expect(loadInbox(dir).items[0].text).toBeUndefined();
  expect(calls.reacts).toEqual(["👍"]);
});

test("a file over the cap is never fetched: an item with the error, and a short reply instead of 👍", async () => {
  const { d, calls } = fakeDeps();
  expect(await fileInboxMessage({ ...base, document: { file_id: "big", file_name: "big.zip", file_size: 5000 } }, d)).toBe("stored-with-error");
  expect(calls.fetched).toEqual([]);
  expect(loadInbox(dir).items[0]).toMatchObject({ kind: "document", fileName: "big.zip", reportedSize: 5000, error: "too large" });
  expect(loadInbox(dir).items[0].file).toBeUndefined();
  expect(loadInbox(dir).items[0].size).toBeUndefined(); // `size` is only ever a stored file's real size
  expect(calls.replies).toEqual([INBOX_TOO_LARGE]);
  expect(calls.reacts).toEqual([]);
});

test("a failed download still makes an item; Telegram's own 'too big' reads as too large", async () => {
  const failing = (msg: string) => fakeDeps({ fetchFile: async () => { throw new Error(msg); } });
  let f = failing("file download HTTP 502");
  expect(await fileInboxMessage({ ...base, video: { file_id: "x" } }, f.d)).toBe("stored-with-error");
  expect(loadInbox(dir).items[0].error).toBe("file download HTTP 502");
  expect(f.calls.replies).toEqual([INBOX_DOWNLOAD_FAILED]);
  f = failing("Telegram getFile failed: 400 Bad Request: file is too big");
  await fileInboxMessage({ ...base, message_id: 11, video: { file_id: "y" } }, f.d);
  expect(f.calls.replies).toEqual([INBOX_TOO_LARGE]);
  expect(loadInbox(dir).items).toHaveLength(2);
  expect(loadInbox(dir).items[1].error).toBe("too large"); // the same word the PC maps, whichever way it was too big
});

test("the same message delivered twice is stored once, fetched once, and 👍'd once", async () => {
  const { d, calls } = fakeDeps();
  expect(await fileInboxMessage({ ...base, photo: [{ file_id: "p1" }] }, d)).toBe("stored");
  expect(await fileInboxMessage({ ...base, photo: [{ file_id: "p1" }] }, d)).toBe("duplicate");
  expect(loadInbox(dir).items).toHaveLength(1);
  expect(calls.fetched).toEqual(["p1"]);
  expect(calls.reacts).toEqual(["👍"]);
});

test("a sender not on the allowlist is ignored: nothing stored, no reaction", async () => {
  const { d, calls } = fakeDeps();
  expect(await fileInboxMessage({ ...base, from: { id: 99 }, text: "hi" }, d)).toBe("skipped");
  expect(await fileInboxMessage({ ...base, from: undefined, text: "hi" }, d)).toBe("skipped");
  expect(loadInbox(dir).items).toEqual([]);
  expect(calls.reacts).toEqual([]);
  expect(calls.replies).toEqual([]);
});

test("unsupported kinds get the short reply; service messages get nothing", async () => {
  const { d, calls } = fakeDeps();
  expect(await fileInboxMessage({ ...base, story: {} } as any, d)).toBe("unsupported");
  expect(await fileInboxMessage({ ...base, new_chat_members: [{ id: 3 }] } as any, d)).toBe("ignored");
  expect(loadInbox(dir).items).toEqual([]);
  expect(calls.replies).toEqual([INBOX_UNSUPPORTED]);
});

test("a /stop in the inbox is stored as text", async () => {
  const { d } = fakeDeps();
  expect(await fileInboxMessage({ ...base, text: "/stop" }, d)).toBe("stored");
  expect(loadInbox(dir).items[0]).toMatchObject({ kind: "text", text: "/stop" });
});

test("the group's move stores nothing and says nothing here (the poller's followInbox logs it once)", async () => {
  const { d, calls } = fakeDeps();
  expect(await fileInboxMessage({ ...base, migrate_to_chat_id: -100777 }, d)).toBe("moved");
  expect(calls.logs).toEqual([]);
  expect(calls.replies).toEqual([]);
  expect(loadInbox(dir).items).toEqual([]);
});

test("an id handed out once is not handed out again, even after its item is gone", async () => {
  const { d } = fakeDeps({ rand: () => "abcd" });
  await fileInboxMessage({ ...base, text: "a" }, d);
  const first = loadInbox(dir).items[0].id;
  mutateInbox(dir, (s) => void (s.items = [])); // as if the PC acked it
  const seq = ["abcd", "abcd", "ef01"];
  await fileInboxMessage({ ...base, message_id: 11, text: "b" }, { ...d, rand: () => seq.shift()! });
  expect(loadInbox(dir).items[0].id).not.toBe(first);
  expect(loadInbox(dir).issued!.map((x) => x.id)).toEqual([first, loadInbox(dir).items[0].id]);
});

test("when the store cannot be written, the fetched file is removed and the sender is told", async () => {
  mkdirSync(join(dir, "items.json.tmp")); // a folder where the temp file goes makes the store write throw
  const { d, calls } = fakeDeps();
  expect(await fileInboxMessage({ ...base, photo: [{ file_id: "p2" }] }, d)).toBe("failed");
  expect(readdirSync(join(dir, "files"))).toEqual([]);
  expect(calls.replies).toEqual([INBOX_STORE_FAILED]);
  expect(calls.reacts).toEqual(["👎"]);
});

test("an album item that cannot be stored gets the reply but no 👎 (it would land on the album's first picture)", async () => {
  mkdirSync(join(dir, "items.json.tmp"));
  const { d, calls } = fakeDeps();
  expect(await fileInboxMessage({ ...base, media_group_id: "album-1", photo: [{ file_id: "p3" }] }, d)).toBe("failed");
  expect(calls.replies).toEqual([INBOX_STORE_FAILED]);
  expect(calls.reacts).toEqual([]);
});

test("a stored file carries the checksum of its bytes", async () => {
  const { d } = fakeDeps();
  await fileInboxMessage({ ...base, photo: [{ file_id: "p1" }] }, d);
  const [item] = loadInbox(dir).items;
  expect(item.sha256).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, item.file!))).digest("hex"));
  expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test("two messages get two ids, in order", async () => {
  const { d } = fakeDeps();
  await fileInboxMessage({ ...base, text: "א" }, d);
  await fileInboxMessage({ ...base, message_id: 11, text: "ב" }, d);
  const items = loadInbox(dir).items;
  expect(items.map((i) => i.text)).toEqual(["א", "ב"]);
  expect(new Set(items.map((i) => i.id)).size).toBe(2);
});

test("foreignGroupNote logs a group once per sender kind, says whether the sender is allowlisted, and logs every move", () => {
  const seen = new Set<string>();
  const allowed = (id: string) => id === "7";
  const stranger = { message_id: 1, chat: { id: -2002, type: "group" }, from: { id: 99 } };
  expect(foreignGroupNote(stranger, seen, allowed)).toBe("[INBOX?] chat -2002 (group, sender allowlisted: no): a group that is not the inbox; never answered");
  expect(foreignGroupNote(stranger, seen, allowed)).toBeNull();
  expect(foreignGroupNote({ ...stranger, from: { id: 7 } }, seen, allowed)).toBe("[INBOX?] chat -2002 (group, sender allowlisted: yes): a group that is not the inbox; never answered");
  expect(foreignGroupNote({ ...stranger, migrate_to_chat_id: -100888 }, seen, allowed)).toBe("[INBOX?] chat -2002 moved to chat -100888");
});

test("the Hebrew lines the bot sends carry no Latin letters", () => {
  for (const s of [INBOX_TOO_LARGE, INBOX_DOWNLOAD_FAILED, INBOX_UNSUPPORTED, INBOX_STORE_FAILED, INBOX_MOVED]) expect(/[A-Za-z]/.test(s)).toBe(false);
});

test("inbox.ts has no road to a Claude turn or to the history", () => {
  const src = readFileSync(join(import.meta.dir, "inbox.ts"), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
  expect(imports).toEqual(["./redact.ts", "./reminders.ts", "node:fs", "node:os", "node:path"]);
  expect(src).not.toContain("Bun.spawn");
});

test("two deliveries of one message racing through the download store one item and keep one file", async () => {
  const { d, calls } = fakeDeps();
  const msg = { ...base, photo: [{ file_id: "p4" }] };
  // both pass the early check before either reaches the store; the check under the lock decides
  const outcomes = await Promise.all([fileInboxMessage(msg, d), fileInboxMessage(msg, d)]);
  expect(outcomes.sort()).toEqual(["duplicate", "stored"]);
  expect(calls.fetched).toEqual(["p4", "p4"]);
  expect(loadInbox(dir).items).toHaveLength(1);
  expect(readdirSync(join(dir, "files"))).toEqual([loadInbox(dir).items[0].file!.slice("files/".length)]);
  expect(calls.reacts).toEqual(["👍"]);
});

test("a followed move is remembered across a restart until the setting is updated", () => {
  expect(resolveInboxChatId(-1001, dir)).toBe(-1001);
  writeMoved(dir, -1001, -100777);
  expect(resolveInboxChatId(-1001, dir)).toBe(-100777); // restarted before the setting changed
  expect(resolveInboxChatId(-100777, dir)).toBe(-100777); // the setting was updated
  expect(resolveInboxChatId(-2002, dir)).toBe(-2002); // another group altogether
  expect(resolveInboxChatId(null, dir)).toBeNull();
  writeFileSync(join(dir, "moved.json"), '{"from":-1001,"to":42}'); // a positive id is never an inbox
  expect(resolveInboxChatId(-1001, dir)).toBe(-1001);
});
