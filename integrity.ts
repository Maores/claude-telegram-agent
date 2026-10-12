/**
 * integrity.ts: wall 3 of the server hardening, a read-only check of the hardened droplet.
 *
 *   bun run integrity.ts [--json]      exit 0 when every check is ok, 1 otherwise
 *
 * Run as the poller's user. Sixteen checks (guard files equal git, the installed managed settings
 * and sudoers equal the tracked copies, no settings overrides, the turn user's home sealed, no
 * bunfig, no .env files, no stray state in the repo, the state folder's layout with no links,
 * FIFOs or hard links, the phone inbox key unchanged, the turn user sealed, the main home closed,
 * the firewall rule present, the service switches set, the guard's refusals counted, the
 * database's schema exactly db.ts's).
 *
 * Every filesystem and command access goes through IntegrityIo, which is async so that a per-check
 * budget can pre-empt a stuck call; the real one never uses a blocking spawn. Every command has a
 * deadline after which its promise resolves as a timeout; the poller's user can kill only its own
 * children, so a command run through sudo (as root, or as the turn user) carries its own
 * `/usr/bin/timeout -s KILL <s>` inside the sudo, and that user kills it on time. Reads under the
 * turn user's home run as that user with a timeout; sudo reads only fixed files under /etc/; no
 * read follows a link. A finding never quotes file content or a name a turn could have chosen: details
 * are counts, fixed names and exit codes.
 *
 * The poller runs it nightly at 04:15 (INTEGRITY_NIGHTLY=1, held over Shabbat and holidays) through
 * nightlyIntegrity(), which records the attempt first so a restart cannot run or message twice the
 * same day; health.ts alerts when no run has completed for 96 hours.
 */
import { Database, constants as sqliteConstants } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix } from "node:path";
import { REPO_DIR, stateDir as resolveStateDir, statePath, readNoFollow, writeAtomic } from "./paths.ts";
import { localParts } from "./ccjournal.ts";
import { hardenDb, schemaDrift } from "./db.ts";

export interface StatInfo { mode: number; owner: string; group: string; isLink: boolean; isDir: boolean; isFile: boolean; nlink: number }
export interface IntegrityIo {
  /** A file as the poller's user, never through a link; null when it does not exist. */
  read(p: string): Promise<string | null>;
  /** A fixed system file (/etc/...) read as root; null when it cannot be read. */
  sudoRead(p: string): Promise<string | null>;
  /** A file under the turn user's home, read as that user with a timeout, regular files only. */
  turnRead(p: string): Promise<string | null>;
  list(dir: string): Promise<string[] | null>;
  /** lstat (a link is reported as a link) with owner and group names; null when missing. */
  stat(p: string): Promise<StatInfo | null>;
  run(argv: string[], timeoutMs?: number): Promise<{ code: number; out: string }>;
  /** The service's Environment values plus its environment files' KEY=value lines. */
  serviceEnv(): Promise<Record<string, string>>;
  /** db.ts's schemaDrift() of a database opened read-only and hardened, never through a link;
   *  null when the file does not exist. */
  dbDrift(p: string): Promise<string[] | null>;
}
export interface Finding { name: string; ok: boolean; detail: string }
export interface IntegrityConfig { repo: string; stateDir: string; turnUser: string; mainHome: string; turnHome: string }

const SUDO = "/usr/bin/sudo";
const MAIN_USER = "claudebot";
const DATA_GROUP = "agentdata";
const SERVICE = "telegram-agent";
export const INCOMPLETE_MESSAGE = "בדיקת השלמות של השרת לא הסתיימה";
export const INTEGRITY_LAST_FILE = statePath("integrity-last.json");

/** An error whose message is ours (never file content), so it may be shown in a finding. */
class CheckFail extends Error {}
class CheckTimeout extends Error {}

/** Links, FIFOs, sockets, devices, and regular files with more than one name, anywhere under the
 *  state folder, searched as root so a folder a turn closes cannot hide one. The outer parentheses
 *  make -print apply to both branches. */
export function STATE_ODD_FIND_ARGS(stateDir: string): string[] {
  return [SUDO, "-n", "/usr/bin/find", stateDir, "-mindepth", "1", "(", "(", "!", "-type", "f", "!", "-type", "d", ")", "-o", "(", "-type", "f", "-links", "+1", ")", ")", "-print"];
}

/** Anything in the repo or Bun's folder writable by others or by the data group, searched as root;
 *  links are skipped (a link's own mode is always 0777 and grants nothing). */
export function CODE_WRITABLE_FIND_ARGS(repo: string, bunDir: string): string[] {
  return [SUDO, "-n", "/usr/bin/find", repo, bunDir, "!", "-type", "l", "(", "-perm", "/o+w", "-o", "(", "-group", DATA_GROUP, "-perm", "/g+w", ")", ")", "-print"];
}

