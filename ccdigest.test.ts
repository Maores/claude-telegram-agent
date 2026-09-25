import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry, Journal, JournalDay } from "./ccjournal";
import {
  hebrewDate,
  quietNight,
  calendarSweep,
  initialDigestState,
  shouldRunDigest,
  canonical,
  entryKey,
  isAmendment,
  amendmentTarget,
  selectPending,
  loadDigestState,
  saveDigestState,
  markSent,
  isPaused,
  parseJournal,
  loadJournal,
  type DigestState,
} from "./ccdigest";

// All fixtures are synthetic: they copy the shapes of the owner's log, never its content.

const at = (iso: string) => new Date(iso);
const E = (time: string, text: string, links: string[] = [], notes?: string[]): Entry =>
  notes ? { time, text, links, notes } : { time, text, links };
const J = (days: JournalDay[], pushedAt = 1_790_000_000, sanitizer = 1): Journal => ({ v: 1, sanitizer, pushedAt, days });
const fresh = (since = "2026-09-24"): DigestState => initialDigestState(since);
const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ccdigest-"));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

// --- Hebrew calendar and schedule ----------------------------------------------------------

test("hebrewDate reads the Hebrew calendar, leap-year Adar included", () => {
  expect(hebrewDate("2026-09-26")).toEqual({ month: "Tishri", day: 15 });
  expect(hebrewDate("2027-04-22")).toEqual({ month: "Nisan", day: 15 });
  expect(hebrewDate("2027-03-01")).toEqual({ month: "Adar I", day: 22 });
});

test("quietNight: 21:30 inside Shabbat or a Yom Tov is quiet, Motzei Shabbat and Chol HaMoed are not", () => {
  const table: [string, boolean][] = [
    ["2026-09-11", true], // Friday, erev Rosh Hashanah
    ["2026-09-12", true], // Rosh Hashanah 1, the second day follows
    ["2026-09-13", false], // Rosh Hashanah 2 ends; Monday is a workday
    ["2026-09-20", true], // erev Yom Kippur
    ["2026-09-21", false], // after Yom Kippur
    ["2026-09-24", false], // ordinary Thursday
    ["2026-09-25", true], // Friday, erev Sukkot
    ["2026-09-26", false], // Motzei Shabbat and Sukkot day 1
    ["2026-09-27", false], // Chol HaMoed
    ["2026-10-02", true], // Friday, erev Shemini Atzeret
    ["2026-10-03", false], // after Shemini Atzeret
    ["2027-04-21", true], // erev Pesach
    ["2027-04-22", false], // Pesach day 1 ends; Friday 16 Nisan is Chol HaMoed
    ["2027-04-27", true], // erev the seventh day of Pesach
    ["2027-06-10", true], // erev Shavuot
    ["2027-06-11", true], // Shavuot falls on a Friday, so that night is Shabbat
    ["2027-06-12", false], // Motzei Shabbat
  ];
  for (const [date, quiet] of table) expect({ date, ...quietNight(date) }).toEqual({ date, quiet, calendarOk: true });
});

test("quietNight fails quiet when the Hebrew calendar cannot be read, and the sweep finds no such night", () => {
  expect(quietNight("2026-09-24", () => null)).toEqual({ quiet: true, calendarOk: false });
  expect(quietNight("2026-09-25", () => null)).toEqual({ quiet: true, calendarOk: true }); // Shabbat settles it
  const sweep = calendarSweep("2026-09-25", 400);
  expect(sweep.checked).toBe(400);
  expect(sweep.unreadable).toBe(0);
  expect(sweep.quiet).toBeGreaterThan(57); // at least every Friday night
});

