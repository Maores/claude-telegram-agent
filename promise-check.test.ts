import { describe, expect, test } from "bun:test";
import { classifyDeferredPromise, gainedBacking, looksLikeDeferredPromise } from "./promise-check";

const MATCH: Array<[string, string]> = [
  // the actual incident text this module was built to catch
  [
    "מכין סקירה מעמיקה. אשלח את הממצאים והשוואה כשהבדיקה תסתיים.",
    "incident text: אשלח ... כש...תסתיים",
  ],
  ["אעדכן אותך כשזה יהיה מוכן.", "אעדכן כש...מוכן"],
  ["אחזור אליך ברגע שהבדיקה תושלם.", "אחזור אליך ברגע ש...תושלם"],
  ["אודיע לך כשזה יסתיים.", "אודיע לך כש...יסתיים"],
  ["אני אעדכן אותך בהמשך.", "אעדכן ... בהמשך"],
  ["זה יעודכן בהמשך.", "יעודכן בהמשך"],
  ["אני עובד ברקע על זה עכשיו.", "עובד ברקע"],
  ["I'll update you when it's done.", "I'll update you when"],
  ["I'll get back to you later.", "I'll get back to you later"],
  ["I'll let you know shortly.", "I'll let you know shortly"],
  ["This is running in the background.", "running in the background"],
  ["I'll keep checking and update you.", "keep checking"],
  ["I will follow up once it's ready.", "will follow up once"],
];

const ALLOW: Array<[string, string]> = [
  ["נקודה ירוקה קבועה = היחידה עובדת תקין.", "unrelated status text"],
  ["הוספתי תזכורת למחר בתשע לקרוא לבנק.", "ordinary reminder confirmation"],
  ["אעדכן אותך עכשיו: הקבוצה נסגרה.", "update happening now, not deferred"],
  ["רעש ברקע לא מפריע להקלטה.", "background noise, unrelated sense of ברקע"],
  ["מוזיקה ברקע יכולה לעזור להתרכז.", "background music, unrelated sense"],
  ["I'll send the file now.", "immediate action, no deferral trigger"],
  ["The service is stable and well tested.", "unrelated english text"],
];

describe("looksLikeDeferredPromise", () => {
  for (const [text, label] of MATCH) {
    test(`matches: ${label}`, () => {
      expect(looksLikeDeferredPromise(text)).toBe(true);
    });
  }
  for (const [text, label] of ALLOW) {
    test(`allows: ${label}`, () => {
      expect(looksLikeDeferredPromise(text)).toBe(false);
    });
  }
});

describe("classifyDeferredPromise", () => {
  // The model claiming it will act after the reply. Nothing survives the
  // reply, so only a mechanism created this turn can back these.
  const ACTS = [
    "מכין סקירה מעמיקה. אשלח את הממצאים והשוואה כשהבדיקה תסתיים.",
    "אני אעדכן אותך בהמשך.",
    "I'll get back to you later.",
    "I will follow up once it's ready.",
  ];
  for (const text of ACTS) {
    test(`agent-acts: ${text.slice(0, 40)}`, () => {
      expect(classifyDeferredPromise(text)).toBe("agent-acts");
    });
  }

  // True statements about poller-owned monitors. Flagging these as unbacked
  // was the live false positive: Maor has a standing dollar monitor, so a
  // correct answer about it carried a note calling itself unreal.
  const RUNS = [
    "המוניטור רץ ברקע ויבדוק כל 15 דקות.",
    "הגדרתי מוניטור שעובד ברקע ויתריע כשהדולר יעבור 3.93.",
    "The monitor is running in the background and checks every 15 minutes.",
    "I set a monitor that keeps checking the price every 15 minutes.",
  ];
  for (const text of RUNS) {
    test(`mechanism-runs: ${text.slice(0, 40)}`, () => {
      expect(classifyDeferredPromise(text)).toBe("mechanism-runs");
    });
  }

  test("a text making both claims takes the stricter kind", () => {
    expect(classifyDeferredPromise("אעדכן אותך כשזה יהיה מוכן, זה רץ ברקע.")).toBe("agent-acts");
  });

  test("ordinary text classifies as neither", () => {
    expect(classifyDeferredPromise("הוספתי תזכורת למחר בתשע לקרוא לבנק.")).toBe(null);
    expect(classifyDeferredPromise("מוזיקה ברקע יכולה לעזור להתרכז.")).toBe(null);
  });
});

