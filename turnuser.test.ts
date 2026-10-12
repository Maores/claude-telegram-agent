import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { turnSpawn, turnUser, isSecretName, isSecretValue, TURN_SECRETS, TURN_WRAPPER, parseProcessList, descendantsOf, orphansOf, killAsUserArgv } from "./turnuser";

const full = {
  PATH: "/usr/bin:/bin", HOME: "/home/someone", USER: "someone", TELEGRAM_BOT_TOKEN: "tok-test", GROQ_API_KEY: "groq-test",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-test", ICLOUD_USER: "u-test", ICLOUD_APP_PASSWORD: "p-test", TELEGRAM_CHAT_ID: "1",
  TELEGRAM_TURN_ID: "t1", CLAUDE_AUTO_SESSION: "1", STATE_DIR: "/var/lib/telegram-agent", MEM_USER_BUDGET: "2200",
  RECALL_K: "5", TZ: "Asia/Jerusalem", SUDO_USER: "x", XDG_RUNTIME_DIR: "/run/user/1000", SKILL_APPROVAL: "1",
  PING_URL: "https://user:pw@example.test/x",
};

test("unset: exactly as given", () => {
  const r = turnSpawn(["claude", "-p"], full);
  expect(r.argv).toEqual(["claude", "-p"]);
  expect(r.env.TELEGRAM_BOT_TOKEN).toBe("tok-test");
});

test("set: sudo, env, the per-turn wrapper; non-secrets on the command line; only the three secrets in the environment", () => {
  const r = turnSpawn(["claude", "-p"], { ...full, TURN_USER: "agentturn" });
  expect(r.argv.slice(0, 6)).toEqual(["/usr/bin/sudo", "-n", "-u", "agentturn", "--", "/usr/bin/env"]);
  for (const a of ["HOME=/home/agentturn", "TMPDIR=/home/agentturn/tmp", "TELEGRAM_TURN_ID=t1", "TELEGRAM_CHAT_ID=1", "CLAUDE_AUTO_SESSION=1", "MEM_USER_BUDGET=2200", "RECALL_K=5", "TZ=Asia/Jerusalem", "SKILL_APPROVAL=1", "INBOX_STATUS_FILE=/var/lib/telegram-agent/inbox-status.json", "CC_DIGEST_SNAPSHOT=1", "RCHANNEL_SPOOL=/var/lib/telegram-agent/shared/rchannel-proposals", "/bin/sh"]) expect(r.argv).toContain(a);
  expect(r.argv.slice(-2)).toEqual(["claude", "-p"]);
  const line = r.argv.join(" ");
  for (const s of ["oauth-test", "u-test", "p-test", "tok-test", "groq-test", "user:pw", "SUDO_USER", "XDG_RUNTIME_DIR", "HOME=/home/someone", "STATE_DIR=/var/lib"]) expect(line).not.toContain(s);
  expect(Object.keys(r.env).sort()).toEqual([...TURN_SECRETS, "PATH"].sort());
});

test("secret-shaped names and values", () => {
  for (const k of ["TELEGRAM_BOT_TOKEN", "GROQ_API_KEY", "ICLOUD_USER", "SOME_PASSWORD", "X_SECRET"]) expect(isSecretName(k)).toBe(true);
  for (const k of ["TELEGRAM_TURN_ID", "STATE_DIR", "MEM_USER_BUDGET", "SKILL_APPROVAL"]) expect(isSecretName(k)).toBe(false);
  expect(isSecretValue("https://user:pw@example.test/x")).toBe(true);
  expect(isSecretValue("https://example.test/x")).toBe(false);
});

test("the wider denylist: PASS, AUTH, PRIVATE and DSN names, ping URLs and UUID paths; the allow set crosses", () => {
  for (const k of ["SMTP_PASS", "DB_PASSWD", "PASS", "MAIL_PASSPHRASE", "AUTH", "BASIC_AUTH", "AUTH_HEADER", "X_PRIVATE", "PRIVATE_PEM", "SENTRY_DSN", "DSN"]) expect([k, isSecretName(k)]).toEqual([k, true]);
  // word parts, not any substring: these are not secrets
  for (const k of ["PASSTHROUGH_MODE", "COMPASS_DIR", "GIT_AUTHOR_NAME", "AUTHOR", "DSNAME", "MAX_TOKENS_X"]) expect([k, isSecretName(k)]).toEqual([k, k === "MAX_TOKENS_X"]);
  for (const k of ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "MAX_THINKING_TOKENS"]) expect([k, isSecretName(k)]).toEqual([k, false]);
  expect(isSecretValue("https://hc-ping.com/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab")).toBe(true);
  expect(isSecretValue("https://hc-ping.com/ping/some-slug")).toBe(true);
  expect(isSecretValue("http://eu.hc-ping.com/x")).toBe(true);
  expect(isSecretValue("https://example.test/hooks/0F1E2D3C-AAAA-BBBB-CCCC-1234567890AB/run")).toBe(true);
  expect(isSecretValue("https://example.test/a/b?c=1")).toBe(false);
  expect(isSecretValue("https://not-hc-ping.com.example.test/x")).toBe(false);
  expect(isSecretValue("0f1e2d3c-aaaa-bbbb-cccc-1234567890ab")).toBe(false); // a bare id is not a URL
  // and they stay off the command line
  const r = turnSpawn(["claude"], { ...full, TURN_USER: "agentturn", SMTP_PASS: "pw-test", HC_URL: "https://hc-ping.com/x", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "32000" });
  const line = r.argv.join(" ");
  expect(line).not.toContain("pw-test");
  expect(line).not.toContain("hc-ping.com");
  expect(r.argv).toContain("CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000");
});

