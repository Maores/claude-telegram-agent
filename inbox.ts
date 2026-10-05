/**
 * inbox.ts — the phone inbox (spec: docs/superpowers/specs/2026-10-05-phone-inbox-design.md).
 *
 * The owner drops things into a Telegram group that holds only him and the agent (an admin
 * there, so privacy mode lets it see every message). The poller stores each message as an item
 * under ~/inbox/ and reacts 👍: no Claude turn, no history row, no link fetch, no transcription.
 * A PC session pulls the items over ssh when he asks; `ack` deletes what landed, and the
 * poller's tick deletes what nobody pulled after a week, warning in the group the day before.
 *
 *   bun run inbox.ts list          print every item (JSON); only reads
 *   bun run inbox.ts ack <id>...   delete items that landed on the PC, with their files
 *   bun run inbox.ts get <id>      the bytes of one item's stored file
 *   bun run inbox.ts purge         delete what is due (the poller's tick does this too)
 *   bun run inbox.ts status        counts, for the health sweep
 *   bun run inbox.ts gate          the PC key's forced command: admits only list, ack and get
 *
 * list, ack and get reach the PC only through gate; guard.ts refuses all but status to the agent's turns.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./redact.ts";
import { withFileLock } from "./reminders.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InboxKind = "text" | "photo" | "document" | "video" | "voice" | "audio";
export interface InboxEntity {
  type: string;
  offset: number;
  length: number;
  url?: string; // text_link only: the URL hidden behind the link text
}
export interface InboxItem {
  id: string;
  messageId: number; // Telegram's message id: a message delivered twice is stored once
  mediaGroupId?: string; // Telegram's album id: the PC joins an album's pictures
  receivedAt: number; // the message's own Telegram date, epoch seconds
  kind: InboxKind;
  text?: string;
  entities?: InboxEntity[];
  caption?: string;
  captionEntities?: InboxEntity[];
  fileName?: string; // the name Telegram gave the file, for display only
  file?: string; // "files/<id>.<ext>", relative to the inbox folder; absent when the file did not come through
  size?: number; // the stored file's real size; only with `file`
  sha256?: string; // the stored file's checksum (hex); only with `file`
  reportedSize?: number; // what Telegram reported for a file that did not come through
  error?: string; // why the file did not come through
  warnedAt?: number; // when the group was told this item goes tomorrow
}
export interface InboxStore {
  v: 1;
  items: InboxItem[];
  issued?: { id: string; at: number }[]; // ids handed out in the last 10 days, live or gone: never reissued
}
/** The slice of a Telegram file object the inbox reads. */
export interface InboxFileRef {
  file_id: string;
  file_name?: string;
  file_size?: number;
}
/** The slice of a Telegram message the inbox reads (the poller's TgMessage fits it). */
export interface InboxMessage {
  message_id: number;
  date?: number;
  chat: { id: number; type?: string };
  from?: { id: number };
  media_group_id?: string;
  text?: string;
  entities?: InboxEntity[];
  caption?: string;
  caption_entities?: InboxEntity[];
  photo?: { file_id: string; file_size?: number }[];
  document?: InboxFileRef;
  video?: InboxFileRef;
  video_note?: InboxFileRef;
  animation?: InboxFileRef;
  voice?: InboxFileRef;
  audio?: InboxFileRef;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
}
/** What a message will be stored as, before its file is fetched. */
export interface InboxDraft {
  kind: InboxKind;
  mediaGroupId?: string;
  text?: string;
  entities?: InboxEntity[];
  caption?: string;
  captionEntities?: InboxEntity[];
  file?: { fileId: string; name?: string; size?: number };
}

export const ID_RE = /^\d{6}-[0-9a-f]{4}$/;
export const FILE_RE = /^files\/\d{6}-[0-9a-f]{4}\.[a-z0-9]{1,8}$/;

// ---------------------------------------------------------------------------
// Settings, ids, names
// ---------------------------------------------------------------------------

export function inboxDir(env: Record<string, string | undefined> = process.env): string {
  return env.INBOX_DIR ?? join(homedir(), "inbox");
}

/** INBOX_CHAT_ID as a group's chat id, or null (the inbox is off). Groups and supergroups have
 *  negative ids; anything else (a user id pasted by mistake included) is refused. */
export function parseInboxChatId(raw: string | undefined): number | null {
  const t = (raw ?? "").trim();
  if (!/^-\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n < 0 ? n : null;
}

const randomHex4 = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, "0")).join("");

/** "YYMMDD-xxxx": the message's local date (the server runs on Asia/Jerusalem) and four random
 *  hex digits not taken yet. */
