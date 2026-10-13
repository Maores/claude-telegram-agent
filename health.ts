/**
 * health.ts — external dead-man check for the agent (roadmap item 0.2).
 *
 *   bun run health.ts check [--auth]
 *
 * The failure this exists for: on 2026-06-20 the CLAUDE_CODE_OAUTH_TOKEN
 * expired. systemd still reported the service as active, Telegram was fine,
 * and every message got a 401 — the agent was silently dead for ~28 hours and
 * only Maor noticing broke the silence. Nothing that runs *inside* the poller
 * can report that, because the poller is the broken thing.
 *
 * So this runs from cron, independently, and alerts by calling the Telegram Bot
 * API directly with the bot token — never through the poller. It is deliberately
 * edge-triggered: it messages on the way into a fault and on recovery, plus one
 * daily reminder while still broken, so a lasting outage cannot be ignored and a
 * healthy week is completely silent.
 *
 * What it cannot see: the droplet being off or off-network. Nothing hosted on
 * the box can report its own total absence — that needs an outside pinger such
 * as healthchecks.io, which is the one gap this leaves open on purpose.
 */
import { lstatSync } from "node:fs";
import { statePath, writeAtomic, readNoFollow } from "./paths";
import { isolateLatin } from "./bidi";
import { withAlwaysDisallowed } from "./guard";
import { readIntegrityLast, INTEGRITY_LAST_FILE } from "./integrity";
import { quietNow } from "./rchannel";

/** A poll cycle is ~POLL_TIMEOUT seconds, so a heartbeat older than this means
 *  the loop is not turning even if the process is alive. */
export const HEARTBEAT_STALE_S = 600;
const REALERT_AFTER_S = 86_400;

export interface Probe {
  serviceActive: boolean;
  /** Seconds since the poller last completed a cycle; null = no heartbeat file. */
  heartbeatAge: number | null;
  /** null = not probed this run (it runs on a slower cadence than the rest). */
  claudeAuthOk: boolean | null;
  /** The nightly integrity check has not completed for 96 h (see integrityStale). */
  integrityStale?: boolean;
}

/** The nightly integrity run is held over Shabbat and holidays; 96 h covers the longest hold. */
export const INTEGRITY_STALE_S = 96 * 3600;

/** With the nightly run on and outside a quiet window, a run that has not completed for 96 h (or
 *  never) is a fault; lastAt is the completion time (or the poller's `since`). Inside a quiet
 *  window the previous verdict is carried, so a fault neither "recovers" at Shabbat entry nor
 *  starts inside it. */
export function integrityStale(enabled: boolean, lastAt: number | null, now: number, quiet: boolean, prev = false): boolean {
  if (!enabled) return false;
  if (quiet) return prev;
  return lastAt === null || now - lastAt > INTEGRITY_STALE_S;
}

/** The rule as the cron run sees it. It is on when INTEGRITY_NIGHTLY=1 is visible, or when
 *  integrity-last.json exists (the poller writes it only with the nightly run on), since cron may
 *  not load the service's environment file. Staleness counts from the last completion, else from
 *  the poller's `since`. */
export function integrityReading(envOn: boolean, lastPath: string, now: number, quiet: boolean, prev: boolean): boolean {
  let exists = false;
  try {
    lstatSync(lastPath);
    exists = true;
  } catch {}
  const last = readIntegrityLast(lastPath);
  return integrityStale(envOn || exists, last?.at ?? last?.since ?? null, now, quiet, prev);
}

export interface Health { healthy: boolean; faults: string[] }

export function assessHealth(p: Probe): Health {
  const faults: string[] = [];
  if (!p.serviceActive) faults.push("service is not running");
  if (p.heartbeatAge == null) faults.push("no heartbeat from the poller (stalled or never started)");
  else if (p.heartbeatAge > HEARTBEAT_STALE_S) {
    faults.push(`poller heartbeat is ${Math.round(p.heartbeatAge / 60)} min old (stalled)`);
  }
  // Only an explicit false is a fault; null means "not checked this run".
  if (p.claudeAuthOk === false) faults.push("claude auth failing (token likely expired)");
  if (p.integrityStale) faults.push("integrity check has not completed for 96h");
  return { healthy: faults.length === 0, faults };
}

/** integrityStale: the last integrity verdict, carried through quiet windows. */
export interface AlertState { failing: boolean; lastAlertTs: number; integrityStale?: boolean }
export interface AlertDecision { send: boolean; recovered: boolean; nextState: AlertState }

/** Edge-triggered, with a daily nag while still broken. */
export function shouldAlert(h: Health, prev: AlertState, now: number): AlertDecision {
  if (h.healthy) {
    const recovered = prev.failing;
    return {
      send: recovered,
      recovered,
      nextState: { failing: false, lastAlertTs: recovered ? now : prev.lastAlertTs },
    };
  }
  const isNew = !prev.failing;
  const stale = now - prev.lastAlertTs >= REALERT_AFTER_S;
  const send = isNew || stale;
  return {
    send,
    recovered: false,
    nextState: { failing: true, lastAlertTs: send ? now : prev.lastAlertTs },
  };
}

