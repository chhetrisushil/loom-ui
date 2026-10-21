import { TABLE_ROW_ACTION } from "@loom-ui/core/browser";
import { customWidget$ } from "@loom/blueprint-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../elements/lu-table";

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

const value = {
  columns: ["Name", "Size"],
  rows: [
    ["bravo", 2],
    ["alpha", 1],
  ],
  rowKeys: ["k-bravo", "k-alpha"],
  rowActions: [
    [
      { id: "open", label: "Open", primary: true },
      { id: "delete", label: "Delete", destructive: true },
    ],
    [{ id: "open", label: "Open", primary: true }],
  ],
};

describe("lu-table row actions", () => {
  it("draws one named button per action and a primary button in the first cell", async () => {
    const el = await mount(value, () => undefined);
    expect(
      all<HTMLButtonElement>(el, "td.row-actions button").map((x) => x.getAttribute("aria-label"))
    ).toEqual(["Open: bravo", "Delete: bravo", "Open: alpha"]);
    expect(
      q<HTMLButtonElement>(el, "tbody tr:first-child td:first-child button")?.textContent?.trim()
    ).toBe("bravo");
    expect(q(el, "th .sr-only")?.textContent).toBe("Actions");
  });

  it("reports the row's key and the action, and the key follows its row through a sort", async () => {
    const seen: unknown[] = [];
    const el = await mount(value, (a) => {
      seen.push(a);
    });
    q<HTMLButtonElement>(el, "button[aria-label='Delete: bravo']").click();
    q<HTMLButtonElement>(el, "thead th button").click(); // sort by Name, descending first
    q<HTMLButtonElement>(el, "thead th button").click(); // ascending: alpha first
    await el.updateComplete;
    q<HTMLButtonElement>(el, "tbody tr:first-child button[data-row-action='open']").click();
    expect(seen).toEqual([
      { type: TABLE_ROW_ACTION, widgetId: "t", payload: { action: "delete", rowKey: "k-bravo" } },
      { type: TABLE_ROW_ACTION, widgetId: "t", payload: { action: "open", rowKey: "k-alpha" } },
    ]);
  });

  it("disables the buttons when the host gave no handler, and draws nothing extra for a plain table", async () => {
    const el = await mount(value);
    expect(all<HTMLButtonElement>(el, "button[data-row-action]").every((x) => x.disabled)).toBe(
      true
    );
    const plain = await mount({ columns: ["Name"], rows: [["a"]] });
    expect(all(plain, "button[data-row-action]")).toEqual([]);
    expect(q(plain, "th.actions")).toBeNull();
  });

  it("shows the visible error for a value that breaks the contract (actions without keys)", async () => {
    const el = await mount(
      { columns: ["Name"], rows: [["a"]], rowActions: [[{ id: "open", label: "Open" }]] },
      () => undefined
    );
    expect(q(el, "[data-state='error']")).not.toBeNull();
  });

  it("says so when the host answers stale or fails, and clears it on the next action", async () => {
    let answer: unknown = { ok: false, reason: "stale" };
    const el = await mount(value, () => answer);
    q<HTMLButtonElement>(el, "button[aria-label='Delete: bravo']").click();
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      await el.updateComplete;
    }
    expect(q(el, "[role='status']")?.textContent?.trim()).toBeTruthy();
    answer = undefined;
    q<HTMLButtonElement>(el, "button[aria-label='Delete: bravo']").click();
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      await el.updateComplete;
    }
    expect(q(el, "[role='status']")).toBeNull();
  });

  it("ignores a second activation of a row while its action is in flight", async () => {
    let release: () => void = () => undefined;
    const seen: unknown[] = [];
    const el = await mount(value, (a) => {
      seen.push(a);
      return new Promise<void>((r) => {
        release = r;
      });
    });
    const del = q<HTMLButtonElement>(el, "button[aria-label='Delete: bravo']");
    del.click();
    del.click();
    await el.updateComplete;
    expect(seen).toHaveLength(1);
    expect(q<HTMLButtonElement>(el, "button[aria-label='Delete: bravo']").disabled).toBe(true);
    release();
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      await el.updateComplete;
    }
    expect(q<HTMLButtonElement>(el, "button[aria-label='Delete: bravo']").disabled).toBe(false);
  });

  it("keeps a row's DOM (and so focus) with its key when rows are replaced", async () => {
    const el = await mount(value, () => undefined);
    const alpha = q<HTMLButtonElement>(el, "td.row-actions button[aria-label='Open: alpha']");
    const next = {
      ...value,
      rows: [value.rows[1], value.rows[0]],
      rowKeys: ["k-alpha", "k-bravo"],
      rowActions: [value.rowActions[1], value.rowActions[0]],
    };
    (el as unknown as { value: unknown }).value = next;
    await el.updateComplete;
    await Promise.resolve();
    await el.updateComplete;
    expect(all<HTMLButtonElement>(el, "td.row-actions button").includes(alpha)).toBe(true);
    expect(alpha.closest("tr")?.querySelector("td")?.textContent?.trim()).toBe("alpha");
  });

  it("names a button by the displayed first cell, with a fallback for an empty one", async () => {
    const el = await mount(
      {
        columns: ["Name"],
        rows: [[null]],
        rowKeys: ["r9"],
        rowActions: [[{ id: "open", label: "Open" }]],
      },
      () => undefined
    );
    expect(q<HTMLButtonElement>(el, "td.row-actions button").getAttribute("aria-label")).toBe(
      "Open: r9"
    );
  });
});
