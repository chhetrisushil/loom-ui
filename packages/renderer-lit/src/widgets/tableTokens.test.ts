import { TABLE_ROW_ACTION, TABLE_TOKEN } from "@loom-ui/core/browser";
import { customWidget$ } from "@loom/blueprint-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../elements/lu-table";
import { LuTable } from "./lu-table";

const b = { projectionId: "hydration", path: "values.h" };
beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));

type El = HTMLElement & { updateComplete: Promise<unknown> };
async function mount(value: unknown, onAction?: (a: unknown) => unknown): Promise<El> {
  const el = document.createElement("lu-table") as El;
  Object.assign(el, {
    widget: customWidget$({ kind: "Table", id: "t", title: "Records", binding: b, props: {} }),
    value,
    onAction,
  });
  document.body.appendChild(el);
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
  return el;
}
const q = <T extends Element>(el: El, sel: string) => el.shadowRoot?.querySelector(sel) as T;
const all = <T extends Element>(el: El, sel: string) =>
  [...(el.shadowRoot?.querySelectorAll(sel) ?? [])] as T[];
const settle = async (el: El) => {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
};

const tok = (id: string, label = id) => ({ id, label });
const unkeyed = {
  columns: ["Name", "Tags"],
  rows: [
    ["bravo", { tokens: [tok("x1", "zulu"), tok("x2", "yankee")] }],
    ["alpha", { tokens: [tok("y1", "alpha-tag")] }],
  ],
};
const keyed = { ...unkeyed, rowKeys: ["k-bravo", "k-alpha"] };

describe("lu-table token cells", () => {
  it("draws each token as a real button named by its label, in tab order", async () => {
    const el = await mount(keyed, () => undefined);
    const chips = all<HTMLButtonElement>(el, "td.tokens button.chip");
    expect(chips.map((c) => c.textContent?.trim())).toEqual(["zulu", "yankee", "alpha-tag"]);
    for (const c of chips) {
      expect(c.type).toBe("button");
      expect(c.getAttribute("aria-label")).toBeNull();
      expect(c.hasAttribute("tabindex")).toBe(false);
      expect(c.disabled).toBe(false);
    }
  });

  it("emits { rowKey, tokenId } for a keyed table, and never rowIndex", async () => {
    const seen: unknown[] = [];
    const el = await mount(keyed, (a) => void seen.push(a));
    q<HTMLButtonElement>(el, "button[data-token='x2']").click();
    expect(seen).toEqual([
      { type: TABLE_TOKEN, widgetId: "t", payload: { rowKey: "k-bravo", tokenId: "x2" } },
    ]);
  });

  it("emits { rowIndex, tokenId } with the ORIGINAL index after a sort, never rowKey", async () => {
    const seen: unknown[] = [];
    const el = await mount(unkeyed, (a) => void seen.push(a));
    const head = all<HTMLButtonElement>(el, "thead th button")[0] as HTMLButtonElement;
    head.click(); // by Name, descending
    head.click(); // ascending: alpha (original row 1) first
    await settle(el);
    expect(q(el, "tbody tr:first-child td:first-child").textContent?.trim()).toBe("alpha");
    q<HTMLButtonElement>(el, "tbody tr:first-child button.chip").click();
    expect(seen).toEqual([
      { type: TABLE_TOKEN, widgetId: "t", payload: { rowIndex: 1, tokenId: "y1" } },
    ]);
  });

  it("a chip click emits exactly one action and no row action", async () => {
    const seen: { type: string }[] = [];
    const el = await mount(
      { ...keyed, rowActions: [[{ id: "open", label: "Open", primary: true }], []] },
      (a) => void seen.push(a as { type: string })
    );
    q<HTMLButtonElement>(el, "button.chip").click();
    expect(seen.map((a) => a.type)).toEqual([TABLE_TOKEN]);
    expect(seen.some((a) => a.type === TABLE_ROW_ACTION)).toBe(false);
  });

  it("shows the failure words when the host refuses, and clears them on the next success", async () => {
    let ok = false;
    const el = await mount(keyed, () => (ok ? { ok: true } : { ok: false, error: "no" }));
    q<HTMLButtonElement>(el, "button.chip").click();
    await settle(el);
    expect(q(el, ".status").textContent?.trim()).not.toBe("");
    ok = true;
    q<HTMLButtonElement>(el, "button.chip").click();
    await settle(el);
    expect(q(el, ".status").textContent?.trim()).toBe("");
  });

  it("disables the chips when the host gave no handler", async () => {
    const el = await mount(keyed);
    expect(all<HTMLButtonElement>(el, "button.chip").every((c) => c.disabled)).toBe(true);
  });

  it("sorts a token column by its joined labels", async () => {
    const el = await mount({
      columns: ["Tags"],
      rows: [
        [{ tokens: [tok("a", "mango"), tok("b", "zebra")] }],
        [{ tokens: [tok("c", "apple")] }],
        [{ tokens: [tok("d", "mango"), tok("e", "apple")] }],
      ],
    });
    const head = q<HTMLButtonElement>(el, "thead th button");
    head.click(); // descending first
    head.click(); // ascending
    await settle(el);
    const rows = all(el, "tbody tr").map((r) =>
      [...r.querySelectorAll("button.chip")].map((c) => c.textContent?.trim()).join(", ")
    );
    expect(rows).toEqual(["apple", "mango, apple", "mango, zebra"]);
  });

  it("renders a label as plain text, never markup", async () => {
    const el = await mount({
      columns: ["Tags"],
      rows: [[{ tokens: [tok("m", "<img src=x onerror=alert(1)>")] }]],
    });
    expect(q(el, "button.chip img")).toBeNull();
    expect(q(el, "button.chip").textContent?.trim()).toBe("<img src=x onerror=alert(1)>");
  });

  it("the chip container wraps and chips may shrink, so a cell never widens the table", () => {
    const css = String((LuTable as unknown as { styles: { cssText: string } }).styles.cssText);
    const rule = (sel: string): string =>
      new RegExp(`(?:^|\\n|\\s)${sel.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ??
      "";
    const chips = rule(".chips");
    expect(chips).toContain("display: flex");
    expect(chips).toContain("flex-wrap: wrap");
    expect(chips).toContain("min-width: 0");
    const chip = rule(".chip");
    expect(chip).toContain("min-width: 0");
    expect(chip).toContain("max-width: 100%");
    expect(chip).toContain("overflow-wrap: anywhere");
    expect(rule("td.tokens")).toContain("white-space: normal");
  });
});
