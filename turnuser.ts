/**
 * turnuser.ts: how a Claude turn, and any command a turn proposed, is started and stopped.
 *
 * TURN_USER unset (the PC, the tests, the rollback state): argv and environment exactly as given.
 * TURN_USER set (the droplet): through sudo as that weaker user, inside a wrapper that gives the
 * turn a fresh Claude config, XDG config and cache folder and removes it afterwards, so nothing a
 * turn writes there reaches a later turn. The three secrets a turn needs travel in the environment
 * (sudoers env_keep); every other variable goes on the /usr/bin/env command line (secret-shaped
 * names and values never do). Stopping and sweeping signal agentturn processes as agentturn.
 */
import { join } from "node:path";
import { stateDir, REPO_DIR } from "./paths";

export const TURN_SECRETS = ["CLAUDE_CODE_OAUTH_TOKEN", "ICLOUD_USER", "ICLOUD_APP_PASSWORD"] as const;
export const BOT_ONLY_SECRETS = ["TELEGRAM_BOT_TOKEN", "GROQ_API_KEY"] as const;
export const TURN_PATH = "/home/claudebot/.bun/bin:/usr/local/bin:/usr/bin:/bin";
export const PROCESS_LIST_ARGV = ["/usr/bin/ps", "-e", "-o", "pid=,ppid=,user:32="];
export const TURN_WRAPPER =
  'd=$(mktemp -d "$HOME/tmp/turn-XXXXXX") || exit 70; ' +
  "trap 'rm -rf \"$d\"' EXIT; trap 'exit 143' HUP INT TERM; " +
  'mkdir -p "$d/claude" "$d/config" "$d/cache" "$d/bun" || exit 70; ' +
  'export CLAUDE_CONFIG_DIR="$d/claude" XDG_CONFIG_HOME="$d/config" XDG_CACHE_HOME="$d/cache" BUN_INSTALL_CACHE_DIR="$d/bun"; ' +
  '"$@"';
