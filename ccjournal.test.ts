import { test, expect } from "bun:test";
import { localParts, addDays, weekday, scrubContacts } from "./ccjournal";

// All fixtures are synthetic. They copy the SHAPES of the owner's real log lines
// (provenance brackets, gate notes, wikilinks, code spans), never their content.

const at = (iso: string) => new Date(iso);

// --- time -------------------------------------------------------------------

test("localParts reads Asia/Jerusalem wall time whatever the process timezone", () => {
  expect(localParts(at("2026-09-24T18:30:00Z"))).toEqual({ date: "2026-09-24", minutes: 21 * 60 + 30, hhmm: "21:30" });
  expect(localParts(at("2026-09-24T21:00:00Z"))).toEqual({ date: "2026-09-25", minutes: 0, hhmm: "00:00" });
  // winter time is UTC+2
  expect(localParts(at("2026-12-24T19:29:00Z"))).toEqual({ date: "2026-12-24", minutes: 21 * 60 + 29, hhmm: "21:29" });
});

test("addDays and weekday work on civil dates across month and year ends", () => {
  expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  expect(weekday("2026-09-24")).toBe(4); // Thursday
  expect(weekday("2026-09-26")).toBe(6); // Saturday
});

// --- contacts -------------------------------------------------------------------

test("scrubContacts removes full, provider-only and cut-off addresses and every usual phone grouping", () => {
  const phones = [
    "050-0000000",
    "0500000000",
    "050-000-0000",
    "050-000-00-00",
    "(050) 000-0000",
    "050.000.0000",
    "+972-50-000-0000",
    "+972500000000",
    "972500000000",
    "+972 (0)50-000-0000",
    "02-0000000",
  ];
  for (const p of phones) expect(scrubContacts(`call ${p} now`)).toBe("call  now");
  expect(scrubContacts("to person.name07@example.com and other@example.co.il")).toBe("to  and ");
  expect(scrubContacts("mail name@outlook today")).toBe("mail  today");
  expect(scrubContacts("boxes: main box@; digests other@) done")).toBe("boxes: main ; digests ) done");
  for (const cut of ["box7@.", "box7@: x", "box7@— x", "box7@/x", "box7@שלום"]) expect(scrubContacts(cut)).not.toContain("box7");
});

test("scrubContacts leaves versions, times, dates, prices, addresses, counts, hashes and tags alone", () => {
  const keep = [
    "0.17.3",
    "10:00",
    "24/09",
    "1,999 ₪",
    "$4.50",
    "192.0.2.10",
    "812 pass / 0 fail",
    "2c738d3",
    "0999-batch",
    "tool@latest",
    "pkg@1.2.3",
    "@scope/pkg",
    "@reboot",
    "03.09.2026",
    "10.0.2.15",
    "08:30-11:30",
    "bak-20250101-1234",
    "0x800710E0",
    "12,345,678 bytes",
  ];
  for (const k of keep) expect(scrubContacts(`x ${k} y`)).toBe(`x ${k} y`);
});
