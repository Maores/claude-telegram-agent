import { test, expect, beforeEach } from "bun:test";
import { rmSync, existsSync, readFileSync } from "node:fs";

// ask.ts is a CLI, so this drives the real binary end to end. That matters:
// the bug it guards lived in ask.ts alone, and a test against proposeChoice
// would have passed while the CLI still truncated.

const STORE = `${import.meta.dir}/choices.asktest-${process.pid}.json`;
const env = { ...process.env, CHOICES_FILE: STORE, TELEGRAM_CHAT_ID: "1", TELEGRAM_TURN_ID: "t-asktest" };

beforeEach(() => {
  rmSync(STORE, { force: true });
  rmSync(STORE + ".lock", { force: true });
});

const runAsk = (options: string[]) =>
  Bun.spawnSync({
    cmd: ["bun", "run", `${import.meta.dir}/ask.ts`, "choice", "--question", "איך לפתוח את זה?",
          ...options.flatMap((o) => ["--option", o])],
    env,
    cwd: import.meta.dir,
  });

const stored = () => JSON.parse(readFileSync(STORE, "utf8"));

// --- the option IS the next turn's prompt, not a label (2026-08-21) --------
// ask.ts cut every option at 100 chars. A real dev option is ~134, so the
// STORED text was truncated mid-word before Telegram rendered anything: the
// live store held "…לימי שבוע ותאריכים, וכשהפענוח נ". Tapping that button
// would have sent half a sentence as the entire next prompt.

const LONG =
  "/opus תקן את הבאג של «זמן אחר…» בפולר: הרחב את parseCustomSnoozeTime לימי שבוע ותאריכים, " +
  "וכשהפענוח נכשל אל תזרוק את השאלה אלא העבר אותה אליי עם ההקשר. ענף + PR, בלי לדפלוי.";

test("a realistic dev option reaches the store whole", () => {
  expect(LONG.length).toBeGreaterThan(100); // the exact shape that used to be cut
  const r = runAsk([LONG, "בטל"]);
  expect(r.exitCode).toBe(0);
  expect(existsSync(STORE)).toBe(true);
  const opts = stored()[0].options;
  expect(opts[0]).toBe(LONG);
  expect(opts[0].endsWith("בלי לדפלוי.")).toBe(true); // not "…וכשהפענוח נ"
});

test("the sanity cap still exists, far above any real option", () => {
  const r = runAsk(["x".repeat(1500), "בטל"]);
  expect(r.exitCode).toBe(0);
  expect(stored()[0].options[0].length).toBe(1000);
});
