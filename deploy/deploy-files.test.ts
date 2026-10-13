import { test, expect, afterAll } from "bun:test";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync, cpSync, appendFileSync, accessSync, constants, statSync, readdirSync } from "node:fs";
import { join, resolve, posix } from "node:path";
import { tmpdir } from "node:os";
import { TURN_SECRETS } from "../turnuser";

const d = import.meta.dir;
const made: string[] = [];
afterAll(() => { for (const x of made) rmSync(x, { recursive: true, force: true }); });
const SCRIPTS = ["rollout-r3.sh", "rollback-r3.sh", "rollout-r4.sh", "rollback-r4.sh"];
const PROOFS = ["proofs-r4.sh", "proofs-r5.sh"];

test("managed settings: sealed, fail-closed hook on the full matcher, managed hooks only", () => {
  const m = JSON.parse(readFileSync(join(d, "managed-settings.json"), "utf8"));
  expect(m.allowManagedHooksOnly).toBe(true);
  const h = m.hooks.PreToolUse[0];
  expect(h.matcher).toBe("Bash|Monitor|Edit|Write|MultiEdit|NotebookEdit|Read|Grep|Glob|LS|create_draft");
  const cmd: string = h.hooks[0].command;
  for (const s of ["cd /home/claudebot/claude-bot", "/usr/bin/env -i", "/usr/bin/timeout -k 5 30 /home/claudebot/.bun/bin/bun", "--no-env-file", "--config=/home/claudebot/claude-bot/deploy/empty-bunfig.toml", "hooks/pretooluse-guard.ts", "exit 2"]) expect(cmd).toContain(s);
});

test.skipIf(process.platform === "win32")("the hook command fails closed when its pieces are missing", () => {
  const m = JSON.parse(readFileSync(join(d, "managed-settings.json"), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "hookcmd-")); made.push(root);
  const cmd = (m.hooks.PreToolUse[0].hooks[0].command as string).replaceAll("/home/claudebot/claude-bot", root);
  const r = Bun.spawnSync(["/bin/sh", "-c", cmd], { stdin: Buffer.from('{"tool_name":"Bash","tool_input":{"command":"ls"}}') });
  expect(r.exitCode).toBe(2);
});

test("sudoers keeps exactly the three secrets and grants nothing as root", () => {
  const s = readFileSync(join(d, "sudoers-agentturn"), "utf8");
  expect(s.match(/env_keep \+= "([^"]+)"/)![1].split(/\s+/).sort()).toEqual([...TURN_SECRETS].sort());
  expect(s).toContain("claudebot ALL=(agentturn) NOPASSWD: ALL");
  expect(s).not.toMatch(/\(ALL\)|\(root\)/);
  for (const x of ["umask=0007", "umask_override", "!use_pty"]) expect(s).toContain(x);
});

test("the egress unit stays up after start and uses the integrity check's exact rule", () => {
  const u = readFileSync(join(d, "agentturn-egress.service"), "utf8");
  expect(u).toContain("RemainAfterExit=yes");
  expect(u).toContain("-m owner --uid-owner agentturn -d 169.254.169.254 -j REJECT");
});

test("the egress unit inserts the rule first in OUTPUT, after removing any copy, and never appends it", () => {
  const start = readFileSync(join(d, "agentturn-egress.service"), "utf8").split("\n").find((l) => l.startsWith("ExecStart="))!;
  const rule = "-m owner --uid-owner agentturn -d 169.254.169.254 -j REJECT";
  expect(start).toContain(`while /usr/sbin/iptables -D OUTPUT ${rule} 2>/dev/null; do :; done;`);
  expect(start).toContain(`/usr/sbin/iptables -I OUTPUT 1 ${rule}`);
  expect(start.indexOf("-D OUTPUT")).toBeLessThan(start.indexOf("-I OUTPUT 1"));
  expect(start).not.toContain("-A OUTPUT");
});

