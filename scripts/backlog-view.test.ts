import { describe, expect, test } from "bun:test";
import { parseBacklog, staleOrderRefs, render } from "./backlog-view";

// The parser reads docs/BACKLOG.md, whose tokens are Hebrew. Two things make it
// easy to get wrong, and both are pinned here: the header carries explanatory
// tables that are NOT backlog rows, and the detail blocks live under a `# פירוט`
// heading whose `## <id>` sub-headings must not be mistaken for domain sections.

const LEDGER = `# בקלוג

### סטטוסים

| סטטוס | מוצג כ | משמעות |
|---|---|---|
| \`החלטה\` | דורש החלטה | ממתין למאור |
| \`קיים\` | קיים | נבנה ואומת |

## סדר עבודה

נקבע על ידי מאור ב-27 באוגוסט: קודם TA-0827-alpha, אחר כך TA-0827-beta.

---

## אמינות ונתונים

| מזהה | פריט | סטטוס | גודל | נדע שזה נגמר כש |
|---|---|---|---|---|
| TA-0827-alpha | הדבר הראשון | החלטה | S | אלפא הוכח |
| TA-0827-beta | הדבר השני | קיים | M | בטא הוכח |

## תחזוקה

| מזהה | פריט | סטטוס | גודל | נדע שזה נגמר כש |
|---|---|---|---|---|
| TA-0827-gamma | הדבר השלישי | הקפאה | L | גמא הוכח |

---

# פירוט

## TA-0827-alpha

**מקור:** בדיקה, 27 באוגוסט 2026.

**למה:** כי כך.

## TA-0827-beta

**מקור:** ממקום אחר.
`;

describe("parseBacklog", () => {
  const { rows, order } = parseBacklog(LEDGER);

  test("reads every real row and no legend rows", () => {
    expect(rows.map((r) => r.id)).toEqual([
      "TA-0827-alpha",
      "TA-0827-beta",
      "TA-0827-gamma",
    ]);
  });

  test("the status legend in the header is not mistaken for data", () => {
    // The legend's first column holds the same Hebrew tokens in backticks, and
    // its rows would parse as items if the header were not excluded.
    expect(rows.some((r) => r.item.includes("ממתין למאור"))).toBe(false);
  });

  test("assigns each row the domain section it sits under", () => {
    expect(rows.find((r) => r.id === "TA-0827-alpha")!.section).toBe("אמינות ונתונים");
    expect(rows.find((r) => r.id === "TA-0827-gamma")!.section).toBe("תחזוקה");
  });

  test("carries the scannable fields through", () => {
    const beta = rows.find((r) => r.id === "TA-0827-beta")!;
    expect(beta.status).toBe("קיים");
    expect(beta.size).toBe("M");
    expect(beta.doneWhen).toBe("בטא הוכח");
  });

  test("attaches the detail block to its row, and none where absent", () => {
    expect(rows.find((r) => r.id === "TA-0827-alpha")!.detail).toContain("כי כך");
    expect(rows.find((r) => r.id === "TA-0827-gamma")!.detail).toBe("");
  });

  test("detail sub-headings do not leak in as sections", () => {
    expect(rows.some((r) => r.section === "TA-0827-alpha")).toBe(false);
  });

  test("captures the order-of-work prose", () => {
    expect(order).toContain("נקבע על ידי מאור");
  });
});

describe("staleOrderRefs", () => {
  const { rows, order } = parseBacklog(LEDGER);

  test("flags an item the order still names after it was finished", () => {
    expect(staleOrderRefs(order, rows).map((r) => r.id)).toEqual(["TA-0827-beta"]);
  });

  test("does not flag items that are still open", () => {
    expect(staleOrderRefs(order, rows).some((r) => r.id === "TA-0827-alpha")).toBe(false);
  });

  test("says nothing when the order block is empty", () => {
    expect(staleOrderRefs("", rows)).toEqual([]);
  });
});

describe("render", () => {
  const { rows, order } = parseBacklog(LEDGER);
  const html = render(rows, order, "27/08/2026");

  test("opens on open work: finished history is present but unchecked", () => {
    expect(html).toMatch(/class="filter on" data-status="החלטה"/);
    expect(html).toMatch(/class="filter" data-status="קיים"/);
  });

  test("orders rows needs-decision first and history last", () => {
    // החלטה (alpha) → הקפאה (gamma) → קיים (beta), regardless of ledger order,
    // where beta is filed before gamma. Scoped to the list: ids also appear in
    // the stale-order banner ABOVE it, which would otherwise be found first.
    const list = html.slice(html.indexOf('<ul class="rows">'), html.indexOf("</ul>"));
    const at = (id: string) => list.indexOf(`<code class="ltr">${id}</code>`);
    expect(at("TA-0827-alpha")).toBeGreaterThan(-1);
    expect(at("TA-0827-alpha")).toBeLessThan(at("TA-0827-gamma"));
    expect(at("TA-0827-gamma")).toBeLessThan(at("TA-0827-beta"));
  });

  test("counts come from the data, never hand-maintained", () => {
    // Open = החלטה + מאושר + הקפאה, so alpha and gamma; beta is finished.
    expect(html).toContain("2 פריטים פתוחים מתוך 3");
  });

  test("surfaces the stale order-of-work warning", () => {
    expect(html).toContain("סדר העבודה לא מעודכן");
    expect(html).toContain("TA-0827-beta");
  });

  test("keeps Hebrew status tokens out of CSS selectors", () => {
    // Class names must stay ASCII; the Hebrew lives in data attributes and text.
    const classAttrs = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(" ");
    expect(classAttrs).not.toMatch(/[֐-׿]/);
  });

  test("is right-to-left with isolated LTR islands for ids", () => {
    expect(html).toContain('<html dir="rtl" lang="he">');
    expect(html).toContain("unicode-bidi: isolate");
    expect(html).toMatch(/<code class="ltr">TA-0827-alpha<\/code>/);
  });

  test("status marks are drawn, never emoji or glyph stand-ins", () => {
    expect(html).toContain("<svg class=\"ico");
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u);
  });

  test("escapes markup coming out of the ledger", () => {
    const evil = parseBacklog(LEDGER.replace("הדבר הראשון", "הדבר <img src=x> הראשון"));
    expect(render(evil.rows, evil.order, "x")).not.toContain("<img src=x>");
  });
});
