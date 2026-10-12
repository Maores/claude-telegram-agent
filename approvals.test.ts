import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "./db";
import { createSkill, skillBodyPath, skillsIndexBlock, viewSkill, getSkill } from "./skills";
import { addOnce, addRepeat, popDue, loadStore, type Reminder } from "./reminders";
import {
  type Approvals,
  emptyApprovals,
  loadApprovals,
  mutateApprovals,
  jobKey,
  isJobApproved,
  jobNeedsCard,
  parseAjCallback,
  ajCardText,
  ajKeyboard,
  consumeOnceApproval,
  approvalHold,
  skillKey,
  skillGate,
  skillNeedsCard,
  skillEntries,
  parseAsCallback,
  asCardText,
  asKeyboard,
  skillBodyText,
  seedApprovals,
  applyJobTap,
  applySkillTap,
  newCardToken,
  sendCardRound,
  CARD_MAX,
  HIDDEN_MARK,
  hiddenLine,
  hasHidden,
  HIDDEN_NOTICE,
  hiddenNotice,
  TOO_LONG_LINE,
  moreWaitingLine,
  pruneApprovals,
  outstandingCards,
  newCardState,
  textParts,
  keyLines,
  parseKeyLines,
  listLines,
  MAX_PARTS,
  MAX_OUTSTANDING,
  type CardState,
  type SkillEntry,
} from "./approvals";
import { createHash } from "node:crypto";

const T1 = "0123456789abcdef";
const T2 = "fedcba9876543210";
const jobCard = (key: string, id: string) => ({ kind: "job" as const, key, id, at: 1 });
const skillCard = (key: string) => ({ kind: "skill" as const, key, at: 1 });

const made: string[] = [];
function tmp(p = "approvals-"): string {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
}
const savedReminders = process.env.REMINDERS_FILE;
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
  if (savedReminders === undefined) delete process.env.REMINDERS_FILE;
  else process.env.REMINDERS_FILE = savedReminders;
});

const once = (over: Partial<Reminder> = {}): Reminder => ({ id: "r1", chatId: 100, fireAt: 1000, text: "[AUTO] summarize the day", repeat: null, ...over });
const daily = { hour: 20, minute: 35, days: [0, 1, 2, 3, 4, 5, 6] };
const buttons = (kb: any): Array<{ text: string; callback_data: string }> => kb.inline_keyboard.flat();

describe("job keys", () => {
  test("the key changes with the text, the chat, the id and once-or-repeat, never with the fire time", () => {
    const base = jobKey(once());
    expect(base).toMatch(/^[0-9a-f]{32}$/);
    expect(jobKey(once({ text: "[AUTO] something else" }))).not.toBe(base);
    expect(jobKey(once({ chatId: 101 }))).not.toBe(base);
    expect(jobKey(once({ id: "r2" }))).not.toBe(base);
    expect(jobKey(once({ repeat: daily }))).not.toBe(base);
    expect(jobKey(once({ fireAt: 999_999 }))).toBe(base);
    // a repeating job's schedule (its time) is not in the key either
    expect(jobKey(once({ repeat: daily }))).toBe(jobKey(once({ repeat: { hour: 7, minute: 0, days: [1] }, fireAt: 5 })));
  });

  test("every card gets its own random token; the callback carries only the token", () => {
    const t1 = newCardToken();
    const t2 = newCardToken();
    expect(t1).toMatch(/^[0-9a-f]{16}$/);
    expect(t2).not.toBe(t1);
    const [yes, no] = buttons(ajKeyboard(t1));
    expect(yes.callback_data).toBe(`aj:${t1}:y`);
    expect(no.callback_data).toBe(`aj:${t1}:n`);
    for (const d of [yes.callback_data, no.callback_data]) expect(Buffer.byteLength(d)).toBeLessThan(64);
    expect(parseAjCallback(yes.callback_data)).toEqual({ token: t1, act: "y" });
    expect(parseAjCallback(no.callback_data)).toEqual({ token: t1, act: "n" });
    expect(parseAjCallback("aj:r1:0123abcd:y")).toBeNull(); // the old id:key8 form is gone
    expect(parseAjCallback(`aj:${t1}:x`)).toBeNull();
    expect(parseAjCallback(`aj:${t1.toUpperCase()}:y`)).toBeNull();
    expect(parseAjCallback(`as:${t1}:y`)).toBeNull();
  });

  test("jobNeedsCard: true once for an unapproved [AUTO] job, never for a plain reminder or an approved job", () => {
    const a = emptyApprovals();
    const r = once();
    expect(jobNeedsCard(a, r)).toBe(true);
    a.jobs.carded[T1] = jobCard(jobKey(r), r.id);
    expect(jobNeedsCard(a, r)).toBe(false);
    expect(jobNeedsCard(emptyApprovals(), once({ text: "call the bank" }))).toBe(false);
    const b = emptyApprovals();
    b.jobs.approved.push(jobKey(r));
    expect(isJobApproved(b, r)).toBe(true);
    expect(jobNeedsCard(b, r)).toBe(false);
    // a new text is a new job: it needs its own card
    expect(jobNeedsCard(a, once({ text: "[AUTO] changed" }))).toBe(true);
  });

  test("the job card puts the job text and the schedule on their own lines", () => {
    const lines = ajCardText(once({ fireAt: Math.floor(new Date(2026, 9, 12, 9, 5).getTime() / 1000) })).split("\n");
    expect(lines[0]).toBe("משימה אוטומטית חדשה מחכה לאישור שלך");
    expect(lines[1]).toBe("summarize the day");
    expect(lines[2]).toContain("2026-10-12 09:05");
    const rep = ajCardText(once({ repeat: daily })).split("\n");
    expect(rep[1]).toBe("summarize the day");
    expect(rep[2]).toContain("20:35");
    expect(rep[2]).toContain("כל יום");
  });

  test("a malformed schedule renders as a fixed line instead of throwing", () => {
    const bad = "לוח זמנים לא תקין";
    for (const repeat of [{ hour: 20, minute: 35, days: 5 }, { hour: "x", minute: 0, days: [1] }, { hour: 25, minute: 0, days: [1] }, { hour: 8, minute: 0, days: [9] }, { hour: 8, minute: 0, days: [] }, "daily"]) {
      const lines = ajCardText(once({ repeat: repeat as any })).split("\n");
      expect(lines[1]).toBe("summarize the day");
      expect(lines[2]).toBe(bad);
    }
    expect(ajCardText(once({ fireAt: "soon" as any })).split("\n")[2]).toBe(bad);
  });

  test("a long job text is cut to the card limit, says how much is hidden, and keeps the schedule", () => {
    const text = "x".repeat(10_000);
    const card = ajCardText(once({ text: "[AUTO] " + text, repeat: daily }));
    expect(card.length).toBeLessThanOrEqual(CARD_MAX);
    const lines = card.split("\n");
    const shown = lines[1].length;
    expect(lines[2]).toBe(hiddenLine(10_000 - shown));
    expect(lines[3]).toContain("20:35");
    expect(ajCardText(once()).includes("תווים לא מוצגים")).toBe(false); // nothing cut, no line
  });

  test("bidi and zero-width controls in a card's text become a visible marker", () => {
    const codes = [
      0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
      0x061c, 0x2028, 0x2029, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x00ad, 0x180e,
    ];
    const hidden = codes.map((c) => String.fromCharCode(c)).join("");
    const job = ajCardText(once({ text: `[AUTO] run a${hidden}b` }));
    for (const c of codes) expect(job.includes(String.fromCharCode(c))).toBe(false);
    expect(job.split("\n")[1]).toBe(`run a${HIDDEN_MARK.repeat(codes.length)}b`);
    const skill = asCardText("alpha-skill", `d${hidden}`, `b${hidden}`);
    for (const c of codes) expect(skill.includes(String.fromCharCode(c))).toBe(false);
    expect(skill).toContain(`d${HIDDEN_MARK.repeat(codes.length)}`);
    expect(skill).toContain(`b${HIDDEN_MARK.repeat(codes.length)}`);
  });

  // Tag characters (U+E0000-E007F), variation selectors and the other default-ignorable code points
  // spell text no one sees; each becomes the marker, one marker per code point.
  const DEFAULT_IGNORABLE = [
    0xe0001, 0xe0041, 0xe007f, 0xe0000, 0xfe00, 0xfe0f, 0xe0100, 0xe01ef, 0x034f, 0x115f, 0x1160, 0x3164, 0xffa0, 0x17b4, 0x17b5,
    0x180b, 0x180c, 0x180d, 0x1d173, 0x1d17a, 0x200d,
  ];
  test("tag characters, variation selectors and other default-ignorable code points become the marker", () => {
    const hidden = DEFAULT_IGNORABLE.map((c) => String.fromCodePoint(c)).join("");
    const line = ajCardText(once({ text: `[AUTO] run a${hidden}b` })).split("\n")[1];
    expect(line).toBe(`run a${HIDDEN_MARK.repeat(DEFAULT_IGNORABLE.length)}b`);
    for (const c of DEFAULT_IGNORABLE) expect(hasHidden(`x${String.fromCodePoint(c)}y`)).toBe(true);
    expect(hasHidden("run the nightly summary, שלום")).toBe(false);
    // a tag run that spells "IGNORE" between visible words
    const tags = [..."IGNORE"].map((ch) => String.fromCodePoint(0xe0000 + ch.charCodeAt(0))).join("");
    expect(asCardText("alpha-skill", "d", `step${tags} one`)).toContain(`step${HIDDEN_MARK.repeat(6)} one`);
  });

  test("this file and approvals.ts hold no literal invisible character", () => {
    for (const f of ["approvals.ts", "approvals.test.ts"]) {
      const src = readFileSync(join(import.meta.dir, f), "utf8");
      expect(hasHidden(src)).toBe(false);
    }
  });
});