/** The egress unit's rule (deploy/agentturn-egress.service holds the same words). */
export function firewallRuleArgs(turnUser: string): string[] {
  return ["-m", "owner", "--uid-owner", turnUser, "-d", "169.254.169.254", "-j", "REJECT"];
}

/** True when an `iptables -S` line is exactly the egress rule in OUTPUT, in either order iptables
 *  prints its options: the metadata address (with or without /32), the owner match on the turn
 *  user (by name or uid), REJECT (with any --reject-with), and nothing else. */
export function isEgressRuleLine(line: string, turnUser: string, uid: string | null): boolean {
  const t = line.trim().split(/\s+/);
  if (t[0] !== "-A" || t[1] !== "OUTPUT") return false;
  const seen: Record<string, string> = {};
  for (let i = 2; i < t.length; i += 2) {
    const [k, v] = [t[i], t[i + 1]];
    if (v === undefined || !["-d", "-m", "--uid-owner", "-j", "--reject-with"].includes(k) || k in seen) return false;
    seen[k] = v;
  }
  return (
    (seen["-d"] === "169.254.169.254" || seen["-d"] === "169.254.169.254/32") &&
    seen["-m"] === "owner" &&
    (seen["--uid-owner"] === turnUser || (uid !== null && seen["--uid-owner"] === uid)) &&
    seen["-j"] === "REJECT"
  );
}

type Result = { ok: boolean; detail: string };
type Check = (io: IntegrityIo, c: IntegrityConfig) => Promise<Result>;
const pass = (detail: string): Result => ({ ok: true, detail });
const fail = (detail: string): Result => ({ ok: false, detail });
const verdict = (problems: string[], okDetail: string): Result => (problems.length ? fail(problems.join("; ")) : pass(okDetail));
const lineCount = (s: string) => s.split("\n").filter((l) => l.trim() !== "").length;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const j = (...parts: string[]) => parts.join("/");
const oct = (m: number) => m.toString(8).padStart(4, "0");

// --- the checks ----------------------------------------------------------------------------------

const guardFilesMatchGit: Check = async (io, c) => {
  const st = await io.run(["git", "-C", c.repo, "status", "--porcelain", "--", "guard.ts", "inbox.ts", "hooks", "deploy"]);
  const un = await io.run(["git", "-C", c.repo, "ls-files", "--others", "--exclude-standard", "hooks", "deploy"]);
  if (st.code !== 0 || un.code !== 0) return fail(`git exited ${st.code} (status), ${un.code} (untracked)`);
  const n = lineCount(st.out), m = lineCount(un.out);
  return n || m ? fail(`git status lists ${n} paths, ${m} untracked`) : pass("guard files equal git");
};

async function sameAsTracked(io: IntegrityIo, installed: string, tracked: string): Promise<Result> {
  const [a, b] = await Promise.all([io.sudoRead(installed), io.read(tracked)]);
  if (b === null) return fail(`tracked copy missing: ${tracked}`);
  if (a === null) return fail(`installed copy missing or unreadable: ${installed}`);
  return a === b ? pass("equal to the tracked copy") : fail(`${installed} differs from the tracked copy`);
}
const managedSettingsMatch: Check = (io, c) => sameAsTracked(io, "/etc/claude-code/managed-settings.json", j(c.repo, "deploy", "managed-settings.json"));
const sudoersMatch: Check = (io, c) => sameAsTracked(io, "/etc/sudoers.d/telegram-agent-turn", j(c.repo, "deploy", "sudoers-agentturn"));

/** The override keys a settings file holds, or "unparsable"; never its content. */
function overrideKeys(text: string): string[] | "unparsable" {
  let s: unknown;
  try { s = JSON.parse(text); } catch { return "unparsable"; }
  if (!s || typeof s !== "object" || Array.isArray(s)) return "unparsable";
  const found = ["hooks", "disableAllHooks", "env"].filter((k) => has(s as object, k));
  const perms = (s as Record<string, unknown>).permissions;
  if (perms && typeof perms === "object" && has(perms, "defaultMode")) found.push("permissions.defaultMode");
  return found;
}
const noSettingsOverrides: Check = async (io, c) => {
  const problems: string[] = [];
  const look = (label: string, text: string | null) => {
    if (text === null) return;
    const k = overrideKeys(text);
    if (k === "unparsable") problems.push(`${label} does not parse`);
    else if (k.length) problems.push(`${label} holds ${k.join(", ")}`);
  };
  look("the repo's settings.local.json", await io.read(j(c.repo, ".claude", "settings.local.json")));
  look("the turn user's settings.json", await io.turnRead(j(c.turnHome, ".claude", "settings.json")));
  return verdict(problems, "no hooks, env or mode overrides");
};