test("shouldRunDigest fires from 21:30 local until midnight, once per date", () => {
  const s = (over: Partial<DigestState> = {}): DigestState => ({ ...fresh(), ...over });
  expect(shouldRunDigest(at("2026-09-24T18:29:00Z"), s())).toBe(false); // 21:29
  expect(shouldRunDigest(at("2026-09-24T18:30:00Z"), s())).toBe(true); // 21:30
  expect(shouldRunDigest(at("2026-09-24T20:59:00Z"), s())).toBe(true); // 23:59
  expect(shouldRunDigest(at("2026-09-24T21:00:00Z"), s())).toBe(false); // 00:00, next date
  expect(shouldRunDigest(at("2026-09-24T19:00:00Z"), s({ lastRunDate: "2026-09-24" }))).toBe(false);
  expect(shouldRunDigest(at("2026-09-25T18:30:00Z"), s({ lastRunDate: "2026-09-24" }))).toBe(true);
});

test("initialDigestState counts from the given day and has never run", () => {
  expect(initialDigestState("2026-09-26")).toEqual({
    sent: {},
    lastRunDate: null,
    lastDigestAt: null,
    since: "2026-09-26",
    sanitizer: null,
    lastOutcome: null,
  });
});

// --- keys and amendments ---------------------------------------------------------------------

test("entryKey ignores spacing, punctuation, emphasis and code-span changes, not content", () => {
  const k = (text: string) => entryKey("2026-09-24", E("10:00", text));
  expect(k("Example: batch built on the branch, suite green.")).toBe(k("Example:  batch built on the `branch`,suite green"));
  expect(k("Example: batch built on the branch, suite green.")).not.toBe(k("Example: batch failed on the branch."));
  expect(k("Example: batch built")).toBe("2026-09-24|10:00|examplebatchbuilt");
  expect(canonical("x".repeat(80)).length).toBe(48);
});

test("isAmendment recognizes every amendment phrasing in the log and nothing else", () => {
  const yes = [
    "Correction to the 10:05 line: x",
    "Corrections to the 10:10 Garden line, from a check: x",
    "Second correction to the 10:15 line, from the gate: x",
    "Correction and completion of the 10:20 line, x",
    "Correction to the two 10:25 lines: x",
    "Correction to the line above: x",
    "Correction to the flag above: inferred.",
    "Note on the 10:30 Agent line: the gate marked it",
    "Provenance for the 10:35 line, x",
    "Evidence for the 10:40 Garden line: x",
    "Follow-up to the 10:45 correction: x",
    "Garden: correction to the 10:50 line, x",
    "Lamp, correction to the 10:55 line: x",
    "Corrected yesterday's own correction: x",
    "Two corrections I owe on the 11:00 line: x",
    "Confirmation of the 11:05 line, after the gate could not see it",
    "Precision on the 11:10 line, after the gate read it as x",
    "Verification gate on the second clause of the 11:15 and 11:20 lines: x",
    "Correction to the 11:2x line: x",
    "Clarification of the line above: x",
  ];
  const no = [
    "ExampleApp: note on the design review",
    "Corrected the invoice totals",
    "Lamp: correction to the price estimate",
    "Garden, update to the 11:25 line: x",
    "Agent: health sweep found nothing",
  ];
  for (const t of yes) expect({ t, a: isAmendment(t) }).toEqual({ t, a: true });
  for (const t of no) expect({ t, a: isAmendment(t) }).toEqual({ t, a: false });
});

