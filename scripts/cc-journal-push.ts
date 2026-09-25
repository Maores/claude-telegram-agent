/**
 * cc-journal-push.ts — PC side of the evening Claude Code digest (DEPLOY.md step 14,
 * spec docs/superpowers/specs/2026-09-25-cc-digest-design.md).
 *
 * Reads the last few daily notes, keeps only the timed log lines (sanitized by
 * ccjournal.ts: no emails, phone numbers or editorial brackets), and replaces
 * ~/cc-journal/journal.json on the server in one ssh call. The scheduled task
 * "TelegramAgent cc-journal push" runs it hourly through cc-journal-push.ps1, from a
 * deployed copy in %LOCALAPPDATA%\TelegramAgent\cc-journal-push, never from a
 * development checkout.
 *
 * Settings come from %LOCALAPPDATA%\TelegramAgent\cc-journal-push.json
 * ({"vault": "...", "target": "user@host", "key": "..."}); flags override the file:
 *   bun scripts/cc-journal-push.ts [--config <file>] [--vault <dir>] [--target <user@host>]
 *                                  [--key <path>] [--days 7] [--log <file>] [--dry-run]
 *
 * Exit 0 pushed (or a dry run), 1 a read or the send failed, 2 bad settings. Every exit
 * that is not a dry run leaves one line in the log.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { addDays, buildJournal, localParts } from "../ccjournal.ts";

const ATTEMPTS = 3; // the same budget as pull-backup.ps1
const RETRY_DELAY_MS = 30_000;
const LOG_KEEP = 200;

export interface PushArgs {
  vault: string;
  target: string;
  key: string;
  days: number;
  log: string;
  dryRun: boolean;
}

type Env = Record<string, string | undefined>;

export function agentDir(env: Env = process.env): string {
  return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "TelegramAgent");
}
export function defaultLogPath(env: Env = process.env): string {
  return join(agentDir(env), "cc-journal-push.log");
}
export function defaultConfigPath(env: Env = process.env): string {
  return join(agentDir(env), "cc-journal-push.json");
}

/** Write to a unique part file, check its size, then rename it over the journal, so a
 *  cut-off upload is never taken for a whole one. Part files an earlier cut-off upload
 *  left behind are cleared first (the task never overlaps itself). No quotes on purpose:
 *  the command crosses Windows' command-line quoting on its way to ssh. */
export function remoteCmd(bytes: number): string {
  return `f=$HOME/cc-journal/.journal.json.part.$$; mkdir -p $HOME/cc-journal && rm -f $HOME/cc-journal/.journal.json.part.* && cat > $f && [ $(wc -c < $f) -eq ${bytes} ] && mv -f $f $HOME/cc-journal/journal.json || { rm -f $f; exit 3; }`;
}

export function parsePushArgs(
  argv: string[],
  env: Env = process.env,
  readConfig: (path: string) => string | null = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
): PushArgs | { error: string } {
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (a.startsWith("--") && argv[i + 1] !== undefined) {
      flags.set(a.slice(2), argv[++i]);
      continue;
    }
    return { error: `unexpected argument: ${a}` };
  }

  const configPath = flags.get("config") ?? defaultConfigPath(env);
  let config: Record<string, unknown> = {};
  let raw: string | null;
  try {
    raw = readConfig(configPath);
    // Notepad and Windows PowerShell 5.1 save "UTF-8" with a byte-order mark; JSON.parse rejects it.
    if (raw !== null && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  } catch (e: any) {
    return { error: `cannot read ${configPath}: ${e?.message ?? e}` };
  }
  if (raw === null) {
    if (flags.has("config")) return { error: `no config file at ${configPath}` };
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      config = parsed;
    } catch (e: any) {
      return { error: `bad config file ${configPath}: ${e?.message ?? e}` };
    }
  }

  const pick = (name: string): string => flags.get(name) ?? (typeof config[name] === "string" ? (config[name] as string) : "");
  const vault = pick("vault");
  const target = pick("target");
  const key = pick("key");
  if (!vault) return { error: "no vault: set it in the config file or pass --vault" };
  if (!dryRun) {
    if (target.includes("<") || !/^[\w.-]+@[\w.-]+$/.test(target)) {
      return { error: "target must be user@host (the committed placeholder is refused)" };
    }
    if (!key) return { error: "no key: set it in the config file or pass --key" };
  }
  const days = Number(flags.get("days") ?? (typeof config.days === "number" ? config.days : 7));
  if (!Number.isInteger(days) || days < 1 || days > 14) return { error: "days must be 1..14" };
  return { vault, target, key, days, log: flags.get("log") ?? defaultLogPath(env), dryRun };
}

/** The local dates to read, oldest first: today and the days-1 before it. */
export function journalDates(now: Date, days: number): string[] {
  const today = localParts(now).date;
  return Array.from({ length: days }, (_, i) => addDays(today, i - (days - 1)));
}

interface ReadDeps {
  read: (path: string) => string;
  exists: (path: string) => boolean;
  sleep: (ms: number) => Promise<void>;
}

