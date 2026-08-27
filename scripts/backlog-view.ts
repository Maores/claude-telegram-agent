#!/usr/bin/env bun
/**
 * backlog-view.ts — render docs/BACKLOG.md into docs/backlog-view.html.
 *
 * The ledger is the source of truth; this file only projects it. Nothing here
 * holds state, so the view can never disagree with the ledger the way a
 * hand-maintained page does (that duplication was the single biggest cost in the
 * DeskFlow backlog it is modelled on, and is deliberately not repeated).
 *
 * Run: bun run scripts/backlog-view.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "docs", "BACKLOG.md");
const OUT = join(ROOT, "docs", "backlog-view.html");

type Status = "proposed" | "approved" | "parked" | "shipped" | "closed";

/** Display order: what needs Maor first, history last. */
const ORDER: Status[] = ["proposed", "approved", "parked", "shipped", "closed"];

const LABEL: Record<Status, string> = {
  proposed: "דורש החלטה",
  approved: "מאושר",
  parked: "בהקפאה",
  shipped: "קיים",
  closed: "נסגר",
};

/** Statuses the page opens on. Open work only — never the full history. */
const OPEN_BY_DEFAULT: Status[] = ["proposed", "approved", "parked"];

export interface Row {
  id: string;
  item: string;
  status: Status;
  size: string;
  doneWhen: string;
  section: string;
  detail: string;
}

const isStatus = (s: string): s is Status =>
  (ORDER as string[]).includes(s);

/** Split a markdown table row into trimmed cells, dropping the outer pipes. */
function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

const isSeparatorRow = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line);

/**
 * Parse the ledger. Only content between the first `---` rule and the `# Detail`
 * heading counts as data, which keeps the explanatory tables in the header (the
 * status legend, the size legend) from being read as backlog rows.
 */
