/**
 * dispatch.ts — update triage + queues for the non-blocking receive loop.
 *
 * The poller's loop must never await long work: callbacks ACK instantly on
 * their own serialized chain, /stop is handled at dispatch (kill + drain),
 * and message turns run in strict per-chat FIFO order so history/recall
 * always see the previous turn completed. Spec:
 * docs/superpowers/specs/2026-06-11-nonblocking-loop-design.md
 */

/** True when `text` is exactly the /stop command (optionally @-mentioning this
 *  bot). Case-insensitive; trims surrounding whitespace. A normal message that
 *  merely contains "/stop" is not a stop command and never interrupts a run.
 *  (Moved verbatim from poller.ts so triage has no import cycle.) */
export function isStopCommand(text: string, botUsername: string): boolean {
  const t = (text ?? "").trim().toLowerCase();
  if (t === "/stop") return true;
  if (botUsername && t === `/stop@${botUsername.toLowerCase()}`) return true;
  return false;
}

/** The slice of a Telegram update that triage needs. */
export interface DispatchUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
  callback_query?: unknown;
}

export type UpdateKind = "callback" | "stop" | "message" | "ignore";

/** Triage an update WITHOUT doing any work. /stop outranks "message" so it
 *  interrupts instead of queueing behind the very turn it targets. */
export function classifyUpdate(u: DispatchUpdate, botUsername: string): UpdateKind {
  if (u.callback_query) return "callback";
  if (u.message) return isStopCommand(u.message.text ?? "", botUsername) ? "stop" : "message";
  return "ignore";
}

/** Per-chat FIFO of message turns: strict order within a chat, chats
 *  independent, one thrown job never breaks the chain. drop() (the /stop
 *  path) invalidates queued-but-unstarted jobs via an epoch bump — the
 *  running job is stopChild's problem, not ours. */
export class ChatQueues {
  private tails = new Map<number, Promise<void>>();
  private epochs = new Map<number, number>();
  private queued = new Map<number, number>();

  enqueue(chatId: number, job: () => Promise<void>): void {
    const epoch = this.epochs.get(chatId) ?? 0;
    this.queued.set(chatId, (this.queued.get(chatId) ?? 0) + 1);
    const tail = this.tails.get(chatId) ?? Promise.resolve();
    const next = tail
      .then(async () => {
        // Reached the head of the queue: no longer "queued".
        this.queued.set(chatId, Math.max(0, (this.queued.get(chatId) ?? 0) - 1));
        if ((this.epochs.get(chatId) ?? 0) !== epoch) return; // dropped by /stop
        await job();
      })
      .catch((e: any) => console.error(`[ERR] queued turn (chat ${chatId}): ${e?.message ?? e}`));
    this.tails.set(chatId, next);
  }

  /** Invalidate every queued-but-unstarted job for the chat. Returns how many. */
  drop(chatId: number): number {
    const n = this.queued.get(chatId) ?? 0;
    this.queued.set(chatId, 0); // eager: a second /stop must not re-count the same doomed jobs
    this.epochs.set(chatId, (this.epochs.get(chatId) ?? 0) + 1);
    return n;
  }

  /** Queued-but-unstarted turns for a chat (observability + tests). */
  pending(chatId: number): number {
    return this.queued.get(chatId) ?? 0;
  }

  /** Resolves when every job queued so far, in every chat, has finished.
   *  (Graceful-shutdown drain — a deploy restart must not eat queued turns.) */
  idle(): Promise<void> {
    return Promise.all([...this.tails.values()]).then(() => {});
  }
}

/** One global FIFO for callback queries: each handler ACKs in <1 s, and
 *  serializing them keeps followups.json single-writer within this process
 *  (two rapid button taps can no longer interleave their read-modify-write).
 *  Jobs are expected to finish in <1-2s (ACK + a couple of edits); a job that
 *  hangs (e.g. Telegram 429 with a long retry_after) stalls the chain — add a
 *  per-job timeout if that ever proves real. */
export class SerialChain {
  private tail: Promise<void> = Promise.resolve();
  enqueue(job: () => Promise<void>): void {
    this.tail = this.tail
      .then(job)
      .catch((e: any) => console.error(`[ERR] callback chain: ${e?.message ?? e}`));
  }

  /** Resolves when the chain has run dry (every job enqueued so far). */
  idle(): Promise<void> {
    return this.tail.then(() => {});
  }
}

/** Per-chat message debouncer: buffers a rapid burst and hands it to onFlush
 *  as one batch after `delayMs` of quiet (each arrival restarts the timer).
 *  Pure timer bookkeeping — what a flush MEANS is the caller's business. The
 *  caller must also cover the two paths a timer can't see: clear() on /stop
 *  (a stopped message must not resurrect when its window expires) and
 *  flushAll() on shutdown (the offset is already saved, so anything left
 *  buffered would be lost forever). */
export class Debouncer<T> {
  private buf = new Map<number, { timer: ReturnType<typeof setTimeout>; items: T[] }>();

  constructor(
    private delayMs: number,
    private onFlush: (chatId: number, items: T[]) => void,
  ) {}

  /** Buffer one item and (re)start the chat's quiet-period timer. */
  schedule(chatId: number, item: T): void {
    const e = this.buf.get(chatId);
    if (e) {
      clearTimeout(e.timer);
      e.items.push(item);
      e.timer = setTimeout(() => this.flushNow(chatId), this.delayMs);
    } else {
      this.buf.set(chatId, { items: [item], timer: setTimeout(() => this.flushNow(chatId), this.delayMs) });
    }
  }

  /** Flush one chat immediately (no-op when nothing is buffered). */
  flushNow(chatId: number): void {
    const e = this.buf.get(chatId);
    if (!e) return;
    clearTimeout(e.timer);
    this.buf.delete(chatId);
    try {
      this.onFlush(chatId, e.items);
    } catch (err: any) {
      console.error(`[ERR] debounce flush (chat ${chatId}): ${err?.message ?? err}`);
    }
  }

  /** Drop a chat's buffer without flushing (the /stop path). Returns count. */
  clear(chatId: number): number {
    const e = this.buf.get(chatId);
    if (!e) return 0;
    clearTimeout(e.timer);
    this.buf.delete(chatId);
    return e.items.length;
  }

  /** Flush every chat now (graceful-shutdown drain). */
  flushAll(): void {
    for (const chatId of [...this.buf.keys()]) this.flushNow(chatId);
  }

  /** Buffered items for a chat (observability + tests). */
  pending(chatId: number): number {
    return this.buf.get(chatId)?.items.length ?? 0;
  }
}
