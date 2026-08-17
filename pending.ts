/**
 * pending.ts — the pending-actions store behind the confirm buttons.
 *
 * The bot's claude child REGISTERS a write here (frozen argv + human summary)
 * instead of executing it; the poller sends ✓/✗ buttons and, on approval,
 * executes exactly the stored argv. Security gate: validateArgv (hard
 * allowlist + guard blocklist), no shell anywhere, once-only consumption,
 * 24h expiry. Spec: docs/superpowers/specs/2026-06-12-confirm-buttons-design.md
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "./reminders.ts";
import { checkCommand } from "./guard.ts";

export interface PendingAction {
  id: string;
  chatId: number;
  summary: string;
  argv: string[];
  createdAt: number; // epoch seconds
  status: "pending" | "approved" | "cancelled" | "expired";
  turnId: string;
  /** Morning re-ping already sent (absent on records from before 2026-08-16). */
  nudged?: boolean;
  /** Telegram message currently carrying this proposal's buttons, so the
   *  nudge can strip the old keyboard instead of leaving two live sets
   *  (the lesson PR #15 already learned for reminder follow-ups). */
  messageId?: number;
}

export type ConsumeResult =
  | { outcome: "ok"; action: PendingAction }
  | { outcome: "stale" }
  | { outcome: "expired" };

const EXPIRY_S = 24 * 3600; // tappable for 24h (Maor's call, 2026-06-12)
const PRUNE_AFTER_S = 7 * 24 * 3600; // resolved entries linger a week for debugging

function pendingPath(): string {
  return process.env.PENDING_FILE ?? join(import.meta.dir, "pending.json");
}

function loadActions(): PendingAction[] {
  try {
    const data = JSON.parse(readFileSync(pendingPath(), "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveActions(list: PendingAction[]) {
  const path = pendingPath();
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(list, null, 2));
  renameSync(tmp, path);
}

/** Only these exact (script, subcommand) pairs may ever execute. Email drafts
 *  are deliberately absent — they need a claude session, not a CLI. */
const ALLOWED: Array<{ script: string; subs: string[] }> = [
  { script: "cal.ts", subs: ["add", "edit", "delete"] },
  { script: "todo.ts", subs: ["delete"] },
];

/** The execution gate. Checked at propose time AND again at execution time.
 *  Pure — no I/O. */
export function validateArgv(argv: unknown): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(argv) || argv.length < 4) {
    return { ok: false, reason: "argv must be an array of at least 4 strings" };
  }
  if (!argv.every((a) => typeof a === "string" && a.length > 0 && !a.includes("\0"))) {
    return { ok: false, reason: "argv elements must be non-empty strings" };
  }
  const [a0, a1, a2, a3] = argv as string[];
  if (a0 !== "bun" || a1 !== "run") return { ok: false, reason: "argv must start with: bun run" };
  const rule = ALLOWED.find((r) => r.script === a2);
  if (!rule) return { ok: false, reason: `script not allowlisted: ${a2}` };
  if (!rule.subs.includes(a3)) return { ok: false, reason: `subcommand not allowed: ${a2} ${a3}` };
  const guard = checkCommand((argv as string[]).join(" "));
  if (guard.verdict === "block") return { ok: false, reason: guard.reason ?? "blocked by guard" };
  return { ok: true };
}

/** Turn ids tie proposals to the claude run that made them. */
export function newTurnId(): string {
  return `t${Date.now()}${Math.floor(Math.random() * 10_000)}`;
}

/** Register a proposal. Throws if the argv fails the gate — the bot should
 *  rephrase, not store a dud. */
export function proposeAction(
  chatId: number,
  summary: string,
  argv: string[],
  turnId: string,
  nowS: number,
): PendingAction {
  const v = validateArgv(argv);
  if (!v.ok) throw new Error(`refused to register: ${v.reason}`);
  return withFileLock(pendingPath(), () => {
    const list = loadActions();
    const a: PendingAction = {
      id: `pa${Date.now()}${Math.floor(Math.random() * 1000)}`,
      chatId,
      summary,
      argv,
      createdAt: nowS,
      status: "pending",
      turnId,
    };
    list.push(a);
    saveActions(list);
    return a;
  });
}

