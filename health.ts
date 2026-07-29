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
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  return { healthy: faults.length === 0, faults };
}

export interface AlertState { failing: boolean; lastAlertTs: number }
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

const STATE_FILE = process.env.HEALTH_STATE_FILE ?? join(import.meta.dir, "health-state.json");
export const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE ?? join(import.meta.dir, "heartbeat");

function loadState(): AlertState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { failing: !!s.failing, lastAlertTs: Number(s.lastAlertTs) || 0 };
  } catch {
    return { failing: false, lastAlertTs: 0 };
  }
}
function saveState(s: AlertState) {
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(s));
  require("node:fs").renameSync(tmp, STATE_FILE);
}

function heartbeatAge(now: number): number | null {
  try {
    const ts = Number(readFileSync(HEARTBEAT_FILE, "utf8").trim());
    return Number.isFinite(ts) ? now - ts : null;
  } catch {
    return null;
  }
}

async function serviceActive(): Promise<boolean> {
  const p = Bun.spawn(["systemctl", "is-active", "telegram-agent"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return out === "active";
}

/** Cheapest possible round trip that proves the CLI can still authenticate. */
async function claudeAuthOk(): Promise<boolean> {
  const p = Bun.spawn(["claude", "-p", "reply with the single word ok"], {
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
    // An auth failure can still exit 0 while printing the error as the answer.
    return !/401|invalid authentication|unauthorized|please run .*login/i.test(out + err);
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
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok;
}

async function main() {
  const withAuth = process.argv.includes("--auth");
  const now = Math.floor(Date.now() / 1000);

  const probe: Probe = {
    serviceActive: await serviceActive(),
    heartbeatAge: heartbeatAge(now),
    claudeAuthOk: withAuth ? await claudeAuthOk() : null,
  };
  const h = assessHealth(probe);
  const decision = shouldAlert(h, loadState(), now);

  console.log(
    `[HEALTH] ${h.healthy ? "ok" : "FAULT"}${h.faults.length ? ": " + h.faults.join("; ") : ""}` +
      ` (heartbeat ${probe.heartbeatAge ?? "none"}s, auth ${probe.claudeAuthOk ?? "skipped"})`,
  );
  if (decision.send) {
    const sent = await notify(formatAlert(h, decision.recovered));
    console.log(`[HEALTH] alert ${sent ? "sent" : "FAILED TO SEND"}`);
  }
  saveState(decision.nextState);
  process.exitCode = h.healthy ? 0 : 1;
}

if (import.meta.main) main();
