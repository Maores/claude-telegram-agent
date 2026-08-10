/**
 * voice-confirm.ts — transcripts held for Maor's confirmation.
 *
 * When a transcript is low-confidence or contains characters his speech cannot
 * produce, the poller shows it with ✓/✗ buttons and generates NO answer until he
 * taps. On 2026-08-04 his Hebrew came back as "Hola, ¿qué te pasa?" at 0.40
 * confidence, the agent answered the invented Spanish, and the speech engine
 * faithfully read the nonsense aloud — which made the voice feature look broken
 * when it was working perfectly on broken input.
 *
 * He chose a tap over "say it again" because when the transcript is close
 * enough, confirming beats re-recording the whole thing.
 *
 * Same shape as the choice store: consume-once, expiring, file-backed. No
 * database, so it survives restarts without touching bot.db.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How long a pending transcript stays tappable. Past this the audio is long
 *  gone from Maor's attention and answering it would be a surprise. */
const PENDING_TTL_S = 3600;

export interface PendingVoice {
  id: string;
  chatId: number;
  text: string;
  kind: "voice" | "audio";
  createdAt: number;
  /** A debounced burst confirmed as ONE unit (Maor's pick, 2026-08-10: "confirm
   *  the whole batch or nothing"). The batch's prompt and history line are built
   *  once, when the burst is assembled, and carried here so the confirmed turn
   *  replays the burst exactly instead of re-deriving it from a single
   *  transcript. Absent on ordinary single-recording entries, including any
   *  already sitting in the store when this shipped. */
  batch?: {
    /** The exact merged prompt the turn should run. */
    prompt: string;
    /** The exact line history/recall should store for the burst. */
    historyNote: string;
    /** How many messages the burst contained, for the log line. */
    size: number;
  };
}

function pendingPath(): string {
  return process.env.VOICE_PENDING_FILE || join(import.meta.dir, "voice-pending.json");
}

/** Exported for tests and for answering "what is still waiting on a tap?". */
export function loadPending(): PendingVoice[] {
  try {
    const p = pendingPath();
    if (!existsSync(p)) return [];
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    // A corrupt store must not wedge voice notes — start over rather than throw.
    return [];
  }
}

function save(list: PendingVoice[]): void {
  try {
    writeFileSync(pendingPath(), JSON.stringify(list, null, 2));
  } catch {
    // A transcript that cannot be persisted just means its buttons go stale.
    // Never worth failing the turn over.
  }
}

/** Park a transcript awaiting Maor's ✓/✗. Prunes expired entries on the way in
 *  so an unanswered week of taps can't grow the file without bound. */
export function addPending(
  chatId: number,
  text: string,
  kind: "voice" | "audio",
  nowEpoch = Math.floor(Date.now() / 1000),
  batch?: PendingVoice["batch"],
): PendingVoice {
  const list = loadPending().filter((p) => p.createdAt + PENDING_TTL_S > nowEpoch);
  const taken = new Set(list.map((p) => p.id));
  let id = `v${Date.now()}`;
  while (taken.has(id)) id += "x"; // same-millisecond safety bump
  const pending: PendingVoice = { id, chatId, text, kind, createdAt: nowEpoch, ...(batch ? { batch } : {}) };
  list.push(pending);
  save(list);
  return pending;
}

/** Take a pending transcript exactly once. An expired entry is still removed,
 *  so a stale button can never be replayed into an answer. */
export function consumePending(
  id: string,
  nowEpoch = Math.floor(Date.now() / 1000),
): { outcome: "ok"; pending: PendingVoice } | { outcome: "stale" } | { outcome: "expired" } {
  const list = loadPending();
  const found = list.find((p) => p.id === id);
  if (!found) return { outcome: "stale" };
  save(list.filter((p) => p.id !== id));
  if (found.createdAt + PENDING_TTL_S <= nowEpoch) return { outcome: "expired" };
  return { outcome: "ok", pending: found };
}

// callback_data protocol (≤64 bytes): "vc:<pendingId>:<y|n>".
// Deliberately disjoint from the fu:/fuu:/qz:/pa:/ch: namespaces — a collision
// would route another feature's taps into this handler.

export function parseVcCallback(data: string): { id: string; ok: boolean } | null {
  const m = /^vc:([^:]+):(y|n)$/.exec(data ?? "");
  if (!m) return null;
  return { id: m[1]!, ok: m[2] === "y" };
}

export function vcKeyboard(id: string) {
  return {
    inline_keyboard: [
      [
        { text: "✓ כן, זה מה שאמרתי", callback_data: `vc:${id}:y` },
        { text: "✗ לא", callback_data: `vc:${id}:n` },
      ],
    ],
  };
}