/** Pending proposals registered during one specific turn (the poller's
 *  post-turn pickup). Read-only. */
export function takePending(chatId: number, turnId: string): PendingAction[] {
  return loadActions().filter(
    (a) => a.status === "pending" && a.chatId === chatId && a.turnId === turnId,
  );
}

/** pending → approved/cancelled exactly once; expired when 24h passed.
 *  Anything else (missing / already resolved / already expired) is stale. */
export function consumeAction(id: string, to: "approved" | "cancelled", nowS: number): ConsumeResult {
  return withFileLock(pendingPath(), () => {
    const list = loadActions();
    const a = list.find((x) => x.id === id);
    if (!a) return { outcome: "stale" } as const;
    // pruneActions may have flipped it to expired already — that's terminal
    // and idempotent: every later tap still reports expired, never "stale"
    // (which would read as "already executed").
    if (a.status === "expired") return { outcome: "expired" } as const;
    if (a.status !== "pending") return { outcome: "stale" } as const;
    if (nowS - a.createdAt > EXPIRY_S) {
      a.status = "expired";
      saveActions(list);
      return { outcome: "expired" } as const;
    }
    a.status = to;
    saveActions(list);
    return { outcome: "ok", action: a } as const;
  });
}

/** Housekeeping: expire overdue pendings, drop resolved/expired entries older
 *  than a week. Piggybacks the reminder tick. */
export function pruneActions(nowS: number) {
  withFileLock(pendingPath(), () => {
    const list = loadActions();
    for (const a of list) {
      if (a.status === "pending" && nowS - a.createdAt > EXPIRY_S) a.status = "expired";
    }
    const keep = list.filter(
      (a) => a.status === "pending" || nowS - a.createdAt <= PRUNE_AFTER_S,
    );
    saveActions(keep);
  });
}

/** Open proposals for a chat (CLI `list` + debugging). */
export function listPending(chatId: number): PendingAction[] {
  return loadActions().filter((a) => a.status === "pending" && a.chatId === chatId);
}

// --- morning nudge (2026-08-16) ---------------------------------------------
// A month-long audit found 5 of 7 proposals expiring untapped. The one that
// cost something was proposed at 23:16 for a 09:34 appointment the next
// morning: the buttons arrived while Maor slept and the proposal outlived the
// appointment itself. An expiry warning is useless there (it fires 24h after
// creation, hours AFTER the event) — what helps is one re-ping at breakfast.

/** Local hour when still-open proposals get their one re-ping. */
export const NUDGE_HOUR = 9;
/** Don't nudge a proposal younger than this — a 08:50 proposal untapped at
 *  09:00 is unanswered, not forgotten. */
const NUDGE_MIN_AGE_S = 3600;

/** Proposals due their single morning re-ping. Pure with respect to time: the
 *  caller supplies the local hour (the droplet clock is Asia/Jerusalem; tests
 *  run under TZ=UTC and must not depend on the machine). */
export function dueMorningNudges(nowS: number, localHour: number): PendingAction[] {
  if (localHour !== NUDGE_HOUR) return [];
  return loadActions().filter(
    (a) =>
      a.status === "pending" &&
      !a.nudged &&
      nowS - a.createdAt >= NUDGE_MIN_AGE_S &&
      nowS - a.createdAt <= EXPIRY_S,
  );
}

/** Point a proposal at the message currently showing its buttons. Called
 *  after the first send and again after each nudge, so exactly one message
 *  is ever the live one. */
export function bindActionMessage(id: string, messageId: number) {
  withFileLock(pendingPath(), () => {
    const list = loadActions();
    const a = list.find((x) => x.id === id);
    if (a) {
      a.messageId = messageId;
      saveActions(list);
    }
  });
}

/** Flip the nudged flag. Called BEFORE the send (state-before-effect, same
 *  ordering as the follow-up nudge): a lost nudge beats a double-nudge. */
export function markActionNudged(id: string) {
  withFileLock(pendingPath(), () => {
    const list = loadActions();
    const a = list.find((x) => x.id === id);
    if (a) {
      a.nudged = true;
      saveActions(list);
    }
  });
}
