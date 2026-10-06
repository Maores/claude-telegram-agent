import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "poller.ts"), "utf8");
const ROLLBACK = "// Rollback mode: today's strictly sequential behavior";

/** The text of a function: from its declaration to its matching closing brace. */
function body(decl: string): string {
  const start = SRC.indexOf(decl);
  expect(start).toBeGreaterThan(-1);
  const open = SRC.indexOf("{", start + decl.length - 1);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${decl}`);
}

const MAIN = body("async function main()");
const LOOP = MAIN.slice(MAIN.indexOf("for (const u of updates)"));
const at = (s: string) => LOOP.indexOf(s);
const INBOX_IF = 'if (kind === "inbox")';
const FOREIGN_IF = 'if (kind === "foreign-group")';

test("the receive loop routes the inbox and other groups before every other path, rollback mode included", () => {
  expect(at("const kind = classifyUpdate(u, botUsername, inboxChatId);")).toBeGreaterThan(-1);
  expect(at(ROLLBACK)).toBeGreaterThan(-1);
  for (const marker of [INBOX_IF, FOREIGN_IF]) {
    expect(at(marker)).toBeGreaterThan(-1);
    expect(at(marker)).toBeLessThan(at(ROLLBACK));
    expect(at(marker)).toBeLessThan(at("switch (kind)"));
  }
  expect(at(INBOX_IF)).toBeLessThan(at(FOREIGN_IF));
  expect(LOOP.slice(at(INBOX_IF), at(FOREIGN_IF))).toContain("continue;");
  expect(LOOP.slice(at(FOREIGN_IF), at(ROLLBACK))).toContain("continue;");
  expect(SRC.match(/classifyUpdate\(/g)?.length).toBe(1);
});

test("an inbox message reaches only the inbox handler: no turn, no history, no debouncer", () => {
  const h = body("async function handleInboxMessage(");
  expect(h).toContain("fileInboxMessage(");
  for (const banned of ["handleMessage(", "debouncer", "Bun.spawn", "streamClaude", "insertMessage", "transcribe"]) expect(h).not.toContain(banned);
});

test("every inbox filing goes on one queue, so a group move never runs two filings at once", () => {
  expect(SRC).toMatch(/^const INBOX_QUEUE = 0;/m);
  const branch = LOOP.slice(at(INBOX_IF), at(FOREIGN_IF));
  expect(branch).toContain("chatQueues.enqueue(INBOX_QUEUE, () => handleInboxMessage(m));");
  expect(branch).not.toContain("chatQueues.enqueue(m.chat.id");
  expect(branch).toContain("if (serialMode) await handleInboxMessage(m)"); // rollback mode unchanged
});

test("a move of the inbox group is followed inside the loop and remembered", () => {
  expect(LOOP.slice(at(INBOX_IF), at(FOREIGN_IF))).toContain("followInbox(m.migrate_to_chat_id)");
  expect(LOOP.slice(at(FOREIGN_IF), at(ROLLBACK))).toContain("migrate_from_chat_id");
  const f = body("function followInbox(");
  expect(f).toContain("inboxChatId = to");
  expect(f).toContain("writeMoved(");
  expect(SRC).toContain("resolveInboxChatId(parseInboxChatId(process.env.INBOX_CHAT_ID), inboxDir())");
});

test("the lifetime tick runs every 30 seconds, stops with the process, and the drain waits for it", () => {
  expect(MAIN).toContain("void checkInbox();");
  expect(MAIN).toContain("inboxInFlight ?? Promise.resolve()");
  const tick = body("function checkInbox(");
  expect(tick).toContain("if (stopping) return Promise.resolve();");
  expect(tick).toContain("send: chatId === null ? null"); // unset: no sends, deletions still run
  // unset: the tick is skipped only when the folder itself is gone, so leftovers beside a missing
  // items.json are still swept
  expect(tick).toContain("if (chatId === null && !existsSync(inboxDir())) return Promise.resolve();");
  expect(tick).not.toMatch(/inboxChatId === null \|\|/); // no early return that skips the deletions
});
