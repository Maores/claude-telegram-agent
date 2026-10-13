import { afterAll, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runChecks,
  integrityMessage,
  integrityDue,
  nightlyIntegrity,
  readIntegrityLast,
  seedIntegrityLast,
  rootTimeoutArgv,
  realIo,
  parseServiceShow,
  parseEnvFile,
  STATE_ODD_FIND_ARGS,
  firewallRuleArgs,
  isEgressRuleLine,
  CODE_WRITABLE_FIND_ARGS,
  CHECK_NAMES,
  INCOMPLETE_MESSAGE,
  type IntegrityConfig,
  type IntegrityIo,
  type StatInfo,
  type Finding,
} from "./integrity";
import { openDb } from "./db";

const made: string[] = [];
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };

// ---------------------------------------------------------------------------
// A fake droplet where every check passes; each test bends exactly one fact.
// ---------------------------------------------------------------------------

const CFG: IntegrityConfig = {
  repo: "/home/someone/claude-bot",
  stateDir: "/srv/agent-state",
  turnUser: "agentturn",
  mainHome: "/home/someone",
  turnHome: "/home/agentturn",
};
const R = CFG.repo, S = CFG.stateDir, H = CFG.mainHome, T = CFG.turnHome;
const INBOX_LINE = 'command="bun run inbox.ts",restrict ssh-ed25519 AAAAtestkey phone-inbox';
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const dir = (owner: string, group: string, mode: number): StatInfo => ({ mode, owner, group, isLink: false, isDir: true, isFile: false, nlink: 2 });
const file = (owner: string, group: string, mode: number): StatInfo => ({ mode, owner, group, isLink: false, isDir: false, isFile: true, nlink: 1 });

type RunResult = { code: number; out: string };
interface World {
  files: Record<string, string>;
  sudoFiles: Record<string, string>;
  turnFiles: Record<string, string>;
  dirs: Record<string, string[]>;
  stats: Record<string, StatInfo>;
  runs: Record<string, RunResult | "hang">;
  env: Record<string, string>;
  drift: Record<string, string[]>;
}
const key = (argv: string[]) => argv.join(" | ");

function passingWorld(): World {
  const runs: Record<string, RunResult | "hang"> = {};
  const ok = (argv: string[], out = "") => { runs[key(argv)] = { code: 0, out }; };
  // 1
  ok(["git", "-C", R, "status", "--porcelain", "--", "guard.ts", "inbox.ts", "hooks", "deploy"]);
  ok(["git", "-C", R, "ls-files", "--others", "--exclude-standard", "hooks", "deploy"]);
  // 5
  const turnEntries = [".bashrc", ".profile", ".bash_logout", ".claude", ".config", ".cache", ".bun", ".local", "dev", "tmp", "outbox"];
  ok(["/usr/bin/sudo", "-n", "/usr/bin/ls", "-A", T], turnEntries.join("\n") + "\n");
  for (const d of [".claude", ".config", ".cache", ".bun", ".local"]) ok(["/usr/bin/sudo", "-n", "/usr/bin/ls", "-A", `${T}/${d}`]);
  // 9
  ok(STATE_ODD_FIND_ARGS(S));
  ok(["/usr/bin/sudo", "-n", "/usr/bin/find", S, "-path", `${S}/shared`, "-prune", "-o", "-type", "f", "(", "-perm", "/g+w,o+rwx", "-o", "!", "-user", "claudebot", ")", "-print"]);
  ok(["/usr/bin/sudo", "-n", "/usr/bin/find", `${S}/shared/skills`, "-type", "f", "!", "-user", "agentturn", "-print"]);
  // 11
  ok(["/usr/bin/id", "-nG", "agentturn"], "agentturn agentdata\n");
  ok(["/usr/bin/sudo", "-n", "-l", "-U", "agentturn"], "User agentturn is not allowed to run sudo on testhost.\n");
  ok(["/usr/bin/sudo", "-n", "/usr/sbin/sshd", "-T"], "port 22\npermitrootlogin without-password\ndenyusers agentturn\n");
  // 12
  ok(["/usr/bin/find", H, "-maxdepth", "1", "-mindepth", "1", "!", "-type", "l", "-perm", "/o+rwx", "!", "-name", "claude-bot", "!", "-name", ".bun"]);
  ok(CODE_WRITABLE_FIND_ARGS(R, `${H}/.bun`));
  for (const f of [`${R}/guard.ts`, `${R}/poller.ts`, `${H}/.bun/bin/bun`]) runs[key(["/usr/bin/sudo", "-n", "-u", "agentturn", "/usr/bin/test", "-w", f])] = { code: 1, out: "" };
  // 13
  ok(["/usr/bin/sudo", "-n", "/usr/sbin/iptables", "-C", "OUTPUT", ...firewallRuleArgs("agentturn")]);
  ok(["/usr/bin/sudo", "-n", "/usr/sbin/iptables", "-S", "OUTPUT"], "-P OUTPUT ACCEPT\n-A OUTPUT -d 169.254.169.254/32 -m owner --uid-owner 998 -j REJECT --reject-with icmp-port-unreachable\n-A OUTPUT -o lo -j ACCEPT\n");
  ok(["/usr/bin/id", "-u", "agentturn"], "998\n");
  // 15
  ok(["/usr/bin/sudo", "-n", "/usr/bin/journalctl", "-t", "agent-guard", "--since", "-48h", "-o", "cat"], "Bash: refused one\nBash: refused two\n");

  const stats: Record<string, StatInfo> = {};
  // 5
  stats[T] = dir("root", "root", 0o711);
  for (const f of [".bashrc", ".profile", ".bash_logout"]) stats[`${T}/${f}`] = file("root", "root", 0o644);
  for (const d of [".claude", ".config", ".cache", ".bun", ".local"]) stats[`${T}/${d}`] = dir("root", "root", 0o755);
  stats[`${T}/dev`] = dir("agentturn", "agentturn", 0o700);
  stats[`${T}/tmp`] = dir("agentturn", "agentturn", 0o700);
  stats[`${T}/outbox`] = dir("agentturn", "agentdata", 0o2750);
  // 9
  for (const d of ["", "/data", "/history", "/uploads", "/cc-digest", "/shared"]) stats[`${S}${d}`] = dir("claudebot", "agentdata", 0o2750);
  for (const d of ["/shared/stores", "/shared/data", "/shared/cc-digest", "/shared/rchannel-proposals", "/shared/memory/mirror"]) stats[`${S}${d}`] = dir("claudebot", "agentdata", 0o2770);
  for (const d of ["/shared/memory", "/shared/skills", "/shared/skills/.archive"]) stats[`${S}${d}`] = dir("claudebot", "agentdata", 0o3770);
  stats[`${S}/shared/memory/bot.db`] = file("claudebot", "agentdata", 0o660);
  stats[`${S}/shared/memory/bot.db-wal`] = file("claudebot", "agentdata", 0o660);
  // 12
  stats[H] = dir("claudebot", "claudebot", 0o711);
  for (const e of ["claude-bot", ".bun", ".ssh", "backups"]) stats[`${H}/${e}`] = dir("claudebot", "claudebot", e === "claude-bot" || e === ".bun" ? 0o755 : 0o700);

  return {
    files: {
      [`${R}/deploy/managed-settings.json`]: '{"allowManagedHooksOnly":true}\n',
      [`${R}/deploy/sudoers-agentturn`]: "claudebot ALL=(agentturn) NOPASSWD: ALL\n",
      [`${R}/.claude/settings.local.json`]: '{"permissions":{"allow":["Bash(ls:*)"]}}',
      [`${H}/.ssh/authorized_keys`]: `ssh-ed25519 AAAAother pc\n${INBOX_LINE}\n`,
      [`${R}/.state-dir`]: `${S}\n`,
    },
    sudoFiles: {
      "/etc/claude-code/managed-settings.json": '{"allowManagedHooksOnly":true}\n',
      "/etc/sudoers.d/telegram-agent-turn": "claudebot ALL=(agentturn) NOPASSWD: ALL\n",
      "/etc/telegram-agent/inbox-key.sha256": `${sha(INBOX_LINE)}  -\n`,
      "/etc/cron.deny": "agentturn\n",
      "/etc/at.deny": "daemon\nagentturn\n",
    },
    turnFiles: {},
    dirs: {
      [R]: ["guard.ts", "poller.ts", "hooks", "deploy", ".git", ".claude", "node_modules"],
      [S]: ["shared", "data", "history", "uploads", "cc-digest", "heartbeat", "approvals.json"],
      [H]: ["claude-bot", ".bun", ".ssh", "backups"],
    },
    stats,
    runs,
    env: { TURN_USER: "agentturn", STATE_DIR: S, AUTO_APPROVAL: "1", SKILL_APPROVAL: "1", INTEGRITY_NIGHTLY: "1", TELEGRAM_BOT_TOKEN: "tok-test" },
    drift: { [`${S}/shared/memory/bot.db`]: [] },
  };
}