describe("gainedBacking", () => {
  test("a new reminder id counts as backing", () => {
    expect(gainedBacking(new Set(["r:r1"]), new Set(["r:r1", "r:r9"]))).toBe(true);
  });

  test("a new monitor id counts as backing", () => {
    expect(gainedBacking(new Set(["r:r1"]), new Set(["r:r1", "m:abc"]))).toBe(true);
  });

  test("an unchanged set is not backing", () => {
    expect(gainedBacking(new Set(["r:r1", "m:abc"]), new Set(["r:r1", "m:abc"]))).toBe(false);
  });

  test("a reminder firing and being deleted mid-turn is not backing", () => {
    expect(gainedBacking(new Set(["r:r1", "r:r2"]), new Set(["r:r2"]))).toBe(false);
  });

  test("an empty chat that gains nothing is not backing", () => {
    expect(gainedBacking(new Set(), new Set())).toBe(false);
  });

  // A storage read that throws must never append a note to a real reply.
  test("an unreadable store fails open", () => {
    expect(gainedBacking(new Set(["r:r1"]), null)).toBe(true);
  });

  // The id spaces are namespaced, so a reminder and a monitor that happen to
  // share a raw id stay distinct.
  test("reminder and monitor ids do not collide", () => {
    expect(gainedBacking(new Set(["r:x1"]), new Set(["r:x1", "m:x1"]))).toBe(true);
  });
});

// --- the 400-reply corpus test (2026-08-17) --------------------------------
// The first cut flagged 9 of 400 real archive replies and was right about 1.
// Every false positive was the agent talking ABOUT the phrase rather than
// using it. These are the exact replies, verbatim, so the narrowing cannot
// silently regress. After: 1 of 400, the real incident.

describe("real archive replies that must NOT be flagged", () => {
  const REAL: Array<[number, string, string]> = [
    [1198, "quoted, describing this very feature",
      'הפיצ\'ר שמזהה הבטחות "אעדכן בהמשך" בלי תזכורת AUTO מוכן ועובד, שמור בקומיט על הענף.'],
    [1192, "quoted, apologising for the incident",
      'הבעיה האמיתית לא הייתה טכנית אלא שקרתי: סיימתי תשובה עם "אשלח כשיהיה מוכן" בלי שבאמת יש לי דרך להמשיך.'],
    [1190, "unquoted reported speech, admitting the mistake",
      "כשכתבתי שאכין את הסקירה ואשלח כשהיא תסתיים, זו הייתה טעות שלי."],
    [795, "quoted, correcting its own earlier wording",
      'צודק, ואני צריך להיות ישר: "רץ ברקע" באותה הודעה קודמת לא היה נכון.'],
    [896, "negated — states there is NO background process",
      "אני קם לחיים רק כשמגיעה הודעת טלגרם אמיתית, אין תהליך שרץ ברקע ומחכה לשמוע אותך."],
    [818, "negated and quoted — states it does NOT run between messages",
      'הדבר החשוב, אני לא "רץ ברקע" בין הודעות.'],
    [1084, "not about the agent at all — a stuck Windows Update",
      "לוודא שאין עדכון תקוע שרץ ברקע (זה גורם קלאסי לדיליי)."],
  ];
  for (const [id, why, text] of REAL) {
    test(`#${id}: ${why}`, () => {
      expect(classifyDeferredPromise(text)).toBeNull();
    });
  }
});

test("the incident reply is still caught — the one true positive in 400", () => {
  expect(classifyDeferredPromise("מכין סקירה מעמיקה. אשלח את הממצאים והשוואה כשהבדיקה תסתיים."))
    .toBe("agent-acts");
});

test("a negation in an EARLIER sentence cannot excuse a real promise", () => {
  // the negation guard is per-sentence on purpose, so an honest disclaimer
  // followed by a fresh promise still gets flagged
  expect(classifyDeferredPromise("אין לי ריצה ברקע. אעדכן אותך כשזה יהיה מוכן."))
    .toBe("agent-acts");
});

test("a quote elsewhere in the reply does not blanket-excuse the rest", () => {
  expect(classifyDeferredPromise('הוא אמר "שלום". אשלח לך את זה כשהבדיקה תסתיים.'))
    .toBe("agent-acts");
});
