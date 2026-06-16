import { test, expect } from "bun:test";
import { openDb } from "./db";
import {
  addMonitor, getMonitor, listMonitors, setStatus, removeMonitor,
  dueMonitors, recordCheck, evalThreshold, decideWebpageFire, MonitorError,
  webpageBasis, getByPath, extractNumber,
} from "./monitors";

test("add/get/list/setStatus/remove round-trip", () => {
  const db = openDb(":memory:");
  const m = addMonitor(db, {
    chatId: 1, name: "btc", type: "threshold", url: "https://api.example.com/p",
    config: { op: "lt", value: 40000, jsonPath: "price" }, intervalS: 900, onFire: "notify",
  });
  expect(getMonitor(db, m.id)!.name).toBe("btc");
  expect(getMonitor(db, m.id)!.config.op).toBe("lt");
  expect(listMonitors(db, 1).length).toBe(1);
  setStatus(db, m.id, "paused");
  expect(getMonitor(db, m.id)!.status).toBe("paused");
  removeMonitor(db, m.id);
  expect(getMonitor(db, m.id)).toBeNull();
  db.close();
});

test("interval is floored at 300s", () => {
  const db = openDb(":memory:");
  const m = addMonitor(db, {
    chatId: 1, name: "x", type: "webpage", url: "https://e.com", config: {}, intervalS: 30,
  });
  expect(getMonitor(db, m.id)!.interval_s).toBe(300);
  db.close();
});

test("addMonitor rejects non-https / blocked urls and malformed thresholds", () => {
  const db = openDb(":memory:");
  expect(() => addMonitor(db, { chatId: 1, name: "x", type: "webpage", url: "http://e.com", config: {}, intervalS: 900 }))
    .toThrow(MonitorError);
  expect(() => addMonitor(db, { chatId: 1, name: "x", type: "webpage", url: "https://127.0.0.1/", config: {}, intervalS: 900 }))
    .toThrow(MonitorError);
  expect(() => addMonitor(db, { chatId: 1, name: "x", type: "threshold", url: "https://e.com", config: {}, intervalS: 900 }))
    .toThrow(MonitorError); // no op/value
  db.close();
});

test("evalThreshold lt edge-detects: fires on cross-in, not baseline, re-arms", () => {
  expect(evalThreshold(39000, "lt", 40000, "above")).toEqual({ fired: true, newState: "below" });
  expect(evalThreshold(38000, "lt", 40000, "below")).toEqual({ fired: false, newState: "below" });
  expect(evalThreshold(39000, "lt", 40000, null)).toEqual({ fired: false, newState: "below" }); // baseline
  expect(evalThreshold(41000, "lt", 40000, "below")).toEqual({ fired: false, newState: "above" }); // re-arm
});

test("evalThreshold gt and cross", () => {
  expect(evalThreshold(41000, "gt", 40000, "below")).toEqual({ fired: true, newState: "above" });
  expect(evalThreshold(41000, "cross", 40000, "below")).toEqual({ fired: true, newState: "above" });
  expect(evalThreshold(39000, "cross", 40000, "above")).toEqual({ fired: true, newState: "below" });
  expect(evalThreshold(41000, "cross", 40000, "above")).toEqual({ fired: false, newState: "above" });
  expect(evalThreshold(39000, "cross", 40000, null)).toEqual({ fired: false, newState: "below" }); // baseline
});

test("decideWebpageFire fires only on change with a baseline", () => {
  expect(decideWebpageFire(null, "h1")).toBe(false);
  expect(decideWebpageFire("h1", "h1")).toBe(false);
  expect(decideWebpageFire("h1", "h2")).toBe(true);
});

test("dueMonitors selects active + interval elapsed", () => {
  const db = openDb(":memory:");
  const m = addMonitor(db, {
    chatId: 1, name: "x", type: "webpage", url: "https://e.com", config: {}, intervalS: 300,
  });
  expect(dueMonitors(db, 10_000).map((x) => x.id)).toContain(m.id); // never checked -> due
  recordCheck(db, m.id, { lastValue: "h1", success: true });
  const now = getMonitor(db, m.id)!.last_checked_ts!;
  expect(dueMonitors(db, now + 100).map((x) => x.id)).not.toContain(m.id);
  expect(dueMonitors(db, now + 400).map((x) => x.id)).toContain(m.id);
  db.close();
});

test("webpageBasis narrows to keyword segments, marker when absent", () => {
  const text = "Price is $5 now. The weather is nice. Stock count: 12.";
  expect(webpageBasis(text)).toBe(text); // no keyword -> whole text
  expect(webpageBasis(text, "price")).toContain("Price is $5");
  expect(webpageBasis(text, "price")).not.toContain("weather");
  expect(webpageBasis(text, "absent-word")).toBe("__keyword_absent__");
});

test("getByPath reads dotted paths", () => {
  expect(getByPath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  expect(getByPath({ a: 1 }, "a.missing")).toBeUndefined();
});

test("extractNumber: jsonPath, regex, fallback", () => {
  expect(extractNumber('{"data":{"price":38500}}', { jsonPath: "data.price" })).toBe(38500);
  expect(extractNumber("BTC = 41,250 USD", { regex: "=\\s*([\\d,]+)" })).toBe(41250);
  expect(extractNumber("the value is 17 today", {})).toBe(17);
  expect(extractNumber("no digits here", {})).toBeNull();
});

test("recordCheck auto-pauses after 5 consecutive failures and resets on success", () => {
  const db = openDb(":memory:");
  const m = addMonitor(db, {
    chatId: 1, name: "x", type: "webpage", url: "https://e.com", config: {}, intervalS: 300,
  });
  for (let i = 0; i < 4; i++) recordCheck(db, m.id, { success: false });
  expect(getMonitor(db, m.id)!.status).toBe("active");
  expect(getMonitor(db, m.id)!.consecutive_failures).toBe(4);
  recordCheck(db, m.id, { success: true });
  expect(getMonitor(db, m.id)!.consecutive_failures).toBe(0);
  for (let i = 0; i < 5; i++) recordCheck(db, m.id, { success: false });
  expect(getMonitor(db, m.id)!.status).toBe("paused");
  db.close();
});
