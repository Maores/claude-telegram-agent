import { test, expect } from "bun:test";
import {
  parseFilms,
  normalizeDate,
  filmPageUrl,
  flattenShowtimes,
  filterShowtimes,
  fmtShowtime,
  addDaysISO,
  todayISO,
  KIRYON_URL,
} from "./cinema.ts";

// Markup below mirrors the real seret.co.il page (fetched 2026-07-28): film
// blocks open with an <a name="m<MID>"> anchor, the title is the .TitGreen20
// link, each screening is a .stbox whose title attribute holds the DATE and
// whose .hour span holds the time. Whitespace is collapsed on the live page.
const FILM_A = `<a name="m8528"></a><div class="cardGray textGray14" title="שעות הקרנה של לגמור את הלילה בהוט סינמה קריון"><div><a href="s_movies.asp?MID=8528" class="TitGreen20" title="לעמוד הסרט לגמור את הלילה">לגמור את הלילה</a>  &nbsp;&nbsp; <div class="greynotice" title="החל להציג בארץ ב 6/8/2026">מתחיל רשמית בשבוע הבא (6/8/2026)</div></div><span class="vspace10"></span><div class="posterDsp"><div class="roundedges" title="ז'אנר">קומדיה</div></div><div><div class="dayline"><div class="dayname" title="x">ג</div><div class="dayhours"><div style="display:flex;"><div class="stbox" title="28/7/2026"><span class="hour">19:10</span> <span style="display:block;" title="אולם הקרנה">אולם 2</span></div> <div class="stbox" title="28/7/2026"><span class="hour">21:30</span> <span style="display:block;" title="אולם הקרנה">אולם 2</span></div></div></div></div></div></div>`;

const FILM_B = `<a name="m9001"></a><div class="cardGray textGray14" title="שעות הקרנה של ספיידרמן בהוט סינמה קריון"><div><a href="s_movies.asp?MID=9001" class="TitGreen20" title="לעמוד הסרט ספיידרמן">ספיידרמן &amp; חברים</a></div><div class="posterDsp"><div class="roundedges" title="ז'אנר">אקשן</div></div><div><div class="dayline"><div class="dayname" title="x">ד</div><div class="dayhours"><div class="stbox" title="29/7/2026"><span class="hour">11:00</span> <span style="display:block;" title="אולם הקרנה">אולם 7</span><span style="display:block;" title="זמן סיום משוער">צפי סיום: 13:40</span></div></div></div><div class="dayline"><div class="dayname" title="x">ה</div><div class="dayhours"><div class="stbox" title="30/7/2026"><span class="hour">9:05</span> <span style="display:block;" title="אולם הקרנה">אולם 1</span></div></div></div></div></div>`;

const PAGE = `<html><head><title>הוט סינמה קריון</title></head><body>${FILM_A}${FILM_B}</body></html>`;

// --- normalizeDate: the page writes D/M/YYYY, we store YYYY-MM-DD ------------

test("normalizeDate pads single-digit days and months", () => {
  expect(normalizeDate("28/7/2026")).toBe("2026-07-28");
  expect(normalizeDate("1/12/2026")).toBe("2026-12-01");
  expect(normalizeDate("30/11/2026")).toBe("2026-11-30");
});

test("normalizeDate returns null for anything that isn't a date", () => {
  expect(normalizeDate("אולם 2")).toBeNull();
  expect(normalizeDate("")).toBeNull();
  expect(normalizeDate("28/7")).toBeNull();
});

// --- parseFilms: the actual scrape ------------------------------------------

test("parseFilms reads every film on the page with its id and title", () => {
  const films = parseFilms(PAGE);
  expect(films.length).toBe(2);
  expect(films[0].mid).toBe("8528");
  expect(films[0].title).toBe("לגמור את הלילה");
  expect(films[1].mid).toBe("9001");
});

test("parseFilms decodes HTML entities in the title", () => {
  const films = parseFilms(PAGE);
  expect(films[1].title).toBe("ספיידרמן & חברים");
});

test("parseFilms reads the genre and the not-yet-released notice", () => {
  const films = parseFilms(PAGE);
  expect(films[0].genre).toBe("קומדיה");
  expect(films[0].notice).toContain("מתחיל רשמית");
  expect(films[1].genre).toBe("אקשן");
  expect(films[1].notice).toBeUndefined();
});

test("parseFilms reads each screening's date, time, and hall", () => {
  const [a] = parseFilms(PAGE);
  expect(a.showtimes).toEqual([
    { date: "2026-07-28", time: "19:10", hall: "אולם 2" },
    { date: "2026-07-28", time: "21:30", hall: "אולם 2" },
  ]);
});