function fakeIo(w: World): IntegrityIo {
  const got = <V>(m: Record<string, V>, k: string): V | null => (Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null);
  return {
    read: async (p) => got(w.files, p),
    sudoRead: async (p) => got(w.sudoFiles, p),
    turnRead: async (p) => got(w.turnFiles, p),
    list: async (d) => got(w.dirs, d),
    stat: async (p) => got(w.stats, p),
    run: async (argv) => {
      const r = got(w.runs, key(argv));
      if (r === "hang") return new Promise<RunResult>(() => {});
      if (r === null) throw new Error(`unexpected argv in the fake: ${key(argv)}`);
      return r;
    },
    serviceEnv: async () => ({ ...w.env }),
    dbDrift: async (p) => got(w.drift, p),
  };
}

const failing = (fs: Finding[]) => fs.filter((f) => !f.ok).map((f) => f.name);
async function onlyFails(bend: (w: World) => void, name: string): Promise<Finding> {
  const w = passingWorld();
  bend(w);
  const fs = await runChecks(fakeIo(w), CFG);
  expect(failing(fs)).toEqual([name]);
  return fs.find((f) => f.name === name)!;
}

describe("runChecks against a fake droplet", () => {
  test("every check passes in the passing world and the message is null", async () => {
    const fs = await runChecks(fakeIo(passingWorld()), CFG);
    expect(fs.map((f) => f.name)).toEqual([...CHECK_NAMES]);
    expect(fs.length).toBe(16);
    expect(failing(fs)).toEqual([]);
    expect(integrityMessage(fs)).toBeNull();
  });

  test("1 guard-files-match-git: a modified guard file", async () => {
    await onlyFails((w) => { w.runs[key(["git", "-C", R, "status", "--porcelain", "--", "guard.ts", "inbox.ts", "hooks", "deploy"])] = { code: 0, out: " M guard.ts\n" }; }, "guard-files-match-git");
  });

  test("1 guard-files-match-git: an untracked file under hooks", async () => {
    await onlyFails((w) => { w.runs[key(["git", "-C", R, "ls-files", "--others", "--exclude-standard", "hooks", "deploy"])] = { code: 0, out: "hooks/extra.ts\n" }; }, "guard-files-match-git");
  });

  test("2 managed-settings-match: the installed copy differs", async () => {
    await onlyFails((w) => { w.sudoFiles["/etc/claude-code/managed-settings.json"] = "{}"; }, "managed-settings-match");
  });

  test("2 managed-settings-match: the installed copy is missing", async () => {
    await onlyFails((w) => { delete w.sudoFiles["/etc/claude-code/managed-settings.json"]; }, "managed-settings-match");
  });

  test("3 sudoers-match: the installed drop-in differs", async () => {
    await onlyFails((w) => { w.sudoFiles["/etc/sudoers.d/telegram-agent-turn"] = "claudebot ALL=(ALL) NOPASSWD: ALL\n"; }, "sudoers-match");
  });

  test("4 no-settings-overrides: hooks in the local settings", async () => {
    await onlyFails((w) => { w.files[`${R}/.claude/settings.local.json`] = '{"hooks":{"PreToolUse":[]}}'; }, "no-settings-overrides");
  });

  test("4 no-settings-overrides: permissions.defaultMode, env and disableAllHooks each fail", async () => {
    for (const body of ['{"permissions":{"defaultMode":"bypassPermissions"}}', '{"env":{"X":"1"}}', '{"disableAllHooks":true}']) {
      await onlyFails((w) => { w.files[`${R}/.claude/settings.local.json`] = body; }, "no-settings-overrides");
    }
  });

  test("4 no-settings-overrides: an unparsable file fails without quoting it", async () => {
    const f = await onlyFails((w) => { w.files[`${R}/.claude/settings.local.json`] = "{ secret-ish text"; }, "no-settings-overrides");
    expect(f.detail).not.toContain("secret-ish");
  });

  test("4 no-settings-overrides: a turn user's settings file with env fails", async () => {
    await onlyFails((w) => { w.turnFiles[`${T}/.claude/settings.json`] = '{"env":{"X":"1"}}'; }, "no-settings-overrides");
  });

  test("4 no-settings-overrides: no local settings file is fine", async () => {
    const w = passingWorld();
    delete w.files[`${R}/.claude/settings.local.json`];
    expect(failing(await runChecks(fakeIo(w), CFG))).toEqual([]);
  });

  test("5 turn-home-sealed: a file inside the root-owned .claude", async () => {
    await onlyFails((w) => { w.runs[key(["/usr/bin/sudo", "-n", "/usr/bin/ls", "-A", `${T}/.claude`])] = { code: 0, out: "settings.json\n" }; }, "turn-home-sealed");
  });

  test("5 turn-home-sealed: an extra entry in the home", async () => {
    await onlyFails((w) => {
      w.runs[key(["/usr/bin/sudo", "-n", "/usr/bin/ls", "-A", T])] = { code: 0, out: ".bashrc\n.profile\n.bash_logout\n.claude\n.config\n.cache\n.bun\n.local\ndev\ntmp\noutbox\n.gitconfig\n" };
    }, "turn-home-sealed");
  });

  test("5 turn-home-sealed: the home owned by the turn user, a writable rc file, a wrong outbox mode", async () => {
    await onlyFails((w) => { w.stats[T] = dir("agentturn", "agentturn", 0o711); }, "turn-home-sealed");
    await onlyFails((w) => { w.stats[`${T}/.bashrc`] = file("agentturn", "agentturn", 0o644); }, "turn-home-sealed");
    await onlyFails((w) => { w.stats[`${T}/outbox`] = dir("agentturn", "agentdata", 0o750); }, "turn-home-sealed");
  });

  test("6 no-bunfig: a bunfig.toml in the repo or the main home's config", async () => {
    await onlyFails((w) => { w.stats[`${R}/bunfig.toml`] = file("claudebot", "claudebot", 0o644); }, "no-bunfig");
    await onlyFails((w) => { w.stats[`${H}/.config/.bunfig.toml`] = file("claudebot", "claudebot", 0o644); }, "no-bunfig");
  });

  test("7 no-env-files: a .env file in the repo", async () => {
    await onlyFails((w) => { w.dirs[R] = [...w.dirs[R], ".env.local"]; }, "no-env-files");
  });

  test("8 no-stray-state: a reminders.json in the repo while the state lives elsewhere", async () => {
    await onlyFails((w) => { w.dirs[R] = [...w.dirs[R], "reminders.json"]; }, "no-stray-state");
  });

  test("8 no-stray-state: the repo layout (stateDir === repo) has no stray state by definition", async () => {
    const cfg = { ...CFG, stateDir: R };
    const w = passingWorld();
    w.dirs[R] = [...w.dirs[R], "reminders.json"];
    const fs = await runChecks(fakeIo(w), cfg);
    expect(fs.find((f) => f.name === "no-stray-state")!.ok).toBe(true);
  });

  test("9 state-layout: a link, FIFO or hard link under the state folder (names never quoted)", async () => {
    const f = await onlyFails((w) => { w.runs[key(STATE_ODD_FIND_ARGS(S))] = { code: 0, out: `${S}/shared/stores/click-here-to-approve\n` }; }, "state-layout");
    expect(f.detail).not.toContain("click-here");
  });

  test("9 state-layout: a layout folder with the wrong mode, a file outside shared/ writable, a db file owned by the turn", async () => {
    await onlyFails((w) => { w.stats[`${S}/shared`] = dir("claudebot", "agentdata", 0o2770); }, "state-layout");
    await onlyFails((w) => { delete w.stats[`${S}/shared/skills/.archive`]; }, "state-layout");
    await onlyFails((w) => {
      w.runs[key(["/usr/bin/sudo", "-n", "/usr/bin/find", S, "-path", `${S}/shared`, "-prune", "-o", "-type", "f", "(", "-perm", "/g+w,o+rwx", "-o", "!", "-user", "claudebot", ")", "-print"])] = { code: 0, out: `${S}/approvals.json\n` };
    }, "state-layout");
    await onlyFails((w) => { w.stats[`${S}/shared/memory/bot.db-wal`] = file("agentturn", "agentdata", 0o660); }, "state-layout");
  });

  test("9 state-layout: with TURN_USER set, a skill file not owned by the turn user fails; unset, it is not checked", async () => {
    const skillsFind = key(["/usr/bin/sudo", "-n", "/usr/bin/find", `${S}/shared/skills`, "-type", "f", "!", "-user", "agentturn", "-print"]);
    await onlyFails((w) => { w.runs[skillsFind] = { code: 0, out: `${S}/shared/skills/x.md\n` }; }, "state-layout");
    const w = passingWorld();
    delete w.env.TURN_USER;
    delete w.runs[skillsFind]; // the fake throws on an argv it does not know: proves the find is not run
    const fs = await runChecks(fakeIo(w), CFG);
    expect(failing(fs)).toEqual(["service-switches"]);
  });

  test("10 inbox-key-unchanged: the phone-inbox line changed", async () => {
    await onlyFails((w) => { w.files[`${H}/.ssh/authorized_keys`] = `ssh-ed25519 AAAAother pc\n${INBOX_LINE.replace("AAAAtestkey", "AAAAplanted")}\n`; }, "inbox-key-unchanged");
  });

  test("10 inbox-key-unchanged: a second phone-inbox line", async () => {
    await onlyFails((w) => { w.files[`${H}/.ssh/authorized_keys`] = `${INBOX_LINE}\n${INBOX_LINE}\n`; }, "inbox-key-unchanged");
  });

  test("10 inbox-key-unchanged: the line is hashed without its newline", async () => {
    // A recorded hash taken WITH the newline must not match: pins the newline-free hashing.
    await onlyFails((w) => { w.sudoFiles["/etc/telegram-agent/inbox-key.sha256"] = `${sha(INBOX_LINE + "\n")}  -\n`; }, "inbox-key-unchanged");
  });

  test("11 turn-user-sealed: in the sudo group", async () => {
    await onlyFails((w) => { w.runs[key(["/usr/bin/id", "-nG", "agentturn"])] = { code: 0, out: "agentturn agentdata sudo\n" }; }, "turn-user-sealed");
  });

  test("11 turn-user-sealed: in claudebot's group, sudo rights, cron or at not denied, sshd not denying", async () => {
    await onlyFails((w) => { w.runs[key(["/usr/bin/id", "-nG", "agentturn"])] = { code: 0, out: "agentturn agentdata claudebot\n" }; }, "turn-user-sealed");
    await onlyFails((w) => { w.runs[key(["/usr/bin/sudo", "-n", "-l", "-U", "agentturn"])] = { code: 0, out: "User agentturn may run the following commands:\n    (ALL) ALL\n" }; }, "turn-user-sealed");
    await onlyFails((w) => { w.sudoFiles["/etc/cron.deny"] = "agentturnx\n"; }, "turn-user-sealed");
    await onlyFails((w) => { delete w.sudoFiles["/etc/at.deny"]; }, "turn-user-sealed");
    await onlyFails((w) => { w.sudoFiles["/etc/cron.allow"] = "root\nagentturn\n"; }, "turn-user-sealed");
    await onlyFails((w) => { w.runs[key(["/usr/bin/sudo", "-n", "/usr/sbin/sshd", "-T"])] = { code: 0, out: "port 22\ndenyusers someoneelse\n" }; }, "turn-user-sealed");
  });

  test("11 turn-user-sealed: a cron.allow that does not name the user is enough for cron", async () => {
    const w = passingWorld();
    w.sudoFiles["/etc/cron.allow"] = "root\n";
    delete w.sudoFiles["/etc/cron.deny"];
    expect(failing(await runChecks(fakeIo(w), CFG))).toEqual([]);
  });

  test("12 closed-home: an entry open to others, the home mode, an entry owned by someone else", async () => {
    await onlyFails((w) => {
      w.runs[key(["/usr/bin/find", H, "-maxdepth", "1", "-mindepth", "1", "!", "-type", "l", "-perm", "/o+rwx", "!", "-name", "claude-bot", "!", "-name", ".bun"])] = { code: 0, out: `${H}/backups\n` };
    }, "closed-home");
    await onlyFails((w) => { w.stats[H] = dir("claudebot", "claudebot", 0o755); }, "closed-home");
    await onlyFails((w) => { w.stats[`${H}/backups`] = dir("root", "root", 0o700); }, "closed-home");
  });

  test("12 closed-home: code writable by others or the data group, or by the turn user, is a finding", async () => {
    const f = await onlyFails((w) => { w.runs[key(CODE_WRITABLE_FIND_ARGS(R, `${H}/.bun`))] = { code: 0, out: `${R}/node_modules/x/index.js\n${H}/.bun/bin/bun\n` }; }, "closed-home");
    expect(f.detail).toContain("2 entries in the repo or ~/.bun writable");
    expect(f.detail).not.toContain("index.js");
    await onlyFails((w) => { w.runs[key(["/usr/bin/sudo", "-n", "-u", "agentturn", "/usr/bin/test", "-w", `${R}/guard.ts`])] = { code: 0, out: "" }; }, "closed-home");
    await onlyFails((w) => { w.runs[key(["/usr/bin/sudo", "-n", "-u", "agentturn", "/usr/bin/test", "-w", `${H}/.bun/bin/bun`])] = { code: 124, out: "" }; }, "closed-home");
    // the search skips links and asks for other-writable, or group agentdata and group-writable
    expect(CODE_WRITABLE_FIND_ARGS("/r", "/b").slice(2).join(" ")).toBe("/usr/bin/find /r /b ! -type l ( -perm /o+w -o ( -group agentdata -perm /g+w ) ) -print");
  });

  test("13 firewall-rule: present but not the first OUTPUT rule is a finding", async () => {
    const f = await onlyFails((w) => {
      w.runs[key(["/usr/bin/sudo", "-n", "/usr/sbin/iptables", "-S", "OUTPUT"])] = { code: 0, out: "-P OUTPUT ACCEPT\n-A OUTPUT -j ACCEPT\n-A OUTPUT -d 169.254.169.254/32 -m owner --uid-owner 998 -j REJECT --reject-with icmp-port-unreachable\n" };
    }, "firewall-rule");
    expect(f.detail).toBe("the metadata rule is not the first OUTPUT rule");
  });

  test("isEgressRuleLine: the rule in either option order, by name or uid; anything else is not it", () => {
    const ok = [
      "-A OUTPUT -d 169.254.169.254/32 -m owner --uid-owner 998 -j REJECT --reject-with icmp-port-unreachable",
      "-A OUTPUT -m owner --uid-owner agentturn -d 169.254.169.254 -j REJECT",
    ];
    for (const l of ok) expect(isEgressRuleLine(l, "agentturn", "998")).toBe(true);
    const bad = [
      "-A OUTPUT -d 169.254.169.254/32 -m owner --uid-owner 999 -j REJECT",
      "-A OUTPUT -d 169.254.169.254/32 -m owner --uid-owner 998 -j ACCEPT",
      "-A OUTPUT -d 192.0.2.1/32 -m owner --uid-owner 998 -j REJECT",
      "-A OUTPUT -o lo -d 169.254.169.254/32 -m owner --uid-owner 998 -j REJECT",
      "-A INPUT -d 169.254.169.254/32 -m owner --uid-owner 998 -j REJECT",
      "-A OUTPUT -d 169.254.169.254/32 -m owner ! --uid-owner 998 -j REJECT",
    ];
    for (const l of bad) expect([l, isEgressRuleLine(l, "agentturn", "998")]).toEqual([l, false]);
    expect(isEgressRuleLine(ok[0], "agentturn", null)).toBe(false); // a uid line needs the uid
  });

  test("13 firewall-rule: the rule is missing", async () => {
    await onlyFails((w) => { w.runs[key(["/usr/bin/sudo", "-n", "/usr/sbin/iptables", "-C", "OUTPUT", ...firewallRuleArgs("agentturn")])] = { code: 1, out: "" }; }, "firewall-rule");
  });

  test("14 service-switches: a gate off; values are compared, never printed", async () => {
    const f = await onlyFails((w) => { w.env.AUTO_APPROVAL = "0"; w.env.TURN_USER = "agentturn"; }, "service-switches");
    expect(f.detail).toContain("AUTO_APPROVAL");
    expect(f.detail).not.toContain("tok-test");
    await onlyFails((w) => { delete w.env.SKILL_APPROVAL; }, "service-switches");
    await onlyFails((w) => { w.env.STATE_DIR = "/srv/elsewhere"; }, "service-switches");
  });

  test("14 service-switches: the sweep off, the nightly run off, or a marker that names another folder", async () => {
    const sweep = await onlyFails((w) => { w.env.TURN_SWEEP = "0"; }, "service-switches");
    expect(sweep.detail).toContain("TURN_SWEEP");
    const nightly = await onlyFails((w) => { delete w.env.INTEGRITY_NIGHTLY; }, "service-switches");
    expect(nightly.detail).toContain("INTEGRITY_NIGHTLY");
    const marker = await onlyFails((w) => { w.files[`${R}/.state-dir`] = "/srv/other\n"; }, "service-switches");
    expect(marker.detail).toContain(".state-dir marker");
    expect(marker.detail).not.toContain("/srv/other");
    await onlyFails((w) => { delete w.files[`${R}/.state-dir`]; }, "service-switches");
    // a sweep that is on, or unset, is fine
    const w = passingWorld();
    w.env.TURN_SWEEP = "1";
    expect(failing(await runChecks(fakeIo(w), CFG))).toEqual([]);
  });

  test("15 guard-refusals-48h is always ok and counts the lines", async () => {
    const fs = await runChecks(fakeIo(passingWorld()), CFG);
    const f = fs.find((x) => x.name === "guard-refusals-48h")!;
    expect(f.ok).toBe(true);
    expect(f.detail).toContain("2");
    expect(f.detail).not.toContain("refused one");
  });

  test("15 guard-refusals-48h stays ok when the journal cannot be read", async () => {
    const w = passingWorld();
    delete w.runs[key(["/usr/bin/sudo", "-n", "/usr/bin/journalctl", "-t", "agent-guard", "--since", "-48h", "-o", "cat"])]; // the fake throws
    const f = (await runChecks(fakeIo(w), CFG)).find((x) => x.name === "guard-refusals-48h")!;
    expect(f.ok).toBe(true);
    expect(f.detail).toMatch(/^journal unreadable/);
  });

  test("16 db-schema: drift is a finding that counts the objects and never names them", async () => {
    const f = await onlyFails((w) => { w.drift[`${S}/shared/memory/bot.db`] = ['added trigger "click-here"', 'changed trigger "messages_ai"']; }, "db-schema");
    expect(f.detail).toBe("2 schema objects added, removed or changed");
    await onlyFails((w) => { delete w.drift[`${S}/shared/memory/bot.db`]; }, "db-schema");
  });

  test("16 db-schema: in the repo layout the database is the repo's memory/bot.db", async () => {
    const w = passingWorld();
    w.drift = { [`${R}/memory/bot.db`]: [] };
    const fs = await runChecks(fakeIo(w), { ...CFG, stateDir: R });
    expect(fs.find((f) => f.name === "db-schema")!.ok).toBe(true);
  });

  test("a check whose run never resolves becomes a finding within its budget", async () => {
    const w = passingWorld();
    w.runs[key(["/usr/bin/sudo", "-n", "/usr/sbin/iptables", "-C", "OUTPUT", ...firewallRuleArgs("agentturn")])] = "hang";
    const t = Date.now();
    const fs = await runChecks(fakeIo(w), CFG, 50);
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(failing(fs)).toEqual(["firewall-rule"]);
    expect(fs.find((f) => f.name === "firewall-rule")!.detail).toMatch(/^check failed to run: timed out/);
  });

  test("a check that throws is a finding whose detail never carries the error's text", async () => {
    const io = fakeIo(passingWorld());
    io.read = async (p) => { if (p.endsWith("settings.local.json")) throw new Error("PRIVATE FILE CONTENT"); return fakeIo(passingWorld()).read(p); };
    const fs = await runChecks(io, CFG);
    const f = fs.find((x) => x.name === "no-settings-overrides")!;
    expect(f.ok).toBe(false);
    expect(f.detail).toMatch(/^check failed to run: /);
    expect(f.detail).not.toContain("PRIVATE");
  });
});

