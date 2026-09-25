import { test, expect } from "bun:test";
import {
  SANITIZER_VERSION,
  ENTRY_MAX,
  splitBrackets,
  sanitizeLine,
  isPlantedTestLine,
  extractNote,
  extractEntries,
  buildJournal,
} from "./ccjournal";

// All fixtures are synthetic. They copy the SHAPES of the owner's real log lines
// (provenance brackets, gate notes, wikilinks, code spans), never their content.

const ch = (cp: number) => String.fromCharCode(cp);

// --- brackets and sanitizing -------------------------------------------------------

test("splitBrackets removes nested groups, returns them, and keeps an unmatched bracket", () => {
  expect(splitBrackets("a [b [c] d] e [f]")).toEqual({ text: "a  e ", groups: ["b [c] d", "f"] });
  expect(splitBrackets("keep [this")).toEqual({ text: "keep [this", groups: [] });
});

test("sanitizeLine drops provenance brackets, nested ones included", () => {
  const body =
    "Example project: release 1.2 merged [measured in this session: the suite, 120 pass [corrected at 10:05: 121]] and shipped [gate: out of reach; rests on the log]. ([[Example project]])";
  expect(sanitizeLine(body)).toEqual({ text: "Example project: release 1.2 merged and shipped.", links: ["Example project"], notes: [] });
});

test("sanitizeLine keeps the notes that open with a verdict on the line, and only those", () => {
  expect(sanitizeLine("Example: the export is done [corrected at 16:05: queued, not done]. ([[Proj]])")).toEqual({
    text: "Example: the export is done.",
    links: ["Proj"],
    notes: ["corrected at 16:05: queued, not done"],
  });
  expect(sanitizeLine("Guard: a check went green [FALSE — corrected at 14:10 below; nothing ran].").notes).toEqual([
    "FALSE — corrected at 14:10 below; nothing ran",
  ]);
  expect(sanitizeLine("Tool: the setting changed **[gate: refuted; see 15:40]**.")).toEqual({
    text: "Tool: the setting changed.",
    links: [],
    notes: ["gate: refuted; see 15:40"],
  });
  expect(sanitizeLine("Tool: the flag is set **[gate: marked refuted after a commit search; the flag lives on the server, see 15:50]**.").notes).toEqual([
    "gate: marked refuted after a commit search; the flag lives on the server, see 15:50",
  ]);
  expect(sanitizeLine("Garden: the second bed moves to next week [plan, see 16:05].").notes).toEqual(["plan, see 16:05"]);
  expect(sanitizeLine("Shelf: none fits [imprecise; see 11:57].").notes).toEqual(["imprecise; see 11:57"]);
  // provenance that merely mentions a verdict further in is dropped like other provenance
  expect(sanitizeLine('Report: the audit is filed [gate: out of reach for the report; its "refuted" read later commits].').notes).toEqual([]);
});

test("sanitizeLine keeps markdown link text and turns a gate pointer into a note", () => {
  const body =
    "Agent: the fix merged as [PR #7](https://github.com/example/repo/pull/7) **[gate: corrected at 15:01, see the next line]** and deployed. ([[Agent notes]])";
  expect(sanitizeLine(body)).toEqual({
    text: "Agent: the fix merged as PR #7 and deployed.",
    links: ["Agent notes"],
    notes: ["gate: corrected at 15:01, see the next line"],
  });
  expect(sanitizeLine("Mail: wrote [the list](mailto:list@example.com) today.").text).toBe("Mail: wrote the list today.");
});

test("sanitizeLine collects wikilinks without Projects/ or aliases", () => {
  const body = "Shop: checkout designed. ([[Projects/Shop system/Product and decisions]], [[Tools index|/tool-x]], [[Tools index]])";
  expect(sanitizeLine(body)).toEqual({
    text: "Shop: checkout designed.",
    links: ["Shop system/Product and decisions", "Tools index"],
    notes: [],
  });
});

