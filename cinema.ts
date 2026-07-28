/**
 * cinema.ts — what's playing at Hot Cinema Kiryon, read from seret.co.il.
 *   bun run cinema.ts showtimes [--date YYYY-MM-DD] [--days N] [--q "<title substr>"]
 *   bun run cinema.ts films
 *
 * READ-ONLY BY DESIGN. This lists screenings and links the film page; Maor books
 * in the Hot Cinema app himself. Automating the booking was considered and
 * dropped on 2026-07-28: hotcinema.co.il answers this server with a 403 (its bot
 * protection), so booking would mean working around that and building
 * cart-plus-seat-lock automation, which is the same primitive ticket bots use.
 * Listing a public schedule page needs none of that.
 *
 * Turning a screening into a calendar event goes through the normal confirm.ts
 * flow, and "tell me when <film> shows up" is a monitor.ts webpage monitor on
 * KIRYON_URL with --keyword. Neither needs anything from this file beyond the
 * listing.
 */
import { safeFetch } from "./net.ts";

/** Kiryon's theatre id on seret.co.il. Verified 2026-07-28: the page names
 *  קריון / הוט סינמה throughout and returns 200. */
export const KIRYON_URL = "https://www.seret.co.il/movies/s_theatres.asp?TID=50";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface Showtime {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  hall?: string;
}
export interface Film {
  mid: string;
  title: string;
  genre?: string;
  notice?: string; // e.g. "מתחיל רשמית בשבוע הבא (6/8/2026)"
  showtimes: Showtime[];
}
export type Screening = Showtime & { title: string; mid: string };

const pad = (n: number | string) => String(n).padStart(2, "0");

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

const clean = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** The page writes screening dates as D/M/YYYY in a title attribute. */
export function normalizeDate(raw: string): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(raw ?? "");
  if (!m) return null;
  return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
}

export function filmPageUrl(mid: string): string {
  return `https://www.seret.co.il/movies/s_movies.asp?MID=${mid}`;
}

/** YYYY-MM-DD for a Date, in local time (the droplet runs Asia/Jerusalem). */
export function todayISO(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Calendar-correct day arithmetic on a YYYY-MM-DD string, done in UTC so it
 *  never shifts across a DST boundary. */
export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Scrape the theatre page. Each film opens with an `<a name="m<MID>">` anchor,
 * so the page splits cleanly into per-film blocks; inside a block the title is
 * the `.TitGreen20` link and every screening is a `.stbox` whose title
 * attribute carries the date and whose `.hour` span carries the time.
 * Structure verified against the live page on 2026-07-28.
 */
export function parseFilms(html: string): Film[] {
  const anchors = [...(html ?? "").matchAll(/<a\s+name="m(\d+)"\s*>\s*<\/a>/gi)];
  const films: Film[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const mid = anchors[i][1];
    const start = anchors[i].index! + anchors[i][0].length;
    const end = i + 1 < anchors.length ? anchors[i + 1].index! : html.length;
    const block = html.slice(start, end);

    const title = clean(/class="TitGreen20"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? "");
    if (!title) continue;

    const genre = clean(/class="roundedges"[^>]*>([^<]*)</i.exec(block)?.[1] ?? "");
    const notice = clean(/class="greynotice"[^>]*>([^<]*)</i.exec(block)?.[1] ?? "");

    const showtimes: Showtime[] = [];
    // A .stbox holds only spans, so the first </div> really does close it.
    for (const box of block.matchAll(/<div class="stbox"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/div>/gi)) {
      const date = normalizeDate(box[1]);
      const rawTime = /class="hour"[^>]*>([^<]*)</i.exec(box[2])?.[1]?.trim() ?? "";
      const t = /^(\d{1,2}):(\d{2})$/.exec(rawTime);
      if (!date || !t) continue;
      const hall = clean(/title="אולם הקרנה"[^>]*>([^<]*)</i.exec(box[2])?.[1] ?? "");
      showtimes.push({ date, time: `${pad(t[1])}:${t[2]}`, ...(hall ? { hall } : {}) });
    }

    films.push({
      mid,
      title,
      ...(genre ? { genre } : {}),
      ...(notice ? { notice } : {}),
      showtimes,
    });
  }
  return films;
}

/** One flat, chronologically sorted list of screenings across all films. */
export function flattenShowtimes(films: Film[]): Screening[] {
  const rows = films.flatMap((f) => f.showtimes.map((s) => ({ ...s, title: f.title, mid: f.mid })));
  return rows.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

export function filterShowtimes(
  rows: Screening[],
  opts: { from?: string; to?: string; q?: string },
): Screening[] {
  const q = opts.q?.trim().toLowerCase();
  return rows.filter((r) => {
    if (opts.from && r.date < opts.from) return false;
    if (opts.to && r.date > opts.to) return false;
    if (q && !r.title.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Same shape as calendar.ts fmtEvent, so both listings read alike. */
export function fmtShowtime(r: Screening): string {
  const d = new Date(`${r.date}T00:00:00Z`);
  const day = `${DAYS[d.getUTCDay()]} ${r.date.slice(8, 10)}/${r.date.slice(5, 7)}`;
  return `${day} ${r.time} — ${r.title}${r.hall ? ` (${r.hall})` : ""}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
const str = (v: string | boolean | undefined): string | undefined => (typeof v === "string" ? v : undefined);

async function loadFilms(): Promise<Film[]> {
  const res = await safeFetch(KIRYON_URL);
  if (!res.ok) throw new Error(`could not fetch the Kiryon schedule: ${res.error}`);
  const films = parseFilms(res.text);
  if (!films.length) throw new Error("fetched the page but found no films — the site's layout may have changed");
  return films;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  if (cmd === "films") {
    const films = await loadFilms();
    for (const f of films) {
      const bits = [f.genre, f.notice, `${f.showtimes.length} screening(s)`].filter(Boolean);
      console.log(`${f.title} — ${bits.join(", ")}`);
      console.log(`  ${filmPageUrl(f.mid)}`);
    }
    console.log(`source: ${KIRYON_URL}`);
    return;
  }

  if (cmd === "showtimes") {
    const from = str(flags.date) ?? todayISO();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error("--date must be YYYY-MM-DD");
    const days = Math.max(1, Number(str(flags.days) ?? 1) || 1);
    const to = addDaysISO(from, days - 1);
    const q = str(flags.q);

    const rows = filterShowtimes(flattenShowtimes(await loadFilms()), { from, to, q });
    if (!rows.length) {
      const what = q ? `"${q}" ` : "";
      console.log(`(no ${what}screenings at Kiryon between ${from} and ${to})`);
    } else {
      for (const r of rows) console.log(fmtShowtime(r));
    }
    console.log(`source: ${KIRYON_URL}`);
    return;
  }

  console.log(
    [
      "usage:",
      "  bun run cinema.ts showtimes [--date YYYY-MM-DD] [--days N] [--q \"<title substr>\"]",
      "  bun run cinema.ts films",
      "",
      "Booking is not automated: open the Hot Cinema app to buy.",
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e?.message ?? String(e));
    process.exit(1);
  });
}