const ROOT_FILES = [".bashrc", ".profile", ".bash_logout"];
const ROOT_DIRS = [".claude", ".config", ".cache", ".bun", ".local"];
const TURN_ENTRIES = new Set([...ROOT_FILES, ...ROOT_DIRS, "dev", "tmp", "outbox"]);
const turnHomeSealed: Check = async (io, c) => {
  const problems: string[] = [];
  const T = c.turnHome;
  const home = await io.stat(T);
  if (!home || home.isLink || !home.isDir || home.owner !== "root" || home.mode !== 0o711) problems.push("home is not a root-owned 0711 folder");
  const ls = await io.run([SUDO, "-n", "/usr/bin/ls", "-A", T]);
  if (ls.code !== 0) problems.push(`home not listable (exit ${ls.code})`);
  else {
    const extra = ls.out.split("\n").filter((n) => n !== "" && !TURN_ENTRIES.has(n)).length;
    if (extra) problems.push(`${extra} unexpected entries in the home`);
  }
  // Root-owned and writable by nobody else, so a turn can leave nothing a later turn would load.
  for (const f of ROOT_FILES) {
    const s = await io.stat(j(T, f));
    if (!s || s.isLink || !s.isFile || s.owner !== "root" || (s.mode & 0o022) !== 0) problems.push(`${f} is not a root-owned file`);
  }
  for (const d of ROOT_DIRS) {
    const s = await io.stat(j(T, d));
    if (!s || s.isLink || !s.isDir || s.owner !== "root" || (s.mode & 0o022) !== 0) { problems.push(`${d} is not a root-owned folder`); continue; }
    const r = await io.run([SUDO, "-n", "/usr/bin/ls", "-A", j(T, d)]);
    if (r.code !== 0 || lineCount(r.out)) problems.push(`${d} is not empty`);
  }
  for (const [d, group, mode] of [["dev", c.turnUser, 0o700], ["tmp", c.turnUser, 0o700], ["outbox", DATA_GROUP, 0o2750]] as const) {
    const s = await io.stat(j(T, d));
    if (!s || s.isLink || !s.isDir || s.owner !== c.turnUser || s.group !== group || s.mode !== mode) problems.push(`${d} is not ${c.turnUser}:${group} ${oct(mode)}`);
  }
  return verdict(problems, "sealed");
};

const noBunfig: Check = async (io, c) => {
  const paths = [j(c.repo, "bunfig.toml"), j(c.repo, ".bunfig.toml"), j(c.mainHome, ".bunfig.toml"), j(c.mainHome, ".config", ".bunfig.toml")];
  const found: string[] = [];
  for (const p of paths) if ((await io.stat(p)) !== null) found.push(p);
  return found.length ? fail(`found: ${found.join(", ")}`) : pass("none");
};

async function names(io: IntegrityIo, dir: string, label: string): Promise<string[]> {
  const n = await io.list(dir);
  if (n === null) throw new CheckFail(`${label} not listable`);
  return n;
}
const noEnvFiles: Check = async (io, c) => {
  let n = (await names(io, c.repo, "the repo")).filter((x) => x.startsWith(".env")).length;
  if (c.stateDir !== c.repo) n += (await names(io, c.stateDir, "the state folder")).filter((x) => x.startsWith(".env")).length;
  return n ? fail(`${n} .env* files in the repo or the state folder`) : pass("none");
};

const STRAY = ["memory", "reminders.json", "followups.json", "choices.json", "pending.json", "skills", "uploads", "history"];
const noStrayState: Check = async (io, c) => {
  if (c.stateDir === c.repo) return pass("state lives in the repo (no state folder)");
  const there = new Set(await names(io, c.repo, "the repo"));
  const found = STRAY.filter((x) => there.has(x));
  return found.length ? fail(`in the repo: ${found.join(", ")}`) : pass("none");
};

const LAYOUT: [string, number][] = [
  ["", 0o2750], ["data", 0o2750], ["history", 0o2750], ["uploads", 0o2750], ["cc-digest", 0o2750], ["shared", 0o2750],
  ["shared/stores", 0o2770], ["shared/data", 0o2770], ["shared/cc-digest", 0o2770], ["shared/rchannel-proposals", 0o2770], ["shared/memory/mirror", 0o2770],
  ["shared/memory", 0o3770], ["shared/skills", 0o3770], ["shared/skills/.archive", 0o3770],
];
const stateLayout: Check = async (io, c) => {
  const S = c.stateDir;
  const problems: string[] = [];
  const odd = await io.run(STATE_ODD_FIND_ARGS(S));
  if (odd.code !== 0) problems.push(`the link search exited ${odd.code}`);
  else if (lineCount(odd.out)) problems.push(`${lineCount(odd.out)} links, FIFOs, special files or hard-linked files under the state folder`);
  for (const [rel, mode] of LAYOUT) {
    const s = await io.stat(rel ? j(S, rel) : S);
    if (!s || s.isLink || !s.isDir || s.owner !== MAIN_USER || s.group !== DATA_GROUP || s.mode !== mode) problems.push(`${rel || "the state folder"} is not ${MAIN_USER}:${DATA_GROUP} ${oct(mode)}`);
  }
  const loose = await io.run([SUDO, "-n", "/usr/bin/find", S, "-path", `${S}/shared`, "-prune", "-o", "-type", "f", "(", "-perm", "/g+w,o+rwx", "-o", "!", "-user", MAIN_USER, ")", "-print"]);
  if (loose.code !== 0) problems.push(`the file mode search exited ${loose.code}`);
  else if (lineCount(loose.out)) problems.push(`${lineCount(loose.out)} files outside shared/ are not 0640 ${MAIN_USER}`);
  for (const f of ["bot.db", "bot.db-wal", "bot.db-shm"]) {
    const s = await io.stat(j(S, "shared", "memory", f));
    if (s && (s.isLink || s.owner !== MAIN_USER)) problems.push(`${f} is not owned by ${MAIN_USER}`);
  }
  let turnsAsUser: boolean | null = null;
  try { turnsAsUser = !!(await io.serviceEnv()).TURN_USER; } catch { problems.push("the service environment is unreadable"); }
  if (turnsAsUser) {
    const r = await io.run([SUDO, "-n", "/usr/bin/find", j(S, "shared", "skills"), "-type", "f", "!", "-user", c.turnUser, "-print"]);
    if (r.code !== 0) problems.push(`the skill owner search exited ${r.code}`);
    else if (lineCount(r.out)) problems.push(`${lineCount(r.out)} skill files not owned by ${c.turnUser}`);
  }
  return verdict(problems, "layout, modes and owners as designed");
};