test("sanitizeLine keeps code spans verbatim but scrubs contacts inside and across them", () => {
  const body =
    "Repo: committed the `.env.example` file and `__init__.py` with `[AUTO]` tags, then ran `main()` [measured: log]. The systemd .env file and .NET's cache stay.";
  expect(sanitizeLine(body).text).toBe(
    "Repo: committed the `.env.example` file and `__init__.py` with `[AUTO]` tags, then ran `main()`. The systemd .env file and .NET's cache stay.",
  );
  expect(sanitizeLine("Mail: sent from `user@example.com`.").text).toBe("Mail: sent from ``.");
  expect(sanitizeLine("Mail: wrote to `person`@example.com today.").text).toBe("Mail: wrote to today.");
  expect(sanitizeLine("Call: `050`-0000000 is the desk.").text).toBe("Call: is the desk.");
});

test("sanitizeLine finds contacts that bold, italics or a code-span edge split, in text and notes", () => {
  expect(sanitizeLine("Mail: wrote to **someone**@example.com today.").text).toBe("Mail: wrote to today.");
  expect(sanitizeLine("Mail: wrote to someone@**example.com** today.").text).toBe("Mail: wrote to today.");
  expect(sanitizeLine("Mail: wrote to *someone*@example.com today.").text).toBe("Mail: wrote to today.");
  expect(sanitizeLine("Call: the desk is 050-**000**-0000 now.").text).toBe("Call: the desk is now.");
  for (const body of [
    "Mail: sent [corrected: it went to **someone**@example.com, not the list].",
    "Mail: sent [corrected: it went to `someone`@example.com, not the list].",
  ]) {
    const out = sanitizeLine(body);
    expect(out.notes.length).toBe(1);
    expect(JSON.stringify(out)).not.toContain("someone");
    expect(JSON.stringify(out)).not.toContain("example.com");
  }
  // bold glued to the word beside it (the scrub runs while the marks still show the edges),
  // strikethrough, highlight, an escaped @, an invisible character, a doubled space
  for (const body of [
    "Call: Tel.**050-000-0000** now.",
    "Call: desk**050-000-0000** now.",
    "Call: v2**0500000000** now.",
    "Call: desk **050-000-0000**x now.",
    "Mail: wrote to ~~someone~~@example.com today.",
    "Mail: wrote to ==someone==@example.com today.",
    "Mail: wrote to someone\\@example.com today.",
    `Mail: wrote to some${ch(0x200e)}one@example.com today.`,
    `Mail: wrote to some${ch(0xad)}one@example.com today.`,
    `Mail: wrote to some${ch(0x200d)}one@example.com today.`,
    "Call: the desk is 050  000-0000 now.",
  ]) {
    const out = JSON.stringify(sanitizeLine(body));
    expect({ body, leaks: out.includes("0000") || out.includes("example.com") }).toEqual({ body, leaks: false });
  }
});

test("sanitizeLine strips control and bidi characters, including a smuggled placeholder", () => {
  expect(sanitizeLine(`Note: a${ch(0x2067)}b${ch(0x202e)}c.`).text).toBe("Note: abc.");
  expect(sanitizeLine(`Note: x${ch(0)}0${ch(1)} y.`).text).toBe("Note: x0 y.");
});

test("sanitizeLine tidies what the removals leave behind", () => {
  expect(sanitizeLine("A: done [x] . ([[N]])").text).toBe("A: done.");
  expect(sanitizeLine("A: one  [x]  two").text).toBe("A: one two");
  expect(sanitizeLine("Mail: replied (someone@example.com, one per request).").text).toBe("Mail: replied (one per request).");
  expect(sanitizeLine("Accounts (main box@; digests other@) set.").text).toBe("Accounts (main; digests) set.");
});

test("isPlantedTestLine drops planted gate tests and keeps work that only mentions them", () => {
  const planted = [
    "Lamp: the hallway lamp was replaced. **[DELIBERATE FALSE TEST LINE, nothing was replaced]**",
    "Probe line, deliberately false on purpose: the spare folder was emptied.",
    "Gate check: a line that is true on purpose [DELIBERATE TRUE TEST LINE].",
  ];
  const work = [
    "Checker: work wrapped up; it now refutes a deliberately false line within a minute.",
    "Notes: the deliberate false test line from this morning was refuted.",
    "Docs: the marker `[DELIBERATE FALSE TEST LINE]` is described for the next session.",
  ];
  for (const t of planted) expect({ t, planted: isPlantedTestLine(t) }).toEqual({ t, planted: true });
  for (const t of work) expect({ t, planted: isPlantedTestLine(t) }).toEqual({ t, planted: false });
});

// --- extraction and the journal ----------------------------------------------------------