test("amendmentTarget reads which line is amended, on which day", () => {
  expect(amendmentTarget("Correction to the 10:05 line: it said 10:00")).toEqual({ kind: "time", time: "10:05" });
  expect(amendmentTarget("Correction to the two 10:25 lines: x")).toEqual({ kind: "time", time: "10:25" });
  expect(amendmentTarget("Correction to the 11:2x line: x")).toEqual({ kind: "time", time: "11:20" });
  expect(amendmentTarget("Correction to the line above: its 18:25 was a guess")).toEqual({ kind: "above" });
  expect(amendmentTarget("Correction to the flag above: inferred.")).toEqual({ kind: "flag" });
  expect(amendmentTarget("Corrected yesterday's own correction: x")).toEqual({ kind: "yesterday" });
  expect(amendmentTarget("Second correction to the Garden line: x")).toEqual({ kind: "unknown" });
  expect(amendmentTarget("Correction to the 15:00 line of, which said x", ["2026-09-20"])).toEqual({ kind: "time", time: "15:00", date: "2026-09-20" });
  expect(amendmentTarget("Correction to the 15:00 line of, which said x", ["Daily/2026-09-20", "Shop"])).toEqual({
    kind: "time",
    time: "15:00",
    date: "2026-09-20",
  });
  expect(amendmentTarget("Correction to the two 15:00 Shop lines of, which said x", ["2026-09-20"])).toEqual({
    kind: "time",
    time: "15:00",
    date: "2026-09-20",
  });
  expect(amendmentTarget("Correction to the 07:10 and 07:25 lines of, which said x", ["2026-09-20"])).toEqual({
    kind: "time",
    time: "07:10",
    date: "2026-09-20",
  });
  // a later time with its own "lines of" is context, not part of the target's list
  expect(amendmentTarget("Correction to the 16:10 line, which repeated the 09:00 lines of, x", ["2026-09-03"])).toEqual({ kind: "time", time: "16:10" });
  // a daily-note link anywhere else is context: the target stays on the line's own day
  expect(amendmentTarget("Garden: correction to the 16:10 line: the seeds came from the order in.", ["2026-09-03"])).toEqual({
    kind: "time",
    time: "16:10",
  });
  expect(amendmentTarget("Correction to the 16:10 line, as the note of says", ["2026-09-03"])).toEqual({ kind: "time", time: "16:10" });
});

// --- selection -----------------------------------------------------------------------------

test("selectPending returns unsent entries sorted by date and time, skipping days before since", () => {
  const journal = J([
    { date: "2026-09-23", entries: [E("20:00", "Old: before since.")] },
    { date: "2026-09-24", entries: [E("11:00", "B: second."), E("08:00", "A: first."), E("12:00", "C: already sent.")] },
    { date: "2026-09-25", entries: [E("00:30", "D: after midnight.")] },
  ]);
  const state = fresh("2026-09-24");
  state.sent[entryKey("2026-09-24", E("12:00", "C: already sent."))] = 1;
  const { pending, dropKeys, rekeyed } = selectPending(journal, state);
  expect(pending.map((p) => `${p.date} ${p.time}`)).toEqual(["2026-09-24 08:00", "2026-09-24 11:00", "2026-09-25 00:30"]);
  expect(pending[0].idx).toBe(1);
  expect(dropKeys).toEqual([]);
  expect(rekeyed).toEqual([]);
});

test("an amendment is kept with its line and dropped when the line already went out", () => {
  const day = {
    date: "2026-09-24",
    entries: [
      E("10:00", "Garden: bed one planted."),
      E("10:05", "Correction to the 10:00 Garden line: it was bed two."),
      E("15:00", "Agent: sweep done."),
      E("15:05", "Correction to the 15:00 Agent line: 18 entries, not 17."),
    ],
  };
  const state = fresh();
  state.sent[entryKey("2026-09-24", day.entries[2])] = 1;
  const { pending, dropKeys } = selectPending(J([day]), state);
  expect(pending.map((p) => p.time)).toEqual(["10:00", "10:05"]);
  expect(dropKeys).toEqual([entryKey("2026-09-24", day.entries[3])]);
});

test("'line above' needs the entry right above it to be pending; 'flag above' always drops", () => {
  const day = {
    date: "2026-09-24",
    entries: [
      E("18:00", "Notes: tidied."),
      E("18:05", "Correction to the line above: its time was a guess."),
      E("18:10", "Correction to the flag above: inferred."),
    ],
  };
  const { pending, dropKeys } = selectPending(J([day]), fresh());
  expect(pending.map((p) => p.time)).toEqual(["18:00", "18:05"]);
  expect(dropKeys).toEqual([entryKey("2026-09-24", day.entries[2])]);
  const state = fresh();
  state.sent[entryKey("2026-09-24", day.entries[0])] = 1;
  const again = selectPending(J([day]), state);
  expect(again.pending).toEqual([]);
  expect(again.dropKeys.length).toBe(2);
});