/** The sha256 of a line without its newline, as recorded at rollout. */
export function lineHash(line: string): string {
  return createHash("sha256").update(line).digest("hex");
}
const inboxKeyUnchanged: Check = async (io, c) => {
  const ak = await io.read(j(c.mainHome, ".ssh", "authorized_keys"));
  if (ak === null) return fail("authorized_keys missing");
  const hits = ak.split("\n").filter((l) => l.endsWith(" phone-inbox"));
  if (hits.length !== 1) return fail(`${hits.length} phone-inbox lines (expected 1)`);
  const rec = await io.sudoRead("/etc/telegram-agent/inbox-key.sha256");
  if (rec === null) return fail("the recorded hash is missing");
  return lineHash(hits[0]) === rec.trim().split(/\s+/)[0] ? pass("unchanged") : fail("the phone-inbox key line changed");
};

const namesUser = (text: string, u: string) => text.split("\n").some((l) => l.trim() === u);
const turnUserSealed: Check = async (io, c) => {
  const u = c.turnUser;
  const problems: string[] = [];
  const g = await io.run(["/usr/bin/id", "-nG", u]);
  if (g.code !== 0) problems.push(`id exited ${g.code}`);
  else {
    // Only its own group and the data group: sudo, claudebot, or any other group (adm, lxd, docker) is a finding.
    const extra = g.out.trim().split(/\s+/).filter((x) => x && x !== u && x !== DATA_GROUP);
    if (extra.length) problems.push(`in groups: ${extra.join(", ")}`);
  }
  const l = await io.run([SUDO, "-n", "-l", "-U", u]);
  if (!l.out.includes("not allowed")) problems.push("has sudo rights (or sudo -l failed)");
  for (const tool of ["cron", "at"]) {
    const allow = await io.sudoRead(`/etc/${tool}.allow`);
    if (allow !== null) {
      if (namesUser(allow, u)) problems.push(`${tool}.allow names the user`);
      continue;
    }
    const deny = await io.sudoRead(`/etc/${tool}.deny`);
    if (deny === null || !namesUser(deny, u)) problems.push(`${tool}.deny does not list the user`);
  }
  const sshd = await io.run([SUDO, "-n", "/usr/sbin/sshd", "-T"]);
  const denied = sshd.out.split("\n").some((line) => {
    const w = line.trim().split(/\s+/);
    return w[0]?.toLowerCase() === "denyusers" && w.slice(1).includes(u);
  });
  if (sshd.code !== 0) problems.push(`sshd -T exited ${sshd.code}`);
  else if (!denied) problems.push("sshd does not deny the user");
  return verdict(problems, "no sudo, no extra groups, cron, at and ssh denied");
};