test("DEPLOY.md runs proofs-r5.sh only by its full path, and R2's Linux list holds every file with Linux-only tests", () => {
  const md = readFileSync(join(d, "..", "DEPLOY.md"), "utf8");
  const calls = md.match(/[^\s`(]*proofs-r5\.sh \d/g) ?? [];
  expect(calls.length).toBeGreaterThanOrEqual(5);
  for (const c of calls) expect(c).toBe(`/home/claudebot/claude-bot/deploy/proofs-r5.sh ${c.slice(-1)}`);
  const r2 = md.split("\n").find((l) => l.includes("env -u STATE_DIR ~/.bun/bin/bun test paths.test.ts"))!;
  const root = join(d, "..");
  const tests = [...readdirSync(root).filter((f) => f.endsWith(".test.ts")), ...readdirSync(d).filter((f) => f.endsWith(".test.ts")).map((f) => `deploy/${f}`)];
  const linuxOnly = tests.filter((f) => readFileSync(join(root, f), "utf8").includes('skipIf(process.platform === "win32")'));
  expect(linuxOnly.length).toBeGreaterThan(5);
  for (const f of linuxOnly) expect([f, r2.includes(f)]).toEqual([f, true]);
});

test("rollout-r3 gives the .state-dir marker mode 0644 right after writing it", () => {
  const t = text("rollout-r3.sh");
  const w = lineOf(t, 'echo "$S" > "$REPO/.state-dir"');
  expect(w).toBeGreaterThanOrEqual(0);
  expect(t.split("\n")[w + 1]).toBe('chmod 0644 "$REPO/.state-dir"');
});

test("the service drop-in uses UMask 0027", () => {
  expect(readFileSync(join(d, "telegram-agent-hardening.conf"), "utf8")).toContain("UMask=0027");
});

test("rollout and rollback scripts: strict mode, no && lists", () => {
  for (const f of SCRIPTS) {
    const t = readFileSync(join(d, f), "utf8");
    expect([f, t.includes("set -euo pipefail")]).toEqual([f, true]);
    const bad = t.split("\n").filter((l) => !l.trim().startsWith("#") && /\S\s*&&\s*\S/.test(l));
    expect([f, bad]).toEqual([f, []]);
  }
});

test.skipIf(process.platform === "win32")("every script parses", () => {
  for (const f of [...SCRIPTS, ...PROOFS]) expect([f, Bun.spawnSync(["bash", "-n", join(d, f)]).exitCode]).toEqual([f, 0]);
});

const text = (f: string) => readFileSync(join(d, f), "utf8");
const lineOf = (t: string, s: string) => t.split("\n").findIndex((l) => l.includes(s));

test("no script reads a listing through process substitution (a failed listing must stop it)", () => {
  for (const f of SCRIPTS) expect([f, text(f).includes("< <(")]).toEqual([f, false]);
});

test("rollout-r3 compares history and uploads counts before it removes the repo folders", () => {
  const t = text("rollout-r3.sh");
  const rm = lineOf(t, 'rm -rf "$REPO/history"');
  for (const s of ["FAILED: history count", "FAILED: uploads count"]) {
    expect([s, lineOf(t, s) >= 0 && lineOf(t, s) < rm]).toEqual([s, true]);
  }
});

test("rollout-r4 checks the phone-inbox key line before it changes anything", () => {
  const t = text("rollout-r4.sh");
  const check = lineOf(t, "FAILED: expected exactly one phone-inbox key line");
  expect(check).toBeGreaterThanOrEqual(0);
  expect(check).toBeLessThan(lineOf(t, "sudo install -d -m 0755"));
  expect(check).toBeLessThan(lineOf(t, "sudo useradd"));
});

test("rollback-r3 backs the env file up before it edits it", () => {
  const t = text("rollback-r3.sh");
  const bak = lineOf(t, ".env.bak-rollback-r3") >= 0 ? lineOf(t, 'cp -p "$ENVF"') : -1;
  expect(bak).toBeGreaterThanOrEqual(0);
  expect(bak).toBeLessThan(lineOf(t, "sed -i '/^STATE_DIR=/d'"));
});

test("integrity-last.json, which the R3 way back copies to the repo root, is ignored", () => {
  expect(readFileSync(join(d, "..", ".gitignore"), "utf8").split(/\r?\n/)).toContain("integrity-last.json");
});

test("proofs-r4's append proofs write nothing even when the append is allowed", () => {
  const t = text("proofs-r4.sh");
  expect(t).not.toContain("echo x >>");
  expect(t).toContain(': >> $S/$f');
});

test("proofs-r5: no probe's expected text appears in its own prompt", () => {
  const lines = text("proofs-r5.sh").split("\n");
  const checked: string[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/--expect(?:-output)? (?:'([^']+)'|([^\s"$'][^\s]*))/);
    if (!m || !l.includes("<<'EOF'")) return;
    const want = m[1] ?? m[2];
    const body: string[] = [];
    for (let k = i + 1; k < lines.length && lines[k] !== "EOF"; k++) body.push(lines[k]);
    expect([want, body.join("\n").includes(want)]).toEqual([want, false]);
    checked.push(want);
  });
  expect(checked).toContain("PLANT42ED");
});

test("proofs-r5: every expected text must come from tool output, never the model's own words", () => {
  const t = text("proofs-r5.sh");
  const probes = t.split("\n").filter((l) => /^\s*probe /.test(l));
  expect(probes.length).toBe(5);
  // Proofs 0, 1, 2 and 4-plant: the command's output or the guard's refusal, which only a tool result holds.
  expect(probes.filter((l) => l.includes("--expect-output ")).length).toBe(4);
  expect(probes.some((l) => /--expect /.test(l))).toBe(false);
  for (const s of ['--expect-output "$first"', "--expect-output 'refused: editing guard.ts'", "--expect-output 'refused: [AUTO] sessions may not approve pending actions'", "--expect-output PLANT42ED"]) expect(t).toContain(s);
  expect(t).toContain("--reject ZEBRA");
});

// The R3 scripts on a fake tree: every server path is rewritten into a temp folder, and the root
// tools (sudo, systemctl, chown, the group tools) and Bun are stubbed. These tests run on the live
// server as a user with passwordless sudo, so nothing may ever reach a real system tool:
// - the sandbox never lies under /home/claudebot (the rewrite would collide with it);
// - a rewrite that leaves any server path or a bare `sudo ` behind throws (every sudo call names
//   the stub by its absolute path);
// - before every script run, a preflight under the exact environment the script gets proves that
//   each external that could touch the system resolves inside the stub folder, and that a stub
//   actually executes (a noexec temp folder would make bash fall through to the real tools).
const SYSTEM_TOOLS = ["sudo", "systemctl", "getent", "id", "install", "chown", "chgrp", "groupadd", "usermod", "gpasswd", "groupdel"];
const STUB_MARK = "STUB-SUDO-RUNS";

// Rewrites a script's server paths into the sandbox and every `sudo ` into the stub's absolute
// path, then throws when any server path or bare `sudo ` is left. The stub's own path is removed
// before T, since "<T>/stub/sudo " minus T would still read as a bare `sudo `.
function rewriteForSandbox(name: string, script: string, map: [string, string][], T: string): string {
  const stubSudo = posix.join(T, "stub", "sudo");
  let t = script;
  for (const [a, b] of map) t = t.replaceAll(a, b);
  t = t.replace(/\bsudo /g, `${stubSudo} `);
  const rest = t.replaceAll(stubSudo, "").replaceAll(T, "");
  for (const bad of ["/home/claudebot", "/var/lib/", "/etc/", "sudo "]) if (rest.includes(bad)) throw new Error(`${name}: ${bad} left after the rewrite`);
  return t;
}

test("the sandbox rewrite passes a script whose every sudo it rewrote, and throws on a sudo it could not reach", () => {
  const T = "/tmp/r3-made-up";
  const map: [string, string][] = [["/home/someone/repo", `${T}/repo`], ["/var/lib/telegram-agent", `${T}/state`], ["/etc/systemd/system", `${T}/sysd`]];
  const ok = 'sudo install -d "/var/lib/telegram-agent"\ncp a /home/someone/repo/b\n[ -x x ] || sudo systemctl daemon-reload # /etc/systemd/system\n';
  const t = rewriteForSandbox("ok.sh", ok, map, T);
  expect(t.split(`${T}/stub/sudo `).length - 1).toBe(2);
  expect(t.replaceAll(`${T}/stub/sudo`, "").match(/\bsudo /)).toBeNull();
  // `\bsudo ` cannot match inside a longer word, so this call keeps a bare "sudo " the check must catch.
  expect(() => rewriteForSandbox("hidden.sh", "my_sudo rm -rf x\n", map, T)).toThrow("hidden.sh: sudo  left after the rewrite");
  expect(() => rewriteForSandbox("unmapped.sh", "cat /etc/passwd\n", map, T)).toThrow("unmapped.sh: /etc/ left after the rewrite");
});

function sandboxRoot(): string {
  for (const base of [tmpdir(), "/tmp"]) {
    const r = resolve(base);
    if (r === "/home/claudebot" || r.startsWith("/home/claudebot/")) continue;
    if (!/^[A-Za-z0-9_./-]+$/.test(r)) continue;
    return r;
  }
  throw new Error("no temp folder outside /home/claudebot with a plain path: refusing to build the R3 sandbox");
}

function r3Sandbox() {
  const T = mkdtempSync(join(sandboxRoot(), "r3-")); made.push(T);
  if (!/^[A-Za-z0-9_./-]+$/.test(T) || T.startsWith("/home/claudebot")) throw new Error(`unsafe sandbox path ${T}`);
  const p = (...x: string[]) => join(T, ...x);
  const put = (rel: string, body: string) => { mkdirSync(join(p(rel), ".."), { recursive: true }); writeFileSync(p(rel), body); };
  for (const x of ["memory/mirror", "skills/.archive", "history/sub", "uploads", "data", "deploy"]) mkdirSync(p("repo", x), { recursive: true });
  for (const x of ["env", "ccj", "sysd/telegram-agent.service.d", "stub"]) mkdirSync(p(x), { recursive: true });
  writeFileSync(p("repo/deploy/telegram-agent-hardening.conf"), text("telegram-agent-hardening.conf"));
  const files: Record<string, string> = {
    "memory/bot.db": "DB", "memory/mirror/a.md": "m", "skills/x.md": "s", "history/sub/1.json": "h", "history/.offset": "o",
    "uploads/f.jpg": "u", "data/quiz-state.json": "q", "data/avot-state.json": "a", "data/questions.json": "Q",
    "heartbeat": "hb", "health-state.json": "hs", "reminders.json": "r", "followups.json": "f", "choices.json": "c",
  };
  for (const [k, v] of Object.entries(files)) put(`repo/${k}`, v);
  writeFileSync(p("env/.env"), "A=1\nTOKEN=tok-test\n");
  writeFileSync(p("ccj/paused"), "P");
  writeFileSync(p("ccj/last-digest.txt"), "L");
  const stubs: Record<string, string> = {
    sudo: `if [ "$1" = --stub-check ]; then echo ${STUB_MARK}; exit 0; fi; exec "$@"`,
    systemctl: 'if [ "$1" = is-active ]; then echo inactive; exit 3; fi; exit 0',
    getent: 'echo "agentdata:x:999:claudebot"',
    id: 'if [ "$1" = agentturn ]; then exit 1; fi; if [ "$1" = -nG ]; then echo "claudebot agentdata"; exit 0; fi; exec /usr/bin/id "$@"',
    install: 'a=(); while [ $# -gt 0 ]; do case "$1" in -o|-g) shift 2 ;; *) a+=("$1"); shift ;; esac; done; exec /usr/bin/install "${a[@]}"',
    bun: "echo ok",
  };
  stubs.chgrp = 'exec /usr/bin/chgrp "$@"'; // the scripts only chgrp their own files to the user's own group
  for (const s of ["chown", "groupadd", "usermod", "gpasswd", "groupdel"]) stubs[s] = "exit 0";
  for (const [k, v] of Object.entries(stubs)) { writeFileSync(p("stub", k), `#!/bin/bash\n${v}\n`); chmodSync(p("stub", k), 0o755); }
  const map: [string, string][] = [
    ["/home/claudebot/.claude/channels/telegram/.env", p("env/.env")], ["/home/claudebot/claude-bot", p("repo")],
    ["/var/lib/telegram-agent", p("state")], ["/home/claudebot/cc-journal", p("ccj")], ["/home/claudebot/tmp", p("tmp")],
    ["/home/claudebot/.bun/bin/bun", p("stub/bun")], ["/etc/systemd/system", p("sysd")],
  ];
  for (const f of ["rollout-r3.sh", "rollback-r3.sh"]) writeFileSync(p(f), rewriteForSandbox(f, text(f), map, T));
  const env = { ...process.env, PATH: `${p("stub")}:${process.env.PATH}` };
  const preflight = () => {
    const where = Bun.spawnSync(["bash", "-c", 'command -v "$@"', "preflight", ...SYSTEM_TOOLS], { env });
    const found = where.stdout.toString().split("\n").filter(Boolean);
    // bash's command -v can name a non-executable file when nothing executable follows in PATH,
    // so each hit must also pass an execute check (which a noexec mount fails too).
    const executable = (x: string) => { try { accessSync(x, constants.X_OK); return true; } catch { return false; } };
    const outside = found.filter((x) => !x.startsWith(`${p("stub")}/`) || !executable(x));
    if (found.length !== SYSTEM_TOOLS.length || outside.length) {
      throw new Error(`preflight: system tools do not all resolve to the stubs (found ${found.length} of ${SYSTEM_TOOLS.length}; outside: ${outside.join(", ") || "none"})`);
    }
    const mark = Bun.spawnSync(["bash", "-c", `"${p("stub/sudo")}" --stub-check; sudo --stub-check`], { env }).stdout.toString();
    if (mark !== `${STUB_MARK}\n${STUB_MARK}\n`) throw new Error("preflight: the sudo stub does not execute");
  };
  preflight();
  const run = (f: string) => {
    preflight();
    const r = Bun.spawnSync(["bash", p(f)], { env });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  return { p, run, files, preflight };
}

test.skipIf(process.platform === "win32")("R3 and its way back: a full round trip brings every entry home", () => {
  const { p, run, files } = r3Sandbox();
  const out = run("rollout-r3.sh");
  expect([out.code, out.out.includes("R3 MOVE DONE")]).toEqual([0, true]);
  expect(statSync(p("repo/.state-dir")).mode & 0o777).toBe(0o644); // whatever the shell's umask
  writeFileSync(p("state/shared/stores/reminders.json"), "changed");
  writeFileSync(p("state/integrity-last.json"), "I");
  writeFileSync(p("state/inbox-status.json"), "{}");
  rmSync(p("state/shared/cc-digest/paused"));
  writeFileSync(p("state/shared/stores/approvals.json"), "junk");
  const back = run("rollback-r3.sh");
  expect([back.code, back.out.includes("R3 ROLLBACK DONE")]).toEqual([0, true]);
  for (const [k, v] of Object.entries(files)) expect([k, readFileSync(p("repo", k), "utf8")]).toEqual([k, k === "reminders.json" ? "changed" : v]);
  expect(readFileSync(p("repo/integrity-last.json"), "utf8")).toBe("I");
  expect(existsSync(p("repo/approvals.json"))).toBe(false);
  expect(existsSync(p("repo/inbox-status.json"))).toBe(false);
  expect(back.out).toContain("skipped inbox-status.json (regenerated)");
  expect(existsSync(p("ccj/paused"))).toBe(false);
  expect(existsSync(p("state"))).toBe(false);
  expect(existsSync(p("repo/.state-dir"))).toBe(false);
  expect(readFileSync(p("env/.env"), "utf8")).toBe("A=1\nTOKEN=tok-test\n");
});

test.skipIf(process.platform === "win32")("R3's way back after a partial removal: folders left only in the state folder come home", () => {
  const { p, run, files } = r3Sandbox();
  expect(run("rollout-r3.sh").code).toBe(0);
  // The removal stopped partway: memory (with bot.db) survived in the repo, the other three did not.
  cpSync(p("state/shared/memory"), p("repo/memory"), { recursive: true });
  const back = run("rollback-r3.sh");
  expect([back.code, back.out]).toEqual([0, expect.stringContaining("R3 ROLLBACK DONE")]);
  for (const [k, v] of Object.entries(files)) expect([k, readFileSync(p("repo", k), "utf8")]).toEqual([k, v]);
  expect(existsSync(p("state"))).toBe(false);
});

test.skipIf(process.platform === "win32")("R3's way back refuses, changing nothing, when a repo folder differs from its state copy", () => {
  const { p, run } = r3Sandbox();
  expect(run("rollout-r3.sh").code).toBe(0);
  cpSync(p("state/shared/memory"), p("repo/memory"), { recursive: true });
  appendFileSync(p("repo/memory/mirror/a.md"), "different");
  const back = run("rollback-r3.sh");
  expect([back.code, back.out]).toEqual([1, expect.stringContaining("REFUSED")]);
  expect(existsSync(p("state/history/sub/1.json"))).toBe(true);
  expect(existsSync(p("repo/history"))).toBe(false);
});

test.skipIf(process.platform === "win32")("the sandbox preflight refuses a stub that is not executable or missing", () => {
  const a = r3Sandbox();
  expect(() => a.preflight()).not.toThrow();
  chmodSync(a.p("stub/groupdel"), 0o644);
  expect(() => a.preflight()).toThrow(/do not all resolve to the stubs/);
  expect(() => a.run("rollback-r3.sh")).toThrow();
  const b = r3Sandbox();
  rmSync(b.p("stub/systemctl"));
  expect(() => b.preflight()).toThrow(/do not all resolve to the stubs/);
  const c = r3Sandbox();
  writeFileSync(c.p("stub/sudo"), "#!/bin/bash\nexec \"$@\"\n");
  expect(() => c.preflight()).toThrow(/does not execute/);
});

test.skipIf(process.platform === "win32")("the rewritten scripts call sudo only by the stub's absolute path", () => {
  const { p } = r3Sandbox();
  for (const f of ["rollout-r3.sh", "rollback-r3.sh"]) {
    const t = readFileSync(p(f), "utf8");
    expect([f, t.includes(`${p("stub/sudo")} `)]).toEqual([f, true]);
    expect([f, t.replaceAll(p("stub/sudo"), "").match(/\bsudo /)]).toEqual([f, null]);
  }
});

test("rollback-r3 skips the poller's regenerated inbox status and fails loudly when the env backup fails", () => {
  const t = text("rollback-r3.sh");
  expect(t).toContain('echo "skipped inbox-status.json (regenerated)"');
  expect(t).toContain('cp -p "$ENVF" "$ENVF.bak-rollback-r3" || { echo "FAILED: env backup"; exit 1; }');
  expect(readFileSync(join(d, "..", ".gitignore"), "utf8").split(/\r?\n/)).toContain("inbox-status.json");
});
