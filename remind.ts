/**
 * remind.ts — CLI the bot calls (via Bash) to manage reminders.
 *
 *   bun run remind.ts add-once   <chatId> <epochSeconds> <text...>
 *   bun run remind.ts add-repeat <chatId> <HH:MM> <daysCSV> <text...>   (days: 0=Sun..6=Sat)
 *   bun run remind.ts list       <chatId>
 *   bun run remind.ts edit       <chatId> <id> [--at <epoch>] [--time HH:MM] [--days <csv>] [--text "..."]
 *   bun run remind.ts cancel     <chatId> <id>          (ids look like r7, not 7)
 */

import { addOnce, addRepeat, listFor, cancel, editReminder, fmt, type ReminderEdit, snoozeFollowup } from "./reminders.ts";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const [cmd, chatIdRaw, ...rest] = process.argv.slice(2);
const chatId = Number(chatIdRaw);

if (!cmd) die("usage: remind.ts <add-once|add-repeat|list|cancel> <chatId> ...");
if (!Number.isFinite(chatId)) die(`invalid chatId: ${chatIdRaw}`);

const nowSec = Math.floor(Date.now() / 1000);

switch (cmd) {
  case "add-once": {
    const fireAt = Number(rest[0]);
    const text = rest.slice(1).join(" ").trim();
    if (!Number.isFinite(fireAt) || !text) die("usage: add-once <chatId> <epochSeconds> <text>");
    if (fireAt <= nowSec) die("that time is in the past");
    const r = addOnce(chatId, fireAt, text);
    console.log(`OK ${r.id} — one-time at ${fmt(r.fireAt)}: ${r.text}`);
    break;
  }
  case "add-repeat": {
    const m = /^(\d{1,2}):(\d{2})$/.exec(rest[0] ?? "");
    if (!m) die("usage: add-repeat <chatId> <HH:MM> <daysCSV> <text>");
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) die("invalid time");
    const days = (rest[1] ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    const text = rest.slice(2).join(" ").trim();
    if (!days.length || !text) die("need days (CSV of 0-6) and text");
    const r = addRepeat(chatId, hour, minute, days, text);
    console.log(`OK ${r.id} — repeats ${rest[0]} on days [${days.join(",")}], next ${fmt(r.fireAt)}: ${r.text}`);
    break;
  }
  case "list": {
    const items = listFor(chatId);
    if (!items.length) {
      console.log("(no reminders)");
      break;
    }
    for (const r of items) {
      console.log(`${r.id}  ${fmt(r.fireAt)}${r.repeat ? "  (repeats)" : ""}  ${r.text}`);
    }
    break;
  }
  // Only reachable when the poller injected a <snooze-ask> directive naming a
  // real follow-up id. Without that block the model has no valid id to pass,
  // which is the containment: this is not a general "reschedule anything"
  // surface. The poller still owns the buttons; this owns one reply to one ask.
  case "snooze-followup": {
    const f = new Map<string, string>();
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].startsWith("--") && rest[i + 1] != null) { f.set(rest[i].slice(2), rest[i + 1]); i++; }
    }
    const id = f.get("id");
    const at = Number(f.get("at"));
    if (!id || !Number.isFinite(at)) die('usage: snooze-followup --id <fuId> --at <epoch>');
    if (at <= Math.floor(Date.now() / 1000)) die("that time is already past — work out the next occurrence");
    const r = snoozeFollowup(id, at);
    if (!r) die(`no open follow-up with id ${id} (already done, snoozed, or expired)`);
    console.log(`OK snoozed «${r.followup.text}» to ${fmt(at)} (${r.reminder.id})`);
    break;
  }
  case "cancel": {
    const id = rest[0];
    if (!id) die("usage: cancel <chatId> <id>  (id looks like r7, not 7)");
    console.log(cancel(chatId, id) ? `cancelled ${id}` : `no reminder with id ${id}`);
    break;
  }
  case "edit": {
    // Move or reword in place instead of cancel + re-add, which mints a new id
    // and loses the reminder outright if the add half fails.
    const id = rest[0];
    if (!id) die('usage: edit <chatId> <id> [--at <epoch>] [--time HH:MM] [--days <csv>] [--text "..."]');
    const f = new Map<string, string>();
    for (let i = 1; i < rest.length; i++) {
      if (rest[i].startsWith("--") && rest[i + 1] != null) { f.set(rest[i].slice(2), rest[i + 1]); i++; }
    }
    const edit: ReminderEdit = {};
    if (f.has("at")) {
      const at = Number(f.get("at"));
      if (!Number.isFinite(at)) die("--at takes epoch seconds");
      edit.fireAt = at;
    }
    if (f.has("time")) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(f.get("time")!);
      if (!m) die("--time must be HH:MM");
      edit.hour = Number(m[1]);
      edit.minute = Number(m[2]);
    }
    if (f.has("days")) {
      const days = f.get("days")!.split(",").map((s) => Number(s.trim()));
      if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        die("--days must be a CSV of 0..6 (0=Sun)");
      }
      edit.days = days;
    }
    if (f.has("text")) edit.text = f.get("text")!;

    let updated;
    try {
      updated = editReminder(chatId, id, edit);
    } catch (e: any) {
      die(e?.message ?? String(e));
    }
    if (!updated) die(`no reminder with id ${id}`);
    console.log(
      `updated ${updated.id} — ${fmt(updated.fireAt)}${updated.repeat ? "  (repeats)" : ""}: ${updated.text}`,
    );
    break;
  }
  default:
    die(`unknown command: ${cmd}`);
}