const closedHome: Check = async (io, c) => {
  const H = c.mainHome;
  const problems: string[] = [];
  const h = await io.stat(H);
  if (!h || h.isLink || !h.isDir || h.mode !== 0o711) problems.push("the home is not 0711");
  const open = await io.run(["/usr/bin/find", H, "-maxdepth", "1", "-mindepth", "1", "!", "-type", "l", "-perm", "/o+rwx", "!", "-name", "claude-bot", "!", "-name", ".bun"]);
  if (open.code !== 0) problems.push(`the permission search exited ${open.code}`);
  else if (lineCount(open.out)) problems.push(`${lineCount(open.out)} top-level entries open to others`);
  let notMine = 0;
  for (const n of await names(io, H, "the home")) {
    const s = await io.stat(j(H, n));
    if (!s || s.owner !== MAIN_USER) notMine++;
  }
  if (notMine) problems.push(`${notMine} top-level entries not owned by ${MAIN_USER}`);
  // The code the poller runs: nothing in the repo or in Bun's folder is writable by others or by
  // the data group (links skipped: a link's own mode means nothing), and the turn user cannot write
  // the guard, the poller or the bun binary.
  const B = j(H, ".bun");
  const w = await io.run(CODE_WRITABLE_FIND_ARGS(c.repo, B));
  if (w.code !== 0) problems.push(`the code write search exited ${w.code}`);
  else if (lineCount(w.out)) problems.push(`${lineCount(w.out)} entries in the repo or ~/.bun writable by others or ${DATA_GROUP}`);
  for (const f of [j(c.repo, "guard.ts"), j(c.repo, "poller.ts"), j(B, "bin", "bun")]) {
    const t = await io.run([SUDO, "-n", "-u", c.turnUser, "/usr/bin/test", "-w", f]);
    if (t.code === 0) problems.push(`${c.turnUser} can write ${f}`);
    else if (t.code !== 1) problems.push(`the write test of ${f} exited ${t.code}`);
  }
  return verdict(problems, "closed");
};

/** Present, and the first OUTPUT rule: an ACCEPT before it would leave it in place but dead. */
const firewallRule: Check = async (io, c) => {
  const r = await io.run([SUDO, "-n", "/usr/sbin/iptables", "-C", "OUTPUT", ...firewallRuleArgs(c.turnUser)]);
  if (r.code !== 0) return fail(`iptables -C exited ${r.code}: the metadata rule is missing`);
  const s = await io.run([SUDO, "-n", "/usr/sbin/iptables", "-S", "OUTPUT"]);
  if (s.code !== 0) return fail(`iptables -S exited ${s.code}`);
  const id = await io.run(["/usr/bin/id", "-u", c.turnUser]);
  const first = s.out.split("\n").find((l) => l.startsWith("-A "));
  return first !== undefined && isEgressRuleLine(first, c.turnUser, id.code === 0 ? id.out.trim() : null)
    ? pass("present, the first OUTPUT rule")
    : fail("the metadata rule is not the first OUTPUT rule");
};

const serviceSwitches: Check = async (io, c) => {
  const env = await io.serviceEnv();
  const want: Record<string, string> = { TURN_USER: c.turnUser, STATE_DIR: c.stateDir, AUTO_APPROVAL: "1", SKILL_APPROVAL: "1", INTEGRITY_NIGHTLY: "1" };
  // Values are compared, never printed: the environment file also holds the secrets.
  const off = Object.keys(want).filter((k) => env[k] !== want[k]);
  if (env.TURN_SWEEP === "0") off.push("TURN_SWEEP");
  // The repo's marker names the same state folder (a CLI run without the env reads the marker).
  const marker = await io.read(j(c.repo, ".state-dir"));
  if (marker === null) off.push("the .state-dir marker (missing)");
  else if (marker.split("\n")[0].trim() !== env.STATE_DIR) off.push("the .state-dir marker");
  return off.length ? fail(`not as expected: ${off.join(", ")}`) : pass("set as expected");
};

/** Reported, never a finding (only a hang past the budget is). */
const guardRefusals: Check = async (io) => {
  let r: { code: number; out: string };
  try {
    r = await io.run([SUDO, "-n", "/usr/bin/journalctl", "-t", "agent-guard", "--since", "-48h", "-o", "cat"]);
  } catch (e) {
    return pass(`journal unreadable: ${safeMessage(e)}`);
  }
  if (r.code !== 0) return pass(`journal unreadable (exit ${r.code})`);
  const n = r.out.split("\n").filter((l) => l.trim() !== "" && l.trim() !== "-- No entries --").length;
  return pass(`${n} refusals in the last 48 h`);
};

/** bot.db's sqlite_master equals what db.ts creates: a trigger, view or table a turn planted (or a
 *  trigger it redefined) is a finding. Counted, never named, since a turn chose the names. */
const dbSchema: Check = async (io, c) => {
  const p = c.stateDir === c.repo ? j(c.repo, "memory", "bot.db") : j(c.stateDir, "shared", "memory", "bot.db");
  const drift = await io.dbDrift(p);
  if (drift === null) return fail("bot.db missing");
  return drift.length ? fail(`${drift.length} schema objects added, removed or changed`) : pass("as db.ts creates it");
};

const CHECKS: [string, Check][] = [
  ["guard-files-match-git", guardFilesMatchGit],
  ["managed-settings-match", managedSettingsMatch],
  ["sudoers-match", sudoersMatch],
  ["no-settings-overrides", noSettingsOverrides],
  ["turn-home-sealed", turnHomeSealed],
  ["no-bunfig", noBunfig],
  ["no-env-files", noEnvFiles],
  ["no-stray-state", noStrayState],
  ["state-layout", stateLayout],
  ["inbox-key-unchanged", inboxKeyUnchanged],
  ["turn-user-sealed", turnUserSealed],
  ["closed-home", closedHome],
  ["firewall-rule", firewallRule],
  ["service-switches", serviceSwitches],
  ["guard-refusals-48h", guardRefusals],
  ["db-schema", dbSchema],
];
export const CHECK_NAMES: readonly string[] = CHECKS.map(([n]) => n);