describe("integrityMessage", () => {
  test("names each failing check and its detail under a Hebrew count line", () => {
    const msg = integrityMessage([
      { name: "a-check", ok: true, detail: "fine" },
      { name: "firewall-rule", ok: false, detail: "rule missing" },
      { name: "no-bunfig", ok: false, detail: "found: 1" },
    ])!;
    expect(msg.split("\n")).toEqual(["בדיקת השלמות של השרת מצאה 2 בעיות", "firewall-rule", "rule missing", "no-bunfig", "found: 1"]);
  });
});

describe("check 13 ties to the egress unit", () => {
  test("the firewall arguments are exactly the egress unit's rule", () => {
    const rule = "-m owner --uid-owner agentturn -d 169.254.169.254 -j REJECT";
    expect(firewallRuleArgs("agentturn").join(" ")).toBe(rule);
    const unit = join(import.meta.dir, "deploy", "agentturn-egress.service");
    expect(readFileSync(unit, "utf8")).toContain(firewallRuleArgs("agentturn").join(" "));
  });
});

describe("check 9's real find", () => {
  test.skipIf(process.platform === "win32")("prints a FIFO, a link and a hard link, and not a plain file or a folder", () => {
    const d = tmp("odd-");
    writeFileSync(join(d, "plain"), "x");
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "sub", "deep"), "y");
    symlinkSync(join(d, "plain"), join(d, "link"));
    writeFileSync(join(d, "orig"), "z");
    linkSync(join(d, "orig"), join(d, "sub", "hard"));
    expect(Bun.spawnSync(["mkfifo", join(d, "fifo")]).exitCode).toBe(0);
    const argv = STATE_ODD_FIND_ARGS(d);
    expect(argv.slice(0, 3)).toEqual(["/usr/bin/sudo", "-n", "/usr/bin/find"]);
    const r = Bun.spawnSync(argv.slice(2), { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    const out = r.stdout.toString().split("\n").filter(Boolean);
    for (const p of [join(d, "fifo"), join(d, "link"), join(d, "sub", "hard"), join(d, "orig")]) expect(out).toContain(p);
    for (const p of [join(d, "plain"), join(d, "sub"), join(d, "sub", "deep")]) expect(out).not.toContain(p);
  });
});

