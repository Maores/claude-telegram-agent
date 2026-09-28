/**
 * rchannel-pc.ts — the PC half of the routine channel (DEPLOY.md step 15, spec
 * docs/superpowers/specs/2026-09-27-routine-channel-design.md).
 *
 * Claude Desktop routines leave request files in the outbox. The scheduled task "TelegramAgent
 * routine channel" runs `sync` every 5 minutes through rchannel-sync.ps1, from a deployed copy in
 * the channel's home, never from a development checkout: one ssh call hands new requests to the
 * server and takes the owner's answers back, the handler registered for each routine carries them
 * out, and a second call reports the results. The PC never runs anything that came from the
 * server: an answer names a request, a card, a verdict and (for a correction) a text, and the
 * program that acts on it is the one handlers.json names on this machine.
 *
 *   bun scripts/rchannel-pc.ts sync
 *   bun scripts/rchannel-pc.ts open
 *   bun scripts/rchannel-pc.ts answer --request <id> (--card <n> | --all) --verdict approve|reject|correct [--text-file <path>]
 *   bun scripts/rchannel-pc.ts notice --routine <name> --title "<title>" --text "<text>"
 *
 * Home: %USERPROFILE%\.claude\tools\routine-channel (override RCHANNEL_HOME). The Claude desktop
 * app does not redirect that folder, so its sessions and the task see the same files.
 * Exit codes: 0 done (or another run holds the lock), 1 a call or a step failed, 2 bad settings or
 * arguments, 3 the routine's handler was busy.
 */
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  LIMITS,
  PAYLOAD_MAX_BYTES,
  ROUTINE_RE,
  checkText,
  validateReply,
  validateRequest,
  type Outcome,
  type RcAnswer,
  type RcClose,
  type RcRequest,
  type RcResult,
  type RequestKind,
  type SyncReply,
  type Verdict,
} from "../rchannel-schema.ts";

export const REMOTE_CMD = "cd $HOME/claude-bot && $HOME/.bun/bin/bun run rchannel.ts sync";
const SSH_TIMEOUT_MS = 60_000;
const LOCK_STALE_MS = 10 * 60_000;
const LOG_KEEP = 200;
const SENT_KEEP = 50;
const WORK_KEEP = 20;
const KEEP_STATE_S = 60 * 24 * 3600;
const KEEP_LEDGER_S = 90 * 24 * 3600;
/** A run's time. A later routine's handler starts only if it can run to its timeout and still leave
 *  the second ssh call its 60 s inside this budget, the task's 5-minute limit less 15 s; otherwise
 *  its answers wait, unacked, for the next cycle. The first routine always runs: the first call
 *  takes at most 60 s, so 60 + 150 + 60 = 270 s fits. */
export const HANDLER_TIMEOUT_MAX_S = 150;
export const RUN_BUDGET_MS = 285_000;
/** A handler busy this long (its data file refused every save) stops being retried: its answers
 *  are reported failed, so the phone stops saying "waiting for the PC". */
export const BUSY_GIVE_UP_S = 3600;
const HANDLED: readonly Outcome[] = ["approved", "rejected", "corrected", "already"];

type Env = Record<string, string | undefined>;

export function channelHome(env: Env = process.env): string {
  return env.RCHANNEL_HOME ?? join(env.USERPROFILE ?? homedir(), ".claude", "tools", "routine-channel");
}

