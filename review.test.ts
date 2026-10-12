import { test, expect } from "bun:test";
import { buildReviewPrompt, reviewSpawnArgs, shouldReview, REVIEW_ALLOWED_TOOLS } from "./review.ts";

test("buildReviewPrompt embeds the rules and the transcript in order", () => {
  const p = buildReviewPrompt([
    { role: "user", content: "אני אלרגי לבוטנים" },
    { role: "assistant", content: "רשמתי" },
  ]);
  expect(p).toContain("mem.ts add");
  expect(p).toContain("skill.ts");
  expect(p).toContain("--source derived");
  expect(p.indexOf("[user] אני אלרגי לבוטנים")).toBeLessThan(p.indexOf("[assistant] רשמתי"));
  expect(p).toContain("PATCH an existing");
});

test("reviewSpawnArgs whitelists exactly mem.ts and skill.ts, cheap model, no skip-permissions", () => {
  const args = reviewSpawnArgs();
  expect(args).toContain("--allowedTools");
  for (const t of REVIEW_ALLOWED_TOOLS) expect(args).toContain(t);
  expect(args).toContain("haiku");
  expect(args).not.toContain("--dangerously-skip-permissions"); // whitelist must bind
});

test("reviewSpawnArgs starts the review without the Monitor tool, after the whitelist", () => {
  const args = reviewSpawnArgs();
  expect(args.filter((a) => a === "--disallowedTools").length).toBe(1);
  expect(args.slice(-2)).toEqual(["--disallowedTools", "Monitor"]);
  const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  expect(allowed).toEqual(REVIEW_ALLOWED_TOOLS);
});

test("reviewSpawnArgs seals settings and MCP only under a turn user, before the whitelist", () => {
  const plain = reviewSpawnArgs("haiku", {});
  expect(plain).not.toContain("--setting-sources");
  expect(plain).not.toContain("--strict-mcp-config");
  const a = reviewSpawnArgs("haiku", { TURN_USER: "agentturn" });
  expect(a[a.indexOf("--setting-sources") + 1]).toBe("project,local");
  expect(a.filter((x) => x === "--strict-mcp-config").length).toBe(1);
  expect(a.indexOf("--setting-sources")).toBeLessThan(a.indexOf("--allowedTools"));
  expect(a.indexOf("--strict-mcp-config")).toBeLessThan(a.indexOf("--allowedTools"));
});

test("shouldReview gates by per-chat cooldown", () => {
  const state = new Map<number, number>();
  expect(shouldReview(1, 1000, state)).toBe(true);
  expect(shouldReview(1, 1000 + 899, state)).toBe(false); // inside 15 min
  expect(shouldReview(2, 1000 + 10, state)).toBe(true); // other chat independent
  expect(shouldReview(1, 1000 + 900, state)).toBe(true); // cooldown elapsed
});