describe("integrityDue", () => {
  const at = (iso: string) => new Date(iso);
  test("before 04:15 local false, at or after true, an attempted date false, quiet false", () => {
    // 2026-10-13 is a Tuesday; Asia/Jerusalem is UTC+3 then.
    expect(integrityDue(at("2026-10-13T01:14:00Z"), null, false)).toBe(false);
    expect(integrityDue(at("2026-10-13T01:15:00Z"), null, false)).toBe(true);
    expect(integrityDue(at("2026-10-13T09:00:00Z"), "2026-10-12", false)).toBe(true);
    expect(integrityDue(at("2026-10-13T09:00:00Z"), "2026-10-13", false)).toBe(false);
    expect(integrityDue(at("2026-10-13T09:00:00Z"), null, true)).toBe(false);
  });

  test("an attempt date seeded from integrity-last.json holds it to once a day", () => {
    const d = tmp("ilast-");
    const p = join(d, "integrity-last.json");
    expect(readIntegrityLast(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ attempted: "2026-10-13" }));
    const seeded = readIntegrityLast(p)?.attempted ?? null; // the poller's startup seed
    expect(seeded).toBe("2026-10-13");
    expect(integrityDue(at("2026-10-13T09:00:00Z"), seeded, false)).toBe(false);
    expect(integrityDue(at("2026-10-14T09:00:00Z"), seeded, false)).toBe(true);
  });
});

