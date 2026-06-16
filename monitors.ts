/**
 * monitors.ts — pure logic for typed "monitors" (feature E2).
 *
 * A monitor is a recurring, typed check that pings Maor only when something
 * changes (webpage content) or a number crosses a threshold. Pure logic over a
 * Database handle so tests run on ":memory:" (mirrors memory.ts). The actual
 * fetch + Telegram delivery live in net.ts / poller.ts; this module owns the
 * data model, selection (dueMonitors), and the fire decisions (evalThreshold,
 * decideWebpageFire) that are unit-tested directly.
 */
import type { Database } from "bun:sqlite";
import { parseAndCheckUrl, safeFetch, extractText, normalize, hashContent } from "./net";

export type MonitorType = "webpage" | "threshold";
export type OnFire = "notify" | "summarize";
export type MonitorStatus = "active" | "paused" | "disabled";
export type ThresholdOp = "lt" | "gt" | "cross";
export type ThresholdSide = "below" | "above";

export interface MonitorConfig {
  selector?: string;
  keyword?: string;
  op?: ThresholdOp;
  value?: number;
  jsonPath?: string;
  regex?: string;
}

export interface Monitor {
  id: string;
  chat_id: number;
  name: string;
  type: MonitorType;
  url: string;
  config: MonitorConfig;
  interval_s: number;
  on_fire: OnFire;
  last_checked_ts: number | null;
  last_value: string | null;
  last_state: ThresholdSide | null;
  consecutive_failures: number;
  status: MonitorStatus;
  created_ts: number;
}

export class MonitorError extends Error {}

export const MIN_INTERVAL_S = 300;
export const FAILURE_LIMIT = 5;

interface RawRow {
  id: string; chat_id: number; name: string; type: string; url: string;
  config: string | null; interval_s: number; on_fire: string;
  last_checked_ts: number | null; last_value: string | null; last_state: string | null;
  consecutive_failures: number; status: string; created_ts: number;
}

function rowToMonitor(r: RawRow): Monitor {
  return {
    ...r,
    type: r.type as MonitorType,
    on_fire: r.on_fire as OnFire,
    status: r.status as MonitorStatus,
    last_state: (r.last_state as ThresholdSide | null) ?? null,
    config: r.config ? (JSON.parse(r.config) as MonitorConfig) : {},
  };
}

function genId(): string {
  return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export interface MonitorArgs {
  chatId: number;
  name: string;
  type: MonitorType;
  url: string;
  config: MonitorConfig;
  intervalS: number;
  onFire?: OnFire;
}

export function addMonitor(db: Database, a: MonitorArgs): Monitor {
  const name = a.name?.trim();
  if (!name) throw new MonitorError("name is required");
  if (a.type !== "webpage" && a.type !== "threshold") {
    throw new MonitorError(`invalid type: ${a.type} (use webpage|threshold)`);
  }
  const onFire: OnFire = a.onFire ?? "notify";
  if (onFire !== "notify" && onFire !== "summarize") {
    throw new MonitorError(`invalid on-fire: ${a.onFire} (use notify|summarize)`);
  }
  const urlChk = parseAndCheckUrl(a.url);
  if (!urlChk.ok) throw new MonitorError(`refused url: ${urlChk.reason}`);
  if (a.type === "threshold") {
    const op = a.config?.op;
    if (op !== "lt" && op !== "gt" && op !== "cross") {
      throw new MonitorError("threshold monitor needs config.op = lt|gt|cross");
    }
    if (typeof a.config?.value !== "number" || Number.isNaN(a.config.value)) {
      throw new MonitorError("threshold monitor needs a numeric config.value");
    }
  }
  const interval = Math.max(MIN_INTERVAL_S, Math.floor(a.intervalS) || MIN_INTERVAL_S);
  const id = genId();
  const now = Math.floor(Date.now() / 1000);
  db.query(
    `INSERT INTO monitors (id, chat_id, name, type, url, config, interval_s, on_fire,
       last_checked_ts, last_value, last_state, consecutive_failures, status, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 'active', ?)`,
  ).run(id, a.chatId, name, a.type, a.url, JSON.stringify(a.config ?? {}), interval, onFire, now);
  return getMonitor(db, id)!;
}

export function getMonitor(db: Database, id: string): Monitor | null {
  const r = db.query("SELECT * FROM monitors WHERE id = ?").get(id) as RawRow | null;
  return r ? rowToMonitor(r) : null;
}

export function listMonitors(db: Database, chatId?: number): Monitor[] {
  const rows = (chatId == null
    ? db.query("SELECT * FROM monitors ORDER BY created_ts").all()
    : db.query("SELECT * FROM monitors WHERE chat_id = ? ORDER BY created_ts").all(chatId)) as RawRow[];
  return rows.map(rowToMonitor);
}

export function setStatus(db: Database, id: string, status: MonitorStatus): void {
  db.query("UPDATE monitors SET status = ? WHERE id = ?").run(status, id);
}

export function removeMonitor(db: Database, id: string): void {
  db.query("DELETE FROM monitors WHERE id = ?").run(id);
}

/** Active monitors whose interval has elapsed (or were never checked). */
export function dueMonitors(db: Database, nowS: number): Monitor[] {
  const rows = db
    .query(
      `SELECT * FROM monitors
        WHERE status = 'active'
          AND (last_checked_ts IS NULL OR ? - last_checked_ts >= interval_s)`,
    )
    .all(nowS) as RawRow[];
  return rows.map(rowToMonitor);
}

function side(value: number, target: number): ThresholdSide {
  return value < target ? "below" : "above";
}

/**
 * Edge-detected threshold evaluation. Fires once when the value crosses INTO the
 * watched side (or in either direction for "cross"), not on every tick while it
 * stays there. Re-arms when it crosses back. First check (lastState=null) only
 * records a baseline.
 */
export function evalThreshold(
  value: number,
  op: ThresholdOp,
  target: number,
  lastState: ThresholdSide | null,
): { fired: boolean; newState: ThresholdSide } {
  const ns = side(value, target);
  let fired = false;
  // Fire only on a genuine crossing into the watched side (never on the first
  // check, where lastState is null — that just records a baseline).
  if (op === "lt") fired = ns === "below" && lastState === "above";
  else if (op === "gt") fired = ns === "above" && lastState === "below";
  else fired = lastState !== null && ns !== lastState; // cross (either direction)
  return { fired, newState: ns };
}

/** Webpage fires only when the hash changed AND a baseline already existed. */
export function decideWebpageFire(last: string | null, next: string): boolean {
  return last !== null && last !== next;
}

/**
 * Record the outcome of a check: stamp last_checked_ts (real now), update value/
 * state, and track consecutive failures — auto-pausing at FAILURE_LIMIT.
 */
export function recordCheck(
  db: Database,
  id: string,
  o: { lastValue?: string; lastState?: ThresholdSide | null; success: boolean },
): void {
  const m = getMonitor(db, id);
  if (!m) return;
  const fails = o.success ? 0 : m.consecutive_failures + 1;
  const status: MonitorStatus = fails >= FAILURE_LIMIT ? "paused" : m.status;
  db.query(
    `UPDATE monitors SET last_checked_ts = ?, last_value = COALESCE(?, last_value),
       last_state = ?, consecutive_failures = ?, status = ? WHERE id = ?`,
  ).run(
    Math.floor(Date.now() / 1000),
    o.lastValue ?? null,
    o.lastState === undefined ? m.last_state : o.lastState,
    fails,
    status,
    id,
  );
}

// ---------- performing a check (the one network-touching function) ----------

/** Narrow a page's text to the segments mentioning `keyword`, so unrelated
 *  changes (ads, timestamps) don't trigger. No keyword → the whole text. */
export function webpageBasis(text: string, keyword?: string): string {
  if (!keyword) return text;
  const kw = keyword.toLowerCase();
  const segs = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.toLowerCase().includes(kw));
  return segs.length ? segs.join(" ") : "__keyword_absent__";
}

