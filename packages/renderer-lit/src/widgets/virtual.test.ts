import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it, vi } from "vitest";
import "../register";
import { createLitRegistry } from "../dom/litRegistry";
import {
  DEFAULT_MIN_ROWS,
  DEFAULT_OVERSCAN,
  DEFAULT_ROW_HEIGHT,
  resolveVirtualize,
  virtualWindow,
} from "./virtual";

const b = { projectionId: "hydration", path: "values.h" };
type Mounted = HTMLElement & { updateComplete: Promise<unknown>; virtualize?: unknown };

describe("virtualWindow (pure)", () => {
  it("covers the viewport plus overscan on both sides, and the spacers account for the rest", () => {
    const w = virtualWindow(1000, 30, 3000, 300, 5);
    expect(w).toEqual({ start: 95, end: 115, padTop: 95 * 30, padBottom: 885 * 30 });
    expect(w.padTop + (w.end - w.start) * 30 + w.padBottom).toBe(1000 * 30); // total height is preserved
  });
  it("clamps at both ends: the top, and a scrollTop past the bottom is the LAST window, never blank", () => {
    expect(virtualWindow(1000, 30, 0, 300, 5).start).toBe(0);
    expect(virtualWindow(1000, 30, -50, 300, 5).start).toBe(0);
    const past = virtualWindow(1000, 30, 10_000_000, 300, 5);
    expect(past.end).toBe(1000);
    expect(past.padBottom).toBe(0);
    expect(past.end - past.start).toBeGreaterThan(0);
  });
  it("is empty for no rows and never larger than the viewport + 2 * overscan (+1) rows", () => {
    expect(virtualWindow(0, 30, 0, 300, 5)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    for (let top = 0; top < 30_000; top += 137) {
      const w = virtualWindow(1000, 30, top, 300, 5);
      expect(w.end - w.start).toBeLessThanOrEqual(10 + 2 * 5 + 1);
    }
  });
  it("resolveVirtualize: off by default, defaults for true, hostile knobs clamped", () => {
    expect(resolveVirtualize(undefined)).toBeUndefined();
    expect(resolveVirtualize(false)).toBeUndefined();
    expect(resolveVirtualize(true)).toEqual({
      rowHeight: DEFAULT_ROW_HEIGHT,
      overscan: DEFAULT_OVERSCAN,
      minRows: DEFAULT_MIN_ROWS,
    });
    expect(resolveVirtualize({ rowHeight: -3, overscan: Number.NaN, minRows: 10 })).toEqual({
      rowHeight: DEFAULT_ROW_HEIGHT,
      overscan: DEFAULT_OVERSCAN,
      minRows: 10,
    });
  });
});

async function mount(
  tag: string,
  props: Record<string, unknown>,
  viewport = 300,
  /** What the host reports as its content height; the default is a real scroller (content taller than the box). */
  scrollHeight = 10_000_000
): Promise<Mounted> {
  const el = document.createElement(tag) as Mounted;
  Object.defineProperty(el, "clientHeight", { value: viewport, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.assign(el, props);
  document.body.appendChild(el);
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
  return el;
}
const bodyRows = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll("tbody tr:not(.pad)") ?? [])] as HTMLElement[];
const scrollTo = async (el: Mounted, top: number) => {
  el.scrollTop = top;
  el.dispatchEvent(new Event("scroll"));
  await el.updateComplete;
};
const first = (el: HTMLElement) => bodyRows(el)[0]?.querySelector("td")?.textContent?.trim();

describe("lu-table windowing", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => [`r${i}`, i]);
  const value = { columns: ["id", "n"], rows };
  const widget = customWidget$({ kind: "Table", id: "t", title: "Big", binding: b });

  it("DEFAULT is unchanged: no virtualize means the 200-row cap and its 'show more' button", async () => {
    const el = await mount("lu-table", { widget, value });
    expect(bodyRows(el)).toHaveLength(200);
    expect(el.shadowRoot?.querySelector(".more")).not.toBeNull();
    expect(el.shadowRoot?.querySelector("tr.pad")).toBeNull();
  });

  it("a small table is rendered whole and plainly even with virtualize on", async () => {
    const small = { columns: ["id"], rows: rows.slice(0, 50).map((r) => [r[0]]) };
    const el = await mount("lu-table", { widget, value: small, virtualize: true });
    expect(bodyRows(el)).toHaveLength(50);
    expect(el.shadowRoot?.querySelector("tr.pad")).toBeNull();
    expect(el.shadowRoot?.querySelector("table")?.hasAttribute("aria-rowcount")).toBe(false);
  });

  it("mounts only the rows near the scroll position out of 5000, and follows the scroll", async () => {
    const el = await mount("lu-table", {
      widget,
      value,
      virtualize: { rowHeight: 30, overscan: 4 },
    });
    const initial = bodyRows(el).length;
    expect(initial).toBeLessThan(40); // 300px / 30px + overscan, not 5000, not 200
    expect(first(el)).toBe("r0");
    expect(el.shadowRoot?.querySelector(".more")).toBeNull(); // every row is reachable by scrolling
    expect(el.shadowRoot?.querySelector("table")?.getAttribute("aria-rowcount")).toBe("5001");

    await scrollTo(el, 30 * 2500);
    expect(bodyRows(el).length).toBeLessThan(40);
    expect(first(el)).toBe("r2496"); // 2500 - overscan
    const pads = [...(el.shadowRoot?.querySelectorAll("tr.pad") ?? [])] as HTMLElement[];
    expect(pads).toHaveLength(2);
    const mounted = bodyRows(el).length;
    expect(
      Number.parseInt(pads[0]?.style.height ?? "0", 10) +
        Number.parseInt(pads[1]?.style.height ?? "0", 10) +
        mounted * 30
    ).toBe(5000 * 30);
    // The DOM rows carry their true position for assistive technology (header is row 1).
    expect(bodyRows(el)[0]?.getAttribute("aria-rowindex")).toBe("2498");
    expect(el.shadowRoot?.querySelector("thead tr")?.getAttribute("aria-rowindex")).toBe("1");

    await scrollTo(el, 30 * 5000 + 999); // past the end: the last window, never blank
    expect(bodyRows(el).at(-1)?.querySelector("td")?.textContent?.trim()).toBe("r4999");
  });

  it("a host that is NOT the scroll container (no layout box, or content not taller than its box) falls back to the classic rendering", async () => {
    // clientHeight 0: no box at all (display: contents, a hidden ancestor). The page scrolls, no
    // scroll event ever reaches the host, so a window would leave every row past the first blank.
    const noBox = await mount("lu-table", { widget, value, virtualize: true }, 0, 0);
    expect(bodyRows(noBox)).toHaveLength(200); // classic: the 200-row cap and its button
    expect(noBox.shadowRoot?.querySelector("tr.pad")).toBeNull();
    expect(noBox.shadowRoot?.querySelector(".more")).not.toBeNull();
    expect(noBox.shadowRoot?.querySelector("table")?.hasAttribute("aria-rowcount")).toBe(false);

    // a definite height but the content is not clipped (the box grew to fit): scrollHeight <= clientHeight
    const grown = await mount("lu-table", { widget, value, virtualize: true }, 300, 300);
    expect(bodyRows(grown)).toHaveLength(200);
    expect(grown.shadowRoot?.querySelector("tr.pad")).toBeNull();
  });

  it("a host that proves to be a scroller keeps its window (CONTROL for the fallback)", async () => {
    const el = await mount("lu-table", { widget, value, virtualize: true }, 300, 5000 * 30);
    expect(bodyRows(el).length).toBeLessThan(60);
    expect(el.shadowRoot?.querySelectorAll("tr.pad").length).toBeGreaterThan(0);
  });

  it("re-renders only when the mounted window changes, not on every scroll event", async () => {
    const el = await mount("lu-table", {
      widget,
      value,
      virtualize: { rowHeight: 30, overscan: 4 },
    });
    await scrollTo(el, 30 * 100);
    const update = vi.spyOn(el as unknown as { requestUpdate(): void }, "requestUpdate");
    for (let i = 0; i < 5; i++) await scrollTo(el, 30 * 100); // the same position again and again
    expect(update).not.toHaveBeenCalled();
    await scrollTo(el, 30 * 101);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("sorting re-windows from the top (the old offset means nothing in the new order)", async () => {
    const el = await mount("lu-table", { widget, value, virtualize: true });
    await scrollTo(el, 30 * 3000);
    (el.shadowRoot?.querySelector("th button") as HTMLElement).click();
    await el.updateComplete;
    expect(el.scrollTop).toBe(0);
    expect(bodyRows(el).length).toBeLessThan(60);
  });
});

describe("lu-data-table windowing", () => {
  const rows = Array.from({ length: 3000 }, (_, i) => ({ id: `r${i}`, n: i }));
  const widget = customWidget$({ kind: "DataTable", id: "d", title: "Big", binding: b });

  it("default unchanged; windowed when asked; both agree on the content of a row", async () => {
    const plain = await mount("lu-data-table", { widget, value: rows });
    expect(bodyRows(plain)).toHaveLength(200);
    const el = await mount("lu-data-table", { widget, value: rows, virtualize: { overscan: 2 } });
    expect(bodyRows(el).length).toBeLessThan(30);
    expect(first(el)).toBe("r0");
    await scrollTo(el, DEFAULT_ROW_HEIGHT * 1500);
    expect(first(el)).toBe("r1498");
    expect(el.shadowRoot?.querySelector("table")?.getAttribute("aria-rowcount")).toBe("3001");
  });
});

describe("lu-chat windowing", () => {
  it("flags a long transcript for content-visibility rendering only when asked and only above minRows", async () => {
    const entries = Array.from({ length: 300 }, (_, i) => ({
      id: `e${i}`,
      turn: i + 1,
      role: i % 2 ? "assistant" : "user",
      status: "complete",
      parts: [{ type: "text", text: `m${i}` }],
    }));
    const value = { entries, mode: "owner" };
    const widget = customWidget$({ kind: "Chat", id: "c", title: "Chat", binding: b });
    const off = await mount("lu-chat", { widget, value });
    expect(off.shadowRoot?.querySelector(".log")?.hasAttribute("data-windowed")).toBe(false);
    const on = await mount("lu-chat", { widget, value, virtualize: true });
    expect(on.shadowRoot?.querySelector(".log")?.hasAttribute("data-windowed")).toBe(true);
    const few = await mount("lu-chat", {
      widget,
      value: { entries: entries.slice(0, 5), mode: "owner" },
      virtualize: true,
    });
    expect(few.shadowRoot?.querySelector(".log")?.hasAttribute("data-windowed")).toBe(false);
  });
});

describe("the registry option reaches the elements", () => {
  it("createLitRegistry({ virtualize }) sets it on the element it mounts", () => {
    const host = document.createElement("div");
    const reg = createLitRegistry({ virtualize: { rowHeight: 40 } });
    const h = (reg.get("Table") as NonNullable<ReturnType<typeof reg.get>>)(host, {
      widget: customWidget$({ kind: "Table", id: "t", title: "T", binding: b }),
      value: undefined,
      status: undefined,
      onAction: undefined,
    } as never);
    expect((host.querySelector("lu-table") as Mounted).virtualize).toEqual({ rowHeight: 40 });
    h.dispose();
  });
});