describe("nightlyIntegrity", () => {
  const NOW = new Date("2026-10-13T02:00:00Z"); // 05:00 local
  /** A completed run's JSON: all 16 checks ok, with `bad` in place of its namesake. */
  const fullRun = (bad?: Finding, names: readonly string[] = CHECK_NAMES) =>
    JSON.stringify(names.map((n) => (bad && bad.name === n ? bad : { name: n, ok: true, detail: "ok" })));

  test("a run holding anything but exactly the 16 checks counts as not completed", async () => {
    for (const out of [
      fullRun(undefined, CHECK_NAMES.slice(0, CHECK_NAMES.length - 1)), // truncated
      fullRun(undefined, [...CHECK_NAMES.slice(0, CHECK_NAMES.length - 1), CHECK_NAMES[0]]), // a duplicate in place of the last
      fullRun(undefined, [...CHECK_NAMES, "extra-check"]),
    ]) {
      const x = deps({ runCheck: async () => ({ killed: false, out }) });
      await nightlyIntegrity(x.d);
      expect(x.sent).toEqual([INCOMPLETE_MESSAGE]);
      expect(readIntegrityLast(x.d.lastFile)!.at).toBeUndefined();
    }
  });

  function deps(over: Partial<Parameters<typeof nightlyIntegrity>[0]> = {}) {
    const d = tmp("night-");
    const sent: string[] = [];
    const logs: string[] = [];
    let runs = 0;
    const base: Parameters<typeof nightlyIntegrity>[0] = {
      now: () => NOW,
      quiet: () => false,
      lastFile: join(d, "integrity-last.json"),
      state: { attempted: null },
      runCheck: async () => { runs++; return { killed: false, out: fullRun({ name: "firewall-rule", ok: false, detail: "rule missing" }) }; },
      send: async (t) => { sent.push(t); },
      log: (l) => logs.push(l),
      ...over,
    };
    return { d: base, sent, logs, runs: () => runs };
  }

  test("records the attempt before running, then the completion, and sends the findings once", async () => {
    const x = deps();
    let seenBefore: unknown = null;
    x.d.runCheck = async () => {
      seenBefore = JSON.parse(readFileSync(x.d.lastFile, "utf8"));
      return { killed: false, out: fullRun({ name: "firewall-rule", ok: false, detail: "rule missing" }) };
    };
    await nightlyIntegrity(x.d);
    expect(seenBefore).toEqual({ attempted: "2026-10-13" });
    expect(x.d.state.attempted).toBe("2026-10-13");
    const last = JSON.parse(readFileSync(x.d.lastFile, "utf8"));
    expect(last.attempted).toBe("2026-10-13");
    expect(last.date).toBe("2026-10-13");
    expect(last.at).toBe(Math.floor(NOW.getTime() / 1000));
    expect(x.sent).toEqual(["בדיקת השלמות של השרת מצאה 1 בעיות\nfirewall-rule\nrule missing"]);
    await nightlyIntegrity(x.d);
    expect(x.sent.length).toBe(1);
  });

  test("a clean run records completion and sends nothing", async () => {
    const x = deps({ runCheck: async () => ({ killed: false, out: fullRun() }) });
    await nightlyIntegrity(x.d);
    expect(x.sent).toEqual([]);
    expect(readIntegrityLast(x.d.lastFile)!.at).toBe(Math.floor(NOW.getTime() / 1000));
  });

  test("a killed run or one without JSON sends the incomplete notice once, no retry that date", async () => {
    for (const r of [{ killed: true, out: "" }, { killed: false, out: "not json" }, { killed: false, out: '{"x":1}' }]) {
      const x = deps();
      let n = 0;
      x.d.runCheck = async () => { n++; return r; };
      await nightlyIntegrity(x.d);
      await nightlyIntegrity(x.d);
      expect(n).toBe(1);
      expect(x.sent).toEqual([INCOMPLETE_MESSAGE]);
      expect(INCOMPLETE_MESSAGE).toBe("בדיקת השלמות של השרת לא הסתיימה");
      expect(readIntegrityLast(x.d.lastFile)!.at).toBeUndefined();
    }
  });

  test("a restart the same day does not run again: the seed comes from the file", async () => {
    const x = deps();
    writeFileSync(x.d.lastFile, JSON.stringify({ attempted: "2026-10-13" }));
    x.d.state.attempted = readIntegrityLast(x.d.lastFile)?.attempted ?? null;
    await nightlyIntegrity(x.d);
    expect(x.runs()).toBe(0);
    expect(x.sent).toEqual([]);
  });

  test("not due while quiet or before 04:15", async () => {
    const q = deps({ quiet: () => true });
    await nightlyIntegrity(q.d);
    expect(q.runs()).toBe(0);
    const early = deps({ now: () => new Date("2026-10-13T00:30:00Z") });
    await nightlyIntegrity(early.d);
    expect(early.runs()).toBe(0);
  });

  test("an earlier completion is kept while a new attempt runs", async () => {
    const x = deps();
    writeFileSync(x.d.lastFile, JSON.stringify({ attempted: "2026-10-12", date: "2026-10-12", at: 1_790_000_000 }));
    x.d.state.attempted = "2026-10-12";
    let seen: any = null;
    x.d.runCheck = async () => { seen = JSON.parse(readFileSync(x.d.lastFile, "utf8")); return { killed: true, out: "" }; };
    await nightlyIntegrity(x.d);
    expect(seen).toEqual({ attempted: "2026-10-13", date: "2026-10-12", at: 1_790_000_000 });
  });
});