export function newItemId(at: Date, taken: Set<string>, rand: () => string = randomHex4): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${p(at.getFullYear() % 100)}${p(at.getMonth() + 1)}${p(at.getDate())}`;
  for (let i = 0; i < 50; i++) {
    const id = `${day}-${rand()}`;
    if (ID_RE.test(id) && !taken.has(id)) return id;
  }
  throw new Error("could not find a free item id");
}

const EXT_RE = /\.([A-Za-z0-9]{1,8})$/;
const DEFAULT_EXT: Record<InboxKind, string> = { text: "txt", photo: "jpg", document: "bin", video: "mp4", voice: "oga", audio: "ogg" };
// The notes app opens these as live documents; stored as plain text instead.
const LIVE_EXT = new Set(["md", "markdown", "canvas", "base"]);

/** The stored file's name: the item id and an ASCII extension, never anything else the sender
 *  typed (the PC copies files down by name). */
export function diskName(id: string, kind: InboxKind, name?: string, remotePath?: string): string {
  const raw = (name && EXT_RE.exec(name)?.[1]) || (remotePath && EXT_RE.exec(remotePath)?.[1]) || DEFAULT_EXT[kind];
  const ext = raw.toLowerCase();
  return `${id}.${LIVE_EXT.has(ext) ? "txt" : ext}`;
}

// ---------------------------------------------------------------------------
// What a message becomes
// ---------------------------------------------------------------------------

// Service messages: ignored silently. Anything else the inbox cannot store is "unsupported".
const SERVICE_FIELDS = [
  "new_chat_members", "left_chat_member", "new_chat_title", "new_chat_photo", "delete_chat_photo",
  "group_chat_created", "supergroup_chat_created", "channel_chat_created", "pinned_message",
  "migrate_to_chat_id", "migrate_from_chat_id", "message_auto_delete_timer_changed",
  "video_chat_scheduled", "video_chat_started", "video_chat_ended", "video_chat_participants_invited",
  "forum_topic_created", "forum_topic_edited", "forum_topic_closed", "forum_topic_reopened",
  "general_forum_topic_hidden", "general_forum_topic_unhidden", "write_access_allowed",
  "chat_background_set", "boost_added", "users_shared", "chat_shared", "proximity_alert_triggered",
];

// Telegram's documented entity types (Bot API, MessageEntity); anything else is dropped.
export const ENTITY_TYPES = new Set([
  "mention", "hashtag", "cashtag", "bot_command", "url", "email", "phone_number", "bold", "italic",
  "underline", "strikethrough", "spoiler", "blockquote", "expandable_blockquote", "code", "pre",
  "text_link", "text_mention", "custom_emoji",
]);

/** Keep only documented entity types with sane offsets; a text_link keeps its URL only when it is
 *  http(s), and without one it is dropped (the PC's validation never meets a field it refuses). */
function cleanEntities(list: InboxEntity[] | undefined): InboxEntity[] | undefined {
  const out: InboxEntity[] = [];
  for (const e of list ?? []) {
    if (!ENTITY_TYPES.has(e.type) || !Number.isInteger(e.offset) || !Number.isInteger(e.length) || e.offset < 0 || e.length < 0) continue;
    if (e.type === "text_link") {
      if (typeof e.url !== "string" || !/^https?:\/\/\S+$/i.test(e.url)) continue;
      out.push({ type: e.type, offset: e.offset, length: e.length, url: e.url });
    } else {
      out.push({ type: e.type, offset: e.offset, length: e.length });
    }
  }
  return out.length ? out : undefined;
}

function fileOf(ref: InboxFileRef): NonNullable<InboxDraft["file"]> {
  const f: NonNullable<InboxDraft["file"]> = { fileId: ref.file_id };
  if (ref.file_name) f.name = ref.file_name;
  if (ref.file_size != null) f.size = ref.file_size;
  return f;
}

/** The item a message becomes; null for a service message (ignored silently); "unsupported" for
 *  everything else the inbox does not keep (the sender gets a short reply). */
export function describeInboxMessage(msg: InboxMessage): InboxDraft | "unsupported" | null {
  const withExtras = (d: InboxDraft): InboxDraft => {
    if (msg.media_group_id) d.mediaGroupId = msg.media_group_id;
    if (msg.caption) d.caption = msg.caption;
    const ce = cleanEntities(msg.caption_entities);
    if (ce) d.captionEntities = ce;
    return d;
  };
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1]; // Telegram sends sizes in ascending order
    const file: NonNullable<InboxDraft["file"]> = { fileId: largest.file_id };
    if (largest.file_size != null) file.size = largest.file_size;
    return withExtras({ kind: "photo", file });
  }
  // animation before document: Telegram sends an animation with a document beside it
  const video = msg.video ?? msg.video_note ?? msg.animation;
  if (video) return withExtras({ kind: "video", file: fileOf(video) });
  if (msg.document) return withExtras({ kind: "document", file: fileOf(msg.document) });
  if (msg.voice) return withExtras({ kind: "voice", file: fileOf(msg.voice) });
  if (msg.audio) return withExtras({ kind: "audio", file: fileOf(msg.audio) });
  if (msg.text) {
    const d: InboxDraft = { kind: "text", text: msg.text };
    const e = cleanEntities(msg.entities);
    if (e) d.entities = e;
    return d;
  }
  const fields = msg as unknown as Record<string, unknown>;
  if (SERVICE_FIELDS.some((f) => fields[f] !== undefined)) return null;
  return "unsupported";
}

// ---------------------------------------------------------------------------
// The store (~/inbox/items.json, outside the repo; override INBOX_DIR)
// ---------------------------------------------------------------------------

const itemsFile = (dir: string) => join(dir, "items.json");

export function emptyInbox(): InboxStore {
  return { v: 1, items: [] };
}

function parseInbox(raw: string): InboxStore | null {
  try {
    const s = JSON.parse(raw);
    return s && s.v === 1 && Array.isArray(s.items) ? (s as InboxStore) : null;
  } catch {
    return null;
  }
}

/** The store as it is now, for reading. A missing or unreadable file reads as empty. */
export function loadInbox(dir: string): InboxStore {
  let raw: string;
  try {
    raw = readFileSync(itemsFile(dir), "utf8");
  } catch {
    return emptyInbox();
  }
  return parseInbox(raw) ?? emptyInbox();
}

/** Load, change and save under the store's lock (the poller and the CLI both write it), via a
 *  temporary file renamed into place. Nothing is written when fn changed nothing. An unreadable
 *  file is kept aside as items.json.corrupt-<ms> and a fresh store starts. */
export function mutateInbox<T>(dir: string, fn: (s: InboxStore) => T, log: (line: string) => void = console.error): T {
  const path = itemsFile(dir);
  mkdirSync(dir, { recursive: true });
  return withFileLock(path, () => {
    let raw: string | null = null;
    try {
      raw = readFileSync(path, "utf8");
    } catch {}
    let store = raw === null ? null : parseInbox(raw);
    if (raw !== null && !store) {
      const aside = `${path}.corrupt-${Date.now()}`;
      try {
        renameSync(path, aside);
        log(`[INBOX] the store was unreadable; kept aside as ${aside}`);
      } catch (e: any) {
        log(`[INBOX] the store is unreadable and could not be set aside: ${e?.message ?? e}`);
      }
    }
    store ??= emptyInbox();
    const before = JSON.stringify(store);
    const out = fn(store);
    if (JSON.stringify(store) !== before) {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(store, null, 2));
      renameSync(tmp, path);
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Filing a message (the poller's handler; Telegram calls injected)
// ---------------------------------------------------------------------------

// Pure Hebrew and digits: nothing for the BiDi algorithm to reorder.
export const INBOX_TOO_LARGE = "הקובץ הזה לא נשמר בתיבה, הוא גדול מדי (מעל 20 מגה).";
export const INBOX_DOWNLOAD_FAILED = "הקובץ הזה לא נשמר בתיבה, ההורדה מטלגרם נכשלה. אפשר לשלוח אותו שוב.";
export const INBOX_UNSUPPORTED = "סוג הודעה כזה לא נשמר בתיבה.";
export const INBOX_STORE_FAILED = "לא הצלחתי לשמור את זה בתיבה.";
export const INBOX_MOVED = "הקבוצה קיבלה מספר זיהוי חדש. התיבה ממשיכה לעבוד, אבל צריך לעדכן את ההגדרה בשרת.";

/** How long a handed-out id stays reserved after it was issued (its item may be long gone). */
export const ISSUED_KEEP_S = 10 * 24 * 3600;

export interface InboxDeps {
  dir: string;
  now: () => Date;
  allowed: (fromId: string) => boolean;
  fetchFile: (fileId: string) => Promise<{ bytes: ArrayBuffer | Uint8Array; remotePath: string }>;
  react: (emoji: string) => Promise<void>;
  reply: (text: string) => Promise<void>;
  log: (line: string) => void;
  maxBytes: number;
  rand?: () => string;
}
export type InboxOutcome = "moved" | "skipped" | "ignored" | "unsupported" | "duplicate" | "stored" | "stored-with-error" | "failed";

/** Store one message from the inbox group as an item, then 👍 it (or say in one Hebrew line why
 *  its file did not come through). The journal gets the item's id and kind, never its words. */
export async function fileInboxMessage(msg: InboxMessage, d: InboxDeps): Promise<InboxOutcome> {
  if (msg.migrate_to_chat_id) return "moved"; // the poller's followInbox logs and acts on it
  if (!msg.from || !d.allowed(String(msg.from.id))) {
    d.log(`[INBOX] skipped message ${msg.message_id}: the sender is not on the allowlist`);
    return "skipped";
  }
  const draft = describeInboxMessage(msg);
  if (draft === null) {
    d.log(`[INBOX] nothing to store in message ${msg.message_id}`);
    return "ignored";
  }
  if (draft === "unsupported") {
    d.log(`[INBOX] message ${msg.message_id} is a kind the inbox does not keep`);
    await d.reply(INBOX_UNSUPPORTED);
    return "unsupported";
  }
  const store = loadInbox(d.dir);
  if (store.items.some((i) => i.messageId === msg.message_id)) {
    d.log(`[INBOX] message ${msg.message_id} is already stored`);
    return "duplicate";
  }

  const nowS = Math.floor(d.now().getTime() / 1000);
  const receivedAt = msg.date ?? nowS;
  const taken = new Set([...store.items.map((i) => i.id), ...(store.issued ?? []).map((x) => x.id)]);
  const id = newItemId(new Date(receivedAt * 1000), taken, d.rand);
  const item: InboxItem = { id, messageId: msg.message_id, receivedAt, kind: draft.kind };
  if (draft.mediaGroupId) item.mediaGroupId = draft.mediaGroupId;
  if (draft.text !== undefined) item.text = draft.text;
  if (draft.entities) item.entities = draft.entities;
  if (draft.caption !== undefined) item.caption = draft.caption;
  if (draft.captionEntities) item.captionEntities = draft.captionEntities;

  let failReply: string | null = null;
  if (draft.file) {
    if (draft.file.name) item.fileName = draft.file.name;
    if (draft.file.size != null && draft.file.size > d.maxBytes) {
      item.error = "too large";
      item.reportedSize = draft.file.size;
      failReply = INBOX_TOO_LARGE;
    } else {
      try {
        const got = await d.fetchFile(draft.file.fileId);
        const name = diskName(id, draft.kind, draft.file.name, got.remotePath);
        const filesDir = join(d.dir, "files");
        mkdirSync(filesDir, { recursive: true });
        const part = join(filesDir, `${name}.part`);
        const bytes = got.bytes instanceof Uint8Array ? got.bytes : new Uint8Array(got.bytes);
        writeFileSync(part, bytes);
        renameSync(part, join(filesDir, name));
        item.file = `files/${name}`;
        item.size = statSync(join(filesDir, name)).size;
        item.sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      } catch (e: any) {
        const why = redact(String(e?.message ?? e)).slice(0, 200);
        // Telegram's own refusal of a big file reads the same as the size pre-check, on both ends
        item.error = /too big/i.test(why) ? "too large" : why;
        if (draft.file.size != null) item.reportedSize = draft.file.size;
        failReply = item.error === "too large" ? INBOX_TOO_LARGE : INBOX_DOWNLOAD_FAILED;
      }
    }
  }

  let added: boolean;
  try {
    added = mutateInbox(
      d.dir,
      (s) => {
        if (s.items.some((i) => i.messageId === item.messageId)) return false; // a second delivery raced in
        s.items.push(item);
        s.issued = [...(s.issued ?? []).filter((x) => nowS - x.at < ISSUED_KEEP_S), { id, at: nowS }];
        return true;
      },
      d.log,
    );
  } catch (e: any) {
    d.log(`[INBOX] could not store item ${id}: ${e?.message ?? e}`);
    if (item.file) rmSync(join(d.dir, item.file), { force: true });
    await d.reply(INBOX_STORE_FAILED);
    // An album's reactions all land on its first message, where the next 👍 would overwrite this.
    if (!item.mediaGroupId) await d.react("👎");
    return "failed";
  }
  if (!added) {
    if (item.file) rmSync(join(d.dir, item.file), { force: true });
    return "duplicate";
  }
  d.log(`[INBOX] stored ${id} (${item.kind}${item.error ? ", its file did not come through" : ""})`);
  if (failReply) {
    await d.reply(failReply);
    return "stored-with-error";
  }
  await d.react("👍");
  return "stored";
}

/** The journal line for a message in a group that is not the inbox: once per chat and sender
 *  kind (setup reads the inbox's id from the line marked "yes"), and every move. */
export function foreignGroupNote(msg: InboxMessage, seen: Set<string>, allowed: (fromId: string) => boolean): string | null {
  const id = msg.chat.id;
  if (msg.migrate_to_chat_id) return `[INBOX?] chat ${id} moved to chat ${msg.migrate_to_chat_id}`;
  const yes = msg.from ? allowed(String(msg.from.id)) : false;
  const key = `${id}:${yes ? "yes" : "no"}`;
  if (seen.has(key)) return null;
  seen.add(key);
  return `[INBOX?] chat ${id} (${msg.chat.type ?? "unknown"}, sender allowlisted: ${yes ? "yes" : "no"}): a group that is not the inbox; never answered`;
}