const realRead: ReadDeps = {
  read: (p) => readFileSync(p, "utf8"),
  exists: existsSync,
  sleep: (ms) => Bun.sleep(ms),
};

/** Read a note twice about 500 ms apart and retry while the reads differ, so a note
 *  another session is writing right now is not sampled half-written. null = no note;
 *  a read error throws. */
export async function readStable(path: string, deps: ReadDeps = realRead): Promise<string | null> {
  if (!deps.exists(path)) return null;
  let a = deps.read(path);
  for (let i = 0; i < 3; i++) {
    await deps.sleep(500);
    const b = deps.read(path);
    if (a === b) return a;
    a = b;
  }
  return a;
}

export async function sshSend(args: PushArgs, json: string): Promise<void> {
  const proc = Bun.spawn(
    // prettier-ignore
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-i", args.key, args.target, remoteCmd(Buffer.byteLength(json))],
    { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
  );
  try {
    await proc.stdin.write(json);
    await proc.stdin.end();
  } catch {
    // ssh can exit without reading stdin (no connection); its exit code tells the story
  }
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`ssh exited ${code}: ${err.trim().slice(0, 200)}`);
}

/** One timestamped line per outcome; never throws (a diagnostic that can fail the run it
 *  documents is worse than none). */
export function writeLog(path: string, message: string, now: Date = new Date()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const p = localParts(now);
    appendFileSync(path, `${p.date} ${p.hhmm}  ${message}\n`, "utf8");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    if (lines.length > LOG_KEEP) writeFileSync(path, lines.slice(-LOG_KEEP).join("\n") + "\n", "utf8");
  } catch {}
}

export interface PushDeps {
  now: () => Date;
  readNote: (path: string) => Promise<string | null>;
  send: (args: PushArgs, json: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  markOk: () => void;
  print: (s: string) => void;
  version: string | null; // the deployed copy's commit, from version.txt
}

export async function runPush(args: PushArgs, deps: PushDeps): Promise<number> {
  const now = deps.now();
  const notes: { date: string; text: string | null }[] = [];
  for (const date of journalDates(now, args.days)) {
    try {
      notes.push({ date, text: await deps.readNote(join(args.vault, "Daily", `${date}.md`)) });
    } catch (e: any) {
      deps.log(`FAILED reading ${date}.md: ${e?.message ?? e}`);
      return 1;
    }
  }
  const { journal, stats } = buildJournal(notes, Math.floor(now.getTime() / 1000), deps.version ?? undefined);
  const json = JSON.stringify(journal);
  if (args.dryRun) {
    deps.print(json);
    return 0;
  }
  const extras = [
    stats.ignoredBelowHeading ? `${stats.ignoredBelowHeading} timed lines below a heading ignored` : "",
    stats.testLinesDropped ? `${stats.testLinesDropped} test lines dropped` : "",
    stats.automationDropped ? `${stats.automationDropped} watchdog lines dropped` : "",
    stats.unparsedTimed ? `${stats.unparsedTimed} timed-looking lines not parsed or empty` : "",
    deps.version ? `copy ${deps.version}` : "",
  ].filter(Boolean);
  const suffix = extras.length ? `; ${extras.join("; ")}` : "";
  let lastErr = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      await deps.send(args, json);
      const retry = attempt > 1 ? ` on attempt ${attempt}` : "";
      deps.log(`pushed ${stats.entries} entries over ${journal.days.length} days (${Buffer.byteLength(json)} bytes)${retry}${suffix}`);
      deps.markOk();
      return 0;
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
      if (attempt < ATTEMPTS) {
        deps.log(`attempt ${attempt} of ${ATTEMPTS} failed: ${lastErr}; retrying in 30s`);
        await deps.sleep(RETRY_DELAY_MS);
      }
    }
  }
  deps.log(`FAILED after ${ATTEMPTS} attempt(s): ${lastErr}${suffix}`);
  return 1;
}

if (import.meta.main) {
  const parsed = parsePushArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    writeLog(defaultLogPath(), `FAILED: ${parsed.error}`);
    process.exit(2);
  }
  if (!existsSync(join(parsed.vault, "Daily"))) {
    const message = "FAILED: no Daily folder under the configured vault";
    console.error(message);
    if (!parsed.dryRun) writeLog(parsed.log, message);
    process.exit(2);
  }
  const versionFile = join(import.meta.dir, "..", "version.txt");
  let code = 1;
  try {
    code = await runPush(parsed, {
      now: () => new Date(),
      readNote: (p) => readStable(p),
      send: sshSend,
      sleep: (ms) => Bun.sleep(ms),
      log: (m) => writeLog(parsed.log, m),
      markOk: () => {
        try {
          writeFileSync(join(dirname(parsed.log), "last-push-ok"), new Date().toISOString());
        } catch {}
      },
      print: (s) => console.log(s),
      version: existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : null,
    });
  } catch (e: any) {
    writeLog(parsed.log, `CRASHED: ${e?.message ?? e}`);
  }
  process.exit(code);
}