describe("the real io's pure parts and run", () => {
  test("parseServiceShow reads Environment values and EnvironmentFiles paths", () => {
    const out = 'Environment=TURN_USER=agentturn "TUNE=a b" AUTO_APPROVAL=1\nEnvironmentFiles=/home/someone/.env (ignore_errors=no)\n';
    const r = parseServiceShow(out);
    expect(r.env).toEqual({ TURN_USER: "agentturn", TUNE: "a b", AUTO_APPROVAL: "1" });
    expect(r.files).toEqual(["/home/someone/.env"]);
  });

  test("parseEnvFile takes KEY=value lines, skips comments, strips quotes", () => {
    expect(parseEnvFile('# c\nSTATE_DIR=/srv/agent-state\n\nSKILL_APPROVAL="1"\nTELEGRAM_BOT_TOKEN=tok-test\nnot a line\n')).toEqual({
      STATE_DIR: "/srv/agent-state", SKILL_APPROVAL: "1", TELEGRAM_BOT_TOKEN: "tok-test",
    });
  });

  test("run returns stdout and the exit code, and kills on its timeout", async () => {
    const io = realIo(CFG);
    const ok = await io.run([process.execPath, "-e", "console.log('hi'); process.exit(3)"]);
    expect(ok).toEqual({ code: 3, out: "hi\n" });
    const t = Date.now();
    const slow = await io.run([process.execPath, "-e", "setTimeout(() => {}, 60000)"], 300);
    expect(slow.code).toBe(124);
    expect(Date.now() - t).toBeLessThan(5_000);
  });

  test("read returns null for a missing file and the text of a present one; list likewise", async () => {
    const d = tmp("rio-");
    writeFileSync(join(d, "a"), "hello");
    const io = realIo(CFG);
    expect(await io.read(join(d, "a"))).toBe("hello");
    expect(await io.read(join(d, "missing"))).toBeNull();
    expect(await io.list(d)).toEqual(["a"]);
    expect(await io.list(join(d, "missing"))).toBeNull();
    expect(await io.stat(join(d, "missing"))).toBeNull();
  });

  test.skipIf(process.platform === "win32")("stat gives the mode, owner and group names, and sees a link as a link", async () => {
    const d = tmp("rst-");
    writeFileSync(join(d, "f"), "x", { mode: 0o640 });
    Bun.spawnSync(["chmod", "0640", join(d, "f")]);
    symlinkSync(join(d, "f"), join(d, "l"));
    const me = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();
    const io = realIo(CFG);
    const s = (await io.stat(join(d, "f")))!;
    expect(s.mode).toBe(0o640);
    expect(s.owner).toBe(me);
    expect(s.isFile).toBe(true);
    expect((await io.stat(join(d, "l")))!.isLink).toBe(true);
  });

  test("dbDrift opens a real database read-only: [] when clean, the planted trigger when not, null when missing", async () => {
    const d = tmp("rdb-");
    const p = join(d, "bot.db");
    const db = openDb(p);
    db.close();
    const io = realIo(CFG);
    expect(await io.dbDrift(p)).toEqual([]);
    const w = openDb(p);
    w.exec("CREATE TRIGGER evil AFTER INSERT ON meta BEGIN DELETE FROM messages; END;");
    w.close();
    expect(await io.dbDrift(p)).toEqual(['added trigger "evil"']);
    expect(await io.dbDrift(join(d, "missing.db"))).toBeNull();
  });

  test.skipIf(process.platform === "win32")("dbDrift refuses a link and a FIFO in place of the database", async () => {
    const d = tmp("rdbl-");
    const real = join(d, "real.db");
    openDb(real).close();
    symlinkSync(real, join(d, "link.db"));
    expect(Bun.spawnSync(["mkfifo", join(d, "fifo.db")]).exitCode).toBe(0);
    const io = realIo(CFG);
    await expect(io.dbDrift(join(d, "link.db"))).rejects.toThrow("bot.db is not a regular file");
    await expect(io.dbDrift(join(d, "fifo.db"))).rejects.toThrow("bot.db is not a regular file");
  });

  test("sudoRead reads only under /etc/, turnRead only under the turn user's home; both refuse before running anything", async () => {
    const io = realIo(CFG);
    for (const p of ["/home/someone/.ssh/id_ed25519", "/etc/../home/someone/x", "etc/passwd", "/etcetera/x"]) {
      await expect(io.sudoRead(p)).rejects.toThrow("sudoRead outside /etc/");
    }
    for (const p of ["/etc/shadow", "/home/agentturn", "/home/agentturn/../someone/x", "/home/agentturnx/y"]) {
      await expect(io.turnRead(p)).rejects.toThrow("turnRead outside the turn user's home");
    }
  });
});

