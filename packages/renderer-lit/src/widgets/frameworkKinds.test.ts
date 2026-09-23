import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
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
    (th?.[1] as HTMLElement).click();
    await el.updateComplete;
    expect(firstCells(el)).toEqual(["orders", "carts", "users"]);
    expect(th?.[1]?.getAttribute("aria-sort")).toBe("descending");
    (th?.[0] as HTMLElement).click();
    await el.updateComplete;
    expect(firstCells(el)).toEqual(["users", "orders", "carts"]);
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
});
