import { test, expect } from "bun:test";
import { LIMITS, checkText, validateRequest, validatePayload, validateReply } from "./rchannel-schema";

// All fixtures are synthetic: invented items and texts in the real shapes.

const card = (key: string, extra: object = {}) => ({ key, heading: `פריט ${key}`, body: "תיאור קצר של הפריט.", ...extra });
const cardsReq = (extra: object = {}) => ({
  v: 1,
  id: "map-20261004-0945-a1b2",
  routine: "map",
  title: "מפת הסקילים",
  kind: "cards",
  text: "שלוש טיוטות מחכות לאישור שלך.",
  supersedes: true,
  cards: [card("a"), card("b", { note: "לא נבדק" }), card("c")],
  ...extra,
});
const notice = (extra: object = {}) => ({ v: 1, id: "audit-20261022-1000-c3d4", routine: "audit", title: "תזכורת חודשית", kind: "notice", text: "הגיע הזמן לבדיקה.", ...extra });
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);

test("a cards request and a notice pass, and only the known fields are kept", () => {
  const r = validateRequest({ ...cardsReq(), extra: "dropped" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(Object.keys(r.value).sort()).toEqual(["cards", "id", "kind", "routine", "supersedes", "text", "title", "v"]);
  expect(r.value.cards[1]).toEqual({ key: "b", heading: "פריט b", body: "תיאור קצר של הפריט.", note: "לא נבדק" });
  const n = validateRequest(notice());
  expect(n.ok && n.value).toMatchObject({ kind: "notice", supersedes: false, cards: [] });
});

test("ids, routines and kinds are checked by shape", () => {
  expect(reason(validateRequest(cardsReq({ v: 2 })))).toBe("v must be 1");
  expect(reason(validateRequest(cardsReq({ id: "Map 1" })))).toBe("id must be 1 to 60 of a-z, 0-9 and -");
  expect(reason(validateRequest(cardsReq({ id: "a".repeat(61) })))).toBe("id must be 1 to 60 of a-z, 0-9 and -");
  expect(reason(validateRequest(cardsReq({ routine: "../map" })))).toContain("routine must be");
  expect(reason(validateRequest(cardsReq({ kind: "shell" })))).toContain("kind must be cards or notice");
  expect(reason(validateRequest(cardsReq({ supersedes: "yes" })))).toContain("supersedes must be true or false");
  expect(validateRequest([cardsReq()]).ok).toBe(false);
});

test("the limits hold at their edges", () => {
  expect(validateRequest(cardsReq({ title: "א".repeat(LIMITS.title) })).ok).toBe(true);
  expect(reason(validateRequest(cardsReq({ title: "א".repeat(LIMITS.title + 1) })))).toContain("title is over 60 characters");
  expect(reason(validateRequest(cardsReq({ title: "   " })))).toContain("title is empty");
  expect(reason(validateRequest(cardsReq({ text: "א".repeat(LIMITS.text + 1) })))).toContain("text is over 1000");
  expect(validateRequest(cardsReq({ cards: Array.from({ length: 30 }, (_, i) => card(`k${i}`)) })).ok).toBe(true);
  expect(reason(validateRequest(cardsReq({ cards: Array.from({ length: 31 }, (_, i) => card(`k${i}`)) })))).toContain("1 to 30 cards");
  expect(reason(validateRequest(cardsReq({ cards: [] })))).toContain("1 to 30 cards");
  expect(reason(validateRequest(cardsReq({ cards: [card("a", { body: "ב".repeat(601) })] })))).toContain("card 1 body is over 600");
  expect(reason(validateRequest(cardsReq({ cards: [card("a", { heading: "ב".repeat(101) })] })))).toContain("card 1 heading is over 100");
  expect(reason(validateRequest(cardsReq({ cards: [card("k".repeat(301))] })))).toContain("card 1 key is over 300");
  expect(reason(validateRequest(cardsReq({ cards: [card("a", { note: "ב".repeat(41) })] })))).toContain("card 1 note is over 40");
  expect(reason(validateRequest(cardsReq({ cards: [card("a"), card("a")] })))).toContain("card 2 repeats a key");
});

test("a notice needs text and carries no cards", () => {
  expect(reason(validateRequest(notice({ text: "" })))).toContain("text is empty");
  expect(reason(validateRequest(notice({ cards: [card("a")] })))).toContain("a notice has no cards");
});

test("controls, direction marks and broken characters are refused; a newline only where allowed", () => {
  const nl = String.fromCharCode(10);
  expect(checkText(`שורה${nl}שנייה`, "body", 600, 1, true)).toBeNull();
  expect(checkText(`שורה${nl}שנייה`, "heading", 100, 1, false)).toBe("heading holds a control character");
  expect(checkText(`a${String.fromCharCode(0)}b`, "body", 600, 1, true)).toBe("body holds a control character");
  for (const mark of [0x200f, 0x202e, 0x2066, 0x2069, 0x061c]) {
    expect(checkText(`שם${String.fromCharCode(mark)}x`, "heading", 100, 1, false)).toBe("heading holds a direction mark");
  }
  expect(checkText(`x${String.fromCharCode(0xd83d)}`, "body", 600, 1, true)).toBe("body holds a broken character");
  expect(checkText("x😀", "body", 600, 1, true)).toBeNull(); // a whole surrogate pair is fine
  expect(checkText(7, "body", 600, 1, true)).toBe("body must be text");
});

test("validatePayload refuses the whole payload for one bad part", () => {
  const ok = validatePayload({ v: 1, requests: [cardsReq(), notice()], acks: ["3fa9c1d2-7"], results: [{ request: "map-1", card: "a", outcome: "approved" }], closes: [{ request: "map-1", card: "b" }] });
  expect(ok.ok).toBe(true);
  expect(validatePayload({ v: 1 }).ok).toBe(true); // every list defaults to empty
  expect(reason(validatePayload({ v: 1, requests: [cardsReq(), notice({ id: "BAD" })] }))).toBe("id must be 1 to 60 of a-z, 0-9 and -");
  expect(reason(validatePayload({ v: 1, acks: ["x y"] }))).toBe("an ack is not an answer id");
  expect(reason(validatePayload({ v: 1, results: [{ request: "map-1", card: "a", outcome: "deleted" }] }))).toBe("result 1: bad outcome");
  expect(reason(validatePayload({ v: 1, results: [{ request: "map-1", card: "a", outcome: "failed", detail: "d".repeat(81) }] }))).toContain("detail is over 80");
  expect(reason(validatePayload({ v: 1, closes: [{ request: "map 1", card: "a" }] }))).toBe("close 1: bad request id");
  expect(reason(validatePayload({ v: 1, requests: Array.from({ length: 51 }, () => notice()) }))).toBe("requests holds more than 50");
  expect(reason(validatePayload({ v: 1, acks: "a1" }))).toBe("acks must be a list");
});

test("validateReply lets only well-formed answers through to a handler", () => {
  const good = { v: 1, received: ["map-1"], answers: [{ id: "3fa9c1d2-1", request: "map-1", card: "a", verdict: "approve" }, { id: "3fa9c1d2-2", request: "map-1", card: "b", verdict: "correct", text: "תיאור חדש." }] };
  const r = validateReply(good);
  expect(r.ok && r.value.answers).toEqual(good.answers as any);
  expect(reason(validateReply({ ...good, answers: [{ id: "3fa9c1d2-1", request: "map-1", card: "a", verdict: "run" }] }))).toBe("answer 1: bad verdict");
  expect(reason(validateReply({ ...good, answers: [{ id: "3fa9c1d2-1", request: "map-1", card: "a", verdict: "correct" }] }))).toBe("answer 1 text must be text");
  expect(reason(validateReply({ ...good, answers: [{ id: "3fa9c1d2-1", request: "map-1", card: "a", verdict: "approve", text: "x" }] }))).toBe("answer 1: only a correction carries text");
  expect(reason(validateReply({ ...good, answers: [{ id: "../x", request: "map-1", card: "a", verdict: "approve" }] }))).toBe("answer 1: bad id");
  expect(reason(validateReply({ ...good, received: ["BAD ID"] }))).toBe("received must be a list of request ids");
  expect(reason(validateReply("nope"))).toBe("the reply is not a JSON object");
  const many = Array.from({ length: 1001 }, (_, i) => ({ id: `s-${i}`, request: "map-1", card: "a", verdict: "approve" }));
  expect(reason(validateReply({ ...good, answers: many }))).toBe("answers holds more than 1000");
});

test("invisible format characters and variation selectors are refused; Hebrew points are not", () => {
  const tag = String.fromCodePoint(0xe0041); // a Unicode tag character: shown as nothing
  const vs = String.fromCharCode(0xfe0f);
  const soft = String.fromCharCode(0xad);
  for (const hidden of [tag, vs, soft]) expect(checkText(`שם${hidden}`, "heading", 100, 1, false)).toBe("heading holds an invisible character");
  expect(checkText("שָׁלוֹם", "heading", 100, 1, false)).toBeNull();
});