describe("root commands time out as root", () => {
  test("a sudo argv gets timeout -s KILL after sudo's own options and --", () => {
    expect(rootTimeoutArgv(["/usr/bin/sudo", "-n", "/usr/bin/find", "/srv/x", "-print"], 10_000)).toEqual(
      ["/usr/bin/sudo", "-n", "--", "/usr/bin/timeout", "-s", "KILL", "10", "/usr/bin/find", "/srv/x", "-print"],
    );
  });

  test("-u <user> stays before the timeout, and the seconds round up", () => {
    expect(rootTimeoutArgv(["/usr/bin/sudo", "-n", "-u", "agentturn", "/usr/bin/timeout", "5", "/usr/bin/cat", "--", "/home/agentturn/x"], 2_500)).toEqual(
      ["/usr/bin/sudo", "-n", "-u", "agentturn", "--", "/usr/bin/timeout", "-s", "KILL", "3", "/usr/bin/timeout", "5", "/usr/bin/cat", "--", "/home/agentturn/x"],
    );
  });

  test("an existing -- is kept once", () => {
    expect(rootTimeoutArgv(["/usr/bin/sudo", "-n", "--", "/usr/bin/cat", "/etc/x"], 10_000)).toEqual(
      ["/usr/bin/sudo", "-n", "--", "/usr/bin/timeout", "-s", "KILL", "10", "/usr/bin/cat", "/etc/x"],
    );
  });

  test("a non-sudo argv and a sudo argv with no command (sudo -l -U) are untouched", () => {
    const plain = ["/usr/bin/find", "/home/someone", "-maxdepth", "1"];
    expect(rootTimeoutArgv(plain, 10_000)).toEqual(plain);
    const list = ["/usr/bin/sudo", "-n", "-l", "-U", "agentturn"];
    expect(rootTimeoutArgv(list, 10_000)).toEqual(list);
  });

  test("every sudo argv the checks run with a command gets the timeout", () => {
    // The passing world's argvs are the checks' real ones; the wrapping happens inside realIo only.
    const sudoArgvs = Object.keys(passingWorld().runs).map((k) => k.split(" | ")).filter((a) => a[0] === "/usr/bin/sudo");
    expect(sudoArgvs.length).toBeGreaterThan(5);
    for (const a of sudoArgvs) {
      const w = rootTimeoutArgv(a, 10_000);
      if (a.includes("-l")) expect(w).toEqual(a);
      else expect(w.slice(w.indexOf("--") + 1, w.indexOf("--") + 5)).toEqual(["/usr/bin/timeout", "-s", "KILL", "10"]);
    }
  });
});

describe("integrity-last.json at poller startup", () => {
  test("missing: writes { since } and seeds no attempt; present: seeds its attempt and leaves it alone", () => {
    const d = tmp("seed-");
    const p = join(d, "integrity-last.json");
    expect(seedIntegrityLast(p, 1_790_000_000)).toBeNull();
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ since: 1_790_000_000 });
    expect(readIntegrityLast(p)!.since).toBe(1_790_000_000);
    writeFileSync(p, JSON.stringify({ attempted: "2026-10-13", date: "2026-10-13", at: 5 }));
    expect(seedIntegrityLast(p, 1_790_000_999)).toBe("2026-10-13");
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ attempted: "2026-10-13", date: "2026-10-13", at: 5 });
  });

  test("an unreadable file is left in place (health sees it and alerts), not overwritten", () => {
    const d = tmp("seed-");
    const p = join(d, "integrity-last.json");
    writeFileSync(p, "not json");
    expect(seedIntegrityLast(p, 1_790_000_000)).toBeNull();
    expect(readFileSync(p, "utf8")).toBe("not json");
  });
});
