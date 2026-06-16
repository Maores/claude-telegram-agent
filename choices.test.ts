import { test, expect, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import {
  proposeChoice,
  takePendingChoices,
  consumeChoice,
  pruneChoices,
  type Choice,
} from "./choices";
import { newTurnId } from "./pending";

// Isolate the store per run (copy of the PENDING_FILE pattern).
const TEST_FILE = `${import.meta.dir}/choices.test-${process.pid}.json`;
process.env.CHOICES_FILE = TEST_FILE;
beforeEach(() => {
  rmSync(TEST_FILE, { force: true });
  rmSync(TEST_FILE + ".lock", { force: true });
});

const OPTS = ["Pizza", "Sushi", "Burgers"];

test("proposeChoice refuses fewer than 2 or more than 4 options", () => {
  expect(() => proposeChoice(5, "q?", ["only one"], false, newTurnId(), 1000)).toThrow();
  expect(() => proposeChoice(5, "q?", ["a", "b", "c", "d", "e"], false, newTurnId(), 1000)).toThrow();
});

test("proposeChoice accepts 2..4 options and stores a pending record", () => {
  const two = proposeChoice(5, "Tea or coffee?", ["Tea", "Coffee"], false, newTurnId(), 1000);
  expect(two.status).toBe("pending");
  const c = proposeChoice(5, "Lunch?", OPTS, true, "turnX", 1000);
  expect(c.status).toBe("pending");
  expect(c.options).toEqual(OPTS);
  expect(c.allowOther).toBe(true);
  expect(c.question).toBe("Lunch?");
  expect(c.chatId).toBe(5);
  expect(c.turnId).toBe("turnX");
  expect(c.id.startsWith("ch")).toBe(true);
});

test("propose → takePendingChoices picks up exactly the turn's pending entries", () => {
  const turn = newTurnId();
  const a = proposeChoice(5, "q1", OPTS, false, turn, 1000);
  proposeChoice(5, "q2", OPTS, false, newTurnId(), 1000); // different turn
  proposeChoice(6, "q3", OPTS, false, turn, 1000); // different chat
  const picked = takePendingChoices(5, turn);
  expect(picked.map((p) => p.id)).toEqual([a.id]);
  expect(picked[0].status).toBe("pending");
  expect(picked[0].question).toBe("q1");
});

test("consumeChoice: once-only flip pending→answered, then stale", () => {
  const c = proposeChoice(5, "q", OPTS, false, newTurnId(), 1000);
  const first = consumeChoice(c.id, 2000);
  expect(first.outcome).toBe("ok");
  if (first.outcome === "ok") expect(first.choice.status).toBe("answered");
  expect(consumeChoice(c.id, 2001).outcome).toBe("stale");
  expect(consumeChoice("ch-no-such", 2002).outcome).toBe("stale");
});

test("consumeChoice: 1-hour expiry boundary", () => {
  const a = proposeChoice(5, "q", OPTS, false, newTurnId(), 1000);
  expect(consumeChoice(a.id, 1000 + 3600).outcome).toBe("ok"); // exactly 1h is still valid
  const b = proposeChoice(5, "q", OPTS, false, newTurnId(), 1000);
  expect(consumeChoice(b.id, 1000 + 3600 + 1).outcome).toBe("expired");
  // expired is terminal AND idempotent: a later tap still reports expired
  expect(consumeChoice(b.id, 1000 + 3600 + 2).outcome).toBe("expired");
});

test("pruneChoices: expires old pendings, drops old resolved, keeps fresh ones", () => {
  const nowS = 100_000;
  // resolved 25h ago → dropped entirely (past PRUNE_AFTER_S)
  const done = proposeChoice(5, "old resolved", OPTS, false, newTurnId(), nowS - 25 * 3600);
  consumeChoice(done.id, nowS - 25 * 3600 + 1);
  // pending 2h ago → past 1h expiry so prune flips it to expired, but within
  // PRUNE_AFTER_S so the entry is kept in the file
  const old = proposeChoice(5, "old pending", OPTS, false, newTurnId(), nowS - 2 * 3600);
  const fresh = proposeChoice(5, "really fresh", OPTS, false, newTurnId(), nowS - 10);
  pruneChoices(nowS);
  const left = takePendingChoices(5, fresh.turnId);
  expect(left.map((p) => p.id)).toEqual([fresh.id]); // only the fresh one is still pending
  expect(consumeChoice(old.id, nowS).outcome).toBe("expired"); // expired by prune, kept
  expect(consumeChoice(done.id, nowS).outcome).toBe("stale"); // dropped entirely
});
