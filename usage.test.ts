import { test, expect, describe } from "bun:test";
import { openDb } from "./db";
import {
  recordUsage,
  windowSpendUsd,
  shouldWarn,
  isLimitHitStderr,
  parseRetryAfter,
  limitHitReply,
} from "./usage";

describe("usage_log recording + rolling-window spend", () => {
  test("records calls and sums cost_usd within the window", () => {
    const db = openDb(":memory:");
    recordUsage(db, { ts: 1000, chatId: 1, model: "opus", kind: "interactive", costUsd: 0.1, inputTokens: 100, outputTokens: 50 });
    recordUsage(db, { ts: 2000, chatId: 1, model: "sonnet", kind: "auto", costUsd: 0.05, inputTokens: 200, outputTokens: 30 });
    recordUsage(db, { ts: 500, chatId: 1, model: "opus", kind: "interactive", costUsd: 1.0, inputTokens: 10, outputTokens: 10 });
    expect(windowSpendUsd(db, 1000)).toBeCloseTo(0.15, 5); // only ts >= 1000
    expect(windowSpendUsd(db, 0)).toBeCloseTo(1.15, 5); // all three
  });

  test("NULL costs are ignored in the sum", () => {
    const db = openDb(":memory:");
    recordUsage(db, { ts: 1000, chatId: 1, model: "opus", kind: "interactive", costUsd: null, inputTokens: null, outputTokens: null });
    recordUsage(db, { ts: 1000, chatId: 1, model: "opus", kind: "interactive", costUsd: 0.2, inputTokens: 1, outputTokens: 1 });
    expect(windowSpendUsd(db, 0)).toBeCloseTo(0.2, 5);
  });

  test("empty table sums to 0", () => {
    const db = openDb(":memory:");
    expect(windowSpendUsd(db, 0)).toBe(0);
  });
});

describe("shouldWarn edge-detect", () => {
  test("fires once on crossing up, then stays quiet while still above", () => {
    const first = shouldWarn(6, 5, true);
    expect(first).toEqual({ warn: true, armed: false });
    const stillAbove = shouldWarn(7, 5, false);
    expect(stillAbove).toEqual({ warn: false, armed: false });
  });

  test("re-arms below the threshold, then can fire again", () => {
    const below = shouldWarn(3, 5, false);
    expect(below).toEqual({ warn: false, armed: true });
    expect(shouldWarn(6, 5, true).warn).toBe(true);
  });

  test("below threshold never warns", () => {
    expect(shouldWarn(1, 5, true).warn).toBe(false);
  });
});

describe("limit-hit classification", () => {
  test("isLimitHitStderr matches limit/quota/429 wording", () => {
    expect(isLimitHitStderr("claude exited 1: usage limit reached")).toBe(true);
    expect(isLimitHitStderr("rate limit exceeded")).toBe(true);
    expect(isLimitHitStderr("Error 429 Too Many Requests")).toBe(true);
    expect(isLimitHitStderr("you have exceeded your monthly limit")).toBe(true);
  });

  test("isLimitHitStderr is false for ordinary errors / empty", () => {
    expect(isLimitHitStderr("claude exited 1: ECONNRESET")).toBe(false);
    expect(isLimitHitStderr("claude timed out after 120000ms")).toBe(false);
    expect(isLimitHitStderr("")).toBe(false);
    expect(isLimitHitStderr(undefined)).toBe(false);
  });

  test("parseRetryAfter extracts a hint when present, else null", () => {
    expect(parseRetryAfter("rate limit, try again in 3 hours")).toBe("3 hours");
    expect(parseRetryAfter("retry after 60s")).toBe("60s");
    expect(parseRetryAfter("usage limit reached")).toBeNull();
  });

  test("limitHitReply returns a Hebrew message only for limit hits", () => {
    const m = limitHitReply("usage limit reached, try again in 2 hours");
    expect(m).toContain("מגבלת השימוש");
    expect(m).toContain("2 hours");
    expect(limitHitReply("ECONNRESET")).toBeNull();
  });
});
