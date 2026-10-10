import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it, vi } from "vitest";
import * as i18n from "../i18n";
import { setLocale } from "../i18n";
import "./index";

const b = { projectionId: "hydration", path: "values.h" };
type Mounted = HTMLElement & { updateComplete: Promise<unknown> };
const mount = async (tag: string, props: Record<string, unknown>): Promise<Mounted> => {
  const el = document.createElement(tag) as Mounted;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};
const text = (el: HTMLElement) => (el.shadowRoot?.textContent ?? "").replace(/\s+/g, " ").trim();
const stateOf = (el: HTMLElement) =>
  el.shadowRoot?.querySelector("[data-state]")?.getAttribute("data-state");

describe("lu-kpi", () => {
  it("renders the formatted value, the delta badge and the value's label; an ISO unit is not doubled", async () => {
    setLocale("en-US");
    const el = await mount("lu-kpi", {
      widget: customWidget$({ kind: "Kpi", id: "k", title: "Revenue", binding: b }),
      value: { value: 1234.5, unit: "USD", deltaPct: -0.034, label: "vs last week" },
    });
    expect(text(el)).toContain("$1,234.50");
    expect(text(el)).not.toContain("USD");
    expect(text(el)).toContain("▼");
    expect(text(el)).toContain("3.4%");
    expect(text(el)).toContain("vs last week");
    expect(el.shadowRoot?.querySelector(".delta")?.getAttribute("data-direction")).toBe("down");
  });
  it("falls back to the title and a plain unit suffix; a bare number is a contract error", async () => {
    const el = await mount("lu-kpi", {
      widget: customWidget$({ kind: "Kpi", id: "k2", title: "p99", binding: b }),
      value: { value: 7, unit: "ms" },
    });
    expect(text(el)).toContain("ms");
    expect(text(el)).toContain("p99");
    expect(el.shadowRoot?.querySelector(".delta")).toBeNull();
    Object.assign(el, { value: 7 });
    await el.updateComplete;
    expect(stateOf(el)).toBe("error");
  });
});

