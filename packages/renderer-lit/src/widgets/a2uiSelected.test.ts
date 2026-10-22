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

describe("lu-a2ui-view selected item", () => {
  let el: LuA2UIView;
  let scrolled: string[];
  let reduced = false;
  beforeEach(() => {
    scrolled = [];
    reduced = false;
    Element.prototype.scrollIntoView = function (this: Element, o?: unknown) {
      scrolled.push(`${this.textContent?.trim()}:${JSON.stringify(o)}`);
    };
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: reduced && q.includes("reduce") }));
    el = document.createElement("lu-a2ui-view") as LuA2UIView;
    el.view = view;
    document.body.appendChild(el);
  });
  afterEach(() => {
    el.remove();
    vi.unstubAllGlobals();
  });
  const set = async (data: unknown) => {
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
  it("scrolls the selection into view when it changes, not on unrelated re-renders", async () => {
    await set({ items: items(null) });
    expect(scrolled).toEqual([]);
    await set({ items: items(1) });
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]).toContain("b:");
    await set({ items: items(1, "!") }); // same selection, other data changed
    expect(scrolled).toHaveLength(1);
    await set({ items: items(2, "!") });
    expect(scrolled).toHaveLength(2);
    expect(current()).toEqual(["c!"]);
  });
  it("does not smooth-scroll under prefers-reduced-motion", async () => {
    reduced = true;
    await set({ items: items(0) });
    expect(scrolled[0]).toContain('"behavior":"auto"');
  });
  it("smooth-scrolls otherwise", async () => {
    await set({ items: items(0) });
    expect(scrolled[0]).toContain('"behavior":"smooth"');
  });
});
