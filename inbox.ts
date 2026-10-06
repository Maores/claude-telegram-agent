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

// ---------------------------------------------------------------------------
// Lifetime (owner's choice, 2026-10-05): deleted once it landed on the PC (ack), or after a week,
// never sooner than a day after a warning in the group, and never later than ten days. The
// poller's tick drives it.
// ---------------------------------------------------------------------------

export const WARN_AFTER_S = 6 * 24 * 3600;
export const KEEP_S = 7 * 24 * 3600;
export const WARN_STANDS_S = 24 * 3600;
export const HARD_CAP_S = 10 * 24 * 3600;
export const ORPHAN_AFTER_S = 3600;
export const CORRUPT_KEEP_S = 7 * 24 * 3600;
/** The poller's MAX_FILE_BYTES default: Telegram's getFile cap for bots. */
export const MAX_GET_BYTES = 20 * 1024 * 1024;

/** A warning is due when an unwarned item turns 6 days old; it then also covers every unwarned
 *  item within 6 hours of that age, so a burst sent together gets one message. */
export const WARN_BATCH_S = 6 * 3600;
export function dueWarnings(s: InboxStore, nowS: number): InboxItem[] {
  const unwarned = s.items.filter((i) => i.warnedAt === undefined);
  if (!unwarned.some((i) => nowS - i.receivedAt >= WARN_AFTER_S)) return [];
  return unwarned.filter((i) => nowS - i.receivedAt >= WARN_AFTER_S - WARN_BATCH_S);
}

/** Items due for deletion: past the hard cap always; past the week only after a warning that
 *  stood a day, and never inside quiet time. */
export function expiredItems(s: InboxStore, nowS: number, quiet: boolean): InboxItem[] {
  return s.items.filter((i) => {
    const age = nowS - i.receivedAt;
    if (age >= HARD_CAP_S) return true;
    return !quiet && age >= KEEP_S && i.warnedAt !== undefined && nowS - i.warnedAt >= WARN_STANDS_S;
  });
}

/** Pure Hebrew and digits. */
export function inboxWarningText(n: number): string {
  return n === 1
    ? "בתיבה יש פריט אחד שעוד לא נמשך למחשב. מחר הוא יימחק מהשרת, והמקור נשאר כאן בקבוצה."
    : `בתיבה יש ${n} פריטים שעוד לא נמשכו למחשב. מחר הם יימחקו מהשרת, והמקור נשאר כאן בקבוצה.`;
}

/** Delete an item's file, but only a path the inbox itself could have written. */
function removeItemFile(dir: string, item: InboxItem, log: (line: string) => void): void {
  if (!item.file) return;
  if (!FILE_RE.test(item.file)) {
    log(`[INBOX] item ${item.id} named a file outside files/; not removed`);
    return;
  }
  rmSync(join(dir, item.file), { force: true });
}

function removeWhere(dir: string, pick: (s: InboxStore) => InboxItem[], log: (line: string) => void): InboxItem[] {
  const gone = mutateInbox(
    dir,
    (s) => {
      const out = pick(s);
      if (out.length) s.items = s.items.filter((i) => !out.includes(i));
      return out;
    },
    log,
  );
  for (const item of gone) removeItemFile(dir, item, log);
  return gone;
}

export function removeExpired(dir: string, nowS: number, quiet: boolean, log: (line: string) => void): number {
  return removeWhere(dir, (s) => expiredItems(s, nowS, quiet), log).length;
}

/** Delete what a crash can leave behind: a file in files/ that no item names (or a .part file),
 *  older than an hour, and a set-aside unreadable store older than a week. Never logs a name. */
export function sweepLeftovers(dir: string, nowMs: number, log: (line: string) => void): number {
  let n = 0;
  // Only a readable store may say which files are orphans: a missing or broken one would make
  // every stored file look unnamed (its set-aside copy still names them).
  // And not while a recent set-aside copy exists: a store rebuilt after a corruption names only
  // what arrived since, and the copy is what a recovery would read.
  let storeOk = false;
  try {
    const s = JSON.parse(readFileSync(join(dir, "items.json"), "utf8"));
    storeOk = !!s && s.v === 1 && Array.isArray(s.items);
  } catch {}
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith("items.json.corrupt-") && nowMs - statSync(join(dir, name)).mtimeMs < CORRUPT_KEEP_S * 1000) storeOk = false;
    }
  } catch {}
  const named = new Set(loadInbox(dir).items.map((i) => i.file).filter((f): f is string => !!f));
  const old = (p: string, limitS: number) => {
    try {
      return nowMs - statSync(p).mtimeMs >= limitS * 1000;
    } catch {
      return false;
    }
  };
  let files: string[] = [];
  try {
    if (storeOk) files = readdirSync(join(dir, "files"));
  } catch {}
  for (const name of files) {
    const p = join(dir, "files", name);
    if (named.has(`files/${name}`) || !old(p, ORPHAN_AFTER_S)) continue;
    rmSync(p, { force: true });
    n++;
  }
  let top: string[] = [];
  try {
    top = readdirSync(dir);
  } catch {}
  for (const name of top) {
    const p = join(dir, name);
    if (!name.startsWith("items.json.corrupt-") || !old(p, CORRUPT_KEEP_S)) continue;
    rmSync(p, { force: true });
    n++;
  }
  if (n) log(`[INBOX] removed ${n} leftover file(s)`);
  return n;
}

