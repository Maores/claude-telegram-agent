import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeInboxMessage, diskName, ID_RE, loadInbox, mutateInbox, newItemId, parseInboxChatId, type InboxMessage } from "./inbox.ts";

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
