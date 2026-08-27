import { describe, expect, test } from "bun:test";
import { parseBacklog, staleOrderRefs, render } from "./backlog-view";

// The parser reads docs/BACKLOG.md. Two things make it easy to get wrong, and
// both are pinned here: the header carries explanatory tables that are NOT
// backlog rows, and the detail blocks live under a `# Detail` heading whose
// `## <id>` sub-headings must not be mistaken for domain sections.

const LEDGER = `# Backlog

### Status

| status | shown as | means |
|---|---|---|
| \`proposed\` | דורש החלטה | waiting on Maor |
| \`shipped\` | קיים | built and verified |

## Order of work

Sealed by Maor 2026-08-27: TA-0827-alpha first, then TA-0827-beta.

---

## Reliability

| ID | Item | Status | Size | Done when |
|---|---|---|---|---|
| TA-0827-alpha | First thing | proposed | S | Alpha proven |
| TA-0827-beta | Second thing | shipped | M | Beta proven |

## Housekeeping

| ID | Item | Status | Size | Done when |
|---|---|---|---|---|
| TA-0827-gamma | Third thing | parked | L | Gamma proven |

---

# Detail

## TA-0827-alpha

**Source:** sweep 2026-08-27.

**Why:** because.

## TA-0827-beta

**Source:** elsewhere.
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
    // The legend's first column holds `proposed` / `shipped` in backticks, and
    // its rows would parse as items if the header were not excluded.
    expect(rows.some((r) => r.item.includes("waiting on Maor"))).toBe(false);
  });

  test("assigns each row the domain section it sits under", () => {
    expect(rows.find((r) => r.id === "TA-0827-alpha")!.section).toBe("Reliability");
    expect(rows.find((r) => r.id === "TA-0827-gamma")!.section).toBe("Housekeeping");
  });

  test("carries the scannable fields through", () => {
    const beta = rows.find((r) => r.id === "TA-0827-beta")!;
    expect(beta.status).toBe("shipped");
    expect(beta.size).toBe("M");
    expect(beta.doneWhen).toBe("Beta proven");
  });

  test("attaches the detail block to its row, and none where absent", () => {
    expect(rows.find((r) => r.id === "TA-0827-alpha")!.detail).toContain("because");
    expect(rows.find((r) => r.id === "TA-0827-gamma")!.detail).toBe("");
  });

  test("detail sub-headings do not leak in as sections", () => {
    expect(rows.some((r) => r.section === "TA-0827-alpha")).toBe(false);
  });

  test("captures the order-of-work prose", () => {
    expect(order).toContain("Sealed by Maor 2026-08-27");
  });
});

describe("staleOrderRefs", () => {
  const { rows, order } = parseBacklog(LEDGER);

  test("flags an item the order still names after it shipped", () => {
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

  test("opens on open work: closed history is present but unchecked", () => {
    // Open statuses get the `on` class; shipped must not.
    expect(html).toMatch(/class="chip on" data-status="proposed"/);
    expect(html).toMatch(/class="chip" data-status="shipped"/);
  });

  test("orders cards needs-decision first and history last", () => {
    // proposed (alpha) → parked (gamma) → shipped (beta), regardless of the
    // order they appear in the ledger, where beta is filed before gamma.
    const at = (id: string) => html.indexOf(`<code class="id ltr">${id}</code>`);
    expect(at("TA-0827-alpha")).toBeGreaterThan(-1);
    expect(at("TA-0827-alpha")).toBeLessThan(at("TA-0827-gamma"));
    expect(at("TA-0827-gamma")).toBeLessThan(at("TA-0827-beta"));
  });

  test("counts come from the data, never hand-maintained", () => {
    // Open = proposed + approved + parked, so alpha and gamma; beta shipped.
    expect(html).toContain("2 פריטים פתוחים מתוך 3");
  });

  test("surfaces the stale order-of-work warning", () => {
    expect(html).toContain("סדר העבודה לא מעודכן");
    expect(html).toContain("TA-0827-beta");
  });

  test("is right-to-left with isolated LTR islands for ids", () => {
    expect(html).toContain('<html dir="rtl" lang="he">');
    expect(html).toContain("unicode-bidi: isolate");
    expect(html).toMatch(/<code class="id ltr">TA-0827-alpha<\/code>/);
  });

  test("escapes markup coming out of the ledger", () => {
    const evil = parseBacklog(
      LEDGER.replace("First thing", "First <img src=x> thing"),
    );
    expect(render(evil.rows, evil.order, "x")).not.toContain("<img src=x>");
  });
});
