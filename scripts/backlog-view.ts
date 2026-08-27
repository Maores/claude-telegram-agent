#!/usr/bin/env bun
/**
 * backlog-view.ts — render docs/BACKLOG.md into docs/backlog-view.html.
 *
 * The ledger is the source of truth; this file only projects it. Nothing here
 * holds state, so the view can never disagree with the ledger the way a
 * hand-maintained page does (that duplication was the single biggest cost in the
 * sibling project's backlog, and is deliberately not repeated).
 *
 * Run: bun run scripts/backlog-view.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SRC = join(ROOT, "docs", "BACKLOG.md");
const OUT = join(ROOT, "docs", "backlog-view.html");

/** Ledger tokens are Hebrew, matching the file Maor reads and edits. */
export type Status = "החלטה" | "מאושר" | "הקפאה" | "קיים" | "נסגר";

/** Display order: what needs him first, history last. */
const ORDER: Status[] = ["החלטה", "מאושר", "הקפאה", "קיים", "נסגר"];

const LABEL: Record<Status, string> = {
  החלטה: "דורש החלטה",
  מאושר: "מאושר",
  הקפאה: "בהקפאה",
  קיים: "קיים",
  נסגר: "נסגר",
};

/** Statuses the page opens on. Open work only — never the full history. */
const OPEN_BY_DEFAULT: Status[] = ["החלטה", "מאושר", "הקפאה"];

