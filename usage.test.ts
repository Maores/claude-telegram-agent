import { test, expect, describe } from "bun:test";
import { openDb } from "./db";
import {
  recordUsage,
  windowSpendUsd,
  shouldWarn,
  isLimitHitStderr,
  parseRetryAfter,
  detectUpstreamError,
  upstreamErrorReply,
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

// ---------------------------------------------------------------------------
// Upstream API errors that arrive as the ANSWER, not as a thrown error.
// Live incident 2026-07-29 23:25-23:40: three turns had their reply replaced by
// "API Error: 529 Overloaded". The poller treated each as a successful turn, so
// no [ERR] was logged, [MSG]/[DONE] stayed balanced, and Maor was handed a raw
// English error mid-Hebrew conversation. Nothing anywhere noticed.
// ---------------------------------------------------------------------------

describe("detectUpstreamError", () => {
  const REAL_529 =
    "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.";
  const REAL_401 = "Failed to authenticate. API Error: 401 Invalid authentication credentials";

  test("catches the exact 529 text from the live incident and marks it retryable", () => {
    const d = detectUpstreamError(REAL_529);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("overloaded");
    expect(d!.retryable).toBe(true);
  });

  test("catches the exact 401 text from the 2026-06-20 outage, not retryable", () => {
    const d = detectUpstreamError(REAL_401);
    expect(d!.kind).toBe("auth");
    expect(d!.retryable).toBe(false);
  });

  test("treats other 5xx as retryable server trouble", () => {
    expect(detectUpstreamError("API Error: 503 Service Unavailable")!.retryable).toBe(true);
    expect(detectUpstreamError("API Error: 500 Internal Server Error")!.retryable).toBe(true);
  });

  test("catches a bare overloaded_error payload", () => {
    expect(detectUpstreamError('{"type":"overloaded_error"}')!.kind).toBe("overloaded");
  });

  test("ignores a normal answer, including one that merely discusses errors", () => {
    expect(detectUpstreamError("קבעתי לך תזכורת למחר ב-9")).toBeNull();
    expect(detectUpstreamError("")).toBeNull();
    // A turn that explains HTTP status codes must not be mistaken for a failure.
    expect(
      detectUpstreamError("קוד 529 באמת אומר שהשרת עמוס, וזה מה שהסברתי לך על תקני HTTP בהרחבה רבה מאוד"),
    ).toBeNull();
  });

  // 2026-09-06 03:55: Maor sent a YouTube link and got this back as the reply.
  // It carries none of the shapes above (no "API Error", no status URL), so the
  // detector passed it straight through and the link was never answered.
  const REAL_SESSION_LIMIT = "You've hit your session limit · resets 4:40am (Asia/Jerusalem)";

  test("catches the CLI session-limit answer from the 2026-09-06 incident", () => {
    const d = detectUpstreamError(REAL_SESSION_LIMIT);
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("limit");
  });

  test("a limit is never retried, because it does not clear in seconds", () => {
    expect(detectUpstreamError(REAL_SESSION_LIMIT)!.retryable).toBe(false);
  });

  test("catches the other limit wordings the CLI can emit", () => {
    expect(detectUpstreamError("You've hit your usage limit · resets 9pm")!.kind).toBe("limit");
    expect(detectUpstreamError("Claude usage limit reached. Your limit will reset at 3am.")!.kind).toBe("limit");
  });

  test("does not flag a Hebrew answer that merely talks about limits", () => {
    expect(detectUpstreamError("הגעת למגבלת השימוש? זה קורה כשמריצים הרבה בקשות ברצף")).toBeNull();
    expect(detectUpstreamError("המגבלה מתאפסת ב-4:40 בלילה")).toBeNull();
  });

  test("only fires when the error dominates the reply, not when quoted inside a long answer", () => {
    // The signature must be the whole reply, otherwise a genuine explanation
    // that quotes the error would be silently retried and overwritten.
    const long = "הסבר ארוך: ".repeat(40) + "API Error: 529 Overloaded";
    expect(detectUpstreamError(long)).toBeNull();
  });

  test("survives the placeholder the poller substitutes for empty output", () => {
    expect(detectUpstreamError("(no output)")).toBeNull();
  });
});

describe("upstreamErrorReply", () => {
  test("explains an overload in Hebrew and blames the right thing", () => {
    const m = upstreamErrorReply({ kind: "overloaded", retryable: true });
    expect(m).toMatch(/עמוס|זמנית/);
    expect(m).not.toMatch(/API Error|529/); // never hand the raw error back
  });

  test("an auth failure tells him it needs attention rather than a retry", () => {
    const m = upstreamErrorReply({ kind: "auth", retryable: false });
    expect(m).toMatch(/התחברות|הרשאה|טוקן/);
  });

  test("every message is plain Hebrew with no LTR tokens (bidi rule)", () => {
    for (const kind of ["overloaded", "auth", "server"] as const) {
      const m = upstreamErrorReply({ kind, retryable: kind !== "auth" });
      expect(m).not.toMatch(/[A-Za-z]{3,}/);
    }
  });
});

describe("session-limit reply (2026-09-06)", () => {
  const REAL = "You've hit your session limit · resets 4:40am (Asia/Jerusalem)";

  test("tells Maor in Hebrew that the limit was hit, and when it resets", () => {
    const msg = upstreamErrorReply(detectUpstreamError(REAL)!, REAL);
    expect(msg).toContain("מגבלת השימוש");
    expect(msg).toContain("4:40am");
  });

  test("still answers in Hebrew when no reset time can be read", () => {
    const bare = "You've hit your session limit";
    const msg = upstreamErrorReply(detectUpstreamError(bare)!, bare);
    expect(msg).toContain("מגבלת השימוש");
    expect(msg.length).toBeGreaterThan(10);
  });

  test("parseRetryAfter reads a reset time written without a preposition", () => {
    expect(parseRetryAfter(REAL)).toBe("4:40am");
  });
});
