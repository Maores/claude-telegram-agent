/**
 * choices.ts — the pending-choices store behind the inline multiple-choice
 * buttons (D3). Mirrors pending.ts exactly, with a different payload: a
 * question + 2-4 options instead of a frozen argv.
 *
 * The bot's claude child REGISTERS a question here (via ask.ts) instead of
 * answering it; the poller sends one button per option and, on a tap, feeds
 * the chosen option to a FRESH claude turn. Unlike a confirm proposal a choice
 * runs nothing — the tapped option is treated as untrusted user text on the
 * next turn, so there is no validateArgv gate here.
 *
 * Turn-tagged, once-only consumption, 1-hour expiry, withFileLock. Spec:
 * docs/superpowers/specs/2026-06-15-d3-choice-buttons-design.md
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "./reminders.ts";

export interface Choice {
  id: string;
  chatId: number;
  question: string;
  options: string[]; // 2-4
  allowOther: boolean;
  createdAt: number; // epoch seconds
  status: "pending" | "answered" | "expired";
  turnId: string;
}

export type ConsumeChoiceResult =
  | { outcome: "ok"; choice: Choice }
  | { outcome: "stale" }
  | { outcome: "expired" };

const EXPIRY_S = 3600; // tappable for one hour (Maor's call, 2026-06-15)
const PRUNE_AFTER_S = 24 * 3600; // resolved/expired entries linger a day for debugging

function choicesPath(): string {
  return process.env.CHOICES_FILE ?? join(import.meta.dir, "choices.json");
}

function loadChoices(): Choice[] {
  try {
    const data = JSON.parse(readFileSync(choicesPath(), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveChoices(list: Choice[]) {
  const path = choicesPath();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, path);
}

/** Register a question. Throws on an out-of-range option count — the bot should
 *  rephrase, not store a dud. Pure validation, no I/O before the count check. */
export function proposeChoice(
  chatId: number,
  question: string,
  options: string[],
  allowOther: boolean,
  turnId: string,
  nowS: number,
): Choice {
  if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
    throw new Error("a choice needs between 2 and 4 options");
  }
  if (!options.every((o) => typeof o === "string" && o.trim().length > 0)) {
    throw new Error("every option must be a non-empty string");
  }
  return withFileLock(choicesPath(), () => {
    const list = loadChoices();
    const c: Choice = {
      id: `ch${Date.now()}${Math.floor(Math.random() * 1000)}`,
      chatId,
      question,
      options,
      allowOther,
      createdAt: nowS,
      status: "pending",
      turnId,
    };
    list.push(c);
    saveChoices(list);
    return c;
  });
}

/** Pending questions registered during one specific turn (the poller's
 *  post-turn pickup). Read-only. */
export function takePendingChoices(chatId: number, turnId: string): Choice[] {
  return loadChoices().filter(
    (c) => c.status === "pending" && c.chatId === chatId && c.turnId === turnId,
  );
}

/** pending → answered exactly once; expired when 1h passed. Anything else
 *  (missing / already answered) is stale; already-expired stays expired
 *  (terminal + idempotent, so a repeat tap never reads as "already answered"). */
export function consumeChoice(id: string, nowS: number): ConsumeChoiceResult {
  return withFileLock(choicesPath(), () => {
    const list = loadChoices();
    const c = list.find((x) => x.id === id);
    if (!c) return { outcome: "stale" } as const;
    if (c.status === "expired") return { outcome: "expired" } as const;
    if (c.status !== "pending") return { outcome: "stale" } as const;
    if (nowS - c.createdAt > EXPIRY_S) {
      c.status = "expired";
      saveChoices(list);
      return { outcome: "expired" } as const;
    }
    c.status = "answered";
    saveChoices(list);
    return { outcome: "ok", choice: c } as const;
  });
}

/** Housekeeping: expire overdue pendings, drop resolved/expired entries older
 *  than a day. Piggybacks the reminder tick (quiet expiry, no nudge). */
export function pruneChoices(nowS: number) {
  withFileLock(choicesPath(), () => {
    const list = loadChoices();
    for (const c of list) {
      if (c.status === "pending" && nowS - c.createdAt > EXPIRY_S) c.status = "expired";
    }
    const keep = list.filter(
      (c) => c.status === "pending" || nowS - c.createdAt <= PRUNE_AFTER_S,
    );
    saveChoices(keep);
  });
}