describe("popDue with the approval hold", () => {
  let dir = "";
  beforeEach(() => {
    dir = tmp("approvals-rem-");
    process.env.REMINDERS_FILE = join(dir, "reminders.json");
  });

  test("a held due one-time job stays untouched, and runs once it is approved", () => {
    const now = Math.floor(Date.now() / 1000);
    const job = addOnce(100, now - 60, "[AUTO] summarize the day");
    const ping = addOnce(100, now - 60, "call the bank");
    const path = join(dir, "approvals.json");
    const hold = (r: Reminder) => r.text.startsWith("[AUTO] ") && !isJobApproved(loadApprovals(path), r);

    const first = popDue(now, hold);
    expect(first.map((r) => r.id)).toEqual([ping.id]);
    expect(loadStore()).toEqual([job]); // held exactly as it was
    expect(popDue(now, hold)).toEqual([]);

    mutateApprovals(path, (a) => void a.jobs.approved.push(jobKey(job)));
    expect(popDue(now, hold).map((r) => r.id)).toEqual([job.id]);
    expect(loadStore()).toEqual([]);
  });

  test("a held repeating job is neither fired nor rescheduled", () => {
    const now = Math.floor(Date.now() / 1000);
    const job = addRepeat(100, 20, 35, [0, 1, 2, 3, 4, 5, 6], "[AUTO] nightly", now - 2 * 86_400);
    expect(job.fireAt).toBeLessThan(now);
    expect(popDue(now, () => true)).toEqual([]);
    expect(loadStore()[0].fireAt).toBe(job.fireAt);
  });

  test("without a hold, popDue is unchanged", () => {
    const now = Math.floor(Date.now() / 1000);
    addOnce(100, now - 60, "[AUTO] summarize the day");
    expect(popDue(now).length).toBe(1);
  });

  test("approvalHold: one approved key, one-time or repeating, lets one job through per pop; duplicates stay held", () => {
    const now = Math.floor(Date.now() / 1000);
    const path = join(dir, "approvals.json");
    const job: Reminder = { id: "r1", chatId: 100, fireAt: now - 60, text: "[AUTO] summarize the day", repeat: null };
    const rep: Reminder = { id: "r2", chatId: 100, fireAt: now - 60, text: "[AUTO] nightly", repeat: daily };
    // a turn wrote three copies of the approved one-time job (same id, chat and text) and two of a repeat
    writeFileSync(process.env.REMINDERS_FILE!, JSON.stringify([job, { ...job }, { ...job }, rep, { ...rep }]));
    mutateApprovals(path, (a) => void a.jobs.approved.push(jobKey(job), jobKey(rep)));
    const held: string[] = [];
    const first = popDue(now, approvalHold(path, (r, _k, why) => held.push(`${r.id} ${why}`)));
    expect(first.filter((r) => r.id === "r1").length).toBe(1);
    expect(first.filter((r) => r.id === "r2").length).toBe(1); // one repeat per approved key too
    expect(held).toEqual(["r1 duplicate", "r1 duplicate", "r2 duplicate"]); // held as copies, not as waiting for approval
    // the run uses the approval up: the copies left behind stay held on the next pop
    expect(consumeOnceApproval(path, job)).toBe(true);
    expect(popDue(now, approvalHold(path)).filter((r) => r.id === "r1")).toEqual([]);
    expect(loadStore().filter((r) => r.id === "r1").length).toBe(2);
  });

  test("an approved repeat key that passed within 60 minutes holds its clones across pops; the rescheduled original passes later", () => {
    const now = Math.floor(Date.now() / 1000);
    const path = join(dir, "approvals.json");
    const rep: Reminder = { id: "r2", chatId: 100, fireAt: now - 60, text: "[AUTO] nightly", repeat: daily };
    // a turn planted a clone with a past fire time (fireAt 0 runs "any time")
    writeFileSync(process.env.REMINDERS_FILE!, JSON.stringify([rep, { ...rep, fireAt: 0 }]));
    mutateApprovals(path, (a) => void a.jobs.approved.push(jobKey(rep)));
    const passedAt = new Map<string, number>();
    const held: string[] = [];
    const pop = (t: number) => popDue(t, approvalHold(path, (r, _k, why) => held.push(`${r.id} ${why}`), passedAt, () => t));
    expect(pop(now).length).toBe(1);
    expect(pop(now + 30)).toEqual([]); // the next tick: the clone is the only due copy, and it is held
    expect(pop(now + 50 * 60)).toEqual([]);
    expect(held).toEqual(["r2 duplicate", "r2 duplicate", "r2 duplicate"]);
    expect(passedAt.get(jobKey(rep))).toBe(now);
    // 61 minutes later the original, rescheduled and due again, passes
    const later = now + 61 * 60;
    writeFileSync(process.env.REMINDERS_FILE!, JSON.stringify([{ ...rep, fireAt: later - 5 }]));
    expect(pop(later).map((r) => r.id)).toEqual(["r2"]);
    expect(passedAt.get(jobKey(rep))).toBe(later);
    // a one-time key keeps its own rule (used up at pop), the map is not consulted
    const one: Reminder = { id: "r3", chatId: 100, fireAt: later - 5, text: "[AUTO] once", repeat: null };
    writeFileSync(process.env.REMINDERS_FILE!, JSON.stringify([one]));
    mutateApprovals(path, (a) => void a.jobs.approved.push(jobKey(one)));
    expect(pop(later + 30).map((r) => r.id)).toEqual(["r3"]);
    expect(passedAt.has(jobKey(one))).toBe(false);
  });

  test("approvalHold holds an unapproved [AUTO] job and never a plain reminder", () => {
    const path = join(dir, "approvals.json");
    const why: string[] = [];
    const hold = approvalHold(path, (_r, _k, w) => why.push(w));
    expect(hold(once())).toBe(true);
    expect(hold(once({ text: "call the bank" }))).toBe(false);
    expect(why).toEqual(["waiting"]);
  });

  test("two pops of one approved once key, consumed right after the first pop: only the first passes", () => {
    // What checkReminders does: pop, then use up every popped one-time approval before any await, so
    // an overlapping run (the 30 s tick, a ✓ tap) builds its hold on the approval already gone.
    const now = Math.floor(Date.now() / 1000);
    const path = join(dir, "approvals.json");
    const job: Reminder = { id: "r1", chatId: 100, fireAt: now - 60, text: "[AUTO] summarize the day", repeat: null };
    writeFileSync(process.env.REMINDERS_FILE!, JSON.stringify([job, { ...job }]));
    mutateApprovals(path, (a) => void a.jobs.approved.push(jobKey(job)));
    const pop = () => {
      const due = popDue(now, approvalHold(path));
      for (const r of due) consumeOnceApproval(path, r);
      return due;
    };
    expect(pop().length).toBe(1);
    expect(pop()).toEqual([]);
    expect(loadStore().length).toBe(1); // the copy stays, held, until approved again
  });
});