export function parseBacklog(md: string): { rows: Row[]; order: string } {
  const lines = md.split(/\r?\n/);

  let start = lines.findIndex((l) => l.trim() === "---");
  const detailAt = lines.findIndex((l) => /^#\s+Detail\s*$/.test(l));
  if (start === -1) start = 0;
  const end = detailAt === -1 ? lines.length : detailAt;

  // Detail blocks: `## <id>` under `# Detail`, body until the next `## `.
  const details = new Map<string, string>();
  if (detailAt !== -1) {
    let cur: string | null = null;
    let buf: string[] = [];
    for (const line of lines.slice(detailAt + 1)) {
      const h = line.match(/^##\s+(\S+)\s*$/);
      if (h) {
        if (cur) details.set(cur, buf.join("\n").trim());
        cur = h[1];
        buf = [];
      } else if (cur) buf.push(line);
    }
    if (cur) details.set(cur, buf.join("\n").trim());
  }

  const rows: Row[] = [];
  let section = "";
  for (let i = start; i < end; i++) {
    const line = lines[i];
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      section = h[1];
      continue;
    }
    if (!line.trim().startsWith("|") || isSeparatorRow(line)) continue;
    const c = cells(line);
    if (c.length < 5) continue;
    if (c[0].toLowerCase() === "id") continue; // header row
    if (!isStatus(c[2])) continue; // legend tables and anything malformed
    rows.push({
      id: c[0],
      item: c[1],
      status: c[2],
      size: c[3],
      doneWhen: c[4],
      section,
      detail: details.get(c[0]) ?? "",
    });
  }

  const orderBlock = md.match(/##\s+Order of work\s*\n([\s\S]*?)(?=\n---|\n##\s)/);
  return { rows, order: orderBlock ? orderBlock[1].trim() : "" };
}

/**
 * The order-of-work block is prose Maor writes. It drifts silently when an item
 * named there is later shipped or closed, so flag exactly that rather than
 * trusting it. This is the drift the source backlog had no guard for.
 */
export function staleOrderRefs(order: string, rows: Row[]): Row[] {
  return rows.filter(
    (r) =>
      order.includes(r.id) && (r.status === "shipped" || r.status === "closed"),
  );
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Minimal inline markdown: `code`, **bold**, *italic*. Escaped first. */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code class="ltr">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

/** Detail bodies are short prose; render blank-line-separated paragraphs. */
function paragraphs(body: string): string {
  if (!body.trim()) return "";
  return body
    .split(/\n\s*\n/)
    .map((p) => `<p>${inline(p.replace(/\n/g, " ").trim())}</p>`)
    .join("\n");
}

export function render(rows: Row[], order: string, generatedAt: string): string {
  const counts = ORDER.map((s) => ({
    status: s,
    n: rows.filter((r) => r.status === s).length,
  }));
  const stale = staleOrderRefs(order, rows);

  const sorted = [...rows].sort(
    (a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status),
  );

  const chips = counts
    .map(
      ({ status, n }) =>
        `<button class="chip${OPEN_BY_DEFAULT.includes(status) ? " on" : ""}" data-status="${status}">` +
        `${LABEL[status]} <span class="n">${n}</span></button>`,
    )
    .join("\n      ");

  const cards = sorted
    .map(
      (r) => `      <article class="card" data-status="${r.status}">
        <header>
          <span class="badge s-${r.status}">${LABEL[r.status]}</span>
          <span class="sec">${esc(r.section)}</span>
          <span class="size" title="גודל">${esc(r.size)}</span>
          <code class="id ltr">${esc(r.id)}</code>
        </header>
        <h3>${inline(r.item)}</h3>
        <p class="done"><span class="k">נדע שזה נגמר כש</span>${inline(r.doneWhen)}</p>
        ${r.detail ? `<details><summary>רקע והיסטוריה</summary><div class="body">${paragraphs(r.detail)}</div></details>` : ""}
      </article>`,
    )
    .join("\n");

  const openCount = rows.filter((r) => OPEN_BY_DEFAULT.includes(r.status)).length;

  return `<!doctype html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>בקלוג — סוכן הטלגרם</title>
<style>
  :root {
    --bg: #f7f7f5; --fg: #1b1b19; --muted: #6b6b66; --line: #e2e2dd;
    --card: #ffffff; --accent: #b45309;
    --s-proposed: #b45309; --s-approved: #15803d; --s-parked: #6b6b66;
    --s-shipped: #1d4ed8; --s-closed: #9a3412;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #161614; --fg: #ececE8; --muted: #9a9a93; --line: #2e2e2a;
      --card: #1e1e1b; --accent: #f59e0b;
      --s-proposed: #f59e0b; --s-approved: #4ade80; --s-parked: #9a9a93;
      --s-shipped: #60a5fa; --s-closed: #fb923c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
    font: 16px/1.65 "Segoe UI", system-ui, sans-serif;
  }
  .wrap { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  .sub { color: var(--muted); font-size: .875rem; margin: 0 0 1.5rem; }
  .ltr { direction: ltr; unicode-bidi: isolate; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: .8125em; }
  .bar { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
  .chip {
    font: inherit; font-size: .875rem; cursor: pointer; padding: .3rem .7rem;
    border: 1px solid var(--line); border-radius: 999px;
    background: transparent; color: var(--muted);
  }
  .chip.on { background: var(--fg); color: var(--bg); border-color: var(--fg); }
  .chip .n { opacity: .65; font-variant-numeric: tabular-nums; }
  .note {
    border: 1px solid var(--accent); border-radius: .5rem; padding: .75rem 1rem;
    margin-bottom: 1.5rem; font-size: .875rem;
  }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: .625rem;
    padding: 1rem 1.15rem; margin-bottom: .875rem;
  }
  .card header {
    display: flex; align-items: center; gap: .6rem; flex-wrap: wrap;
    font-size: .75rem; color: var(--muted); margin-bottom: .5rem;
  }
  .badge { font-weight: 600; }
  .s-proposed { color: var(--s-proposed); } .s-approved { color: var(--s-approved); }
  .s-parked { color: var(--s-parked); } .s-shipped { color: var(--s-shipped); }
  .s-closed { color: var(--s-closed); }
  .id { margin-inline-start: auto; opacity: .75; }
  .size { border: 1px solid var(--line); border-radius: .25rem; padding: 0 .35rem; }
  .card h3 { font-size: 1rem; font-weight: 600; margin: 0 0 .5rem; line-height: 1.5; }
  .done { font-size: .875rem; color: var(--muted); margin: 0; }
  .done .k { color: var(--fg); opacity: .8; font-weight: 600; margin-inline-end: .35rem; }
  details { margin-top: .75rem; }
  summary { cursor: pointer; font-size: .8125rem; color: var(--muted); }
  .body { font-size: .9375rem; padding-top: .5rem; }
  .body p { margin: 0 0 .75rem; }
  .empty { color: var(--muted); font-size: .9375rem; }
  footer { margin-top: 2.5rem; color: var(--muted); font-size: .8125rem; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>בקלוג — סוכן הטלגרם</h1>
    <p class="sub">${openCount} פריטים פתוחים מתוך ${rows.length}. הדף נפתח על מה שפתוח בלבד; ההיסטוריה מאחורי הצ׳יפים.</p>

    <div class="bar">
      ${chips}
    </div>
${
  stale.length
    ? `    <div class="note"><strong>סדר העבודה לא מעודכן.</strong> הפריטים האלה מופיעים בו אבל כבר לא פתוחים: ${stale
        .map((r) => `<code class="ltr">${esc(r.id)}</code>`)
        .join(", ")}</div>\n`
    : ""
}
    <div id="list">
${cards}
    </div>
    <p class="empty" id="empty" hidden>אין פריטים בסינון הזה.</p>

    <footer>
      נוצר מ־<code class="ltr">docs/BACKLOG.md</code> בתאריך ${esc(generatedAt)}.
      <br>אל תערוך את הדף הזה ידנית; ערוך את הבקלוג והרץ מחדש:
      <br><code class="ltr">bun run scripts/backlog-view.ts</code>
    </footer>
  </div>
<script>
  const chips = [...document.querySelectorAll(".chip")];
  const cards = [...document.querySelectorAll(".card")];
  const empty = document.getElementById("empty");
  function apply() {
    const on = new Set(chips.filter(c => c.classList.contains("on")).map(c => c.dataset.status));
    let shown = 0;
    for (const card of cards) {
      const vis = on.has(card.dataset.status);
      card.hidden = !vis;
      if (vis) shown++;
    }
    empty.hidden = shown !== 0;
  }
  for (const chip of chips) {
    chip.addEventListener("click", () => { chip.classList.toggle("on"); apply(); });
  }
  apply();
</script>
</body>
</html>
`;
}

if (import.meta.main) {
  const md = readFileSync(SRC, "utf8");
  const { rows, order } = parseBacklog(md);
  const stamp = new Date().toLocaleDateString("en-GB", { timeZone: "Asia/Jerusalem" });
  writeFileSync(OUT, render(rows, order, stamp), "utf8");
  const open = rows.filter((r) => OPEN_BY_DEFAULT.includes(r.status)).length;
  console.log(`backlog-view: ${rows.length} rows (${open} open) -> docs/backlog-view.html`);
  for (const s of ORDER) {
    const n = rows.filter((r) => r.status === s).length;
    if (n) console.log(`  ${s.padEnd(9)} ${n}`);
  }
  const stale = staleOrderRefs(order, rows);
  if (stale.length) console.log(`  WARNING: order-of-work names closed items: ${stale.map((r) => r.id).join(", ")}`);
}