export const at = (home: string) => ({
  config: join(home, "config.json"),
  handlers: join(home, "handlers.json"),
  outbox: join(home, "outbox"),
  rejected: join(home, "outbox", "rejected"),
  sent: join(home, "sent"),
  work: join(home, "work"),
  state: join(home, "state.json"),
  log: join(home, "sync.log"),
  ok: join(home, "last-sync-ok"),
  lock: join(home, "lock"),
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Config {
  target: string;
  key: string;
}
export interface Handler {
  argv: string[];
  timeout_s: number;
}

/** A JSON file, tolerating the byte-order mark Notepad and Windows PowerShell 5.1 write. */
function readJson(path: string): unknown {
  let raw = readFileSync(path, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

export function loadConfig(home: string): Config | { error: string } {
  let c: any;
  try {
    c = readJson(at(home).config);
  } catch (e: any) {
    return { error: `cannot read config.json: ${e?.message ?? e}` };
  }
  if (typeof c?.target !== "string" || !/^[\w.-]+@[\w.-]+$/.test(c.target)) {
    return { error: "config.json: target must be user@host (the committed placeholder is refused)" };
  }
  if (typeof c.key !== "string" || !c.key) return { error: "config.json: key must be the path of the ssh key" };
  return { target: c.target, key: c.key };
}

export function loadHandlers(home: string): Record<string, Handler> | { error: string } {
  let h: any;
  try {
    h = readJson(at(home).handlers);
  } catch (e: any) {
    return { error: `cannot read handlers.json: ${e?.message ?? e}` };
  }
  if (!h || typeof h !== "object" || Array.isArray(h)) return { error: "handlers.json must hold an object" };
  const out: Record<string, Handler> = {};
  for (const [routine, spec] of Object.entries(h as Record<string, any>)) {
    const argvOk = Array.isArray(spec?.argv) && spec.argv.length > 0 && spec.argv.every((a: unknown) => typeof a === "string" && a.length > 0);
    const t = spec?.timeout_s ?? 120;
    if (!argvOk || !Number.isInteger(t) || t < 1 || t > HANDLER_TIMEOUT_MAX_S) {
      return { error: `handlers.json: ${routine} needs argv (a list of text) and timeout_s 1..${HANDLER_TIMEOUT_MAX_S}` };
    }
    out[routine] = { argv: spec.argv, timeout_s: t };
  }
  return out;
}

// ---------------------------------------------------------------------------
// State: requests sent, the ledger of applied answers, and what the next call carries
// ---------------------------------------------------------------------------

export interface PcCard {
  key: string;
  heading: string;
  body: string;
  note?: string;
  handled: boolean; // a result came back that leaves nothing to do (approved, rejected, corrected, already)
  outcome?: Outcome;
  detail?: string;
}
export interface PcRequest {
  id: string;
  routine: string;
  title: string;
  kind: RequestKind;
  supersedes: boolean;
  cards: PcCard[];
  sentAt: number | null; // null: answered in a session before any sync carried it
  superseded: boolean;
  recordedAt: number;
}
export interface PcState {
  v: 1;
  requests: PcRequest[];
  ledger: Record<string, number>; // answer id -> epoch seconds it was carried out
  queue: { acks: string[]; results: RcResult[]; closes: RcClose[] };
  busySince?: Record<string, number>; // answer id -> when its handler was first found busy
}

export function emptyState(): PcState {
  return { v: 1, requests: [], ledger: {}, queue: { acks: [], results: [], closes: [] }, busySince: {} };
}

/** The PC's state. A missing file is an empty state. An unreadable one reads as empty too; given
 *  `log` (the writers: sync and answer), it is first kept aside as state.json.corrupt-<ms> with one
 *  log line, so the evidence survives the next save. */
export function loadState(home: string, log?: (m: string) => void): PcState {
  const path = at(home).state;
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return emptyState();
    // Busy or unreadable is not corrupt: a cycle run on an empty state would save that empty state
    // over the real one, so the caller stops instead.
    if (e?.code) throw e;
  }
  const s = raw as PcState;
  if (s && s.v === 1 && Array.isArray(s.requests) && s.ledger && typeof s.ledger === "object" && s.queue) {
    s.busySince ??= {};
    return s;
  }
  if (log) {
    const aside = `${path}.corrupt-${Date.now()}`;
    try {
      renameSync(path, aside);
      log(`state.json was unreadable; kept aside as ${basename(aside)} (move request files from sent\\ back to outbox\\ to record them again)`);
    } catch (e: any) {
      log(`state.json is unreadable and could not be kept aside: ${e?.message ?? e}`);
    }
  }
  return emptyState();
}

/** Written through a temporary file and a rename. Windows refuses the rename while another
 *  process has state.json open (a reader, an indexer), so it waits and tries again, ten times
 *  200 ms apart, as the skills map's own replace_with_retry does. */
export function saveState(home: string, s: PcState): void {
  mkdirSync(home, { recursive: true });
  const tmp = `${at(home).state}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, at(home).state);
      return;
    } catch (e: any) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e?.code) || i >= 9) {
        rmSync(tmp, { force: true });
        throw e;
      }
      Bun.sleepSync(200);
    }
  }
}

/** Record a request as the PC now knows it; a newer superseding request of the same routine
 *  retires the older ones here too, so `open` shows only what the phone shows. */
export function record(s: PcState, r: RcRequest, sentAt: number | null, nowS: number): PcRequest {
  const existing = s.requests.find((x) => x.id === r.id);
  if (existing) {
    if (existing.sentAt === null && sentAt !== null) existing.sentAt = sentAt;
    return existing;
  }
  const rec: PcRequest = {
    id: r.id,
    routine: r.routine,
    title: r.title,
    kind: r.kind,
    supersedes: r.supersedes,
    cards: r.cards.map((c) => ({ ...c, handled: false })),
    sentAt,
    superseded: false,
    recordedAt: nowS,
  };
  if (r.kind === "cards" && r.supersedes) {
    for (const old of s.requests) if (old.routine === r.routine && old.kind === "cards") old.superseded = true;
  }
  s.requests.push(rec);
  return rec;
}

export function prune(s: PcState, nowS: number): void {
  s.requests = s.requests.filter((r) => nowS - r.recordedAt <= KEEP_STATE_S || (!r.superseded && r.cards.some((c) => !c.handled)));
  for (const [id, t] of Object.entries(s.ledger)) if (nowS - t > KEEP_LEDGER_S) delete s.ledger[id];
}

// ---------------------------------------------------------------------------
// Files: the outbox, the log, the lock
// ---------------------------------------------------------------------------

/** The newest `keep` files of a folder stay; the rest go. Never throws. */
function keepNewest(dir: string, keep: number): void {
  try {
    const files = readdirSync(dir)
      .map((f) => join(dir, f))
      .filter((p) => statSync(p).isFile())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const p of files.slice(keep)) rmSync(p, { force: true });
  } catch {}
}

function moveInto(dir: string, file: string): void {
  mkdirSync(dir, { recursive: true });
  renameSync(file, join(dir, basename(file)));
}

/** Local wall time on the owner's clock, whatever the process timezone. */
export function stamp(now: Date): { date: string; hhmm: string; compact: string } {
  const p: Record<string, string> = {};
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  for (const x of f.formatToParts(now)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}:${p.minute}`, compact: `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}` };
}

/** One timestamped line; the file keeps its last 200. Never throws. */
export function writeLog(home: string, message: string, now: Date = new Date()): void {
  try {
    mkdirSync(home, { recursive: true });
    const t = stamp(now);
    appendFileSync(at(home).log, `${t.date} ${t.hhmm}  ${message}\n`, "utf8");
    const lines = readFileSync(at(home).log, "utf8").split("\n").filter(Boolean);
    if (lines.length > LOG_KEEP) writeFileSync(at(home).log, lines.slice(-LOG_KEEP).join("\n") + "\n", "utf8");
  } catch {}
}

/** The lock the task and `answer` share: created exclusively, stolen after 10 minutes (a run
 *  that died). Returns the release, or null when another holder has it. The age is read against
 *  the real clock, never an injected one: a file's time is real time. The lock holds a token, and
 *  the release removes only a lock that still holds it: a run that slept past the 10 minutes and
 *  woke up must not remove the lock of whoever took over. */
export function takeLock(home: string): (() => void) | null {
  mkdirSync(home, { recursive: true });
  const path = at(home).lock;
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeFileSync(fd, token);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(path, "utf8") === token) rmSync(path, { force: true });
        } catch {}
      };
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
          rmSync(path, { force: true });
          continue;
        }
      } catch {
        continue; // it vanished between the two calls
      }
      return null;
    }
  }
  return null;
}