describe("lu-table", () => {
  const widget = customWidget$({ kind: "Table", id: "t", title: "Top", binding: b });
  const value = {
    columns: ["db", { label: "p99", format: { semanticType: "integer" } }],
    rows: [
      ["orders", 1234.4],
      ["users", null],
      ["carts", 5],
    ],
  };
  const firstCells = (el: HTMLElement) =>
    [...(el.shadowRoot?.querySelectorAll("tbody tr") ?? [])].map((tr) =>
      (tr.querySelector("td")?.textContent ?? "").trim()
    );
  it("renders headings from either column form and formats numeric cells per column", async () => {
    setLocale("en-US");
    const el = await mount("lu-table", { widget, value });
    const headers = [...(el.shadowRoot?.querySelectorAll("th") ?? [])].map((th) =>
      (th.textContent ?? "").trim()
    );
    expect(headers).toEqual(["db", "p99"]);
    expect(text(el)).toContain("1,234");
    expect(text(el)).toContain("—");
    expect(el.shadowRoot?.querySelectorAll("td.num").length).toBe(3);
  });
  it("sorts by column index, nulls last, and says so via aria-sort", async () => {
    const el = await mount("lu-table", { widget, value });
    const th = el.shadowRoot?.querySelectorAll("th");
    (th?.[1]?.querySelector("button") as HTMLElement)?.click();
    await el.updateComplete;
    expect(firstCells(el)).toEqual(["orders", "carts", "users"]);
    expect(th?.[1]?.getAttribute("aria-sort")).toBe("descending");
    (th?.[0]?.querySelector("button") as HTMLElement)?.click();
    await el.updateComplete;
    expect(firstCells(el)).toEqual(["users", "orders", "carts"]);
  });
  it("sort headers are real buttons — keyboard reachable — while aria-sort stays on the th", async () => {
    const el = await mount("lu-table", { widget, value });
    const th = el.shadowRoot?.querySelectorAll("th");
    const btn = th?.[1]?.querySelector("button");
    expect(btn?.tagName).toBe("BUTTON");
    expect(th?.[1]?.hasAttribute("aria-sort")).toBe(true);
    expect(btn?.hasAttribute("aria-sort")).toBe(false);
    // A native <button> is keyboard-operable by the browser itself: focusable by default, and
    // Enter/Space synthesize a click. Invoking it directly is the DOM-level stand-in for that
    // keyboard activation (happy-dom does not itself synthesize clicks from keydown).
    (btn as HTMLElement)?.focus();
    (btn as HTMLElement)?.click();
    await el.updateComplete;
    expect(th?.[1]?.getAttribute("aria-sort")).toBe("descending");
    expect(firstCells(el)).toEqual(["orders", "carts", "users"]);
  });
  it("sorts numeric-looking strings and mixed number/string cells numerically, not lexicographically", async () => {
    setLocale("en-US");
    const mixedWidget = customWidget$({ kind: "Table", id: "t-mixed", title: "Mixed", binding: b });
    const el = await mount("lu-table", {
      widget: mixedWidget,
      value: { columns: ["n"], rows: [["9"], ["10"], [2]] },
    });
    const btn = el.shadowRoot?.querySelector("th")?.querySelector("button");
    expect(btn).not.toBeUndefined();
    (btn as HTMLElement).click();
    await el.updateComplete;
    // First click sorts descending: "10" > "9" > 2, not the lexicographic "2" < "9" < "10"
    // (nor the insertion order "9", "10", 2 a no-op click would leave behind).
    expect(firstCells(el)).toEqual(["10", "9", "2"]);
  });
  it("'showing' and 'more' chrome text passes through t()", async () => {
    const spy = vi.spyOn(i18n, "t");
    const rows = Array.from({ length: 205 }, (_, i) => [`r${i}`]);
    const el = await mount("lu-table", {
      widget: customWidget$({ kind: "Table", id: "t-big", title: "Big", binding: b }),
      value: { columns: ["id"], rows },
    });
    const more = el.shadowRoot?.querySelector(".more");
    expect(more?.textContent?.replace(/\s+/g, " ").trim()).toContain("Showing 200 of 205 rows");
    expect(more?.querySelector("button")?.textContent?.trim()).toBe("Show 5 more");
    const calledWith = spy.mock.calls.map(([k]) => k);
    expect(calledWith).toEqual(
      expect.arrayContaining(["lu.table.showing", "lu.plural.row.other", "lu.table.showMore"])
    );
    spy.mockRestore();
  });
  it("'Showing N of M rows' counts its noun through tPlural (the catalogue's row.* forms apply)", async () => {
    // The footer renders only while some rows are hidden, so `total` is always > 200 in
    // practice; drive tPlural's category through the widget with a catalogue that translates it.
    const cat: Record<string, string> = {
      "lu.plural.row.one": "ROW",
      "lu.plural.row.other": "ROWS",
    };
    const spy = vi.spyOn(i18n, "t").mockImplementation((k, fb) => cat[k] ?? fb ?? k);
    const rows = Array.from({ length: 205 }, (_, i) => [`r${i}`]);
    const el = await mount("lu-table", {
      widget: customWidget$({ kind: "Table", id: "t-pl", title: "Pl", binding: b }),
      value: { columns: ["id"], rows },
    });
    expect(
      el.shadowRoot?.querySelector(".more")?.textContent?.replace(/\s+/g, " ").trim()
    ).toContain("Showing 200 of 205 ROWS");
    spy.mockRestore();
  });
  it("lu-data-table's 'Showing N of M rows' goes through t()/tPlural like lu-table's", async () => {
    const cat: Record<string, string> = {
      "lu.table.showing": "SHOWING {shown} OF {total} {noun}",
      "lu.plural.row.other": "ROWS",
    };
    const spy = vi.spyOn(i18n, "t").mockImplementation((k, fb) => cat[k] ?? fb ?? k);
    const rows = Array.from({ length: 205 }, (_, i) => ({ id: `r${i}` }));
    const el = await mount("lu-data-table", {
      widget: customWidget$({ kind: "DataTable", id: "d-pl", title: "Pl", binding: b }),
      value: rows,
    });
    expect(
      el.shadowRoot?.querySelector(".more")?.textContent?.replace(/\s+/g, " ").trim()
    ).toContain("SHOWING 200 OF 205 ROWS");
    spy.mockRestore();
  });
  it("a row shorter than the columns shows — for the missing cell; records are a contract error", async () => {
    const el = await mount("lu-table", {
      widget,
      value: { columns: ["a", "b"], rows: [["x"]] },
    });
    expect(el.shadowRoot?.querySelectorAll("tbody td").length).toBe(2);
    expect(text(el)).toContain("—");
    Object.assign(el, { value: [{ db: "orders" }] });
    await el.updateComplete;
    expect(stateOf(el)).toBe("error");
  });
});