test("chains, a target written later in the file, an unknown target, midnight and yesterday", () => {
  const day = {
    date: "2026-09-24",
    entries: [
      E("10:05", "Correction to the 10:00 Garden line: only one bed was tested."), // target sits below it
      E("10:00", "Garden: soil test passed."),
      E("10:10", "Correction to the 10:05 line: the exact wording."),
      E("10:15", "Second correction to the Garden line: a wording fix."),
    ],
  };
  expect(selectPending(J([day]), fresh()).pending.map((p) => p.time)).toEqual(["10:00", "10:05", "10:10", "10:15"]);
  const lonely = { date: "2026-09-24", entries: [E("10:15", "Second correction to the Garden line: a wording fix.")] };
  expect(selectPending(J([lonely]), fresh()).pending).toEqual([]);

  const twoDays = J([
    { date: "2026-09-24", entries: [E("23:50", "Agent: late fix merged.")] },
    {
      date: "2026-09-25",
      entries: [E("00:10", "Correction to the 23:50 Agent line: merged, not deployed."), E("09:00", "Corrected yesterday's own correction: deployed at 08:55.")],
    },
  ]);
  expect(selectPending(twoDays, fresh()).pending.map((p) => `${p.date} ${p.time}`)).toEqual([
    "2026-09-24 23:50",
    "2026-09-25 00:10",
    "2026-09-25 09:00",
  ]);
});

test("an amendment that names another day's line is not folded into a same-time line of today", () => {
  const journal = J([
    {
      date: "2026-09-24",
      entries: [E("15:00", "Shop: price list updated."), E("15:05", "Correction to the 15:00 line of, which said the old price.", ["2026-09-20"])],
    },
  ]);
  const { pending, dropKeys } = selectPending(journal, fresh());
  expect(pending.map((p) => p.time)).toEqual(["15:00"]);
  expect(dropKeys).toEqual([entryKey("2026-09-24", journal.days[0].entries[1])]);
});

test("a daily-note link used as context leaves the amendment with its line of the same day", () => {
  const day = {
    date: "2026-09-24",
    entries: [E("16:10", "Garden: seeds sown in bed one."), E("16:20", "Garden: correction to the 16:10 line: the seeds came from the order in.", ["2026-09-03"])],
  };
  const { pending, dropKeys } = selectPending(J([day]), fresh());
  expect(pending.map((p) => p.time)).toEqual(["16:10", "16:20"]);
  expect(dropKeys).toEqual([]);
});

test("a sanitizer version change re-keys lines already sent instead of sending them again", () => {
  const oldText = E("10:00", "Repo: committed the.env.example file."); // what version 1 produced
  const newText = E("10:00", "Repo: committed the new `.env.example` file."); // what version 2 produces
  const state = { ...fresh(), sanitizer: 1 };
  state.sent[entryKey("2026-09-24", oldText)] = 5;
  const journal = J([{ date: "2026-09-24", entries: [newText, E("11:00", "B: genuinely new.")] }], 1_790_000_000, 2);
  const sel = selectPending(journal, state);
  expect(sel.pending.map((p) => p.time)).toEqual(["11:00"]);
  expect(sel.rekeyed).toEqual([entryKey("2026-09-24", newText)]);
  // same version: no fallback, so the changed text would count as new
  expect(selectPending({ ...journal, sanitizer: 1 }, state).pending.map((p) => p.time)).toEqual(["10:00", "11:00"]);
});

// --- server files ----------------------------------------------------------------------------

