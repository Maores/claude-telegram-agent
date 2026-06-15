/**
 * monitor.ts — CLI the bot calls (via Bash) to manage secure monitors (E2).
 *
 *   bun run monitor.ts add    --name "..." --type webpage|threshold --url "https://..."
 *                             [--interval 15m] [--on-fire notify|summarize]
 *                             [--keyword "..."] [--selector "..."]
 *                             [--op lt|gt|cross --value N] [--json-path a.b.c] [--regex "..."]
 *   bun run monitor.ts list
 *   bun run monitor.ts show   <id>
 *   bun run monitor.ts pause  <id>
 *   bun run monitor.ts resume <id>
 *   bun run monitor.ts remove <id>
 *   bun run monitor.ts check  <id>     (dry-run one check now; sends nothing)
 *
 * Creation runs without a confirm tap (benign GET-only checks). [AUTO] sessions
 * are blocked from `monitor.ts add` by guard.ts (self-replication guard).
 */
import { getDb } from "./db";
import { parseFlags } from "./mem";
import {
  addMonitor, listMonitors, getMonitor, setStatus, removeMonitor, performCheck,
  MonitorError, type Monitor, type MonitorType, type OnFire, type MonitorConfig, type ThresholdOp,
} from "./monitors";

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** "15m" / "2h" / "90s" / "900" -> seconds. Defaults to 900 (15 min). */
function parseInterval(s: string | undefined): number {
  if (!s) return 900;
  const m = String(s).match(/^(\d+)\s*([smh]?)$/);
  if (!m) return 900;
  const n = Number(m[1]);
  return m[2] === "m" ? n * 60 : m[2] === "h" ? n * 3600 : n;
}

function fmt(m: Monitor): string {
  return `[${m.id}] ${m.name} (${m.type}/${m.status}/${m.on_fire}) every ${m.interval_s}s — ${m.url}`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) die("usage: monitor.ts <add|list|show|pause|resume|remove|check> ...");
  const db = getDb();
  const f = parseFlags(rest);
  const id = () => String(f._[0] ?? "");

  try {
    switch (cmd) {
      case "add": {
        const config: MonitorConfig = {};
        if (typeof f.keyword === "string") config.keyword = f.keyword;
        if (typeof f.selector === "string") config.selector = f.selector;
        if (typeof f["json-path"] === "string") config.jsonPath = f["json-path"] as string;
        if (typeof f.regex === "string") config.regex = f.regex;
        if (typeof f.op === "string") config.op = f.op as ThresholdOp;
        if (f.value !== undefined) config.value = Number(f.value);
        const m = addMonitor(db, {
          chatId: Number(process.env.TELEGRAM_CHAT_ID ?? f.chat ?? 0),
          name: String(f.name ?? ""),
          type: String(f.type ?? "") as MonitorType,
          url: String(f.url ?? ""),
          config,
          intervalS: parseInterval(typeof f.interval === "string" ? f.interval : undefined),
          onFire: (typeof f["on-fire"] === "string" ? f["on-fire"] : "notify") as OnFire,
        });
        console.log("OK created " + fmt(m));
        break;
      }
      case "list": {
        const rows = listMonitors(db);
        if (!rows.length) { console.log("(no monitors)"); break; }
        for (const m of rows) console.log(fmt(m));
        break;
      }
      case "show": {
        const m = getMonitor(db, id());
        if (!m) die("no monitor with that id");
        console.log(
          fmt(m) +
            `\n  config: ${JSON.stringify(m.config)}` +
            `\n  last_checked: ${m.last_checked_ts ?? "never"}  last_value: ${m.last_value ?? "-"}` +
            `  last_state: ${m.last_state ?? "-"}  failures: ${m.consecutive_failures}`,
        );
        break;
      }
      case "pause": { setStatus(db, id(), "paused"); console.log("paused " + id()); break; }
      case "resume": { setStatus(db, id(), "active"); console.log("resumed " + id()); break; }
      case "remove": { removeMonitor(db, id()); console.log("removed " + id()); break; }
      case "check": {
        const m = getMonitor(db, id());
        if (!m) die("no monitor with that id");
        const o = await performCheck(m);
        if (!o.ok) console.log(`check failed: ${o.error}`);
        else if (o.kind === "webpage") console.log(`ok — content hash ${o.newValue?.slice(0, 12)}… — would fire: ${o.fired}`);
        else console.log(`ok — value ${o.value} — would fire: ${o.fired}`);
        break;
      }
      default:
        die("unknown command: " + cmd);
    }
  } catch (e) {
    if (e instanceof MonitorError) die(e.message);
    throw e;
  }
}

if (import.meta.main) main();
