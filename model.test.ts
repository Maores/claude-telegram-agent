import { test, expect } from "bun:test";
import { pickModel, detectDevIntent } from "./model.ts";

test("defaults to sonnet for ordinary messages", () => {
  expect(pickModel("what's 2+2?").model).toBe("sonnet");
  expect(pickModel("remind me at 6pm to call the bank").model).toBe("sonnet");
  expect(pickModel("summarize my latest email").model).toBe("sonnet");
});

test("/opus prefix escalates to opus and is stripped", () => {
  const r = pickModel("/opus solve this hard puzzle");
  expect(r.model).toBe("opus");
  expect(r.prompt).toBe("solve this hard puzzle");
});

test("/opus prefix is case-insensitive", () => {
  expect(pickModel("/OPUS hi").model).toBe("opus");
  expect(pickModel("/Opus hi").prompt).toBe("hi");
});

test("/sonnet prefix forces sonnet and is stripped", () => {
  const r = pickModel("/sonnet just a quick one");
  expect(r.model).toBe("sonnet");
  expect(r.prompt).toBe("just a quick one");
});

test("keywords escalate to opus without stripping the text", () => {
  expect(pickModel("think hard about this problem").model).toBe("opus");
  expect(pickModel("can you use opus for this?").model).toBe("opus");
  expect(pickModel("Think hard about X").prompt).toBe("Think hard about X");
});

test("code blocks escalate to opus", () => {
  expect(pickModel("fix this:\n```js\nconsole.log(1)\n```").model).toBe("opus");
});

test("a long but ordinary message stays on sonnet", () => {
  expect(pickModel("please summarize the following: " + "blah ".repeat(400)).model).toBe("sonnet");
});

test("surrounding whitespace is handled", () => {
  expect(pickModel("   /opus   hello world  ").prompt).toBe("hello world");
});

// detectDevIntent — fires the interview directive for build requests (agenda #4)
test("detectDevIntent fires on English build requests", () => {
  expect(detectDevIntent("develop a /usage command for the bot")).toBe(true);
  expect(detectDevIntent("can you implement rate limiting?")).toBe(true);
  expect(detectDevIntent("let's build a new feature")).toBe(true);
  expect(detectDevIntent("refactor the poller")).toBe(true);
  expect(detectDevIntent("add a feature that summarizes emails")).toBe(true);
  expect(detectDevIntent("write code to parse the feed")).toBe(true);
  // inflections match via per-token prefix
  expect(detectDevIntent("I'm thinking about building a dashboard")).toBe(true);
  expect(detectDevIntent("implementing the new flow")).toBe(true);
});

test("detectDevIntent fires on Hebrew build requests", () => {
  expect(detectDevIntent("תבנה לי פיצ'ר שמסכם מיילים")).toBe(true);
  expect(detectDevIntent("תפתח פונקציה חדשה")).toBe(true);
  expect(detectDevIntent("בנה את זה")).toBe(true);
  expect(detectDevIntent("תוסיף פיצ'ר חדש")).toBe(true);
  expect(detectDevIntent("תכתוב קוד שיעשה את זה")).toBe(true);
});

test("detectDevIntent does NOT fire on ordinary messages", () => {
  expect(detectDevIntent("what's on my calendar today?")).toBe(false);
  expect(detectDevIntent("remind me at 6 to call the bank")).toBe(false);
  expect(detectDevIntent("summarize my latest email")).toBe(false);
  expect(detectDevIntent("create an event tomorrow at 3pm")).toBe(false); // "create" is not a trigger (calendar uses it)
  // Hebrew "הבנה" (understanding) must NOT match the "בנה" token
  expect(detectDevIntent("יש לי הבנה טובה של החומר")).toBe(false);
  expect(detectDevIntent("")).toBe(false);
});
