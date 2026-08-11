import { describe, expect, test } from "bun:test";
import { looksLikeDeferredPromise } from "./promise-check";

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