test("state round-trips atomically, and a missing file reads as null", () => {
  const dir = tmp();
  expect(loadDigestState(dir)).toEqual({ state: null, error: null });
  const s: DigestState = {
    ...fresh("2026-09-26"),
    lastRunDate: "2026-09-26",
    sent: { "2026-09-26|10:00|x": 5 },
    sanitizer: 1,
    lastOutcome: { date: "2026-09-26", kind: "sent", detail: "3 entries" },
  };
  saveDigestState(s, dir);
  expect(loadDigestState(dir)).toEqual({ state: s, error: null });
  expect(existsSync(join(dir, "state.json.tmp"))).toBe(false);
});

test("a corrupt state file is a parse error with its write time; an unreadable one is an io error", () => {
  const dir = tmp();
  writeFileSync(join(dir, "state.json"), "{not json");
  const r = loadDigestState(dir);
  expect(r.state).toBeNull();
  expect(r.error).toContain("state.json unreadable");
  expect(r.errorKind).toBe("parse");
  expect(typeof r.mtimeMs).toBe("number");
  writeFileSync(join(dir, "state.json"), "null");
  expect(loadDigestState(dir).errorKind).toBe("parse");
  const dir2 = tmp();
  mkdirSync(join(dir2, "state.json")); // reading a folder fails like a disk error would
  expect(loadDigestState(dir2).errorKind).toBe("io");
});

test("markSent adds keys and prunes keys older than 14 days without mutating its input", () => {
  const s = { ...fresh(), sent: { "2026-09-01|10:00|old": 1, "2026-09-20|10:00|recent": 2 } };
  const next = markSent(s, ["2026-09-26|21:00|new"], 99, "2026-09-26");
  expect(next.sent).toEqual({ "2026-09-20|10:00|recent": 2, "2026-09-26|21:00|new": 99 });
  expect(s.sent["2026-09-01|10:00|old"]).toBe(1);
});

test("isPaused follows the paused file", () => {
  const dir = tmp();
  expect(isPaused(dir)).toBe(false);
  writeFileSync(join(dir, "paused"), "x");
  expect(isPaused(dir)).toBe(true);
});

test("parseJournal validates the shape, keeps notes, stats and the copy, and drops malformed parts", () => {
  expect(parseJournal(null)).toBeNull();
  expect(parseJournal({ v: 1, pushedAt: 1, days: [] })).toBeNull(); // no sanitizer version
  expect(parseJournal({ v: 2, sanitizer: 1, pushedAt: 1, days: [] })).toBeNull();
  const stats = { entries: 1, ignoredBelowHeading: 0, testLinesDropped: 2, automationDropped: 0, unparsedTimed: 1 };
  const j = parseJournal({
    v: 1,
    sanitizer: 1,
    pushedAt: 10,
    stats,
    copy: "abc1234",
    days: [
      {
        date: "2026-09-24",
        entries: [
          { time: "10:00", text: "ok", links: ["a", 3], notes: ["corrected: x", 4] },
          { time: "1000", text: "bad" },
          { time: "11:00", text: "  " },
        ],
      },
      { date: "24/09", entries: [] },
    ],
  });
  expect(j).toEqual({ ...J([{ date: "2026-09-24", entries: [E("10:00", "ok", ["a"], ["corrected: x"])] }], 10), stats, copy: "abc1234" });
  expect(parseJournal({ v: 1, sanitizer: 1, pushedAt: 1, days: [], stats: { entries: "x" }, copy: "not a hash!" })).toEqual(J([], 1));
});

test("loadJournal reports a missing, unreadable or wrongly shaped file", () => {
  const dir = tmp();
  expect(loadJournal(dir).error).toContain("no journal yet");
  writeFileSync(join(dir, "journal.json"), "{bad");
  expect(loadJournal(dir).error).toContain("journal.json unreadable");
  writeFileSync(join(dir, "journal.json"), JSON.stringify({ v: 9 }));
  expect(loadJournal(dir).error).toContain("unexpected shape");
  writeFileSync(join(dir, "journal.json"), JSON.stringify(J([])));
  expect(loadJournal(dir)).toEqual({ journal: J([]), error: null });
});