/** Octicon-style marks, one stroke language, drawn rather than borrowed glyphs. */
const ICON: Record<Status, string> = {
  החלטה:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/>',
  מאושר:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.2 8.2 7.1 10.1 10.9 6.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  הקפאה:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.4 5.6v4.8M9.6 5.6v4.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  קיים:
    '<circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.9 8.2 7 10.3 11.1 6" fill="none" stroke="var(--canvas)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  נסגר:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

export interface Row {
  id: string;
  item: string;
  status: Status;
  size: string;
  doneWhen: string;
  section: string;
  detail: string;
}

const isStatus = (s: string): s is Status => (ORDER as string[]).includes(s);

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
 * Parse the ledger. Only content between the first `---` rule and the `# פירוט`
 * heading counts as data, which keeps the explanatory tables in the header (the
 * status legend, the size legend) from being read as backlog rows.
 */
export function parseBacklog(md: string): { rows: Row[]; order: string } {
  const lines = md.split(/\r?\n/);

  let start = lines.findIndex((l) => l.trim() === "---");
  const detailAt = lines.findIndex((l) => /^#\s+פירוט\s*$/.test(l));
  if (start === -1) start = 0;
  const end = detailAt === -1 ? lines.length : detailAt;

  // Detail blocks: `## <id>` under `# פירוט`, body until the next `## `.
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
    if (c[0] === "מזהה") continue; // header row
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

  const orderBlock = md.match(/##\s+סדר עבודה\s*\n([\s\S]*?)(?=\n---|\n##\s)/);
  return { rows, order: orderBlock ? orderBlock[1].trim() : "" };
}

/**
 * The order-of-work block is prose Maor writes. It drifts silently when an item
 * named there is later finished or dropped, so flag exactly that rather than
 * trusting it. The sibling backlog had no guard for this drift.
 */
export function staleOrderRefs(order: string, rows: Row[]): Row[] {
  return rows.filter(
    (r) => order.includes(r.id) && (r.status === "קיים" || r.status === "נסגר"),
  );
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Minimal inline markdown: `code`, **bold**. Escaped first. */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code class="ltr">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/**
 * Detail bodies read as a timeline: the first `**מקור:**` / `**למה:**` pair is
 * the opening note, and each later paragraph is an entry beneath it.
 */
function timeline(body: string): string {
  if (!body.trim()) return "";
  const paras = body.split(/\n\s*\n/).map((p) => p.replace(/\n/g, " ").trim()).filter(Boolean);
  return paras.map((p) => `<p>${inline(p)}</p>`).join("\n");
}

export function render(rows: Row[], order: string, generatedAt: string): string {
  const counts = ORDER.map((s) => ({ status: s, n: rows.filter((r) => r.status === s).length }));
  const stale = staleOrderRefs(order, rows);
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const openCount = rows.filter((r) => OPEN_BY_DEFAULT.includes(r.status)).length;

  const filters = counts
    .map(
      ({ status, n }) =>
        `<button class="filter${OPEN_BY_DEFAULT.includes(status) ? " on" : ""}" data-status="${status}" aria-pressed="${OPEN_BY_DEFAULT.includes(status)}">` +
        `<svg class="ico st-${statusKey(status)}" viewBox="0 0 16 16" aria-hidden="true">${ICON[status]}</svg>` +
        `<span>${LABEL[status]}</span><span class="ct">${n}</span></button>`,
    )
    .join("\n        ");

  const items = sorted
    .map(
      (r) => `        <li class="row" data-status="${r.status}">
          <svg class="ico st-${statusKey(r.status)}" viewBox="0 0 16 16" aria-hidden="true">${ICON[r.status]}</svg>
          <div class="body">
            <h3>${inline(r.item)}</h3>
            <p class="meta">
              <code class="ltr">${esc(r.id)}</code>
              <span class="sep">·</span><span>${esc(r.section)}</span>
              <span class="sep">·</span><span>גודל ${esc(r.size)}</span>
              <span class="lbl st-${statusKey(r.status)}">${LABEL[r.status]}</span>
            </p>
            <p class="when"><span class="k">נדע שזה נגמר כש</span>${inline(r.doneWhen)}</p>
            ${r.detail ? `<details><summary>רקע והיסטוריה</summary><div class="note">${timeline(r.detail)}</div></details>` : ""}
          </div>
        </li>`,
    )
    .join("\n");

  return `<!doctype html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>בקלוג · סוכן הטלגרם</title>
<style>
  :root {
    --canvas: #ffffff;
    --subtle: #f6f8fa;
    --fg: #1f2328;
    --muted: #59636e;
    --border: #d1d9e0;
    --accent: #0969da;
    --attention: #9a6700;
    --attention-bg: #fff8c5;
    --success: #1a7f37;
    --success-bg: #dafbe1;
    --done: #8250df;
    --done-bg: #fbefff;
    --neutral: #59636e;
    --neutral-bg: #eff2f5;
    --danger: #cf222e;
    --danger-bg: #ffebe9;
    --shadow: 0 1px 3px rgba(31, 35, 40, .08), 0 1px 2px rgba(31, 35, 40, .04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --canvas: #0d1117;
      --subtle: #151b23;
      --fg: #f0f6fc;
      --muted: #9198a1;
      --border: #3d444d;
      --accent: #4493f8;
      --attention: #d29922;
      --attention-bg: #2b2412;
      --success: #3fb950;
      --success-bg: #12261a;
      --done: #ab7df8;
      --done-bg: #21172f;
      --neutral: #9198a1;
      --neutral-bg: #1c2129;
      --danger: #f85149;
      --danger-bg: #2b1618;
      --shadow: 0 1px 3px rgba(1, 4, 9, .5);
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; background: var(--canvas); color: var(--fg);
    font: 14px/1.6 "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 62rem; margin: 0 auto; padding: 2.5rem 1.5rem 5rem; }
  .ltr { direction: ltr; unicode-bidi: isolate; }
  code { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 11.5px; }

  header.top { padding-bottom: 1rem; border-bottom: 1px solid var(--border); margin-bottom: 1.25rem; }
  header.top h1 { margin: 0 0 .25rem; font-size: 1.375rem; font-weight: 600; letter-spacing: -.01em; }
  header.top p { margin: 0; color: var(--muted); font-size: .875rem; }

  .listbox { border: 1px solid var(--border); border-radius: 6px; overflow: hidden; background: var(--canvas); }
  .listhead {
    display: flex; flex-wrap: wrap; gap: .375rem; align-items: center;
    background: var(--subtle); border-bottom: 1px solid var(--border);
    padding: .625rem .875rem;
  }
  .filter {
    display: inline-flex; align-items: center; gap: .375rem;
    font: inherit; font-size: .8125rem; cursor: pointer;
    background: transparent; color: var(--muted);
    border: 1px solid transparent; border-radius: 6px; padding: .25rem .5rem;
  }
  .filter:hover { background: var(--canvas); color: var(--fg); }
  .filter.on { color: var(--fg); font-weight: 600; background: var(--canvas); border-color: var(--border); }
  .filter:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .filter .ct { font-variant-numeric: tabular-nums; opacity: .8; }
  .ico { width: 16px; height: 16px; flex: none; }
  .st-decide { color: var(--attention); }
  .st-approved { color: var(--success); }
  .st-parked { color: var(--neutral); }
  .st-exists { color: var(--done); }
  .st-closed { color: var(--danger); }

  ul.rows { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; gap: .75rem; padding: .875rem; border-bottom: 1px solid var(--border); }
  .row:last-child { border-bottom: 0; }
  .row:hover { background: var(--subtle); }
  .row > .ico { margin-top: .2rem; }
  .row .body { min-width: 0; flex: 1; }
  .row h3 {
    margin: 0 0 .25rem; font-size: 1rem; font-weight: 600; line-height: 1.5;
    max-width: 68ch;
  }
  .meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: .375rem;
    margin: 0 0 .5rem; font-size: .75rem; color: var(--muted);
  }
  .meta .sep { opacity: .55; }
  .lbl {
    margin-inline-start: auto; font-size: .6875rem; font-weight: 600;
    border-radius: 999px; padding: .0625rem .5rem; white-space: nowrap;
  }
  .lbl.st-decide { background: var(--attention-bg); }
  .lbl.st-approved { background: var(--success-bg); }
  .lbl.st-parked { background: var(--neutral-bg); }
  .lbl.st-exists { background: var(--done-bg); }
  .lbl.st-closed { background: var(--danger-bg); }
  .when { margin: 0; font-size: .8125rem; color: var(--muted); max-width: 72ch; }
  .when .k { color: var(--fg); font-weight: 600; margin-inline-end: .3rem; }

  details { margin-top: .625rem; }
  summary {
    display: inline-block; cursor: pointer; font-size: .75rem; color: var(--accent);
    padding: .125rem .375rem; margin-inline-start: -.375rem; border-radius: 4px;
  }
  summary:hover { background: var(--subtle); }
  summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .note {
    margin-top: .5rem; border: 1px solid var(--border); border-radius: 6px;
    background: var(--subtle); padding: .75rem .875rem; font-size: .8125rem;
    max-width: 74ch;
  }
  .note p { margin: 0 0 .625rem; }
  .note p:last-child { margin-bottom: 0; }

  .banner {
    display: flex; gap: .625rem; align-items: flex-start;
    border: 1px solid var(--attention); background: var(--attention-bg);
    color: var(--fg); border-radius: 6px; padding: .75rem .875rem;
    margin-bottom: 1rem; font-size: .8125rem;
  }
  .banner .ico { color: var(--attention); margin-top: .1rem; }

  .blank { padding: 3rem 1rem; text-align: center; color: var(--muted); font-size: .875rem; }
  footer { margin-top: 1.25rem; color: var(--muted); font-size: .75rem; line-height: 1.8; }
</style>
</head>
<body>
  <div class="page">
    <header class="top">
      <h1>בקלוג · סוכן הטלגרם</h1>
      <p>${openCount} פריטים פתוחים מתוך ${rows.length}. הדף נפתח על מה שפתוח בלבד; ההיסטוריה מאחורי המסננים.</p>
    </header>
${
  stale.length
    ? `    <div class="banner">
      <svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14H1L8 1.5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="currentColor"/></svg>
      <span><strong>סדר העבודה לא מעודכן.</strong> הפריטים האלה מופיעים בו אבל כבר לא פתוחים: ${stale
        .map((r) => `<code class="ltr">${esc(r.id)}</code>`)
        .join(", ")}</span>
    </div>\n`
    : ""
}
    <div class="listbox">
      <div class="listhead">
        ${filters}
      </div>
      <ul class="rows">
${items}
      </ul>
      <p class="blank" id="blank" hidden>אין פריטים במסננים שנבחרו.</p>
    </div>

    <footer>
      נוצר מהקובץ <code class="ltr">docs/BACKLOG.md</code> בתאריך ${esc(generatedAt)}.
      אל תערוך את הדף הזה ידנית; ערוך את הבקלוג והרץ מחדש:
      <br><code class="ltr">bun run scripts/backlog-view.ts</code>
    </footer>
  </div>
<script>
  const filters = [...document.querySelectorAll(".filter")];
  const rows = [...document.querySelectorAll(".row")];
  const blank = document.getElementById("blank");
  function apply() {
    const on = new Set(filters.filter(f => f.classList.contains("on")).map(f => f.dataset.status));
    let shown = 0;
    for (const row of rows) {
      const vis = on.has(row.dataset.status);
      row.hidden = !vis;
      if (vis) shown++;
    }
    blank.hidden = shown !== 0;
  }
  for (const f of filters) {
    f.addEventListener("click", () => {
      f.classList.toggle("on");
      f.setAttribute("aria-pressed", String(f.classList.contains("on")));
      apply();
    });
  }
  apply();
</script>
</body>
</html>
`;
}

/** Stable ASCII class suffix per status, so CSS never carries Hebrew selectors. */
function statusKey(s: Status): string {
  return { החלטה: "decide", מאושר: "approved", הקפאה: "parked", קיים: "exists", נסגר: "closed" }[s];
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
    if (n) console.log(`  ${LABEL[s]}: ${n}`);
  }
  const stale = staleOrderRefs(order, rows);
  if (stale.length) console.log(`  WARNING: order-of-work names finished items: ${stale.map((r) => r.id).join(", ")}`);
}