/** One pass of the poller's 30-second tick. With `send` null (the setting unset) nothing is sent
 *  and only the deletions run. The warning is held while quiet time is on or starts within a day.
 *  The due items are marked warned BEFORE the send (a store that cannot be written then sends
 *  nothing, instead of the same warning every 30 seconds), and the marks are taken back when the
 *  send fails; a failure is logged at most once an hour (errClock). The deletions and the
 *  leftover sweep run whatever happened. */
export async function runInboxTick(d: {
  dir: string;
  nowS: number;
  quietAt: (ms: number) => boolean;
  send: ((text: string) => Promise<void>) | null;
  log: (line: string) => void;
  errClock: { at: number };
}): Promise<void> {
  const nowMs = d.nowS * 1000;
  const quiet = d.quietAt(nowMs);
  const logOnce = (line: string) => {
    if (d.nowS - d.errClock.at < 3600) return;
    d.errClock.at = d.nowS;
    d.log(line);
  };
  // Deletions first, so a warning never counts an item deleted in the same tick. A store that
  // cannot be written must not stop the warning step or the sweep, nor reject the tick.
  try {
    const n = removeExpired(d.dir, d.nowS, quiet, d.log);
    if (n) d.log(`[INBOX] deleted ${n} item(s) after their week`);
  } catch (e: any) {
    logOnce(`[INBOX] could not delete the items due: ${redact(String(e?.message ?? e))}`);
  }
  let held = quiet || d.send === null;
  for (let h = 1; h <= 24 && !held; h++) held = d.quietAt(nowMs + h * 3600_000);
  if (!held && d.send) {
    let marked: string[] = [];
    let waiting = 0;
    try {
      [marked, waiting] = mutateInbox(d.dir, (s) => {
        const ids = dueWarnings(s, d.nowS).map((i) => i.id);
        for (const i of s.items) if (ids.includes(i.id)) i.warnedAt = d.nowS;
        return [ids, s.items.filter((i) => i.warnedAt !== undefined).length] as [string[], number];
      }, d.log);
    } catch (e: any) {
      logOnce(`[INBOX] could not mark items warned, so no warning was sent: ${redact(String(e?.message ?? e))}`);
    }
    if (marked.length) {
      try {
        await d.send(inboxWarningText(waiting));
        d.log(`[INBOX] warned the group about ${waiting} item(s) due tomorrow`);
      } catch (e: any) {
        logOnce(`[INBOX] the warning could not be sent: ${redact(String(e?.message ?? e))}`);
        try {
          mutateInbox(d.dir, (s) => {
            for (const i of s.items) if (marked.includes(i.id) && i.warnedAt === d.nowS) delete i.warnedAt;
          }, d.log);
        } catch (e2: any) {
          // never through logOnce: these items will now go without their warning
          d.log(`[INBOX] a warning was not sent and its marks could not be taken back: ${redact(String(e2?.message ?? e2))}`);
        }
      }
    }
  }
  try {
    sweepLeftovers(d.dir, nowMs, d.log);
  } catch (e: any) {
    logOnce(`[INBOX] could not sweep leftover files: ${redact(String(e?.message ?? e))}`);
  }
}

// ---------------------------------------------------------------------------
// The CLI. list/ack/get reach the PC only through `gate`, which the PC key's authorized_keys line
// forces; `status` is for the agent and the health sweep.
// ---------------------------------------------------------------------------

export interface InboxCliIo {
  out: (s: string) => void;
  outBytes: (b: Uint8Array) => Promise<void> | void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  now: () => Date;
}

const INBOX_USAGE = "usage: inbox.ts list | ack <id>... | get <id> | purge | status | gate";
const GATE_REFUSED = "refused: the inbox key may only list, ack or get";

