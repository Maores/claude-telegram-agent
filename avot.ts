/**
 * avot.ts — sequential Pirkei Avot study tracker.
 *
 *   bun run avot.ts next      (default) prints today's mishnah and advances the
 *                              saved pointer to tomorrow's
 *   bun run avot.ts current    prints the saved pointer's mishnah WITHOUT advancing
 *   bun run avot.ts status     prints only the reference (perek/mishnah), no fetch
 *
 * The text always comes from Sefaria (never from the model's memory, per Maor's
 * accuracy requirement, 2026-08-31) through the same hardened safeFetch() used by
 * monitors. The chapter/mishnah structure (six chapters, fixed mishnah counts) is
 * a static fact of the printed text — not something Sefaria's API needs to tell
 * us — so pointer advancement is pure and offline; only the TEXT itself is
 * fetched. That split means a transient network failure can never be
 * misread as "end of chapter" and silently skip content.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeFetch } from "./net.ts";

export interface AvotState {
  perek: number;
  mishnah: number;
  cycles: number; // completed read-throughs of the whole tractate
}

/** Mishnayot per chapter, verified against Sefaria 2026-08-31 (Torat Emet ed.):
 *  18, 16, 18, 22, 23, 11 — 108 total. This is fixed structure, not content, so
 *  it does not need to be re-fetched on every run. */
export const MISHNAYOT_PER_PEREK = [18, 16, 18, 22, 23, 11];

function statePath(): string {
  return process.env.AVOT_STATE_FILE ?? join(import.meta.dir, "data", "avot-state.json");
}

export function defaultAvotState(): AvotState {
  return { perek: 1, mishnah: 1, cycles: 0 };
}

export function loadAvotState(): AvotState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8"));
    return { ...defaultAvotState(), ...(typeof raw === "object" && raw ? raw : {}) };
  } catch {
    return defaultAvotState();
  }
}

export function saveAvotState(state: AvotState): void {
  const path = statePath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path); // atomic replace
}

// ---------------------------------------------------------------------------
// Pointer arithmetic (pure)
// ---------------------------------------------------------------------------

/** True when `state` is the very last mishnah of the tractate. */
export function isLastOfTractate(state: Pick<AvotState, "perek" | "mishnah">): boolean {
  return state.perek === MISHNAYOT_PER_PEREK.length && state.mishnah === MISHNAYOT_PER_PEREK[MISHNAYOT_PER_PEREK.length - 1];
}

/** Pointer for the session AFTER `state`: next mishnah, rolling into the next
 *  chapter, and — after the last mishnah of chapter six — back to 1:1 with
 *  `cycles` incremented. */
export function advance(state: AvotState): AvotState {
  if (isLastOfTractate(state)) return { perek: 1, mishnah: 1, cycles: state.cycles + 1 };
  const countInPerek = MISHNAYOT_PER_PEREK[state.perek - 1] ?? MISHNAYOT_PER_PEREK[0];
  if (state.mishnah < countInPerek) return { ...state, mishnah: state.mishnah + 1 };
  return { ...state, perek: state.perek + 1, mishnah: 1 };
}

const HEB_ONES = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
const HEB_TENS = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];

/** Small Hebrew-numeral (gematria) formatter, enough for chapter (1-6) and
 *  mishnah (1-23) numbers — 15/16 get the traditional טו/טז exception so a
 *  printed number never spells a Divine name. */
export function gematria(n: number): string {
  if (!Number.isInteger(n) || n <= 0) return String(n);
  if (n === 15) return "טו";
  if (n === 16) return "טז";
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return HEB_TENS[tens] + HEB_ONES[ones];
}

export function reference(state: Pick<AvotState, "perek" | "mishnah">): string {
  return `פרק ${gematria(state.perek)} משנה ${gematria(state.mishnah)}`;
}

export function sefariaUrl(state: Pick<AvotState, "perek" | "mishnah">): string {
  return `https://www.sefaria.org/Pirkei_Avot.${state.perek}.${state.mishnah}`;
}

function sefariaApiUrl(state: Pick<AvotState, "perek" | "mishnah">): string {
  return `https://www.sefaria.org/api/v3/texts/Pirkei_Avot.${state.perek}.${state.mishnah}?version=hebrew`;
}

// ---------------------------------------------------------------------------
// Text fetch + cleanup
// ---------------------------------------------------------------------------

/** Extract the Hebrew mishnah text from a Sefaria v3 texts-endpoint JSON body.
 *  Returns null on any shape mismatch (incl. Sefaria's own {"error": "..."}). */
export function parseSefariaText(json: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const versions = (data as { versions?: unknown })?.versions;
  if (!Array.isArray(versions) || !versions.length) return null;
  const text = (versions[0] as { text?: unknown })?.text;
  return typeof text === "string" && text.trim() ? text : null;
}

/** Sefaria's Avot text carries the odd literal <br> (chapter 6's baraita
 *  preface); strip markup and collapse whitespace into a single clean block. */
export function cleanMishnahText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Fetch and clean the mishnah text for `state`. Throws (rather than silently
 *  advancing) on any network/parse failure — an unattended nightly run must
 *  never guess its way past a real error. */
export async function fetchMishnahText(state: Pick<AvotState, "perek" | "mishnah">): Promise<string> {
  const res = await safeFetch(sefariaApiUrl(state));
  if (!res.ok) throw new Error(`sefaria fetch failed: ${res.error}`);
  const text = parseSefariaText(res.text);
  if (!text) throw new Error(`sefaria returned no text for ${reference(state)} (${sefariaUrl(state)})`);
  return cleanMishnahText(text);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printMishnah(state: AvotState, text: string, opts: { cycleJustCompleted?: boolean } = {}) {
  console.log(reference(state));
  console.log(text);
  console.log(`source: ${sefariaUrl(state)}`);
  if (opts.cycleJustCompleted) console.log(`(סיום מחזור ${state.cycles} על מסכת אבות — מתחילים מחדש)`);
}

async function main() {
  const cmd = process.argv[2] ?? "next";

  if (cmd === "status") {
    const state = loadAvotState();
    console.log(`${reference(state)} (מחזור ${state.cycles + 1})`);
    return;
  }

  if (cmd === "current") {
    const state = loadAvotState();
    const text = await fetchMishnahText(state);
    printMishnah(state, text);
    return;
  }

  if (cmd === "next") {
    const state = loadAvotState();
    const text = await fetchMishnahText(state);
    const cycleJustCompleted = isLastOfTractate(state);
    printMishnah(state, text, { cycleJustCompleted });
    saveAvotState(advance(state));
    return;
  }

  console.log(
    [
      "usage:",
      "  bun run avot.ts next      (default) print today's mishnah and advance",
      "  bun run avot.ts current   print the saved mishnah without advancing",
      "  bun run avot.ts status    print only the current reference",
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
