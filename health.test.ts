import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessHealth, shouldAlert, formatAlert, HEARTBEAT_STALE_S, healthProbeArgv, integrityStale, integrityReading,
  type Probe, type AlertState,
} from "./health";

test("the health probe's claude -p starts without the Monitor tool, the list last", () => {
  expect(healthProbeArgv()).toEqual(["claude", "-p", "reply with the single word ok", "--disallowedTools", "Monitor"]);
});

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
    // The poller stamps one at startup, so by the time it is serving, absence
    // really does mean it never came up.
    const h = assessHealth({ ...ok, heartbeatAge: null });
    expect(h.healthy).toBe(false);
  });

  test("a heartbeat written seconds ago (fresh restart) is healthy", () => {
    // Regression: the first probe after a deploy hit a POLL_TIMEOUT-wide window
    // where no heartbeat existed yet and alerted on a perfectly good boot.
    expect(assessHealth({ ...ok, heartbeatAge: 1 }).healthy).toBe(true);
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

describe("the nightly integrity check's dead-man rule", () => {
  const H = 3600;
  test("fires at 97 h outside a quiet window, not at 95 h, and not inside one", () => {
    expect(integrityStale(true, NOW - 97 * H, NOW, false)).toBe(true);
    expect(integrityStale(true, NOW - 95 * H, NOW, false)).toBe(false);
    expect(integrityStale(true, NOW - 97 * H, NOW, true)).toBe(false);
  });

  test("a missing record is stale when the nightly run is on; nothing fires when it is off", () => {
    expect(integrityStale(true, null, NOW, false)).toBe(true);
    expect(integrityStale(false, null, NOW, false)).toBe(false);
    expect(integrityStale(false, NOW - 200 * H, NOW, false)).toBe(false);
  });

  test("while quiet the previous verdict is carried: no recovery note at Shabbat entry, no new alert inside it", () => {
    expect(integrityStale(true, NOW - 200 * H, NOW, true, true)).toBe(true);
    expect(integrityStale(true, NOW - 200 * H, NOW, true, false)).toBe(false);
    expect(integrityStale(false, NOW - 200 * H, NOW, true, true)).toBe(false);
  });

  describe("integrityReading (what the cron run sees)", () => {
    const made: string[] = [];
    afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
    const lastFile = (body?: object) => {
      const d = mkdtempSync(join(tmpdir(), "hint-")); made.push(d);
      const p = join(d, "integrity-last.json");
      if (body) writeFileSync(p, JSON.stringify(body));
      return p;
    };

    test("on by the switch alone: a missing file is stale", () => {
      expect(integrityReading(true, lastFile(), NOW, false, false)).toBe(true);
      expect(integrityReading(false, lastFile(), NOW, false, false)).toBe(false);
    });

    test("on by the file alone (cron did not load the env file): an old completion is stale, a recent one is not", () => {
      expect(integrityReading(false, lastFile({ attempted: "x", date: "x", at: NOW - 97 * H }), NOW, false, false)).toBe(true);
      expect(integrityReading(false, lastFile({ attempted: "x", date: "x", at: NOW - 95 * H }), NOW, false, false)).toBe(false);
    });

    test("before any completion it measures from the poller's `since`", () => {
      expect(integrityReading(false, lastFile({ since: NOW - 95 * H }), NOW, false, false)).toBe(false);
      expect(integrityReading(false, lastFile({ since: NOW - 97 * H }), NOW, false, false)).toBe(true);
      expect(integrityReading(false, lastFile({ since: NOW - 200 * H, at: NOW - 1 * H }), NOW, false, false)).toBe(false);
    });

    test("quiet carries the previous verdict here too", () => {
      expect(integrityReading(true, lastFile({ at: NOW - 200 * H }), NOW, true, false)).toBe(false);
      expect(integrityReading(true, lastFile({ at: NOW - 1 * H }), NOW, true, true)).toBe(true);
    });
  });

  test("assessHealth reports it like its other faults", () => {
    const h = assessHealth({ ...ok, integrityStale: true });
    expect(h.healthy).toBe(false);
    expect(h.faults).toEqual(["integrity check has not completed for 96h"]);
    expect(assessHealth({ ...ok, integrityStale: false }).healthy).toBe(true);
  });
});