export async function runInboxCli(argv: string[], io: InboxCliIo): Promise<number> {
  const [cmd, ...rest] = argv;
  const dir = inboxDir(io.env);
  const nowS = Math.floor(io.now().getTime() / 1000);
  if (cmd === "gate") {
    // The PC key's forced command. Only lowercase letters, digits, single spaces and dashes; then
    // exactly one of three shapes. Nothing is passed to a shell.
    const req = io.env.SSH_ORIGINAL_COMMAND ?? "";
    if (!/^[a-z0-9 -]{1,4000}$/.test(req)) {
      io.err(GATE_REFUSED);
      return 2;
    }
    const [op, ...args] = req.split(" ");
    if (op === "list" && args.length === 0) return runInboxCli(["list"], io);
    if (op === "ack" && args.length >= 1 && args.length <= 200 && args.every((a) => ID_RE.test(a))) return runInboxCli(["ack", ...args], io);
    if (op === "get" && args.length === 1 && ID_RE.test(args[0])) return runInboxCli(["get", args[0]], io);
    io.err(GATE_REFUSED);
    return 2;
  }
  if (cmd === "list") {
    // Only reads: deleting here could destroy the very items a pull came to fetch.
    const items = [...loadInbox(dir).items].sort((a, b) => a.receivedAt - b.receivedAt || a.messageId - b.messageId || a.id.localeCompare(b.id));
    io.out(JSON.stringify({ v: 1, items }) + "\n");
    return 0;
  }
  if (cmd === "ack") {
    if (!rest.length || !rest.every((id) => ID_RE.test(id))) {
      io.err(INBOX_USAGE);
      return 2;
    }
    const wanted = new Set(rest);
    const gone = removeWhere(dir, (s) => s.items.filter((i) => wanted.has(i.id)), io.err);
    const acked = gone.map((i) => i.id);
    io.out(JSON.stringify({ v: 1, acked, unknown: rest.filter((id) => !acked.includes(id)) }) + "\n");
    return 0;
  }
  if (cmd === "get") {
    if (rest.length !== 1 || !ID_RE.test(rest[0])) {
      io.err(`refused: ${INBOX_USAGE}`);
      return 2;
    }
    const item = loadInbox(dir).items.find((i) => i.id === rest[0]);
    if (!item?.file || !FILE_RE.test(item.file)) {
      io.err("refused: no stored file for that id");
      return 2;
    }
    const path = join(dir, item.file);
    let bytes: Uint8Array;
    try {
      if (statSync(path).size > MAX_GET_BYTES) {
        io.err("refused: the file is over the cap");
        return 2;
      }
      bytes = readFileSync(path);
    } catch {
      io.err("refused: the file is missing");
      return 2;
    }
    await io.outBytes(bytes);
    return 0;
  }
  if (cmd === "purge") {
    const n = removeExpired(dir, nowS, false, io.err);
    sweepLeftovers(dir, io.now().getTime(), io.err);
    io.out(JSON.stringify({ v: 1, purged: n }) + "\n");
    return 0;
  }
  if (cmd === "status") {
    const items = loadInbox(dir).items;
    let files = 0;
    let bytes = 0;
    try {
      for (const name of readdirSync(join(dir, "files"))) {
        files++;
        bytes += statSync(join(dir, "files", name)).size;
      }
    } catch {}
    const oldest = items.reduce<number | null>((m, i) => (m === null || i.receivedAt < m ? i.receivedAt : m), null);
    io.out(JSON.stringify({ v: 1, waiting: items.length, files, bytes, oldestAgeS: oldest === null ? null : nowS - oldest }) + "\n");
    return 0;
  }
  io.err(INBOX_USAGE);
  return 1;
}

// ---------------------------------------------------------------------------
// A moved group (Telegram upgraded it to a supergroup): remembered until the setting is updated
// ---------------------------------------------------------------------------

export function writeMoved(dir: string, from: number, to: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "moved.json"), JSON.stringify({ from, to }));
}

/** The inbox chat to use: the setting, or the group it moved to while the setting still names
 *  the old one. */
export function resolveInboxChatId(envId: number | null, dir: string): number | null {
  if (envId === null) return null;
  try {
    const m = JSON.parse(readFileSync(join(dir, "moved.json"), "utf8"));
    if (m && m.from === envId && Number.isSafeInteger(m.to) && m.to < 0) return m.to;
  } catch {}
  return envId;
}

if (import.meta.main) {
  const code = await runInboxCli(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    outBytes: async (b) => void (await Bun.write(Bun.stdout, b)), // awaited, so exit never cuts a file short
    err: (s) => console.error(s),
    env: process.env,
    now: () => new Date(),
  });
  process.exit(code);
}