describe("lu-status-card", () => {
  it("announces politely and draws the level, headline and detail", async () => {
    const el = await mount("lu-status-card", {
      widget: customWidget$({ kind: "StatusCard", id: "s", title: "Replication", binding: b }),
      value: { level: "warning", headline: "Replica lag", detail: "12s behind" },
    });
    const live = el.shadowRoot?.querySelector("[role='status']");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toContain("Replica lag");
    expect(el.shadowRoot?.querySelector(".dot")?.getAttribute("data-level")).toBe("warning");
    expect(text(el)).toContain("12s behind");
    Object.assign(el, { value: { level: "meh", headline: "x" } });
    await el.updateComplete;
    expect(stateOf(el)).toBe("error");
  });
  it("shows a visible, non-colour cue for the level — not colour alone", async () => {
    const warn = await mount("lu-status-card", {
      widget: customWidget$({ kind: "StatusCard", id: "s2", title: "Replication", binding: b }),
      value: { level: "warning", headline: "Lag" },
    });
    const critical = await mount("lu-status-card", {
      widget: customWidget$({ kind: "StatusCard", id: "s3", title: "Replication", binding: b }),
      value: { level: "critical", headline: "Down" },
    });
    const ok = await mount("lu-status-card", {
      widget: customWidget$({ kind: "StatusCard", id: "s4", title: "Replication", binding: b }),
      value: { level: "ok", headline: "Fine" },
    });
    const cueOf = (el: HTMLElement) =>
      el.shadowRoot?.querySelector("[data-level-text]")?.textContent?.trim();
    expect(cueOf(warn)).toBe("warning");
    expect(cueOf(critical)).toBe("critical");
    expect(cueOf(ok)).toBe("ok");
    // Three genuinely distinct cues, not the same text painted three colours.
    expect(new Set([cueOf(warn), cueOf(critical), cueOf(ok)]).size).toBe(3);
  });
  it("announces once: the live region carries the description, the group's name stays the plain title", async () => {
    const el = await mount("lu-status-card", {
      widget: customWidget$({ kind: "StatusCard", id: "s5", title: "Replication", binding: b }),
      value: { level: "warning", headline: "Replica lag", detail: "12s behind" },
    });
    const group = el.shadowRoot?.querySelector("[role='group']");
    expect(group?.getAttribute("aria-label")).toBe("Replication");
    const live = el.shadowRoot?.querySelector("[role='status']");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent).toContain("Replica lag");
    expect(live?.textContent).toContain("12s behind");
  });
});

describe("lu-note", () => {
  it("renders its text from props with no binding and is never 'loading'", async () => {
    const el = await mount("lu-note", {
      widget: customWidget$({
        kind: "Note",
        id: "n",
        title: "About",
        props: { text: "Plain words" },
      }),
    });
    expect(text(el)).toContain("Plain words");
    expect(text(el)).toContain("About");
    expect(el.shadowRoot?.querySelector("[role='note']")).not.toBeNull();
    expect(el.shadowRoot?.querySelector("[data-state='loading']")).toBeNull();
  });
  it("an unresolved LocalizedText shows its fallback, never the key", async () => {
    const el = await mount("lu-note", {
      widget: customWidget$({
        kind: "Note",
        id: "n2",
        props: { text: { key: "note.k", fallback: "Fallback" } },
      }),
    });
    expect(text(el)).toContain("Fallback");
    expect(text(el)).not.toContain("note.k");
  });
  it("a non-undefined bound value is a contract error, not silently ignored", async () => {
    const el = await mount("lu-note", {
      widget: customWidget$({
        kind: "Note",
        id: "n3",
        title: "About",
        props: { text: "Plain words" },
      }),
    });
    expect(stateOf(el)).toBeUndefined();
    Object.assign(el, { value: "unexpected" });
    await el.updateComplete;
    expect(stateOf(el)).toBe("error");
  });
});

describe("lu-kpi and lu-status-card colour tokens", () => {
  it("expose their level/delta colours as --lu-* custom properties with the current hex as fallback", async () => {
    const { LuKpi } = await import("./lu-kpi");
    const { LuStatusCard } = await import("./lu-status-card");
    const kpiCss = (LuKpi.styles as unknown as { cssText: string }).cssText;
    const cardCss = (LuStatusCard.styles as unknown as { cssText: string }).cssText;
    expect(kpiCss).toContain("var(--lu-delta-up, #4ade80)");
    expect(kpiCss).toContain("var(--lu-delta-down, #f87171)");
    expect(kpiCss).toContain("var(--lu-delta-flat, #8b949e)");
    expect(cardCss).toContain("var(--lu-status-ok, #4ade80)");
    expect(cardCss).toContain("var(--lu-status-warning, #fbbf24)");
    expect(cardCss).toContain("var(--lu-status-critical, #f87171)");
  });
});