/** Read a dotted path (e.g. "data.price") out of a parsed JSON value. */
export function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
    obj,
  );
}

/** Pull a number from a response body: JSON path first, then a regex, then the
 *  first number found. Returns null when nothing numeric is present. */
export function extractNumber(text: string, config: MonitorConfig): number | null {
  if (config.jsonPath) {
    try {
      const n = Number(getByPath(JSON.parse(text), config.jsonPath));
      if (!Number.isNaN(n)) return n;
    } catch { /* not JSON or bad path — fall through */ }
  }
  if (config.regex) {
    try {
      const m = text.match(new RegExp(config.regex));
      if (m) {
        const n = Number((m[1] ?? m[0]).replace(/[^0-9.\-]/g, ""));
        if (!Number.isNaN(n)) return n;
      }
    } catch { /* bad regex — fall through */ }
  }
  const m = text.match(/-?\d[\d,]*\.?\d*/);
  if (m) {
    const n = Number(m[0].replace(/,/g, ""));
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

export interface CheckOutcome {
  ok: boolean;
  error?: string;
  fired: boolean;
  newValue?: string;             // hash (webpage) or stringified number (threshold)
  newState?: ThresholdSide | null;
  kind: MonitorType;
  text?: string;                 // fetched + normalized text (webpage), for summaries
  value?: number;                // extracted number (threshold)
}

/**
 * Fetch the monitor's URL through the hardened path and evaluate its fire
 * decision against the monitor's last-seen state. Does NOT touch the DB or
 * Telegram — the caller records the outcome and delivers. The only function in
 * this module that does network I/O.
 */
export async function performCheck(m: Monitor): Promise<CheckOutcome> {
  const res = await safeFetch(m.url);
  if (!res.ok) return { ok: false, error: res.error, fired: false, kind: m.type };

  if (m.type === "webpage") {
    const text = normalize(extractText(res.text));
    const hash = hashContent(webpageBasis(text, m.config.keyword));
    return { ok: true, fired: decideWebpageFire(m.last_value, hash), newValue: hash, kind: "webpage", text };
  }
  const value = extractNumber(res.text, m.config);
  if (value == null) return { ok: false, error: "could not extract a number", fired: false, kind: "threshold" };
  const { fired, newState } = evalThreshold(value, m.config.op!, m.config.value!, m.last_state);
  return { ok: true, fired, newValue: String(value), newState, kind: "threshold", value };
}
