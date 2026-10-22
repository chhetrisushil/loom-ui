import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../register";
import type { LuA2UIView } from "./lu-a2ui-view";

const view = {
  nodes: [
    { id: "root", component: "List", children: { path: "/items", componentId: "item" } },
    { id: "item", component: "Column", selected: { path: "/on" }, children: ["t"] },
    { id: "t", component: "Text", text: { path: "/name" } },
  ],
};
const items = (sel: number | null, extra = "") =>
  ["a", "b", "c"].map((name, i) => ({ name: name + extra, on: i === sel }));
const keyedView = {
  nodes: [
    { id: "root", component: "List", children: { path: "/items", componentId: "item" } },
    {
      id: "item",
      component: "Column",
      selected: { path: "/on" },
      selectedKey: { path: "/id" },
      children: ["t"],
    },
    { id: "t", component: "Text", text: { path: "/name" } },
  ],
};
const keyed = (ids: string[], sel: string | null) =>
  ids.map((id) => ({ id, name: id, on: id === sel }));

describe("lu-a2ui-view selected item", () => {
  let el: LuA2UIView;
  let box: HTMLElement;
  let scrolls: { top: number; behavior: string }[];
  let pageScrolls: number;
  let reduced = false;
  let laidOut = true;
  // The item sits 500px below the container's bottom edge (container 0..100, item 600..620).
  beforeEach(() => {
    scrolls = [];
    pageScrolls = 0;
    reduced = false;
    laidOut = true;
    Element.prototype.scrollIntoView = () => {
      pageScrolls++;
    };
    Element.prototype.getClientRects = function (this: Element) {
      return (laidOut ? [{}] : []) as unknown as DOMRectList;
    };
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const sel = this.getAttribute("aria-current") === "true";
      const r: [number, number] = this === box ? [0, 100] : sel ? [600, 620] : [0, 0];
      return { top: r[0], bottom: r[1], height: r[1] - r[0] } as DOMRect;
    };
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce") }));
    box = document.createElement("div");
    box.style.overflowY = "auto";
    Object.defineProperty(box, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(box, "clientHeight", { value: 100 });
    Object.defineProperty(box, "scrollTop", { value: 40, configurable: true });
    box.scrollTo = ((o: { top: number; behavior: string }) => {
      scrolls.push(o);
    }) as unknown as typeof box.scrollTo;
    el = document.createElement("lu-a2ui-view") as LuA2UIView;
    el.view = view;
    box.appendChild(el);
    document.body.appendChild(box);
  });
  afterEach(() => {
    box.remove();
    vi.unstubAllGlobals();
  });
  const set = async (data: unknown, v: unknown = view) => {
    el.view = v as typeof el.view;
    el.data = data;
    await el.updateComplete;
  };
  const current = () =>
    Array.from(el.shadowRoot?.querySelectorAll('[aria-current="true"]') ?? []).map((e) =>
      e.textContent?.trim()
    );

  it("marks the selected item with aria-current without reordering", async () => {
    await set({ items: items(1) });
    expect(current()).toEqual(["b"]);
    const texts = Array.from(el.shadowRoot?.querySelectorAll(".text") ?? []).map(
      (e) => e.textContent
    );
    expect(texts).toEqual(["a", "b", "c"]);
    expect(el.shadowRoot?.querySelector(".sel")).not.toBeNull();
  });
  it("single selection: with several items true only the first is marked and scrolled", async () => {
    await set({ items: items(1).map((i) => ({ ...i, on: true })) });
    expect(current()).toEqual(["a"]);
    expect(el.shadowRoot?.querySelectorAll(".sel")).toHaveLength(1);
    expect(scrolls).toHaveLength(1);
  });
  it("every item of a selecting list reserves the bar (no layout shift)", async () => {
    await set({ items: items(1) });
    expect(el.shadowRoot?.querySelectorAll(".selectable")).toHaveLength(3);
    await set({ items: items(null) });
    expect(el.shadowRoot?.querySelectorAll(".selectable")).toHaveLength(3);
    expect(el.shadowRoot?.querySelector(".sel")).toBeNull();
  });
  it("scrolls only the nearest scroll container (never the page), block-nearest semantics", async () => {
    await set({ items: items(null) });
    expect(scrolls).toEqual([]);
    await set({ items: items(1) });
    // item bottom 620 - container bottom 100 = 520, from scrollTop 40
    expect(scrolls).toEqual([{ top: 560, behavior: "smooth" }]);
    expect(pageScrolls).toBe(0);
    await set({ items: items(1, "!") }); // same selection, other data changed
    expect(scrolls).toHaveLength(1);
    await set({ items: items(2, "!") });
    expect(scrolls).toHaveLength(2);
    expect(current()).toEqual(["c!"]);
  });
  it("re-scrolls when the selection is cleared and then reselected", async () => {
    await set({ items: items(1) });
    await set({ items: items(null) });
    await set({ items: items(1) });
    expect(scrolls).toHaveLength(2);
  });
  it("does not scroll when the item is already visible", async () => {
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return this === box
        ? ({ top: 0, bottom: 1000, height: 1000 } as DOMRect)
        : ({ top: 10, bottom: 30, height: 20 } as DOMRect);
    };
    await set({ items: items(1) });
    Element.prototype.getBoundingClientRect = orig;
    expect(scrolls).toEqual([]);
  });
  it("does not smooth-scroll under prefers-reduced-motion", async () => {
    reduced = true;
    await set({ items: items(0) });
    expect(scrolls[0]?.behavior).toBe("auto");
  });
  it("smooth-scrolls otherwise", async () => {
    await set({ items: items(0) });
    expect(scrolls[0]?.behavior).toBe("smooth");
  });
  it("does not mark the scroll done until the item is laid out, then retries", async () => {
    laidOut = false;
    await set({ items: items(1) });
    expect(scrolls).toEqual([]);
    laidOut = true;
    el.requestUpdate();
    await el.updateComplete;
    expect(scrolls).toHaveLength(1);
  });
  it("with no scrollable ancestor nothing scrolls", async () => {
    Object.defineProperty(box, "scrollHeight", { value: 100 });
    await set({ items: items(1) });
    expect(scrolls).toEqual([]);
    expect(pageScrolls).toBe(0);
  });
  it("unsetting the view resets the selection so a later view scrolls again", async () => {
    await set({ items: items(1) });
    el.view = undefined as unknown as typeof el.view;
    await el.updateComplete;
    await set({ items: items(1) });
    expect(scrolls).toHaveLength(2);
  });

  describe("scroll identity", () => {
    it("positional by default: inserting before the selected item re-scrolls (documented)", async () => {
      await set({ items: items(1) });
      const [a, b, c] = items(1);
      await set({ items: [{ name: "z", on: false }, a, b, c] });
      expect(scrolls).toHaveLength(2);
    });
    it("with selectedKey, inserting or removing before the selected item does not scroll", async () => {
      await set({ items: keyed(["a", "b", "c"], "c") }, keyedView);
      expect(scrolls).toHaveLength(1);
      await set({ items: keyed(["z", "a", "b", "c"], "c") }, keyedView);
      await set({ items: keyed(["b", "c"], "c") }, keyedView);
      expect(scrolls).toHaveLength(1);
      expect(current()).toEqual(["c"]);
    });
    it("with selectedKey, another item selected at the same index scrolls", async () => {
      await set({ items: keyed(["a", "b", "c"], "b") }, keyedView);
      await set({ items: keyed(["a", "x", "c"], "x") }, keyedView);
      expect(scrolls).toHaveLength(2);
    });
  });
});
