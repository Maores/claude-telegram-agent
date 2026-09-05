import { test, expect } from "bun:test";
import {
  MISHNAYOT_PER_PEREK,
  isLastOfTractate,
  advance,
  gematria,
  reference,
  sefariaUrl,
  parseSefariaText,
  cleanMishnahText,
  defaultAvotState,
  type AvotState,
} from "./avot";

const s = (over: Partial<AvotState> = {}): AvotState => ({ ...defaultAvotState(), ...over });

// --- gematria --------------------------------------------------------------

test("gematria renders simple digits and tens+ones", () => {
  expect(gematria(1)).toBe("א");
  expect(gematria(6)).toBe("ו");
  expect(gematria(11)).toBe("יא");
  expect(gematria(22)).toBe("כב");
  expect(gematria(23)).toBe("כג");
});

test("gematria uses the טו/טז exception for 15 and 16", () => {
  expect(gematria(15)).toBe("טו");
  expect(gematria(16)).toBe("טז");
});

// --- reference / url ---------------------------------------------------------

test("reference and sefariaUrl reflect the pointer", () => {
  const state = s({ perek: 3, mishnah: 14 });
  expect(reference(state)).toBe("פרק ג משנה יד");
  expect(sefariaUrl(state)).toBe("https://www.sefaria.org/Pirkei_Avot.3.14");
});

// --- pointer arithmetic -------------------------------------------------------

test("advance steps to the next mishnah within a chapter", () => {
  expect(advance(s({ perek: 1, mishnah: 1 }))).toEqual({ perek: 1, mishnah: 2, cycles: 0 });
});

test("advance rolls from the last mishnah of a chapter into the next chapter", () => {
  expect(advance(s({ perek: 1, mishnah: MISHNAYOT_PER_PEREK[0] }))).toEqual({ perek: 2, mishnah: 1, cycles: 0 });
});

test("advance wraps from the last mishnah of the tractate back to 1:1 and bumps cycles", () => {
  const lastPerek = MISHNAYOT_PER_PEREK.length;
  const lastMishnah = MISHNAYOT_PER_PEREK[lastPerek - 1];
  const state = s({ perek: lastPerek, mishnah: lastMishnah, cycles: 2 });
  expect(isLastOfTractate(state)).toBe(true);
  expect(advance(state)).toEqual({ perek: 1, mishnah: 1, cycles: 3 });
});

test("isLastOfTractate is false everywhere else", () => {
  expect(isLastOfTractate(s({ perek: 6, mishnah: 10 }))).toBe(false);
  expect(isLastOfTractate(s({ perek: 5, mishnah: 23 }))).toBe(false);
});

// --- Sefaria response parsing --------------------------------------------------

test("parseSefariaText extracts text from a v3 texts response", () => {
  const body = JSON.stringify({ versions: [{ text: "מֹשֶׁה קִבֵּל תּוֹרָה מִסִּינַי" }] });
  expect(parseSefariaText(body)).toBe("מֹשֶׁה קִבֵּל תּוֹרָה מִסִּינַי");
});

test("parseSefariaText returns null on Sefaria's own error shape", () => {
  expect(parseSefariaText(JSON.stringify({ error: "We have no text for Pirkei Avot 1:19." }))).toBeNull();
});

test("parseSefariaText returns null on malformed json or missing/blank text", () => {
  expect(parseSefariaText("not json")).toBeNull();
  expect(parseSefariaText(JSON.stringify({ versions: [] }))).toBeNull();
  expect(parseSefariaText(JSON.stringify({ versions: [{ text: "   " }] }))).toBeNull();
});

// --- text cleanup (real fixture: Pirkei Avot 6:1 carries a literal <br>) ---------

test("cleanMishnahText turns Sefaria's literal <br> into a newline and strips other markup", () => {
  const raw =
    "שָׁנוּ חֲכָמִים בִּלְשׁוֹן הַמִּשְׁנָה, בָּרוּךְ שֶׁבָּחַר בָּהֶם וּבְמִשְׁנָתָם: <br>רַבִּי מֵאִיר אוֹמֵר";
  const cleaned = cleanMishnahText(raw);
  expect(cleaned).not.toContain("<br>");
  expect(cleaned).toContain("\n");
  expect(cleaned.split("\n")[1]).toBe("רַבִּי מֵאִיר אוֹמֵר");
});

test("cleanMishnahText collapses stray whitespace and trims", () => {
  expect(cleanMishnahText("  שלום   עולם:  \n")).toBe("שלום עולם:");
});