export function formatAlert(h: Health, recovered: boolean): string {
  if (recovered) return "הסוכן חזר לפעול. הכל תקין.";
  return ["הסוכן לא תקין כרגע:", ...h.faults.map((f) => `- ${f}`)].join("\n");
}

// --- IO ----------------------------------------------------------------------

const STATE_FILE = process.env.HEALTH_STATE_FILE ?? statePath("health-state.json");
export const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE ?? statePath("heartbeat");

function loadState(): AlertState {
  try {
    const s = JSON.parse(readNoFollow(STATE_FILE));
    return { failing: !!s.failing, lastAlertTs: Number(s.lastAlertTs) || 0, integrityStale: s.integrityStale === true };
  } catch (e: any) {
    if (e?.code !== "ENOENT") console.error(`[HEALTH] ${STATE_FILE} unreadable, treated as empty: ${e?.message ?? e}`);
    return { failing: false, lastAlertTs: 0 };
  }
}
function saveState(s: AlertState) {
  writeAtomic(STATE_FILE, JSON.stringify(s));
}

function heartbeatAge(now: number): number | null {
  try {
    const ts = Number(readNoFollow(HEARTBEAT_FILE).trim());
    return Number.isFinite(ts) ? now - ts : null;
  } catch (e: any) {
    if (e?.code !== "ENOENT") console.error(`[HEALTH] ${HEARTBEAT_FILE} unreadable: ${e?.message ?? e}`);
    return null;
  }
}

async function serviceActive(): Promise<boolean> {
  const p = Bun.spawn(["systemctl", "is-active", "telegram-agent"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return out === "active";
}

/** Cheapest possible round trip that proves the CLI can still reach the API.
 *  Covers auth failures (2026-06-20) and upstream overload (2026-07-29) — both
 *  can arrive as printed output on a zero exit code. */
/** The probe's argv. The tools every turn is denied (Monitor) come last, after the
 *  prompt, since the flag takes every following word up to the next flag. */
export function healthProbeArgv(): string[] {
  return withAlwaysDisallowed(["claude", "-p", "reply with the single word ok"]);
}

async function claudeAuthOk(): Promise<boolean> {
  const p = Bun.spawn(healthProbeArgv(), {
    stdout: "pipe", stderr: "pipe",
  });
  const killer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 120_000);
  try {
    const [code, out, err] = await Promise.all([
      p.exited,
      new Response(p.stdout).text(),
      new Response(p.stderr).text().catch(() => ""),
    ]);
    if (code !== 0) return false;
    // The CLI can exit 0 while printing the API error as its answer, so the
    // text is the real signal. 529/overloaded is included: on 2026-07-29 that
    // shape replaced three real replies and no monitor noticed.
    return !/401|invalid authentication|unauthorized|please run .*login|529|overloaded|api error/i.test(
      out + err,
    );
  } finally {
    clearTimeout(killer);
  }
}

/** Alert straight through the Bot API. Never via the poller — the poller may be
 *  exactly what is broken. */
async function notify(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.HEALTH_CHAT_ID;
  if (!token || !chatId) {
    console.error("[HEALTH] cannot alert: TELEGRAM_BOT_TOKEN or chat id not set");
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: isolateLatin(text, 4096) }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok;
}

async function main() {
  const withAuth = process.argv.includes("--auth");
  const now = Math.floor(Date.now() / 1000);
  const prev = loadState();

  const probe: Probe = {
    serviceActive: await serviceActive(),
    heartbeatAge: heartbeatAge(now),
    claudeAuthOk: withAuth ? await claudeAuthOk() : null,
    integrityStale: integrityReading(
      process.env.INTEGRITY_NIGHTLY === "1",
      INTEGRITY_LAST_FILE,
      now,
      quietNow(new Date(now * 1000)),
      prev.integrityStale ?? false,
    ),
  };
  const h = assessHealth(probe);
  const decision = shouldAlert(h, prev, now);

  console.log(
    `[HEALTH] ${h.healthy ? "ok" : "FAULT"}${h.faults.length ? ": " + h.faults.join("; ") : ""}` +
      ` (heartbeat ${probe.heartbeatAge ?? "none"}s, auth ${probe.claudeAuthOk ?? "skipped"})`,
  );
  if (decision.send) {
    const sent = await notify(formatAlert(h, decision.recovered));
    console.log(`[HEALTH] alert ${sent ? "sent" : "FAILED TO SEND"}`);
  }
  saveState({ ...decision.nextState, integrityStale: probe.integrityStale ?? false });
  process.exitCode = h.healthy ? 0 : 1;
}

if (import.meta.main) main();