const DROP = new Set(["HOME", "PATH", "USER", "LOGNAME", "SHELL", "PWD", "OLDPWD", "TMPDIR", "MAIL", "TERM", "SHLVL", "INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "NOTIFY_SOCKET", "MANAGERPID", "LISTEN_PID", "LISTEN_FDS", "TURN_USER", "CLAUDE_CONFIG_DIR", "TURN_SWEEP", "STATE_INIT", "INTEGRITY_NIGHTLY", "STATE_DIR", "BUN_INSTALL_CACHE_DIR"]);

type Env = Record<string, string | undefined>;
type Row = { pid: number; ppid: number; user: string };

/** Names that match the denylist but carry no secret (numeric limits Claude Code reads). */
const SECRET_NAME_ALLOW = new Set(["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "MAX_THINKING_TOKENS"]);
export function isSecretName(k: string): boolean {
  if (SECRET_NAME_ALLOW.has(k)) return false;
  return (
    /TOKEN|PASSWORD|PASSWD|PASSPHRASE|SECRET|KEY|CREDENTIAL|COOKIE|PRIVATE/i.test(k) ||
    // word parts only, so PASSTHROUGH, COMPASS, AUTHOR and DSNAME stay plain names
    /(^|_)(PASS|AUTH|AUTHN|AUTHZ|AUTHORIZATION|DSN)(_|$)/i.test(k) ||
    /^ICLOUD_/.test(k)
  );
}
const UUID_SEGMENT = /:\/\/\S*\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=[/?#\s]|$)/i;
const PING_HOST = /:\/\/(?:[^/\s?#@]*@)?(?:[a-z0-9-]+\.)*hc-ping\.com(?=[:/?#\s]|$)/i;
export function isSecretValue(v: string): boolean {
  // credentials in a URL; a health-check ping URL (anyone holding it can ping or pause the check);
  // any URL with a UUID-shaped path segment (the usual shape of a capability URL)
  return /:\/\/[^/\s:@]+:[^/\s@]+@/.test(v) || PING_HOST.test(v) || UUID_SEGMENT.test(v);
}

export function turnUser(env: Env = process.env): string | null {
  const u = env.TURN_USER;
  if (!u) return null;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(u)) throw new Error(`TURN_USER is not a user name: ${u}`);
  return u;
}

function defined(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
  return out;
}

export function turnSpawn(argv: string[], env: Env): { argv: string[]; env: Record<string, string> } {
  const user = turnUser(env);
  if (!user) return { argv, env: defined(env) };
  const home = `/home/${user}`;
  const pass: Record<string, string> = {};
  for (const [k, v] of Object.entries(defined(env))) {
    if (DROP.has(k) || k.startsWith("SUDO_") || k.startsWith("XDG_") || isSecretName(k) || isSecretValue(v)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    pass[k] = v;
  }
  const s = stateDir(env);
  if (s !== REPO_DIR) {
    pass.INBOX_STATUS_FILE ??= join(s, "inbox-status.json").replace(/\\/g, "/");
    pass.RCHANNEL_SPOOL ??= join(s, "shared", "rchannel-proposals").replace(/\\/g, "/");
  }
  pass.CC_DIGEST_SNAPSHOT = "1";
  const secrets: Record<string, string> = {};
  for (const k of TURN_SECRETS) if (typeof env[k] === "string") secrets[k] = env[k] as string;
  return {
    argv: [
      "/usr/bin/sudo", "-n", "-u", user, "--", "/usr/bin/env",
      `PATH=${TURN_PATH}`, `HOME=${home}`, `TMPDIR=${home}/tmp`,
      ...Object.entries(pass).map(([k, v]) => `${k}=${v}`),
      "/bin/sh", "-c", TURN_WRAPPER, "turn",
      ...argv,
    ],
    env: { ...secrets, PATH: env.PATH ?? "/usr/bin:/bin" },
  };
}

export function parseProcessList(out: string): Row[] {
  const rows: Row[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), user: m[3] });
  }
  return rows;
}

// Both walks follow the whole chain (no depth cap: a turn may build a chain of any depth up to its
// process limit) and stop on a pid already seen. A cycle can only come from a snapshot race (a pid
// reused between ps reading two rows); such a process counts as neither descendant nor orphan this
// round, and the next sweep sees a consistent list.
export function descendantsOf(rows: Row[], rootPid: number, user: string): number[] {
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  return rows.filter((r) => {
    if (r.user !== user) return false;
    const seen = new Set<number>([r.pid]);
    let p: number | undefined = r.ppid;
    while (p !== undefined && p > 0 && !seen.has(p)) {
      if (p === rootPid) return true;
      seen.add(p);
      p = parent.get(p);
    }
    return false;
  }).map((r) => r.pid);
}

export function orphansOf(rows: Row[], user: string): number[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  return rows.filter((r) => {
    if (r.user !== user) return false;
    const seen = new Set<number>();
    let cur: Row | undefined = r;
    while (cur && cur.user === user) {
      if (seen.has(cur.pid)) return false;
      seen.add(cur.pid);
      cur = byPid.get(cur.ppid);
    }
    return !cur || cur.pid === 1;
  }).map((r) => r.pid);
}

export function killAsUserArgv(user: string, sig: "TERM" | "KILL", pids: number[]): string[] {
  return ["/usr/bin/sudo", "-n", "-u", user, "--", "/usr/bin/kill", `-${sig}`, ...pids.map(String)];
}
export function staleTurnDirsArgv(user: string): string[] {
  return ["/usr/bin/sudo", "-n", "-u", user, "--", "/usr/bin/find", `/home/${user}/tmp`, "-maxdepth", "1", "-name", "turn-*", "-mmin", "+60", "-exec", "rm", "-rf", "{}", "+"];
}
export function envKeepProbeArgv(user: string): string[] {
  return ["/usr/bin/sudo", "-n", "-u", user, "--", "/usr/bin/env"];
}
