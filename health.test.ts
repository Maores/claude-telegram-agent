import { describe, expect, test } from "bun:test";
import {
  assessHealth, shouldAlert, formatAlert, HEARTBEAT_STALE_S,
  type Probe, type AlertState,
} from "./health";

const NOW = 1_781_000_000;

// A healthy reading; each test bends one field.
const ok: Probe = { serviceActive: true, heartbeatAge: 30, claudeAuthOk: true };

describe("assessHealth", () => {
  test("all probes good means healthy with no faults", () => {
    const h = assessHealth(ok);
    expect(h.healthy).toBe(true);
    expect(h.faults).toEqual([]);
  });

  test("a stopped service is a fault", () => {
    const h = assessHealth({ ...ok, serviceActive: false });
    expect(h.healthy).toBe(false);
    expect(h.faults.join(" ")).toMatch(/service/i);
  });

  test("a stale heartbeat catches a poller that is running but wedged", () => {
    // The failure systemd cannot see: the process is up, the loop is not turning.
    const h = assessHealth({ ...ok, heartbeatAge: HEARTBEAT_STALE_S + 1 });
    expect(h.healthy).toBe(false);
    expect(h.faults.join(" ")).toMatch(/heartbeat|stall/i);
  });

  test("a heartbeat just inside the window is still fine", () => {
    expect(assessHealth({ ...ok, heartbeatAge: HEARTBEAT_STALE_S - 1 }).healthy).toBe(true);
  });

  test("failed claude auth is a fault — this is the 2026-06-20 outage", () => {
    // The service stayed active and Telegram was fine; only claude -p was 401,
    // and the agent went silent for 28 hours with nothing noticing.
    const h = assessHealth({ ...ok, claudeAuthOk: false });
    expect(h.healthy).toBe(false);
    expect(h.faults.join(" ")).toMatch(/auth|claude/i);
  });

  test("a skipped auth probe is not treated as a failure", () => {
    // The auth probe runs on a slower cadence than the rest; "not checked this
    // run" must never be mistaken for "broken".
    const h = assessHealth({ ...ok, claudeAuthOk: null });
    expect(h.healthy).toBe(true);
  });

  test("a missing heartbeat file reads as stalled, not as healthy", () => {
    const h = assessHealth({ ...ok, heartbeatAge: null });
    expect(h.healthy).toBe(false);
  });

  test("several faults are all reported", () => {
    const h = assessHealth({ serviceActive: false, heartbeatAge: null, claudeAuthOk: false });
    expect(h.faults.length).toBe(3);
  });
});

describe("shouldAlert", () => {
  const down = { healthy: false, faults: ["claude auth failing"] };
  const up = { healthy: true, faults: [] };

  test("alerts on the transition into a fault", () => {
    const s: AlertState = { failing: false, lastAlertTs: 0 };
    expect(shouldAlert(down, s, NOW).send).toBe(true);
  });

  test("does not re-alert every run while the same fault persists", () => {
    const s: AlertState = { failing: true, lastAlertTs: NOW - 60 };
    expect(shouldAlert(down, s, NOW).send).toBe(false);
  });

  test("re-alerts once a day if it is still broken, so it is not forgotten", () => {
    const s: AlertState = { failing: true, lastAlertTs: NOW - 86_400 - 1 };
    expect(shouldAlert(down, s, NOW).send).toBe(true);
  });

  test("sends a recovery note when it comes back", () => {
    const s: AlertState = { failing: true, lastAlertTs: NOW - 60 };
    const d = shouldAlert(up, s, NOW);
    expect(d.send).toBe(true);
    expect(d.recovered).toBe(true);
  });

  test("stays quiet when healthy and previously healthy", () => {
    const s: AlertState = { failing: false, lastAlertTs: 0 };
    expect(shouldAlert(up, s, NOW).send).toBe(false);
  });

  test("carries the new state forward for the next run", () => {
    const s: AlertState = { failing: false, lastAlertTs: 0 };
    expect(shouldAlert(down, s, NOW).nextState.failing).toBe(true);
    expect(shouldAlert(down, s, NOW).nextState.lastAlertTs).toBe(NOW);
  });

  test("a quiet run leaves the last alert time alone", () => {
    const s: AlertState = { failing: true, lastAlertTs: NOW - 60 };
    expect(shouldAlert(down, s, NOW).nextState.lastAlertTs).toBe(NOW - 60);
  });
});

describe("formatAlert", () => {
  test("names every fault so Maor knows what to fix", () => {
    const msg = formatAlert({ healthy: false, faults: ["service is not running", "claude auth failing"] }, false);
    expect(msg).toContain("service is not running");
    expect(msg).toContain("claude auth failing");
  });

  test("the recovery message is short and says it is back", () => {
    const msg = formatAlert({ healthy: true, faults: [] }, true);
    expect(msg).toMatch(/חזר|בסדר|OK/i);
    expect(msg.length).toBeLessThan(120);
  });
});