describe("lu-kpi: unit, flat delta, caption", () => {
  it("keeps a unit beside a decimal format; a currency or percent format never doubles its symbol", async () => {
    setLocale("en-US");
    const ms = await mount("lu-kpi", {
      widget: customWidget$({ kind: "Kpi", id: "ku1", title: "p99", binding: b }),
      value: { value: 7, unit: "ms", format: { semanticType: "decimal" } },
    });
    expect(ms.shadowRoot?.querySelector(".unit")?.textContent).toBe("ms");
    const cur = await mount("lu-kpi", {
      widget: customWidget$({ kind: "Kpi", id: "ku2", title: "Rev", binding: b }),
      value: { value: 12, unit: "USD", format: { semanticType: "currency", currency: "USD" } },
    });
    expect(cur.shadowRoot?.querySelector(".unit")).toBeNull();
    const pct = await mount("lu-kpi", {
      widget: customWidget$({ kind: "Kpi", id: "ku3", title: "Share", binding: b }),
      value: { value: 0.25, unit: "%", format: { semanticType: "percentage" } },
    });
    expect(pct.shadowRoot?.querySelector(".unit")).toBeNull();
    expect(text(pct).match(/%/g)?.length).toBe(1);
  });
  it("a zero delta is flat: no arrow", async () => {
    const el = await mount("lu-kpi", {
      widget: customWidget$({ kind: "Kpi", id: "kf", title: "Errors", binding: b }),
      value: { value: 3, deltaPct: 0 },
    });
    const badge = el.shadowRoot?.querySelector(".delta");
    expect(badge?.getAttribute("data-direction")).toBe("flat");
    expect(badge?.textContent).not.toMatch(/[▲▼]/);
    expect(badge?.textContent?.trim()).toBe("0%");
  });
  it("the value's label is a caption beside the title — the title stays", async () => {
    const el = await mount("lu-kpi", {
      widget: customWidget$({ kind: "Kpi", id: "kc", title: "Revenue", binding: b }),
      value: { value: 1, label: "vs last week" },
    });
    const label = el.shadowRoot?.querySelector(".label");
    expect(label?.textContent).toContain("Revenue");
    expect(label?.querySelector(".caption")?.textContent?.trim()).toBe("vs last week");
  });
});

describe("lu-kpi: a non-finite delta", () => {
  it("shows — with no arrow", async () => {
    const el = await mount("lu-kpi", {
      widget: customWidget$({ kind: "Kpi", id: "kinf", title: "Growth", binding: b }),
      value: { value: 3, deltaPct: Number.POSITIVE_INFINITY },
    });
    const badge = el.shadowRoot?.querySelector(".delta");
    expect(badge?.getAttribute("data-direction")).toBe("none");
    expect(badge?.textContent?.trim()).toBe("—");
  });
});

describe("lu-note without a widget", () => {
  it("renders nothing instead of throwing, like every other LuWidget", async () => {
    const el = document.createElement("lu-note") as Mounted;
    document.body.appendChild(el);
    await expect(el.updateComplete).resolves.toBeDefined();
    expect(text(el)).toBe("");
  });
});

describe("lu-table: locale and chrome", () => {
  it("sorts text by the formatting locale, not the host's", async () => {
    setLocale("sv-SE");
    const el = await mount("lu-table", {
      widget: customWidget$({ kind: "Table", id: "t-sv", title: "Names", binding: b }),
      value: { columns: ["name"], rows: [["z"], ["ä"], ["a"]] },
    });
    (el.shadowRoot?.querySelector("th button") as HTMLElement).click();
    await el.updateComplete;
    const cells = [...(el.shadowRoot?.querySelectorAll("tbody td") ?? [])].map((td) =>
      (td.textContent ?? "").trim()
    );
    // Swedish: ä is its own letter AFTER z (English folds it into a).
    expect(cells).toEqual(["ä", "z", "a"]);
    setLocale("en-US");
  });
  it("styles its 'show more' button like lu-data-table's", async () => {
    const { LuTable } = await import("./lu-table");
    const css = (LuTable.styles as unknown as { cssText: string }).cssText;
    expect(css).toContain(".more button");
    expect(css).toContain(".more button:hover");
  });
});