export interface OutboxScan {
  valid: { file: string; request: RcRequest }[];
  rejected: { file: string; reason: string }[];
}

/** Every *.json in the outbox (not its subfolders), checked with the schema's own gate plus one
 *  local rule: a cards request needs a handler registered for its routine. */
export function scanOutbox(home: string, handlers: Record<string, Handler>): OutboxScan {
  const out: OutboxScan = { valid: [], rejected: [] };
  let names: string[] = [];
  try {
    names = readdirSync(at(home).outbox).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return out;
  }
  for (const f of names) {
    const file = join(at(home).outbox, f);
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch (e: any) {
      out.rejected.push({ file, reason: "not JSON" });
      continue;
    }
    const v = validateRequest(raw);
    if (!v.ok) {
      out.rejected.push({ file, reason: v.reason });
      continue;
    }
    if (v.value.kind === "cards" && !handlers[v.value.routine]) {
      out.rejected.push({ file, reason: `no handler is registered for routine ${v.value.routine}` });
      continue;
    }
    out.valid.push({ file, request: v.value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export interface WorkItem {
  id: string;
  card: string;
  verdict: Verdict;
  text?: string;
  shown?: string; // the body the owner saw; the handler refuses when the item changed since
}
export interface HandlerRun {
  code: number | null; // null: killed at its timeout
  out: string;
}
export type RunHandler = (h: Handler, workFile: string) => Promise<HandlerRun>;

/** The registered argv with the work file appended: no shell, the handler's own timeout. */
export const runHandlerProcess: RunHandler = async (h, workFile) => {
  const proc = Bun.spawn([...h.argv, workFile], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {}
  }, h.timeout_s * 1000);
  const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(killer);
  return { code: timedOut ? null : code, out };
};

const OUTCOMES: readonly string[] = ["approved", "rejected", "corrected", "already", "refused", "failed"];

/** A detail travels to the owner's phone, so only a short Hebrew phrase passes: no Latin letter,
 *  slash or backslash can carry a path, an address or a key through it. */
export function safeDetail(d: unknown): string | undefined {
  if (typeof d !== "string") return undefined;
  const t = d.replace(/\s+/g, " ").trim();
  if (!t || t.length > LIMITS.detail) return undefined;
  return /^[א-ת׳״־0-9 .,:;()'"?!-]+$/.test(t) ? t : undefined;
}

/** One JSON line per card: {"id", "card", "outcome", "detail"?}; anything else is ignored. */
export function parseHandlerOutput(out: string): Map<string, { outcome: Outcome; detail?: string }> {
  const m = new Map<string, { outcome: Outcome; detail?: string }>();
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (typeof o?.id !== "string" || !OUTCOMES.includes(o.outcome)) continue;
    const detail = safeDetail(o.detail);
    m.set(o.id, { outcome: o.outcome, ...(detail ? { detail } : {}) });
  }
  return m;
}

const NO_RECORD = "אין רישום של הבקשה במחשב";
const NOT_SENT = "הכרטיס הזה לא נשלח מהמחשב";
const NO_HANDLER = "אין תוכנית מטפלת לרוטינה";
const HANDLER_FAILED = "התוכנית המטפלת נכשלה";
const NO_LINE = "התוכנית המטפלת לא ענתה על הכרטיס";

function findCard(s: PcState, request: string, key: string): { req: PcRequest; card: PcCard } | null {
  const req = s.requests.find((r) => r.id === request);
  const card = req?.cards.find((c) => c.key === key);
  return req && card ? { req, card } : null;
}

function noteResult(s: PcState, request: string, key: string, outcome: Outcome, detail?: string): void {
  const hit = findCard(s, request, key);
  if (!hit) return;
  hit.card.outcome = outcome;
  if (detail) hit.card.detail = detail;
  else delete hit.card.detail;
  if (HANDLED.includes(outcome)) hit.card.handled = true;
}

/** Run one routine's handler on its items. Exit 0: one result per item (a missing line reads as
 *  failed). Exit 3: busy, so nothing is decided (null). Anything else: every item failed. */
export async function runRoutine(
  home: string,
  h: Handler,
  routine: string,
  items: WorkItem[],
  run: RunHandler,
  now: Date,
): Promise<Map<string, { outcome: Outcome; detail?: string }> | null> {
  mkdirSync(at(home).work, { recursive: true });
  const file = join(at(home).work, `${routine}-${stamp(now).compact}-${Math.floor(Math.random() * 1e4)}.json`);
  writeFileSync(file, JSON.stringify(items, null, 2));
  let r: HandlerRun;
  try {
    r = await run(h, file);
  } catch {
    r = { code: -1, out: "" };
  } finally {
    keepNewest(at(home).work, WORK_KEEP);
  }
  if (r.code === 3) return null;
  const parsed = r.code === 0 ? parseHandlerOutput(r.out) : new Map<string, { outcome: Outcome; detail?: string }>();
  const out = new Map<string, { outcome: Outcome; detail?: string }>();
  for (const it of items) {
    out.set(it.id, parsed.get(it.id) ?? { outcome: "failed", detail: r.code === 0 ? NO_LINE : HANDLER_FAILED });
  }
  return out;
}

// ---------------------------------------------------------------------------
// sync: the task's cycle
// ---------------------------------------------------------------------------

export type SshCall = (cfg: Config, payload: string) => Promise<string>;

/** The ssh call's arguments: no agent, X11 or port forwarding and no terminal, whatever the PC's
 *  ssh configuration says, and the fixed command. */
export const sshArgs = (cfg: Config): string[] =>
  // prettier-ignore
  ["ssh", "-a", "-x", "-T", "-o", "ClearAllForwardings=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-i", cfg.key, cfg.target, REMOTE_CMD];

/** A stream read up to `cap` bytes; past that, reading stops and `over` says so (the caller kills
 *  the process), so a reply that never ends cannot fill the PC's memory. */
export async function readUpTo(stream: ReadableStream<Uint8Array>, cap: number): Promise<{ text: string; over: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return { text: "", over: true };
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), over: false };
}

/** ssh's own error words for sync.log: printable ASCII only, so nothing the server prints can put an
 *  escape sequence into the log a session reads, and 200 characters at most. */
export function safeStderr(s: string): string {
  return s.replace(/[^ -~]+/g, " ").replace(/ +/g, " ").trim().slice(0, 200);
}

export const sshCall: SshCall = async (cfg, payload) => {
  const proc = Bun.spawn(sshArgs(cfg), { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const kill = () => {
    try {
      proc.kill();
    } catch {}
  };
  const killer = setTimeout(kill, SSH_TIMEOUT_MS);
  try {
    await proc.stdin.write(payload);
    await proc.stdin.end();
  } catch {
    // ssh can exit without reading stdin (no connection); its exit code tells the story
  }
  const [out, err, code] = await Promise.all([
    readUpTo(proc.stdout, PAYLOAD_MAX_BYTES).then((r) => {
      if (r.over) kill();
      return r;
    }),
    readUpTo(proc.stderr, 16_384),
    proc.exited,
  ]);
  clearTimeout(killer);
  if (out.over) throw new Error("the server's reply is over 1 MB");
  if (code !== 0) throw new Error(`ssh exited ${code}: ${safeStderr(err.text)}`);
  return out.text;
};

export interface SyncDeps {
  home: string;
  now: () => Date;
  ssh: SshCall;
  runHandler: RunHandler;
  log: (message: string) => void;
  version?: string | null; // the deployed copy's commit (version.txt), named in each log line
  budgetMs?: number; // RUN_BUDGET_MS unless a test says otherwise
}

async function exchange(d: SyncDeps, cfg: Config, body: object): Promise<SyncReply> {
  const text = await d.ssh(cfg, JSON.stringify(body));
  if (Buffer.byteLength(text) > PAYLOAD_MAX_BYTES) throw new Error("the server's reply is over 1 MB");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("the server's reply is not JSON");
  }
  const v = validateReply(raw);
  if (!v.ok) throw new Error(`the server's reply was refused: ${v.reason}`);
  return v.value;
}

const BUSY_TOO_LONG = "המחשב לא הצליח לשמור";

/** Carry out the answers not yet in the ledger, routine by routine. An answer already in the
 *  ledger is acked again (its earlier ack was lost). A busy handler leaves its answers for the next
 *  cycle, for an hour at most. No handler starts once the run has used its time budget; those
 *  answers wait, unacked. Returns counts for the log line. */
async function applyAnswers(
  d: SyncDeps,
  s: PcState,
  handlers: Record<string, Handler>,
  answers: RcAnswer[],
  nowS: number,
  startedMs: number,
) {
  const counts: Record<string, number> = {};
  let busy = 0;
  let deferred = 0;
  const busySince = (s.busySince ??= {});
  const fresh: RcAnswer[] = [];
  for (const a of answers) {
    if (s.ledger[a.id] !== undefined) {
      if (!s.queue.acks.includes(a.id)) s.queue.acks.push(a.id);
    } else fresh.push(a);
  }
  const done = (a: RcAnswer, outcome: Outcome, detail?: string) => {
    s.ledger[a.id] = nowS;
    delete busySince[a.id];
    s.queue.acks.push(a.id);
    s.queue.results.push({ request: a.request, card: a.card, outcome, ...(detail ? { detail } : {}) });
    noteResult(s, a.request, a.card, outcome, detail);
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  };
  const groups = new Map<string, RcAnswer[]>();
  for (const a of fresh) {
    const req = s.requests.find((r) => r.id === a.request);
    if (!req) {
      done(a, "failed", NO_RECORD);
      continue;
    }
    // The server's card keys always come from the PC's own copy of the request: a key the PC never
    // sent reaches no handler, whatever a forged store says.
    if (!req.cards.some((c) => c.key === a.card)) {
      done(a, "failed", NOT_SENT);
      continue;
    }
    groups.set(req.routine, [...(groups.get(req.routine) ?? []), a]);
  }
  let first = true;
  for (const [routine, list] of groups) {
    const h = handlers[routine];
    if (!h) {
      for (const a of list) done(a, "failed", NO_HANDLER);
      continue;
    }
    if (!first && Date.now() - startedMs + h.timeout_s * 1000 + SSH_TIMEOUT_MS > (d.budgetMs ?? RUN_BUDGET_MS)) {
      deferred += list.length;
      continue;
    }
    first = false;
    const items: WorkItem[] = list.map((a) => ({
      id: a.id,
      card: a.card,
      verdict: a.verdict,
      ...(a.text !== undefined ? { text: a.text } : {}),
      ...(findCard(s, a.request, a.card) ? { shown: findCard(s, a.request, a.card)!.card.body } : {}),
    }));
    const results = await runRoutine(d.home, h, routine, items, d.runHandler, d.now());
    if (!results) {
      for (const a of list) {
        busySince[a.id] ??= nowS;
        if (nowS - busySince[a.id] >= BUSY_GIVE_UP_S) done(a, "failed", BUSY_TOO_LONG);
        else busy++;
      }
      continue;
    }
    for (const a of list) {
      const r = results.get(a.id)!;
      done(a, r.outcome, r.detail);
    }
  }
  return { counts, busy, deferred };
}

export async function runSync(d: SyncDeps): Promise<number> {
  const startedMs = Date.now();
  const release = takeLock(d.home);
  if (!release) return 0; // another run, or an `answer` from a session, holds it
  try {
    const cfg = loadConfig(d.home);
    if ("error" in cfg) {
      d.log(`FAILED: ${cfg.error}`);
      return 2;
    }
    const handlers = loadHandlers(d.home);
    if ("error" in handlers) {
      d.log(`FAILED: ${handlers.error}`);
      return 2;
    }
    const nowS = Math.floor(d.now().getTime() / 1000);
    let s: PcState;
    try {
      s = loadState(d.home, d.log);
    } catch (e: any) {
      d.log(`FAILED: cannot read state.json (${e?.code ?? e?.message ?? e}); nothing done this cycle`);
      return 1;
    }
    prune(s, nowS);
    const scan = scanOutbox(d.home, handlers);
    for (const r of scan.rejected) {
      try {
        moveInto(at(d.home).rejected, r.file);
      } catch {}
      d.log(`rejected ${basename(r.file)}: ${r.reason}`);
    }

    const q = { acks: s.queue.acks.length, results: s.queue.results.length, closes: s.queue.closes.length };
    let reply: SyncReply;
    try {
      reply = await exchange(d, cfg, { v: 1, requests: scan.valid.map((v) => v.request), acks: s.queue.acks, results: s.queue.results, closes: s.queue.closes });
    } catch (e: any) {
      d.log(`FAILED: ${e?.message ?? e}`);
      return 1;
    }
    // Delivered: what this call carried leaves the queue; what the server took is recorded, and
    // saved before any file moves or handler runs, so a run that dies from here on has already
    // recorded what the server holds (a file still in the outbox is only sent again, and the
    // server reports it received). Only then do the files move to sent\.
    s.queue.acks = s.queue.acks.slice(q.acks);
    s.queue.results = s.queue.results.slice(q.results);
    s.queue.closes = s.queue.closes.slice(q.closes);
    const taken = scan.valid.filter((v) => reply.received.includes(v.request.id));
    for (const v of taken) record(s, v.request, nowS, nowS);
    saveState(d.home, s);
    const sentNow: string[] = [];
    for (const v of taken) {
      try {
        moveInto(at(d.home).sent, v.file);
      } catch {}
      sentNow.push(v.request.id);
    }
    keepNewest(at(d.home).sent, SENT_KEEP);

    const { counts, busy, deferred } = await applyAnswers(d, s, handlers, reply.answers, nowS, startedMs);
    saveState(d.home, s);

    let resultsNote = "";
    if (s.queue.acks.length || s.queue.results.length) {
      const q2 = { acks: s.queue.acks.length, results: s.queue.results.length };
      try {
        await exchange(d, cfg, { v: 1, requests: [], acks: s.queue.acks, results: s.queue.results, closes: [] });
        s.queue.acks = s.queue.acks.slice(q2.acks);
        s.queue.results = s.queue.results.slice(q2.results);
        saveState(d.home, s);
      } catch (e: any) {
        resultsNote = `; the results call failed, they go with the next cycle: ${e?.message ?? e}`;
      }
    }
    try {
      writeFileSync(at(d.home).ok, d.now().toISOString());
    } catch {}
    const parts = [
      sentNow.length ? `sent ${sentNow.join(", ")}` : "",
      Object.keys(counts).length ? `answers: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}` : "",
      busy ? `${busy} answer(s) wait: the handler was busy` : "",
      deferred ? `${deferred} answer(s) wait for the next cycle: this run's time is spent` : "",
    ].filter(Boolean);
    const copy = d.version ? `; copy ${d.version}` : "";
    if (parts.length || resultsNote) d.log(`${parts.join("; ") || "results pending"}${resultsNote}${copy}`);
    return 0;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// open, answer, notice: for sessions and routines
// ---------------------------------------------------------------------------

/** Requests with a card still waiting on this PC: sent ones not superseded, and cards requests
 *  still in the outbox (not on the phone yet). */
export function openReport(home: string, handlers: Record<string, Handler>): string {
  let s: PcState;
  try {
    s = loadState(home);
  } catch (e: any) {
    return `refused: cannot read state.json (${e?.code ?? e?.message ?? e})`;
  }
  const lines: string[] = [];
  const show = (id: string, title: string, where: string, cards: { heading: string; body: string; note?: string; handled: boolean }[]) => {
    const open = cards.map((c, i) => ({ ...c, n: i + 1 })).filter((c) => !c.handled);
    if (!open.length) return;
    lines.push(`request ${id} (${title}), ${where}: ${open.length} of ${cards.length} waiting`);
    for (const c of open) {
      lines.push(`  ${c.n}. ${c.heading}${c.note ? ` [${c.note}]` : ""}`);
      lines.push(`     ${c.body}`);
    }
  };
  for (const r of s.requests) {
    if (r.kind !== "cards" || r.superseded) continue;
    // "handed to the server": the PC knows the server took it, not that the phone shows it yet
    // (the server holds new messages through Shabbat and holidays).
    show(r.id, r.title, r.sentAt === null ? "answered here before it reached the server" : "handed to the server", r.cards);
  }
  for (const v of scanOutbox(home, handlers).valid) {
    if (v.request.kind !== "cards" || s.requests.some((r) => r.id === v.request.id)) continue;
    show(v.request.id, v.request.title, "not on the phone yet", v.request.cards.map((c) => ({ ...c, handled: false })));
  }
  let refused: string[] = [];
  try {
    refused = readdirSync(at(home).rejected).filter((f) => f.endsWith(".json")).sort();
  } catch {}
  if (refused.length) lines.push(`refused by the channel, never on the phone (the reason is in sync.log): ${refused.join(", ")}`);
  return lines.length ? lines.join("\n") : "nothing is waiting";
}

export interface AnswerArgs {
  request: string;
  card?: number;
  all?: boolean;
  verdict: Verdict;
  textFile?: string;
}
export interface AnswerDeps {
  home: string;
  now: () => Date;
  runHandler: RunHandler;
  print: (s: string) => void;
  sleep: (ms: number) => Promise<void>;
  waitMs: number; // how long to wait for the task's lock before giving up
}

export async function runAnswer(d: AnswerDeps, a: AnswerArgs): Promise<number> {
  let release = takeLock(d.home);
  for (let waited = 0; !release && waited < d.waitMs; waited += 2000) {
    await d.sleep(2000);
    release = takeLock(d.home);
  }
  if (!release) {
    d.print("busy: the sync task is running; try again in a minute");
    return 3;
  }
  try {
    const handlers = loadHandlers(d.home);
    if ("error" in handlers) {
      d.print(`refused: ${handlers.error}`);
      return 2;
    }
    const nowS = Math.floor(d.now().getTime() / 1000);
    let s: PcState;
    try {
      s = loadState(d.home, (m) => writeLog(d.home, m));
    } catch (e: any) {
      d.print(`refused: cannot read state.json (${e?.code ?? e?.message ?? e}); try again in a minute`);
      return 1;
    }
    let req = s.requests.find((r) => r.id === a.request);
    if (!req) {
      const inOutbox = scanOutbox(d.home, handlers).valid.find((v) => v.request.id === a.request);
      if (inOutbox) req = record(s, inOutbox.request, null, nowS);
    }
    if (!req || req.kind !== "cards") {
      d.print(`refused: no cards request ${a.request} is waiting on this PC`);
      return 1;
    }
    if (req.superseded) {
      d.print(`refused: request ${a.request} was replaced by a newer one; answer that one`);
      return 1;
    }
    const h = handlers[req.routine];
    if (!h) {
      d.print(`refused: no handler is registered for routine ${req.routine}`);
      return 1;
    }
    const picks = a.all
      ? req.cards.map((c, i) => ({ c, n: i + 1 })).filter((x) => !x.c.handled)
      : req.cards[(a.card ?? 0) - 1]
        ? [{ c: req.cards[a.card! - 1], n: a.card! }]
        : [];
    if (!picks.length) {
      d.print(a.all ? "nothing is waiting in that request" : `refused: request ${a.request} has no card ${a.card}`);
      return 1;
    }
    if (!a.all && picks[0].c.handled) {
      d.print(`card ${picks[0].n} was already handled (${picks[0].c.outcome})`);
      return 0;
    }
    let text: string | undefined;
    if (a.verdict === "correct") {
      if (a.all || !a.textFile) {
        d.print("refused: a correction is for one card and needs --text-file");
        return 2;
      }
      // Only a file in the channel's own work folder, and it is deleted only once the handler has
      // answered: a refused text or a busy handler leaves it for the retry.
      const workDir = resolve(at(d.home).work).toLowerCase() + sep;
      if (!resolve(a.textFile).toLowerCase().startsWith(workDir)) {
        d.print(`refused: the text file must be in ${at(d.home).work}`);
        return 2;
      }
      try {
        let raw = readFileSync(a.textFile, "utf8");
        if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // a byte-order mark from Notepad
        text = raw.replace(/\s+/g, " ").trim();
      } catch (e: any) {
        d.print(`refused: cannot read the text file: ${e?.message ?? e}`);
        return 2;
      }
      const e = checkText(text, "the new description", LIMITS.body, 1, false);
      if (e) {
        d.print(`refused: ${e}`);
        return 2;
      }
    }
    const t = stamp(d.now()).compact;
    const items: WorkItem[] = picks.map((p, i) => ({ id: `local-${t}-${i + 1}`, card: p.c.key, verdict: a.verdict, ...(text ? { text } : {}), shown: p.c.body }));
    const results = await runRoutine(d.home, h, req.routine, items, d.runHandler, d.now());
    if (!results) {
      d.print("busy: the routine's data is being written right now; try again in a minute (the text file is kept)");
      return 3;
    }
    if (a.textFile) rmSync(a.textFile, { force: true });
    for (const [i, p] of picks.entries()) {
      const r = results.get(items[i].id)!;
      s.ledger[items[i].id] = nowS;
      noteResult(s, req.id, p.c.key, r.outcome, r.detail);
      if (HANDLED.includes(r.outcome)) s.queue.closes.push({ request: req.id, card: p.c.key });
      d.print(`card ${p.n} (${p.c.heading}): ${r.outcome}${r.detail ? `: ${r.detail}` : ""}`);
    }
    saveState(d.home, s);
    return 0;
  } finally {
    release();
  }
}

export function writeNotice(home: string, a: { routine: string; title: string; text: string }, now: Date): { id: string } | { error: string } {
  if (!ROUTINE_RE.test(a.routine)) return { error: "routine must be 1 to 40 of a-z, 0-9 and -" };
  const id =`${a.routine}-${stamp(now).compact.slice(0, 12)}-${Math.floor(Math.random() * 1e4).toString().padStart(4, "0")}`;
  const v = validateRequest({ v: 1, id, routine: a.routine, title: a.title, kind: "notice", text: a.text, supersedes: false, cards: [] });
  if (!v.ok) return { error: v.reason };
  mkdirSync(at(home).outbox, { recursive: true });
  const file = join(at(home).outbox, `${id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(v.value, null, 2));
  renameSync(`${file}.tmp`, file);
  return { id };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseFlags(args: string[]): { flags: Map<string, string>; switches: Set<string>; error?: string } {
  const flags = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const x = args[i];
    if (x === "--all") {
      switches.add("all");
      continue;
    }
    if (x.startsWith("--") && args[i + 1] !== undefined) {
      flags.set(x.slice(2), args[++i]);
      continue;
    }
    return { flags, switches, error: `unexpected argument: ${x}` };
  }
  return { flags, switches };
}

const USAGE =
  "usage: rchannel-pc.ts sync | open | answer --request <id> (--card <n> | --all) --verdict approve|reject|correct [--text-file <path>] | notice --routine <name> --title <title> --text <text>";

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const home = channelHome();
  const log = (m: string) => writeLog(home, m);
  let code = 2;
  try {
    if (cmd === "sync") {
      let version: string | null = null;
      try {
        version = readFileSync(join(import.meta.dir, "..", "version.txt"), "utf8").trim() || null;
      } catch {}
      code = await runSync({ home, now: () => new Date(), ssh: sshCall, runHandler: runHandlerProcess, log, version });
    } else if (cmd === "open") {
      const h = loadHandlers(home);
      console.log("error" in h ? `refused: ${h.error}` : openReport(home, h));
      code = "error" in h ? 2 : 0;
    } else if (cmd === "answer" || cmd === "notice") {
      const { flags, switches, error } = parseFlags(rest);
      if (error) {
        console.error(`${error}\n${USAGE}`);
      } else if (cmd === "notice") {
        const r = writeNotice(home, { routine: flags.get("routine") ?? "", title: flags.get("title") ?? "", text: flags.get("text") ?? "" }, new Date());
        console.log("error" in r ? `refused: ${r.error}` : `notice=${r.id}`);
        code = "error" in r ? 2 : 0;
      } else {
        const verdict = flags.get("verdict");
        const card = flags.has("card") ? Number(flags.get("card")) : undefined;
        const request = flags.get("request");
        if (!request || (verdict !== "approve" && verdict !== "reject" && verdict !== "correct") || (switches.has("all") === (card !== undefined)) || (card !== undefined && !(Number.isInteger(card) && card >= 1))) {
          console.error(USAGE);
        } else {
          code = await runAnswer(
            { home, now: () => new Date(), runHandler: runHandlerProcess, print: (s) => console.log(s), sleep: (ms) => Bun.sleep(ms), waitMs: 90_000 },
            { request, verdict, ...(card !== undefined ? { card } : {}), ...(switches.has("all") ? { all: true } : {}), ...(flags.has("text-file") ? { textFile: flags.get("text-file") } : {}) },
          );
        }
      }
    } else {
      console.error(USAGE);
    }
  } catch (e: any) {
    log(`CRASHED: ${e?.message ?? e}`);
    code = 1;
  }
  process.exit(code);
}