describe("the approvals file", () => {
  test("missing or empty loads as the empty default; corrupt is treated as empty and left in place", () => {
    const d = tmp();
    const p = join(d, "approvals.json");
    expect(loadApprovals(p)).toEqual(emptyApprovals());
    writeFileSync(p, "");
    expect(loadApprovals(p)).toEqual(emptyApprovals());
    writeFileSync(p, "{not json");
    const errs: string[] = [];
    const saved = console.error;
    console.error = (...x: unknown[]) => void errs.push(x.join(" "));
    try {
      expect(loadApprovals(p)).toEqual(emptyApprovals());
    } finally {
      console.error = saved;
    }
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("treated as empty");
    expect(readFileSync(p, "utf8")).toBe("{not json"); // a load never rewrites it
  });

  test("a stored file round-trips; junk fields are dropped", () => {
    const p = join(tmp(), "approvals.json");
    mutateApprovals(p, (a) => {
      a.jobs.approved.push("k1");
      a.jobs.carded[T1] = jobCard("k1", "r1");
      a.skills.rejected.push("s:1");
      a.skills.carded[T2] = skillCard("s:2");
    });
    const a = loadApprovals(p);
    expect(a.v).toBe(1);
    expect(a.jobs.approved).toEqual(["k1"]);
    expect(a.jobs.carded).toEqual({ [T1]: jobCard("k1", "r1") });
    expect(a.skills.rejected).toEqual(["s:1"]);
    expect(a.skills.carded).toEqual({ [T2]: skillCard("s:2") });
    writeFileSync(
      p,
      JSON.stringify({
        v: 1,
        jobs: {
          approved: ["ok", 3, null],
          carded: { [T1]: jobCard("k", "r1"), [T2]: skillCard("wrong-kind"), "not-a-token": jobCard("k", "r1"), aaaaaaaaaaaaaaaa: 5 },
        },
        skills: "nope",
      }),
    );
    expect(loadApprovals(p)).toEqual({ v: 1, jobs: { approved: ["ok"], carded: { [T1]: jobCard("k", "r1") } }, skills: { approved: [], rejected: [], carded: {} } });
  });

  test("mutateApprovals never writes over a file it could not read; the action is not done", () => {
    const p = join(tmp(), "approvals.json");
    writeFileSync(p, "{corrupt but holding approvals");
    const errs: string[] = [];
    const saved = console.error;
    console.error = (...x: unknown[]) => void errs.push(x.join(" "));
    let ran = false;
    try {
      expect(() => mutateApprovals(p, () => void (ran = true))).toThrow("not overwriting");
    } finally {
      console.error = saved;
    }
    expect(ran).toBe(false);
    expect(readFileSync(p, "utf8")).toBe("{corrupt but holding approvals");
    expect(errs).toContain("[ERR] approvals.json unreadable: not overwriting");
  });

  test("a one-time approval is used up when the job runs; a repeating one is kept", () => {
    const p = join(tmp(), "approvals.json");
    const one = once();
    const rep = once({ id: "r2", repeat: daily });
    mutateApprovals(p, (a) => {
      a.jobs.approved.push(jobKey(one), jobKey(rep));
      a.jobs.carded[T1] = jobCard(jobKey(one), one.id);
    });
    expect(consumeOnceApproval(p, one)).toBe(true);
    expect(isJobApproved(loadApprovals(p), one)).toBe(false);
    expect(loadApprovals(p).jobs.carded).toEqual({});
    expect(consumeOnceApproval(p, rep)).toBe(false);
    expect(isJobApproved(loadApprovals(p), rep)).toBe(true);
  });

  test("consuming an approval that is not there writes nothing", () => {
    const p = join(tmp(), "approvals.json");
    expect(consumeOnceApproval(p, once())).toBe(false);
    expect(existsSync(p)).toBe(false);
  });

  test("mutateApprovals from two processes at once keeps every change", async () => {
    const d = tmp();
    const p = join(d, "approvals.json");
    const child = join(d, "child.ts");
    const mod = pathToFileURL(join(import.meta.dir, "approvals.ts")).href;
    writeFileSync(
      child,
      `const { mutateApprovals } = await import(${JSON.stringify(mod)});\n` +
        `for (let i = 0; i < 60; i++) { mutateApprovals(${JSON.stringify(p)}, (a) => void a.jobs.approved.push("c" + i)); Bun.sleepSync(1); }\n`,
    );
    const proc = Bun.spawn([process.execPath, child], { stdout: "ignore", stderr: "pipe" });
    // start once the child is writing, so the two loops really overlap
    const t0 = Date.now();
    while (!loadApprovals(p).jobs.approved.includes("c0") && Date.now() - t0 < 15_000) await Bun.sleep(5);
    for (let i = 0; i < 60; i++) {
      mutateApprovals(p, (a) => void a.jobs.approved.push("p" + i));
      Bun.sleepSync(1);
    }
    expect(await proc.exited).toBe(0);
    const got = new Set(loadApprovals(p).jobs.approved);
    for (let i = 0; i < 60; i++) {
      expect(got.has("c" + i)).toBe(true);
      expect(got.has("p" + i)).toBe(true);
    }
  }, 30_000);
});