test("a malformed TURN_USER is refused", () => {
  expect(() => turnUser({ TURN_USER: "a b" })).toThrow();
  expect(turnUser({ TURN_USER: "" })).toBeNull();
});

const rows = parseProcessList([
  "1 0 root", "900 1 claudebot",            // the poller
  "200 900 root", "201 200 agentturn", "202 201 agentturn",   // a running turn under its sudo
  "300 1 agentturn", "301 300 agentturn",   // a double-forked daemon and its child
  "400 1 claudebot", "500 400 root", "501 500 agentturn",     // a hand-run probe under a claudebot shell
].join("\n"));

test("descendants of a turn's sudo pid", () => {
  expect(descendantsOf(rows, 200, "agentturn").sort()).toEqual([201, 202]);
});
test("orphans: only processes whose nearest non-agentturn ancestor is pid 1", () => {
  expect(orphansOf(rows, "agentturn").sort()).toEqual([300, 301]);
});
function chain(top: number, topParent: number, depth: number, user: string): string[] {
  const lines: string[] = [];
  for (let i = 0; i < depth; i++) lines.push(`${top + i} ${i === 0 ? topParent : top + i - 1} ${user}`);
  return lines;
}

test("a chain deeper than 64 is walked to the end", () => {
  const deep = parseProcessList(["1 0 root", "900 1 claudebot", "200 900 root", ...chain(1001, 200, 70, "agentturn"), ...chain(2001, 1, 70, "agentturn")].join("\n"));
  const under = descendantsOf(deep, 200, "agentturn");
  expect(under.length).toBe(70);
  expect(under).toContain(1070);
  const orphans = orphansOf(deep, "agentturn");
  expect(orphans.length).toBe(70);
  expect(orphans).toContain(2070);
  expect(orphans).not.toContain(1001);
});

test("a cyclic list (a snapshot race) terminates and counts as neither descendant nor orphan", () => {
  const cyc = parseProcessList(["1 0 root", "200 1 root", "10 11 agentturn", "11 12 agentturn", "12 10 agentturn", "13 13 agentturn"].join("\n"));
  expect(descendantsOf(cyc, 200, "agentturn")).toEqual([]);
  expect(orphansOf(cyc, "agentturn")).toEqual([]);
});

test("kill runs as the turn user", () => {
  expect(killAsUserArgv("agentturn", "TERM", [3, 4])).toEqual(["/usr/bin/sudo", "-n", "-u", "agentturn", "--", "/usr/bin/kill", "-TERM", "3", "4"]);
});

test.skipIf(process.platform === "win32")("TURN_WRAPPER passes the exit code through, keeps stdin for the command, and removes its folder after a normal exit and after TERM", async () => {
  const home = mkdtempSync(join(tmpdir(), "tw-"));
  mkdirSync(join(home, "tmp"));
  try {
    const env = { PATH: "/usr/bin:/bin", HOME: home };
    const r = Bun.spawnSync(["/bin/sh", "-c", TURN_WRAPPER, "turn", "/bin/sh", "-c", 'test -d "$CLAUDE_CONFIG_DIR" && exit 7'], { env });
    expect(r.exitCode).toBe(7);
    expect(readdirSync(join(home, "tmp"))).toEqual([]);
    const c = Bun.spawnSync(["/bin/sh", "-c", TURN_WRAPPER, "turn", "/bin/cat"], { env, stdin: Buffer.from("the prompt") });
    expect(c.stdout.toString()).toBe("the prompt");
    // Like killTurnProc: TERM every process of the turn. The wrapper is signalled first, so the
    // exit code and the cleanup come from its TERM trap (without the trap it would die at once
    // and leave its folder); the trapped TERM is held until the foreground child exits, so the
    // child is signalled too.
    const p = Bun.spawn(["/bin/sh", "-c", TURN_WRAPPER, "turn", "/bin/sleep", "5"], { env });
    await Bun.sleep(300);
    p.kill("SIGTERM");
    await Bun.sleep(100);
    Bun.spawnSync(["pkill", "-TERM", "-P", String(p.pid)]);
    expect(await p.exited).toBe(143);
    expect(readdirSync(join(home, "tmp"))).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 15_000);