test("extractNote keeps timed lines, reads an unread minute as 0, and counts everything it leaves out", () => {
  const note = [
    "---",
    "type: daily",
    "---",
    "",
    "# 2026-09-24",
    "",
    "- 09:15 — Example: first thing done. ([[Example]])",
    "- 9:40 - Older style: a hyphen separator.",
    "- 21:0x — Garden: the minute was not read from the clock.",
    "- needs update: sessions ran on x but no breadcrumbs were logged",
    "-",
    "- 10:00 x missing its separator",
    "- 10:30 — Lamp: the hallway lamp was replaced. **[DELIBERATE FALSE TEST LINE, nothing was replaced]**",
    "- 11:00 — watchdog: No vault daily note in 3 days.",
    "- 11:05 — Watchdog: the check now reads the battery log.",
    "- 11:10 — ([[Example]])",
    "- 18:05 — Correction to the line above: its time was a guess. ([[Example]])",
    "",
    "## English translation",
    "- 22:00 — Should not be read.",
  ].join("\n");
  expect(extractNote(note)).toEqual({
    entries: [
      { time: "09:15", text: "Example: first thing done.", links: ["Example"] },
      { time: "09:40", text: "Older style: a hyphen separator.", links: [] },
      { time: "21:00", text: "Garden: the minute was not read from the clock.", links: [] },
      { time: "11:05", text: "Watchdog: the check now reads the battery log.", links: [] },
      { time: "18:05", text: "Correction to the line above: its time was a guess.", links: ["Example"] },
    ],
    ignoredBelowHeading: 1,
    testLinesDropped: 1,
    automationDropped: 1,
    unparsedTimed: 2,
  });
});

test("extractEntries handles CRLF and caps very long lines", () => {
  const long = "Big: " + "x".repeat(5000);
  const out = extractEntries(`- 10:00 — ${long}\r\n- 11:00 — Small: y.\r\n`);
  expect(out[0].text.length).toBe(ENTRY_MAX);
  expect(out[0].text.endsWith("…")).toBe(true);
  expect(out[1]).toEqual({ time: "11:00", text: "Small: y.", links: [] });
});

test("buildJournal skips missing notes, stamps the version and the copy, and adds up the stats", () => {
  const { journal, stats } = buildJournal(
    [
      { date: "2026-09-23", text: null },
      { date: "2026-09-24", text: "- 10:00 — A: done. ([[Proj]])\n## Notes\n- 11:00 — B: below.\n" },
    ],
    123,
    "abc1234",
  );
  const counted = { entries: 1, ignoredBelowHeading: 1, testLinesDropped: 0, automationDropped: 0, unparsedTimed: 0 };
  expect(journal).toEqual({
    v: 1,
    sanitizer: SANITIZER_VERSION,
    pushedAt: 123,
    days: [{ date: "2026-09-24", entries: [{ time: "10:00", text: "A: done.", links: ["Proj"] }] }],
    stats: counted,
    copy: "abc1234",
  });
  expect(stats).toEqual(counted);
  expect(buildJournal([], 1).journal.copy).toBeUndefined();
});

// --- golden output ---------------------------------------------------------------------------

// Changing any expected string below changes entry keys on the server. Bump
// SANITIZER_VERSION in the same commit, so the server re-keys instead of re-sending.
test("golden: the sanitized text of a fixed fixture set (sanitizer version 1)", () => {
  expect(SANITIZER_VERSION).toBe(1);
  const golden: [string, string][] = [
    [
      "Proj: batch built on branch `feat-x`, suite green [measured in this session: 812 pass]. ([[Projects/Proj/Testing]])",
      "Proj: batch built on branch `feat-x`, suite green.",
    ],
    [
      'Garden: bed 2 planted (his words: "looks good") and bed 3 **[gate: corrected at 14:00, see below]** planned.',
      'Garden: bed 2 planted (his words: "looks good") and bed 3 planned.',
    ],
    ["Errand: reminder moved to Sunday at 10:00 as `r9` [rests on the list output].", "Errand: reminder moved to Sunday at 10:00 as `r9`."],
    ["Poster: draft emailed to someone (a.person@example.com) for a pick.", "Poster: draft emailed to someone for a pick."],
  ];
  for (const [input, want] of golden) expect(sanitizeLine(input).text).toBe(want);
});