describe("skill keys and the gate", () => {
  const BODY = "## Steps\n1. Open cal.ts and run the find command.\n2. Confirm the uid, then edit.";
  function setup() {
    const db = openDb(":memory:");
    const dir = tmp("approvals-skills-");
    createSkill(db, dir, { name: "alpha-skill", description: "Use when alpha calendar things happen", source: "maor", body: BODY, now: 1 });
    createSkill(db, dir, { name: "beta-skill", description: "Use when beta calendar things happen", source: "maor", body: BODY, now: 1 });
    return { db, dir };
  }
  const keyOf = (dir: string, db: any, name: string) => {
    const row = getSkill(db, name)!;
    return skillKey(row.name, row.description, readFileSync(skillBodyPath(dir, row), "utf8"));
  };

  test("the key is the name and a full sha-256; it changes with the file or the description", () => {
    const k = skillKey("alpha-skill", "desc", "file");
    expect(k).toMatch(/^alpha-skill:[0-9a-f]{64}$/);
    expect(skillKey("alpha-skill", "desc", "file2")).not.toBe(k);
    expect(skillKey("alpha-skill", "desc2", "file")).not.toBe(k);
    expect(skillKey("beta-skill", "desc", "file")).not.toBe(k);
  });

  test("moving text between the description and the body changes the key", () => {
    const k = skillKey("alpha-skill", "a\nb", "c");
    expect(skillKey("alpha-skill", "a", "b\nc")).not.toBe(k);
    expect(skillKey("alpha-skill", "a\nb\nc", "")).not.toBe(k);
    expect(skillKey("alpha-skill", "", "a\nb\nc")).not.toBe(k);
  });

  test("the gate passes an approved skill only, and an edit needs a new approval", () => {
    const { db, dir } = setup();
    const a = emptyApprovals();
    a.skills.approved.push(keyOf(dir, db, "alpha-skill"));
    a.skills.rejected.push(keyOf(dir, db, "beta-skill"));
    const gate = skillGate(a, dir);
    expect(gate(getSkill(db, "alpha-skill")!)).toBe(true);
    expect(gate(getSkill(db, "beta-skill")!)).toBe(false); // rejected
    expect(skillGate(emptyApprovals(), dir)(getSkill(db, "alpha-skill")!)).toBe(false); // unapproved
    writeFileSync(skillBodyPath(dir, getSkill(db, "alpha-skill")!), "---\nname: alpha-skill\ndescription: x\n---\nchanged\n");
    expect(gate(getSkill(db, "alpha-skill")!)).toBe(false);
    // a missing body is never approved
    rmSync(skillBodyPath(dir, getSkill(db, "beta-skill")!));
    expect(skillGate(a, dir)(getSkill(db, "beta-skill")!)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("the gate refuses a linked body even when the target's key is approved", () => {
    const { db, dir } = setup();
    const row = getSkill(db, "alpha-skill")!;
    const target = join(tmp(), "target.md");
    writeFileSync(target, readFileSync(skillBodyPath(dir, row), "utf8"));
    const a = emptyApprovals();
    a.skills.approved.push(keyOf(dir, db, "alpha-skill"));
    rmSync(skillBodyPath(dir, row));
    symlinkSync(target, skillBodyPath(dir, row));
    expect(skillGate(a, dir)(row)).toBe(false);
  });

  test("viewSkill reads the file once: the gate hashes exactly the bytes it returns", () => {
    const { db, dir } = setup();
    const a = emptyApprovals();
    a.skills.approved.push(keyOf(dir, db, "alpha-skill"));
    const path = skillBodyPath(dir, getSkill(db, "alpha-skill")!);
    const gate = skillGate(a, dir);
    // A turn swaps the file right after the gate looked: the approved bytes are served, not the swap.
    const racy = (row: any, fileText?: string) => {
      const ok = gate(row, fileText);
      writeFileSync(path, "---\nname: alpha-skill\ndescription: Use when alpha calendar things happen\n---\nSWAPPED body\n");
      return ok;
    };
    const v = viewSkill(db, dir, "alpha-skill", 2, racy);
    expect(v.body).toContain("Open cal.ts");
    expect(v.body).not.toContain("SWAPPED");
    // the swapped file is not approved: the next view refuses it
    expect(() => viewSkill(db, dir, "alpha-skill", 3, gate)).toThrow("waiting for Maor's approval");
    // Array.prototype.filter passes an index where the file text goes: still gated by the file
    expect([getSkill(db, "beta-skill")!].filter(gate as any)).toEqual([]);
    const b = emptyApprovals();
    b.skills.approved.push(keyOf(dir, db, "beta-skill"));
    expect([getSkill(db, "beta-skill")!].filter(skillGate(b, dir) as any).length).toBe(1);
  });

  test("viewSkill through the gate refuses an unapproved skill with the approval message", () => {
    const { db, dir } = setup();
    const a = emptyApprovals();
    a.skills.approved.push(keyOf(dir, db, "alpha-skill"));
    expect(viewSkill(db, dir, "alpha-skill", 2, skillGate(a, dir)).body).toContain("Open cal.ts");
    expect(() => viewSkill(db, dir, "beta-skill", 2, skillGate(a, dir))).toThrow(`skill "beta-skill" is waiting for Maor's approval`);
  });

  test("the index block through the gate shows only approved skills", () => {
    const { db, dir } = setup();
    const a = emptyApprovals();
    a.skills.approved.push(keyOf(dir, db, "beta-skill"));
    const block = skillsIndexBlock(db, "calendar things", 1, skillGate(a, dir));
    expect(block).toContain("beta-skill");
    expect(block).not.toContain("alpha-skill");
    expect(skillsIndexBlock(db, "calendar things", 5, skillGate(emptyApprovals(), dir))).toBe("");
  });

  test("skillEntries lists active and stale skills with their current keys; skillNeedsCard once", () => {
    const { db, dir } = setup();
    db.query("UPDATE skills SET status = 'stale' WHERE name = 'beta-skill'").run();
    createSkill(db, dir, { name: "held-skill", description: "Use when held", source: "derived", body: BODY, now: 1 });
    const entries = skillEntries(db, dir);
    expect(entries.map((e) => e.row.name).sort()).toEqual(["alpha-skill", "beta-skill"]);
    const alpha = entries.find((e) => e.row.name === "alpha-skill")!;
    expect(alpha.key).toBe(keyOf(dir, db, "alpha-skill"));
    const a = emptyApprovals();
    expect(skillNeedsCard(a, alpha.key)).toBe(true);
    a.skills.carded[T1] = skillCard(alpha.key);
    expect(skillNeedsCard(a, alpha.key)).toBe(false);
    const b = emptyApprovals();
    b.skills.rejected.push(alpha.key);
    expect(skillNeedsCard(b, alpha.key)).toBe(false);
  });

  test("the skill card shows the name, the description and the body from its start", () => {
    const body = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n");
    const lines = asCardText("alpha-skill", "Use when alpha", body).split("\n");
    expect(lines).toEqual(["כישור חדש או שהשתנה מחכה לאישור שלך", "alpha-skill", "Use when alpha", "l1", "l2", "l3", "l4", "l5", "l6", "l7"]);
    expect(skillBodyText("---\nname: a-b\ndescription: d\n---\nfirst\n\nsecond\n")).toBe("first\n\nsecond");
    expect(skillBodyText("no frontmatter\nline")).toBe("no frontmatter\nline");
  });

  test("a long skill is cut to the card limit and says how many characters are not shown", () => {
    const body = Array.from({ length: 2000 }, (_, i) => `step ${i}`).join("\n");
    const card = asCardText("alpha-skill", "Use when alpha", body);
    expect(card.length).toBeLessThanOrEqual(CARD_MAX);
    const lines = card.split("\n");
    expect(lines.slice(0, 4)).toEqual(["כישור חדש או שהשתנה מחכה לאישור שלך", "alpha-skill", "Use when alpha", "step 0"]);
    const last = lines[lines.length - 1];
    const shownItem = lines.slice(2, -1).join("\n"); // the description and the body as shown
    const item = `Use when alpha\n${body}`;
    expect(item.startsWith(shownItem)).toBe(true);
    expect(last).toBe(hiddenLine(item.length - shownItem.length));
    // a huge description is cut too, never the header
    const big = asCardText("alpha-skill", "d".repeat(9000), "b");
    expect(big.length).toBeLessThanOrEqual(CARD_MAX);
    expect(big.split("\n")[0]).toBe("כישור חדש או שהשתנה מחכה לאישור שלך");
    expect(big.split("\n").at(-1)).toMatch(/^עוד \d+ תווים לא מוצגים$/);
  });

  test("the skill callback carries only the card's token and parses back", () => {
    const [yes, no] = buttons(asKeyboard(T1));
    expect(yes.callback_data).toBe(`as:${T1}:y`);
    expect(parseAsCallback(yes.callback_data)).toEqual({ token: T1, act: "y" });
    expect(parseAsCallback(no.callback_data)).toEqual({ token: T1, act: "n" });
    expect(parseAsCallback("as:0123abcd:y")).toBeNull(); // the old key8 form is gone
    expect(parseAsCallback(`aj:${T1}:y`)).toBeNull();
  });
});

describe("taps", () => {
  test("a job ✓ approves exactly the carded key; ✗ asks for removal; an unknown token is stale", () => {
    const r = once({ id: "r7" });
    const list = [r, once({ id: "r8", text: "plain reminder" })];
    const a = emptyApprovals();
    a.jobs.carded[T1] = jobCard(jobKey(r), "r7");
    expect(applyJobTap(a, list, { token: T1, act: "y" })).toEqual({ outcome: "approve", r });
    expect(isJobApproved(a, r)).toBe(true);
    applyJobTap(a, list, { token: T1, act: "y" });
    expect(a.jobs.approved.length).toBe(1); // no duplicate
    const b = emptyApprovals();
    b.jobs.carded[T1] = jobCard(jobKey(r), "r7");
    expect(applyJobTap(b, list, { token: T1, act: "n" })).toEqual({ outcome: "remove", r });
    expect(isJobApproved(b, r)).toBe(false);
    expect(b.jobs.carded).toEqual({});
    expect(applyJobTap(emptyApprovals(), list, { token: T2, act: "y" })).toEqual({ outcome: "stale" }); // never carded
    const gone = emptyApprovals();
    gone.jobs.carded[T1] = jobCard(jobKey(r), "r7");
    expect(applyJobTap(gone, [], { token: T1, act: "y" })).toEqual({ outcome: "stale" }); // job gone
    // a skill card's token is never a job tap
    const wrong = emptyApprovals();
    wrong.skills.carded[T1] = skillCard(jobKey(r));
    expect(applyJobTap(wrong, list, { token: T1, act: "y" })).toEqual({ outcome: "stale" });
  });

  test("regression: a ✓ on T's card never approves M, even when M's key shares T's first 8 hex", () => {
    // Brute-force two texts whose job keys share their first 32 bits (what the old callback carried).
    const seen = new Map<string, string>();
    let T = "";
    let M = "";
    for (let i = 0; !M; i++) {
      const text = `[AUTO] job ${i}`;
      const k8 = jobKey(once({ id: "r7", text })).slice(0, 8);
      const prev = seen.get(k8);
      if (prev) [T, M] = [prev, text];
      else seen.set(k8, text);
    }
    const t = once({ id: "r7", text: T });
    const m = once({ id: "r7", text: M });
    expect(jobKey(m).slice(0, 8)).toBe(jobKey(t).slice(0, 8));
    expect(jobKey(m)).not.toBe(jobKey(t));

    const a = emptyApprovals();
    a.jobs.carded[T1] = jobCard(jobKey(t), "r7"); // the card showed T
    // the turn swaps the text to M after the card: the owner's ✓ on T's card is stale
    expect(applyJobTap(a, [m], { token: T1, act: "y" })).toEqual({ outcome: "stale" });
    expect(isJobApproved(a, m)).toBe(false);
    expect(isJobApproved(a, t)).toBe(false);
    // and M is a new job that gets its own card
    expect(jobNeedsCard(a, m)).toBe(true);
  });

  test("a skill ✓ approves exactly the carded key; ✗ rejects it; an edited skill is stale", () => {
    const e = { row: { name: "alpha-skill" } as any, key: skillKey("alpha-skill", "d", "f"), fileText: "f" };
    const a = emptyApprovals();
    a.skills.carded[T1] = skillCard(e.key);
    expect(applySkillTap(a, [e], { token: T1, act: "n" })).toEqual({ outcome: "rejected", name: "alpha-skill" });
    expect(a.skills.rejected).toEqual([e.key]);
    expect(applySkillTap(a, [e], { token: T1, act: "y" })).toEqual({ outcome: "approved", name: "alpha-skill" });
    expect(a.skills.approved).toEqual([e.key]);
    expect(a.skills.rejected).toEqual([]);
    const edited = { ...e, key: skillKey("alpha-skill", "d", "f2") };
    const b = emptyApprovals();
    b.skills.carded[T1] = skillCard(e.key);
    expect(applySkillTap(b, [edited], { token: T1, act: "y" })).toEqual({ outcome: "stale" });
    expect(b.skills.approved).toEqual([]);
    expect(skillNeedsCard(b, edited.key)).toBe(true); // the edited version gets its own card
    expect(applySkillTap(emptyApprovals(), [e], { token: T2, act: "y" })).toEqual({ outcome: "stale" });
  });
});

describe("a round of cards", () => {
  const BODY = "## Steps\n1. Do the thing.";
  const entry = (name: string): SkillEntry => {
    const fileText = `---\nname: ${name}\ndescription: Use when ${name}\n---\n${BODY}\n`;
    return { row: { name, description: `Use when ${name}` } as any, key: skillKey(name, `Use when ${name}`, fileText), fileText };
  };
  let n = 0; // token counter shared by every round, as real tokens never repeat
  function round(path: string, jobs: Reminder[] | null, skills: SkillEntry[] | null, send: (text: string, kb: any) => Promise<unknown>, logs: string[], failLogged = new Map<string, number>(), clock = { t: 1000 }, state?: CardState) {
    return sendCardRound({ path, jobs, skills, send, now: () => clock.t, log: (l) => logs.push(l), failLogged, token: () => (++n).toString(16).padStart(16, "0"), state });
  }

  test("each card is recorded with its token only after its send succeeds; later items still get cards", async () => {
    const p = join(tmp(), "approvals.json");
    const sent: Array<{ text: string; kb: any }> = [];
    const logs: string[] = [];
    const jobs = [once({ id: "r1", text: "[AUTO] first" }), once({ id: "r2", text: "[AUTO] second" })];
    const out = await round(p, jobs, [entry("alpha-skill")], async (text, kb) => {
      if (text.includes("first")) throw new Error("Bad Request: message is too long");
      sent.push({ text, kb });
    }, logs);
    expect(out).toEqual({ sent: 2, unreadable: false });
    expect(sent.map((s) => s.text.split("\n")[1])).toEqual(["second", "alpha-skill"]);
    const a = loadApprovals(p);
    expect(Object.values(a.jobs.carded).map((c) => c.id)).toEqual(["r2"]); // r1 failed: not carded
    expect(jobNeedsCard(a, jobs[0])).toBe(true);
    expect(skillNeedsCard(a, entry("alpha-skill").key)).toBe(false);
    // the button names the recorded token
    const token = buttons(sent[0].kb)[0].callback_data.split(":")[1];
    expect(a.jobs.carded[token]).toEqual({ kind: "job", key: jobKey(jobs[1]), id: "r2", at: 1000 });
    expect(logs.filter((l) => l.startsWith("[ERR] approval card job r1"))).toHaveLength(1);
  });

  test("a failing item is logged once an hour, not every round", async () => {
    const p = join(tmp(), "approvals.json");
    const logs: string[] = [];
    const failLogged = new Map<string, number>();
    const clock = { t: 1000 };
    const boom = async () => {
      throw new Error("refused");
    };
    const jobs = [once({ id: "r1" })];
    await round(p, jobs, null, boom, logs, failLogged, clock);
    clock.t += 30;
    await round(p, jobs, null, boom, logs, failLogged, clock);
    expect(logs.filter((l) => l.startsWith("[ERR]"))).toHaveLength(1);
    clock.t += 3600;
    await round(p, jobs, null, boom, logs, failLogged, clock);
    expect(logs.filter((l) => l.startsWith("[ERR]"))).toHaveLength(2);
  });

  test("a malformed or oversized job never stops the round", async () => {
    const p = join(tmp(), "approvals.json");
    const sent: string[] = [];
    const jobs = [
      once({ id: "r1", text: "[AUTO] odd schedule", repeat: { hour: 8, minute: 0, days: 5 as any } }),
      once({ id: "r2", text: "[AUTO] " + "y".repeat(20_000) }),
      null as any, // a turn can write anything into the store
      once({ id: "r3", text: "[AUTO] last" }),
    ];
    const out = await round(p, jobs, null, async (text) => void sent.push(text), []);
    expect(out.sent).toBe(3);
    for (const t of sent) expect(t.length).toBeLessThanOrEqual(CARD_MAX);
    expect(sent[0].split("\n")[2]).toBe("לוח זמנים לא תקין");
    expect(sent[2].split("\n")[1]).toBe("last");
  });

  test("at most `cap` cards per round; nothing is sent while the file cannot be read", async () => {
    const p = join(tmp(), "approvals.json");
    const jobs = Array.from({ length: 8 }, (_, i) => once({ id: `r${i}`, text: `[AUTO] job ${i}` }));
    const sent: string[] = [];
    expect((await round(p, jobs, null, async (t) => void sent.push(t), [])).sent).toBe(5);
    expect((await round(p, jobs, null, async (t) => void sent.push(t), [])).sent).toBe(3);
    expect((await round(p, jobs, null, async (t) => void sent.push(t), [])).sent).toBe(0);
    writeFileSync(p, "{corrupt");
    const saved = console.error;
    console.error = () => {};
    try {
      const sentBefore = sent.length;
      expect(await round(p, [once({ id: "r9", text: "[AUTO] new" })], null, async (t) => void sent.push(t), [])).toEqual({ sent: 0, unreadable: true });
      expect(sent.length).toBe(sentBefore);
    } finally {
      console.error = saved;
    }
  });

  test("an item with hidden characters is never carded: logged and noticed once per key, and stays held", async () => {
    const p = join(tmp(), "approvals.json");
    const tag = String.fromCodePoint(0xe0041);
    const vs = String.fromCodePoint(0xfe0f);
    const jobs = [once({ id: "r1", text: `[AUTO] run${tag} it` }), once({ id: "r2", text: "[AUTO] plain job" })];
    const bad = entry("beta-skill");
    const badSkill: SkillEntry = { ...bad, fileText: bad.fileText.replace("Do the thing", `Do${vs} the thing`) };
    badSkill.key = skillKey("beta-skill", "Use when beta-skill", badSkill.fileText);
    const sent: Array<{ text: string; kb: any }> = [];
    const logs: string[] = [];
    const state = newCardState();
    const send = async (text: string, kb: any) => void sent.push({ text, kb });
    await round(p, jobs, [badSkill], send, logs, new Map(), { t: 1000 }, state);
    await round(p, jobs, [badSkill], send, logs, new Map(), { t: 1030 }, state);
    expect(sent.filter((s) => s.kb).map((s) => s.text.split("\n")[1])).toEqual(["plain job"]); // only the clean job is carded
    // one per key, not per round, each naming its item on its own line
    expect(sent.filter((s) => s.kb === undefined).map((s) => s.text)).toEqual([hiddenNotice("r1"), hiddenNotice("beta-skill")]);
    expect(logs.filter((l) => l === "[AUTO] held r1 (hidden characters)")).toHaveLength(1);
    expect(logs.filter((l) => l === "[SKILL] held beta-skill (hidden characters)")).toHaveLength(1);
    const a = loadApprovals(p);
    expect(jobNeedsCard(a, jobs[0])).toBe(true); // still unapproved: held
    expect(HIDDEN_NOTICE).toBe("פריט עם תווים נסתרים לא יוצג לאישור");
    expect(hiddenNotice("r1")).toBe(`${HIDDEN_NOTICE}\nr1`);
  });

  test("a hidden-item notice is marked sent only after its send succeeds; a hidden name is shown with the marker", async () => {
    const p = join(tmp(), "approvals.json");
    const tag = String.fromCodePoint(0xe0041);
    const e = entry("gamma-skill");
    const named: SkillEntry = { ...e, row: { name: `gam${tag}ma`, description: "Use when gamma-skill" } as any };
    const state = newCardState();
    const sent: string[] = [];
    let down = true;
    const send = async (text: string) => {
      if (down) throw new Error("down");
      sent.push(text);
    };
    const logs: string[] = [];
    await round(p, null, [named], send, logs, new Map(), { t: 1000 }, state);
    expect(sent).toEqual([]);
    down = false;
    await round(p, null, [named], send, logs, new Map(), { t: 1030 }, state); // retried, now sent
    await round(p, null, [named], send, logs, new Map(), { t: 1060 }, state); // and not again
    expect(sent).toEqual([hiddenNotice(JSON.stringify(`gam${HIDDEN_MARK}ma`))]);
    expect(hasHidden(sent[0])).toBe(false);
  });

  test("format characters (Unicode category Cf) count as hidden too", () => {
    for (const c of [0x0600, 0x06dd, 0x110bd, 0xfff9]) expect([c, hasHidden(`a${String.fromCodePoint(c)}b`)]).toEqual([c, true]);
  });

  test("a store that was not read cleanly prunes no job approval", async () => {
    const p = join(tmp(), "approvals.json");
    const r = once({ id: "r1", text: "[AUTO] live" });
    mutateApprovals(p, (a) => void a.jobs.approved.push(jobKey(r)));
    await sendCardRound({ path: p, jobs: [], jobsClean: false, skills: null, send: async () => {}, now: () => 1000, log: () => {}, failLogged: new Map() });
    expect(loadApprovals(p).jobs.approved).toEqual([jobKey(r)]);
    await sendCardRound({ path: p, jobs: [], skills: null, send: async () => {}, now: () => 1000, log: () => {}, failLogged: new Map() });
    expect(loadApprovals(p).jobs.approved).toEqual([]); // a clean, empty store does prune it
  });

  test("a clipped card's full text goes first in plain parts, then the card with both buttons", async () => {
    const p = join(tmp(), "approvals.json");
    const text = "w".repeat(CARD_MAX + 500);
    const sent: Array<{ text: string; kb: any }> = [];
    await round(p, [once({ id: "r1", text: `[AUTO] ${text}` })], null, async (t, kb) => void sent.push({ text: t, kb }), []);
    expect(sent.map((s) => s.kb === undefined)).toEqual([true, true, false]);
    expect(sent[0].text + sent[1].text).toBe(text);
    for (const s of sent) expect(s.text.length).toBeLessThanOrEqual(CARD_MAX);
    expect(buttons(sent[2].kb).map((b) => b.text)).toEqual(["✓ אשר", "✗ מחק"]);
    expect(Object.values(loadApprovals(p).jobs.carded)[0].long).toBeUndefined();
  });

  test("past MAX_PARTS parts the card gets only ✗ and says why; a ✓ on it is never applied", async () => {
    const p = join(tmp(), "approvals.json");
    const r = once({ id: "r1", text: "[AUTO] " + "q".repeat(CARD_MAX * MAX_PARTS + 1) });
    const body = "b".repeat(CARD_MAX * MAX_PARTS + 1);
    const fileText = `---\nname: big-skill\ndescription: d\n---\n${body}\n`;
    const e: SkillEntry = { row: { name: "big-skill", description: "d" } as any, key: skillKey("big-skill", "d", fileText), fileText };
    const sent: Array<{ text: string; kb: any }> = [];
    await round(p, [r], [e], async (t, kb) => void sent.push({ text: t, kb }), []);
    expect(sent).toHaveLength(2); // no parts, two cards
    for (const s of sent) {
      expect(s.text.length).toBeLessThanOrEqual(CARD_MAX);
      expect(s.text.split("\n").at(-1)).toBe(TOO_LONG_LINE);
      expect(buttons(s.kb).map((b) => b.callback_data.endsWith(":n"))).toEqual([true]);
    }
    expect(TOO_LONG_LINE).toBe("ארוך מדי להצגה; אפשר לקצר ולבקש שוב");
    const a = loadApprovals(p);
    const [jt] = Object.keys(a.jobs.carded);
    const [st] = Object.keys(a.skills.carded);
    expect(a.jobs.carded[jt].long).toBe(true);
    expect(loadApprovals(p).skills.carded[st].long).toBe(true); // survives a reload
    expect(applyJobTap(a, [r], { token: jt, act: "y" })).toEqual({ outcome: "stale" });
    expect(applySkillTap(a, [e], { token: st, act: "y" })).toEqual({ outcome: "stale" });
    expect(applyJobTap(a, [r], { token: jt, act: "n" }).outcome).toBe("remove");
    expect(applySkillTap(a, [e], { token: st, act: "n" }).outcome).toBe("rejected");
  });

  test("textParts never splits a surrogate pair", () => {
    const s = "a".repeat(9) + String.fromCodePoint(0x1f600) + "b";
    const parts = textParts(s, 10);
    expect(parts.join("")).toBe(s);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(10);
    expect(parts[0]).toBe("a".repeat(9));
  });

  test("at most MAX_OUTSTANDING unanswered cards; beyond that one count line an hour", async () => {
    const p = join(tmp(), "approvals.json");
    const jobs = Array.from({ length: 14 }, (_, i) => once({ id: `r${i}`, text: `[AUTO] job ${i}` }));
    const sent: Array<{ text: string; kb: any }> = [];
    const send = async (t: string, kb: any) => void sent.push({ text: t, kb });
    const state = newCardState();
    const clock = { t: 1000 };
    for (let i = 0; i < 4; i++) {
      await round(p, jobs, null, send, [], new Map(), clock, state);
      clock.t += 30;
    }
    expect(sent.filter((s) => s.kb)).toHaveLength(MAX_OUTSTANDING);
    expect(outstandingCards(loadApprovals(p))).toBe(MAX_OUTSTANDING);
    const notes = sent.filter((s) => !s.kb).map((s) => s.text);
    expect(notes).toEqual([moreWaitingLine(4)]); // once, not every round
    expect(moreWaitingLine(4)).toBe("4 פריטים נוספים מחכים לאישור");
    clock.t += 3600;
    await round(p, jobs, null, send, [], new Map(), clock, state);
    expect(sent.filter((s) => !s.kb)).toHaveLength(2); // the next hour
    // answering one frees a slot: the next round cards one more
    mutateApprovals(p, (a) => void a.jobs.approved.push(jobKey(jobs[0])));
    await round(p, jobs, null, send, [], new Map(), clock, state);
    expect(sent.filter((s) => s.kb)).toHaveLength(MAX_OUTSTANDING + 1);
  });

  test("each round prunes approvals and cards that match no current item or are answered", async () => {
    const p = join(tmp(), "approvals.json");
    const live = once({ id: "r1", text: "[AUTO] live" });
    const gone = once({ id: "r2", text: "[AUTO] deleted since" });
    const rep = once({ id: "r3", text: "[AUTO] nightly", repeat: daily });
    const e = entry("alpha-skill");
    mutateApprovals(p, (a) => {
      a.jobs.approved.push(jobKey(live), jobKey(gone), jobKey(rep));
      a.jobs.carded[T1] = jobCard(jobKey(live), "r1"); // answered (approved)
      a.jobs.carded["1111111111111111"] = jobCard(jobKey(gone), "r2"); // item gone
      a.skills.approved.push(e.key, "old-skill:" + "0".repeat(64));
      a.skills.rejected.push("kept-rejection:" + "1".repeat(64));
      a.skills.carded[T2] = skillCard(e.key); // answered
      a.skills.carded["2222222222222222"] = skillCard("vanished:" + "2".repeat(64)); // gone
    });
    await round(p, [live, rep], [e], async () => {}, []);
    const a = loadApprovals(p);
    expect(a.jobs.approved.sort()).toEqual([jobKey(live), jobKey(rep)].sort());
    expect(a.jobs.carded).toEqual({});
    expect(a.skills.approved).toEqual([e.key]);
    expect(a.skills.rejected).toEqual(["kept-rejection:" + "1".repeat(64)]);
    expect(a.skills.carded).toEqual({});
    // a gate that is off (a null list) is never pruned
    const b = emptyApprovals();
    b.jobs.approved.push("k");
    expect(pruneApprovals(b, null, null)).toBe(false);
    expect(b.jobs.approved).toEqual(["k"]);
  });
});

describe("seedApprovals", () => {
  const rs: Reminder[] = [
    once({ id: "r1" }),
    once({ id: "r2", text: "call the bank" }),
    once({ id: "r3", text: "[AUTO] weekly", repeat: daily }),
  ];
  const sk = [{ name: "alpha-skill", description: "d", fileText: "f" }];

  test("approves exactly the [AUTO] reminders and the given skills when they equal the expected lines", () => {
    const p = join(tmp(), "approvals.json");
    const expected = keyLines(rs, sk);
    expect(expected).toEqual([`job ${jobKey(rs[0])}`, `job ${jobKey(rs[2])}`, `skill ${skillKey("alpha-skill", "d", "f")}`].sort());
    const out = seedApprovals(p, rs, sk, expected);
    const a: Approvals = loadApprovals(p);
    expect(a.jobs.approved.sort()).toEqual([jobKey(rs[0]), jobKey(rs[2])].sort());
    expect(a.skills.approved).toEqual([skillKey("alpha-skill", "d", "f")]);
    expect(out).toEqual({ ok: true, jobs: ["r1", "r3"], skills: ["alpha-skill"], hidden: 0 });
  });

  test("refuses and writes nothing when the store differs from the expected lines in any way", () => {
    const p = join(tmp(), "approvals.json");
    const expected = keyLines(rs, sk);
    const planted = [...rs, once({ id: "r9", text: "[AUTO] planted after the owner compared" })];
    expect(seedApprovals(p, planted, sk, expected)).toEqual({ ok: false, missing: 0, unexpected: 1 });
    expect(seedApprovals(p, rs.slice(1), sk, expected)).toEqual({ ok: false, missing: 1, unexpected: 0 });
    expect(seedApprovals(p, rs, [{ ...sk[0], fileText: "changed" }], expected)).toEqual({ ok: false, missing: 1, unexpected: 1 });
    expect(seedApprovals(p, [...rs, rs[0]], sk, expected).ok).toBe(false); // a duplicate is a difference too
    expect(existsSync(p)).toBe(false);
  });

  test("replaces approvals.json with a fresh structure, never merging what a turn may have shaped", () => {
    const p = join(tmp(), "approvals.json");
    mutateApprovals(p, (a) => {
      a.jobs.approved.push("planted-key");
      a.jobs.carded[T1] = jobCard("planted-key", "r5");
      a.skills.approved.push("planted:skill");
      a.skills.rejected.push(skillKey("alpha-skill", "d", "f"));
    });
    expect(seedApprovals(p, rs, sk, keyLines(rs, sk)).ok).toBe(true);
    const a = loadApprovals(p);
    expect(a.jobs.approved.sort()).toEqual([jobKey(rs[0]), jobKey(rs[2])].sort());
    expect(a.jobs.carded).toEqual({});
    expect(a.skills).toEqual({ approved: [skillKey("alpha-skill", "d", "f")], rejected: [], carded: {} });
  });

  test("list shows hidden characters as the marker and flags the item; seed leaves such items unapproved", () => {
    const tag = String.fromCodePoint(0xe0041);
    const hiddenJob = once({ id: "r4", text: `[AUTO] run${tag} it` });
    const hiddenSkill = { name: "beta-skill", description: `d${tag}`, fileText: "f" };
    const all = [...rs, hiddenJob];
    const skills = [...sk, hiddenSkill];
    const entries: SkillEntry[] = skills.map((s) => ({ row: { name: s.name, description: s.description } as any, key: skillKey(s.name, s.description, s.fileText), fileText: s.fileText }));
    const lines = listLines(emptyApprovals(), all, entries);
    const out = lines.join("\n");
    expect(hasHidden(out)).toBe(false); // nothing invisible reaches the owner's screen
    expect(lines).toContain(`  text ${JSON.stringify(`run${HIDDEN_MARK} it`)}`);
    expect(lines).toContain(`  description ${JSON.stringify(`d${HIDDEN_MARK}`)}`);
    expect(lines.filter((l) => l.endsWith("(hidden characters)"))).toHaveLength(2);
    expect(lines.find((l) => l.startsWith('  id "r1"'))).not.toContain("hidden");
    const p = join(tmp(), "approvals.json");
    const out2 = seedApprovals(p, all, skills, keyLines(all, skills));
    expect(out2).toEqual({ ok: true, jobs: ["r1", "r3"], skills: ["alpha-skill"], hidden: 2 });
    const a = loadApprovals(p);
    expect(a.jobs.approved.includes(jobKey(hiddenJob))).toBe(false);
    expect(a.skills.approved).toEqual([skillKey("alpha-skill", "d", "f")]);
  });

  test("a chat id holding hidden characters is shown with the marker, flagged, and left unapproved by seed", () => {
    const tag = String.fromCodePoint(0xe0041);
    const odd = { ...once({ id: "r5", text: "[AUTO] plain text" }), chatId: `100${tag}` as any };
    const lines = listLines(emptyApprovals(), [odd], []);
    expect(hasHidden(lines.join("\n"))).toBe(false);
    expect(lines.find((l) => l.startsWith('  id "r5"'))).toBe(`  id "r5", chat ${JSON.stringify(`100${HIDDEN_MARK}`)}, once, waiting (hidden characters)`);
    const p = join(tmp(), "approvals.json");
    expect(seedApprovals(p, [odd], [], keyLines([odd], []))).toEqual({ ok: true, jobs: [], skills: [], hidden: 1 });
  });

  test("parseKeyLines ignores blank lines and line endings, and sorts", () => {
    expect(parseKeyLines("skill b\r\n\njob a\n")).toEqual(["job a", "skill b"]);
  });

  test("listLines shows each item's key line, full text as JSON and a skill's body sha256", () => {
    const fileText = "---\nname: alpha-skill\ndescription: d\n---\nline one\nline two\n";
    const e: SkillEntry = { row: { name: "alpha-skill", description: "d" } as any, key: skillKey("alpha-skill", "d", fileText), fileText };
    const long = "[AUTO] " + "z".repeat(500) + "\njob fake";
    const lines = listLines(emptyApprovals(), [once({ id: "r1", text: long }), once({ id: "r2", text: "plain" })], [e]);
    expect(lines).toContain(`job ${jobKey(once({ id: "r1", text: long }))}`);
    expect(lines).toContain(`  text ${JSON.stringify("z".repeat(500) + "\njob fake")}`); // full, one line
    expect(lines.filter((l) => l.startsWith("job "))).toHaveLength(1); // a newline in a text fakes no key line
    expect(lines).toContain(`skill ${e.key}`);
    expect(lines).toContain(`  body sha256 ${createHash("sha256").update("line one\nline two").digest("hex")}`);
    expect(lines.join("\n")).not.toContain("plain");
  });
});

describe("approvals.ts seed|list", () => {
  test("list --keys writes the key lines; seed --expect approves them; a changed store is refused", () => {
    const state = tmp("approvals-seed-");
    mkdirSync(join(state, "shared", "stores"), { recursive: true });
    const rs: Reminder[] = [once({ id: "r1" }), once({ id: "r2", text: "call the bank" })];
    const storeFile = join(state, "shared", "stores", "reminders.json");
    writeFileSync(storeFile, JSON.stringify(rs));
    const env: Record<string, string | undefined> = { ...process.env, STATE_DIR: state };
    delete env.REMINDERS_FILE;
    const cli = (...args: string[]) => {
      const r = Bun.spawnSync({ cmd: [process.execPath, "run", join(import.meta.dir, "approvals.ts"), ...args], env: env as Record<string, string>, cwd: import.meta.dir });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    };
    const keys = join(state, "r8-expected.txt");
    expect(cli("seed").code).toBe(1); // --expect is required
    const listed = cli("list", "--keys", keys);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain(`job ${jobKey(rs[0])}`);
    expect(readFileSync(keys, "utf8")).toBe(`job ${jobKey(rs[0])}\n`);

    // a job added after the owner compared: refused, nothing written
    writeFileSync(storeFile, JSON.stringify([...rs, once({ id: "r3", text: "[AUTO] planted" })]));
    const refused = cli("seed", "--expect", keys);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("REFUSED");
    expect(existsSync(join(state, "approvals.json"))).toBe(false);

    writeFileSync(storeFile, JSON.stringify(rs));
    const seeded = cli("seed", "--expect", keys);
    expect(seeded.code).toBe(0);
    expect(seeded.out).toContain("approved 1 [AUTO] job(s): r1");
    expect(loadApprovals(join(state, "approvals.json")).jobs.approved).toEqual([jobKey(rs[0])]);
    const list = cli("list");
    expect(list.out).toContain('id "r1", chat 100, once, approved');
    expect(list.out).not.toContain("r2");
    expect(cli("nonsense").code).not.toBe(0);
  }, 60_000);
});

describe("skill.ts with SKILL_APPROVAL=1", () => {
  test("view, search and list show only approved skills; nothing is approved without the file", () => {
    const state = tmp("approvals-cli-");
    mkdirSync(join(state, "shared"), { recursive: true });
    const env = { ...process.env, STATE_DIR: state };
    delete (env as any).SKILL_APPROVAL;
    const cli = (args: string[], extra: Record<string, string> = {}) => {
      const r = Bun.spawnSync({ cmd: [process.execPath, "run", join(import.meta.dir, "skill.ts"), ...args], env: { ...env, ...extra }, cwd: import.meta.dir });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    };
    const body = "## Steps\n1. Open cal.ts and run the find command.\n2. Confirm the uid.";
    expect(cli(["create", "--name", "alpha-skill", "--desc", "Use when alpha calendar work", "--source", "maor", "--body", body]).code).toBe(0);
    expect(cli(["create", "--name", "beta-skill", "--desc", "Use when beta calendar work", "--source", "maor", "--body", body]).code).toBe(0);

    const on = { SKILL_APPROVAL: "1" };
    // no approvals file: fail closed
    expect(cli(["list"], on).out).toContain("(no skills)");
    expect(cli(["search", "calendar"], on).out).toContain("(no matches)");
    const v0 = cli(["view", "alpha-skill"], on);
    expect(v0.code).not.toBe(0);
    expect(v0.out).toContain(`skill "alpha-skill" is waiting for Maor's approval`);

    const dir = join(state, "shared", "skills");
    const fileOf = (n: string) => readFileSync(join(dir, `${n}.md`), "utf8");
    const a = emptyApprovals();
    a.skills.approved.push(skillKey("alpha-skill", "Use when alpha calendar work", fileOf("alpha-skill")));
    writeFileSync(join(state, "approvals.json"), JSON.stringify(a));

    const list = cli(["list"], on).out;
    expect(list).toContain("alpha-skill");
    expect(list).not.toContain("beta-skill");
    const search = cli(["search", "calendar"], on).out;
    expect(search).toContain("alpha-skill");
    expect(search).not.toContain("beta-skill");
    expect(cli(["view", "alpha-skill"], on).out).toContain("Open cal.ts");
    expect(cli(["view", "beta-skill"], on).out).toContain("waiting for Maor's approval");

    // switch unset: today's behaviour
    expect(cli(["list"]).out).toContain("beta-skill");
    expect(cli(["view", "beta-skill"]).out).toContain("Open cal.ts");
  }, 60_000);
});
