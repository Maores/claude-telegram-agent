import { describe, expect, test } from "bun:test";
import { filesToCapture } from "./selfdev";

// filesToCapture must return ONLY modified tracked files — the things a deploy's
// `git reset --hard` would destroy. Untracked (`??`) files survive a hard reset
// and gitignored files never appear in --porcelain, so both are excluded.

describe("filesToCapture", () => {
  test("includes modified / added / deleted tracked files", () => {
    expect(filesToCapture(" M poller.ts")).toEqual(["poller.ts"]);
    expect(filesToCapture("M  tasks.ts")).toEqual(["tasks.ts"]);
    expect(filesToCapture("MM both.ts")).toEqual(["both.ts"]);
    expect(filesToCapture("A  new.ts")).toEqual(["new.ts"]);
    expect(filesToCapture("D  gone.ts")).toEqual(["gone.ts"]);
  });

  test("captures the NEW path of a rename", () => {
    expect(filesToCapture("R  old.ts -> new.ts")).toEqual(["new.ts"]);
  });

  test("excludes untracked files (they survive reset --hard)", () => {
    expect(filesToCapture("?? cal_check.sh")).toEqual([]);
    expect(filesToCapture("?? followups.json")).toEqual([]);
  });

  test("excludes ignored files", () => {
    expect(filesToCapture("!! memory/bot.db")).toEqual([]);
  });

  test("empty / whitespace input yields no files", () => {
    expect(filesToCapture("")).toEqual([]);
    expect(filesToCapture("\n\n")).toEqual([]);
  });

  test("a realistic mixed status returns only the tracked code", () => {
    const porcelain = [
      " M poller.ts",
      "M  tasks.ts",
      "?? cal_check.sh",
      "?? followups.json",
      " M docs/x.md",
    ].join("\n");
    expect(filesToCapture(porcelain)).toEqual(["poller.ts", "tasks.ts", "docs/x.md"]);
  });

  test("unquotes a porcelain-quoted path with spaces", () => {
    expect(filesToCapture('M  "a file.ts"')).toEqual(["a file.ts"]);
  });

  test("trailing CR (CRLF) is stripped from paths", () => {
    expect(filesToCapture(" M poller.ts\r")).toEqual(["poller.ts"]);
  });
});
