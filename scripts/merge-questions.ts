/**
 * merge-questions.ts — import a question bank (e.g. Gilboa's data/questions.json)
 * into ours. Dry-run by default; nothing is written without --write.
 *
 *   bun run scripts/merge-questions.ts <incoming.json>                # report only
 *   bun run scripts/merge-questions.ts <incoming.json> --write        # merge + write
 *   bun run scripts/merge-questions.ts <incoming.json> --write --replace  # incoming only
 *
 * Validation reuses loadQuestions (malformed entries are dropped, counted here).
 * The report flags data-quality risks before they reach the daily send: answers
 * that look like placeholders, algo questions without a LeetCode link, diagram
 * urls off the ByteByteGo CDN, and hint counts other than 3.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  isPlaceholderAnswer,
  loadQuestions,
  mergeQuestionBanks,
  questionsPath,
  splitHints,
  type Question,
} from "../quiz";

const [, , src, ...flags] = process.argv;
if (!src) {
  console.error("usage: bun run scripts/merge-questions.ts <incoming.json> [--write] [--replace]");
  process.exit(2);
}
const write = flags.includes("--write");
const replace = flags.includes("--replace");

let rawCount = 0;
try {
  const raw = JSON.parse(readFileSync(src, "utf8"));
  rawCount = Array.isArray(raw) ? raw.length : NaN;
} catch (e: any) {
  console.error(`cannot parse ${src}: ${e?.message ?? e}`);
  process.exit(1);
}
if (Number.isNaN(rawCount)) {
  console.error(`${src} is not a JSON array of questions`);
  process.exit(1);
}

const incoming = loadQuestions(src);
console.log(
  `incoming: ${rawCount} entries, ${incoming.length} valid, ${rawCount - incoming.length} dropped by schema`,
);
if (!incoming.length) {
  console.error("nothing valid to import; stopping");
  process.exit(1);
}

const ours = replace ? [] : loadQuestions();
const res = mergeQuestionBanks(ours, incoming);
console.log(
  `merge: ${res.incoming} incoming` +
    (res.dupesInIncoming ? ` (${res.dupesInIncoming} duplicate ids inside the file collapsed)` : "") +
    `, ${res.replacedOurs} of ours replaced, ${res.keptOurs} of ours kept` +
    (res.keptOursOverIncoming
      ? `, ${res.keptOursOverIncoming} collisions kept OUR richer version (incoming stub dropped)`
      : "") +
    ` -> ${res.merged.length} total`,
);

function report(qs: Question[]): void {
  const byType = new Map<string, number>();
  for (const q of qs) byType.set(q.type, (byType.get(q.type) ?? 0) + 1);
  console.log("by type: " + [...byType.entries()].map(([t, n]) => `${t}=${n}`).join(", "));
  const count = (f: (q: Question) => boolean) => qs.filter(f).length;
  const pct = (n: number) => `${n} (${Math.round((n / qs.length) * 100)}%)`;
  console.log(
    `coverage: hints=${pct(count((q) => splitHints(q.hint).length > 0))}, ` +
      `lc_description=${pct(count((q) => !!q.lc_description))}, ` +
      `solution_code=${pct(count((q) => !!q.solution_code))}, ` +
      `diagrams=${count((q) => !!q.diagram_url)}`,
  );
  const flag = (label: string, bad: Question[]) => {
    if (!bad.length) return;
    console.log(`⚠ ${label}: ${bad.length} — e.g. ${bad.slice(0, 5).map((q) => q.id).join(", ")}`);
  };
  flag(
    "placeholder-looking answers (check /reveal quality)",
    qs.filter((q) => isPlaceholderAnswer(q.answer)),
  );
  flag(
    "short answers under 60 chars",
    qs.filter((q) => !q.diagram_url && q.answer.trim().length < 60),
  );
  flag(
    "algo without leetcode_url",
    qs.filter((q) => q.type === "algo" && !q.leetcode_url),
  );
  flag(
    "algo hint count is not 3",
    qs.filter((q) => q.type === "algo" && splitHints(q.hint).length !== 3),
  );
  flag(
    "diagram urls off the ByteByteGo CDN",
    qs.filter(
      (q) => q.diagram_url && !q.diagram_url.startsWith("https://assets.bytebytego.com/diagrams/"),
    ),
  );
}
report(res.merged);

if (!write) {
  console.log("dry-run only; add --write to update " + questionsPath());
  process.exit(0);
}
const target = questionsPath();
const tmp = target + ".tmp";
writeFileSync(tmp, JSON.stringify(res.merged, null, 2));
renameSync(tmp, target);
console.log(`wrote ${res.merged.length} questions to ${target}`);