/** What a failed check may say about its error: our own message, an fs error code, or the error's
 *  class name. Never a message from elsewhere, which could carry file content. */
function safeMessage(e: unknown): string {
  if (e instanceof CheckFail || e instanceof CheckTimeout) return e.message;
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{2,20}$/.test(code)) return code;
  return e instanceof Error ? e.name : "error";
}

async function withBudget(name: string, check: () => Promise<Result>, budgetMs: number): Promise<Finding> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CheckTimeout(`timed out after ${budgetMs / 1000} s`)), budgetMs);
  });
  try {
    const r = await Promise.race([Promise.resolve().then(check), timeout]);
    return { name, ok: r.ok, detail: r.detail };
  } catch (e) {
    return { name, ok: false, detail: `check failed to run: ${safeMessage(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Every check, side by side, each raced against its budget, in CHECK_NAMES order. */
export async function runChecks(io: IntegrityIo, cfg: IntegrityConfig, budgetMs = 30_000): Promise<Finding[]> {
  return Promise.all(CHECKS.map(([name, check]) => withBudget(name, () => check(io, cfg), budgetMs)));
}

/** null when every check is ok; else a Hebrew count line, then each failing check's name and detail. */
export function integrityMessage(findings: Finding[]): string | null {
  const bad = findings.filter((f) => !f.ok);
  if (!bad.length) return null;
  return [`בדיקת השלמות של השרת מצאה ${bad.length} בעיות`, ...bad.flatMap((f) => [f.name, f.detail])].join("\n");
}

// --- the nightly run (the poller wires it; the logic lives here so it is tested) ------------------

const NIGHTLY_AT_MIN = 4 * 60 + 15;

/** A local date not yet attempted, at or after 04:15, outside quiet time. */
export function integrityDue(now: Date, lastAttemptDate: string | null, quiet: boolean): boolean {
  const { date, minutes } = localParts(now);
  return date !== lastAttemptDate && minutes >= NIGHTLY_AT_MIN && !quiet;
}

/** attempted: the last date a run started; date/at: the last completion; since: when the poller
 *  first started with the nightly run on and found no file (health measures from it until a run
 *  completes). */
export interface IntegrityLast { attempted?: string; date?: string; at?: number; since?: number }
/** integrity-last.json, read without following a link; null when missing or unreadable. */
export function readIntegrityLast(path: string = INTEGRITY_LAST_FILE): IntegrityLast | null {
  try {
    const v = JSON.parse(readNoFollow(path, 64 * 1024));
    if (!v || typeof v !== "object") return null;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
    return {
      attempted: typeof v.attempted === "string" ? v.attempted : undefined,
      date: typeof v.date === "string" ? v.date : undefined,
      at: num(v.at),
      since: num(v.since),
    };
  } catch {
    return null;
  }
}

/** The poller's startup with the nightly run on: the attempt date to seed (null when none). A
 *  missing file gets `{ since: nowS }`, so health measures 96 h from the switch-on instead of
 *  alerting at once; an unreadable one is left in place for health to see. */
export function seedIntegrityLast(path: string, nowS: number): string | null {
  const last = readIntegrityLast(path);
  if (last) return last.attempted ?? null;
  try {
    lstatSync(path);
    return null; // present but unreadable: leave it
  } catch (e) {
    if (!missing(e)) return null;
  }
  try {
    writeAtomic(path, JSON.stringify({ since: nowS }));
  } catch (e) {
    console.error(`[ERR] integrity: could not write ${path}: ${safeMessage(e)}`);
  }
  return null;
}

/** A completed run's findings: exactly one finding for each of the 16 checks; anything else (a
 *  truncated or altered output) counts as not completed. */
function parseFindings(out: string): Finding[] | null {
  let v: unknown;
  try { v = JSON.parse(out.trim()); } catch { return null; }
  if (!Array.isArray(v) || v.length !== CHECK_NAMES.length) return null;
  const ok = v.every((f) => f && typeof f.name === "string" && typeof f.ok === "boolean" && typeof f.detail === "string");
  if (!ok) return null;
  const names = new Set(v.map((f) => f.name));
  if (names.size !== CHECK_NAMES.length || !CHECK_NAMES.every((n) => names.has(n))) return null;
  return v.map((f) => ({ name: f.name, ok: f.ok, detail: f.detail }));
}

export interface NightlyDeps {
  now: () => Date;
  quiet: (now: Date) => boolean;
  lastFile: string;
  /** In memory, seeded from lastFile at startup. */
  state: { attempted: string | null };
  runCheck: () => Promise<{ killed: boolean; out: string }>;
  send: (text: string) => Promise<void>;
  log: (line: string) => void;
}

/** One tick: when due, record the attempt (memory and file) before anything else, run the check,
 *  then record the completion and send the message on findings; a run that was killed or printed
 *  no findings sends the incomplete notice, and that date is not tried again. */
export async function nightlyIntegrity(d: NightlyDeps): Promise<void> {
  const now = d.now();
  if (!integrityDue(now, d.state.attempted, d.quiet(now))) return;
  const date = localParts(now).date;
  d.state.attempted = date;
  const prev = readIntegrityLast(d.lastFile) ?? {};
  try {
    writeAtomic(d.lastFile, JSON.stringify({ ...prev, attempted: date }));
  } catch (e) {
    d.log(`[ERR] integrity: could not record the attempt: ${safeMessage(e)}`);
  }
  d.log(`[INTEGRITY] nightly run for ${date}`);
  let findings: Finding[] | null = null;
  try {
    const r = await d.runCheck();
    if (!r.killed) findings = parseFindings(r.out);
  } catch (e) {
    d.log(`[ERR] integrity: the run failed to start: ${safeMessage(e)}`);
  }
  const say = async (text: string) => {
    try { await d.send(text); } catch (e) { d.log(`[ERR] integrity: send failed: ${safeMessage(e)}`); }
  };
  if (!findings) {
    d.log("[ERR] integrity: the run did not complete");
    await say(INCOMPLETE_MESSAGE);
    return;
  }
  try {
    writeAtomic(d.lastFile, JSON.stringify({ attempted: date, date, at: Math.floor(d.now().getTime() / 1000) }));
  } catch (e) {
    d.log(`[ERR] integrity: could not record the completion: ${safeMessage(e)}`);
  }
  const bad = findings.filter((f) => !f.ok).length;
  d.log(`[INTEGRITY] ${findings.length} checks, ${bad} findings`);
  const msg = integrityMessage(findings);
  if (msg) await say(msg);
}

// --- the real io ---------------------------------------------------------------------------------

/** `systemctl show -p Environment -p EnvironmentFiles` output: the Environment assignments (quoted
 *  ones may hold spaces) and the environment file paths. */
export function parseServiceShow(out: string): { env: Record<string, string>; files: string[] } {
  const env: Record<string, string> = {};
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("Environment=")) {
      for (const tok of splitQuoted(line.slice("Environment=".length))) {
        const i = tok.indexOf("=");
        if (i > 0) env[tok.slice(0, i)] = tok.slice(i + 1);
      }
    } else if (line.startsWith("EnvironmentFiles=")) {
      const p = line.slice("EnvironmentFiles=".length).replace(/ \(ignore_errors=\w+\)\s*$/, "").trim();
      if (p) files.push(p);
    }
  }
  return { env, files };
}

function splitQuoted(s: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false, any = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length) { cur += s[++i]; any = true; }
    else if (ch === '"') { inQ = !inQ; any = true; }
    else if (!inQ && (ch === " " || ch === "\t")) { if (any) out.push(cur); cur = ""; any = false; }
    else { cur += ch; any = true; }
  }
  if (any) out.push(cur);
  return out;
}

/** An environment file's KEY=value lines (comments and odd lines skipped, outer quotes removed). */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

const missing = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** sudo's options that take a value (-u agentturn, -U agentturn, ...). */
const SUDO_ARG_OPTS = new Set(["-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u"]);

/** A command run through sudo runs as another user, whom the poller's user cannot signal, so the
 *  kill must come from inside the sudo: `/usr/bin/timeout -s KILL <s>` goes right after sudo's own
 *  options and `--`, and the command's own user (root, or the turn user under -u) kills it on
 *  time. Seconds round up. A non-sudo argv, and a sudo argv with no command (`sudo -l -U <user>`,
 *  a lookup sudo does itself with no child), are returned unchanged. */
export function rootTimeoutArgv(argv: string[], timeoutMs: number): string[] {
  if (argv[0] !== SUDO) return argv;
  let i = 1;
  while (i < argv.length && argv[i].startsWith("-") && argv[i] !== "--") i += SUDO_ARG_OPTS.has(argv[i]) ? 2 : 1;
  const cmdAt = argv[i] === "--" ? i + 1 : i;
  if (cmdAt >= argv.length) return argv;
  const secs = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  return [...argv.slice(0, i), "--", "/usr/bin/timeout", "-s", "KILL", secs, ...argv.slice(cmdAt)];
}

export function realIo(
  cfg: Pick<IntegrityConfig, "turnUser" | "turnHome">,
  log: (line: string) => void = (l) => console.error(l),
  service: string = SERVICE,
): IntegrityIo {
  const turnUser = cfg.turnUser;
  const turnHomeSlash = cfg.turnHome.replace(/\/+$/, "") + "/";
  let killErrLogged = false;
  /** Every command has a deadline: when it passes, the promise resolves as exit 124 with no output
   *  and the poller's user SIGKILLs its own child. That kill reaches a command the poller's user
   *  runs directly; a sudo command is killed by the timeout inside it (rootTimeoutArgv), since sudo
   *  runs as root and the poller's user cannot signal it. A failed kill is logged once per run.
   *  stdin and stderr are closed, so nothing waits on a terminal and a chatty stderr cannot fill a
   *  pipe. */
  const run = async (argv: string[], timeoutMs = 10_000): Promise<{ code: number; out: string }> => {
    const p = Bun.spawn(rootTimeoutArgv(argv, timeoutMs), { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((res) => {
      timer = setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch (e) {
          if (!killErrLogged) {
            killErrLogged = true;
            log(`[ERR] integrity: could not kill a timed-out command: ${safeMessage(e)}`);
          }
        }
        res(null);
      }, timeoutMs);
    });
    try {
      const done = await Promise.race([Promise.all([new Response(p.stdout).text(), p.exited]), deadline]);
      return done === null ? { code: 124, out: "" } : { code: done[1], out: done[0] };
    } finally {
      clearTimeout(timer);
    }
  };
  const read = async (p: string): Promise<string | null> => {
    try {
      return readNoFollow(p, 1024 * 1024);
    } catch (e) {
      if (missing(e)) return null;
      const m = e instanceof Error ? e.message : "";
      if (m.startsWith("not a regular file")) throw new CheckFail("not a regular file");
      if (m.startsWith("file over cap")) throw new CheckFail("file over the size cap");
      throw e;
    }
  };
  return {
    read,
    sudoRead: async (path) => {
      const p = posix.normalize(path);
      if (!p.startsWith("/etc/")) throw new CheckFail("sudoRead outside /etc/");
      const r = await run([SUDO, "-n", "/usr/bin/cat", "--", p]);
      return r.code === 0 ? r.out : null;
    },
    turnRead: async (path) => {
      const p = posix.normalize(path);
      if (!p.startsWith(turnHomeSlash)) throw new CheckFail("turnRead outside the turn user's home");
      const t = await run([SUDO, "-n", "/usr/bin/stat", "-c", "%F", "--", p]);
      if (t.code !== 0) return null;
      if (t.out.trim() !== "regular file") throw new CheckFail("not a regular file");
      const r = await run([SUDO, "-n", "-u", turnUser, "/usr/bin/timeout", "5", "/usr/bin/cat", "--", p]);
      if (r.code !== 0) throw new CheckFail(`read as ${turnUser} exited ${r.code}`);
      return r.out;
    },
    list: async (d) => {
      try { return readdirSync(d); } catch (e) { if (missing(e)) return null; throw e; }
    },
    stat: async (p) => {
      let st;
      try { st = lstatSync(p); } catch (e) { if (missing(e)) return null; throw e; }
      const n = await run(["/usr/bin/stat", "-c", "%U %G", "--", p]);
      if (n.code !== 0) throw new CheckFail(`stat exited ${n.code}`);
      const [owner = "", group = ""] = n.out.trim().split(" ");
      return { mode: st.mode & 0o7777, owner, group, isLink: st.isSymbolicLink(), isDir: st.isDirectory(), isFile: st.isFile(), nlink: st.nlink };
    },
    run,
    serviceEnv: async () => {
      const r = await run(["/usr/bin/systemctl", "show", service, "-p", "Environment", "-p", "EnvironmentFiles"]);
      if (r.code !== 0) throw new CheckFail(`systemctl show exited ${r.code}`);
      const { env, files } = parseServiceShow(r.out);
      // systemd: the files' values override Environment=, later files over earlier ones.
      for (const f of files) {
        const text = await read(f);
        if (text !== null) Object.assign(env, parseEnvFile(text));
      }
      return env;
    },
    dbDrift: async (p) => {
      let st;
      try { st = lstatSync(p); } catch (e) { if (missing(e)) return null; throw e; }
      if (!st.isFile()) throw new CheckFail("bot.db is not a regular file");
      // Read-only, no link followed, and hardened before the first read of the schema.
      const db = new Database(p, sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOFOLLOW);
      try {
        hardenDb(db);
        db.exec("PRAGMA busy_timeout = 5000;");
        return schemaDrift(db);
      } finally {
        db.close();
      }
    },
  };
}

export function defaultConfig(env: Record<string, string | undefined> = process.env): IntegrityConfig {
  const turnUser = env.TURN_USER || "agentturn";
  return { repo: REPO_DIR, stateDir: resolveStateDir(env), turnUser, mainHome: homedir(), turnHome: `/home/${turnUser}` };
}

async function main(): Promise<void> {
  const cfg = defaultConfig();
  const findings = await runChecks(realIo(cfg), cfg);
  const text = process.argv.includes("--json")
    ? JSON.stringify(findings)
    : findings.map((f) => `${f.ok ? "ok  " : "FAIL"} ${f.name}: ${f.detail}`).join("\n");
  await Bun.write(Bun.stdout, text + "\n");
  process.exit(findings.every((f) => f.ok) ? 0 : 1);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[ERR] integrity: ${safeMessage(e)}`);
    process.exit(1);
  });
}