test("parseFilms keeps screenings across several day rows and pads the hour", () => {
  const b = parseFilms(PAGE)[1];
  expect(b.showtimes).toEqual([
    { date: "2026-07-29", time: "11:00", hall: "אולם 7" },
    { date: "2026-07-30", time: "09:05", hall: "אולם 1" }, // page writes 9:05
  ]);
});

test("parseFilms never bleeds one film's screenings into the next", () => {
  const films = parseFilms(PAGE);
  expect(films[0].showtimes.every((s) => s.date === "2026-07-28")).toBe(true);
  expect(films[1].showtimes.length).toBe(2);
});

test("parseFilms returns an empty list for junk or an error page", () => {
  expect(parseFilms("")).toEqual([]);
  expect(parseFilms("<html><body>403 Forbidden</body></html>")).toEqual([]);
});

// --- links -------------------------------------------------------------------

test("filmPageUrl builds an absolute seret.co.il film link", () => {
  expect(filmPageUrl("8528")).toBe("https://www.seret.co.il/movies/s_movies.asp?MID=8528");
});

test("KIRYON_URL points at the Kiryon theatre page (TID 50, verified 2026-07-28)", () => {
  expect(KIRYON_URL).toBe("https://www.seret.co.il/movies/s_theatres.asp?TID=50");
});

// --- flatten + filter ---------------------------------------------------------

test("flattenShowtimes sorts every screening chronologically across films", () => {
  const rows = flattenShowtimes(parseFilms(PAGE));
  expect(rows.map((r) => `${r.date} ${r.time}`)).toEqual([
    "2026-07-28 19:10",
    "2026-07-28 21:30",
    "2026-07-29 11:00",
    "2026-07-30 09:05",
  ]);
  expect(rows[0].title).toBe("לגמור את הלילה");
});

test("filterShowtimes keeps a single requested day", () => {
  const rows = filterShowtimes(flattenShowtimes(parseFilms(PAGE)), { from: "2026-07-29", to: "2026-07-29" });
  expect(rows.length).toBe(1);
  expect(rows[0].time).toBe("11:00");
});

test("filterShowtimes keeps an inclusive date range", () => {
  const rows = filterShowtimes(flattenShowtimes(parseFilms(PAGE)), { from: "2026-07-28", to: "2026-07-29" });
  expect(rows.length).toBe(3);
});

test("filterShowtimes matches a title substring, case-insensitively", () => {
  const all = flattenShowtimes(parseFilms(PAGE));
  expect(filterShowtimes(all, { q: "ספיידרמן" }).length).toBe(2);
  expect(filterShowtimes(all, { q: "לגמור" }).length).toBe(2);
  expect(filterShowtimes(all, { q: "אין כזה סרט" }).length).toBe(0);
});

test("filterShowtimes combines a date range with a title query", () => {
  const all = flattenShowtimes(parseFilms(PAGE));
  const rows = filterShowtimes(all, { from: "2026-07-30", to: "2026-07-30", q: "ספיידרמן" });
  expect(rows.length).toBe(1);
  expect(rows[0].time).toBe("09:05");
});

// --- date helpers (pure, so tests don't depend on the runner's clock/TZ) ------

test("todayISO formats a given date as YYYY-MM-DD in local time", () => {
  expect(todayISO(new Date(2026, 6, 28, 23, 30))).toBe("2026-07-28");
  expect(todayISO(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
});

test("addDaysISO walks the calendar, including across a month end", () => {
  expect(addDaysISO("2026-07-28", 0)).toBe("2026-07-28");
  expect(addDaysISO("2026-07-28", 3)).toBe("2026-07-31");
  expect(addDaysISO("2026-07-30", 3)).toBe("2026-08-02");
  expect(addDaysISO("2026-12-31", 1)).toBe("2027-01-01");
});

// --- output formatting --------------------------------------------------------

// Day abbreviations follow calendar.ts fmtEvent so both listings read alike.
// 2026-07-28 is a Tuesday (the live page labelled it יום שלישי).
test("fmtShowtime matches the repo's list style (cal.ts fmtEvent)", () => {
  const rows = flattenShowtimes(parseFilms(PAGE));
  expect(fmtShowtime(rows[0])).toBe("Tue 28/07 19:10 — לגמור את הלילה (אולם 2)");
});

test("fmtShowtime omits the hall when the page didn't give one", () => {
  const row = { date: "2026-07-30", time: "19:10", title: "סרט", mid: "1" };
  expect(fmtShowtime(row)).toBe("Thu 30/07 19:10 — סרט");
});
