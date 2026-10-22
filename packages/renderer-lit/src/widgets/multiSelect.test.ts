import { SELECT_MANY_ACTION, isSubmitKey } from "@loom-ui/core/chat-ui";
import { customWidget$ } from "@loom/blueprint-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../elements/lu-inputs";

type Mounted = HTMLElement & { updateComplete: Promise<unknown>; value: unknown; widget: unknown };
type Act = { type: string; widgetId: string; payload: { values: string[]; key: string } };
const settle = async (el: Mounted) => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
};
const value = (selected: string[] = [], note?: string) => ({
  options: [
    { value: "a", label: "Q3 report" },
    { value: "b", label: "Contract v2" },
    { value: "c", label: "Invoice March", hint: "processing" },
  ],
  selected,
  ...(note && { note }),
});
const mount = async (
  v: unknown,
  onAction?: (a: Act) => unknown,
  props: Record<string, unknown> = {}
) => {
  const el = document.createElement("lu-multi-select-input") as Mounted;
  Object.assign(el, {
    widget: customWidget$({
      kind: "MultiSelectInput",
      id: "scope",
      title: "Scope",
      props: {
        label: "Search in",
        emptyLabel: "All documents",
        placeholder: "Add a document…",
        ...props,
      },
    }),
    value: v,
    ...(onAction && { onAction }),
  });
  document.body.appendChild(el);
  await settle(el);
  return el;
};
const q = <T extends Element>(el: HTMLElement, sel: string) =>
  el.shadowRoot?.querySelector(sel) as T | null;
const qa = (el: HTMLElement, sel: string) => Array.from(el.shadowRoot?.querySelectorAll(sel) ?? []);
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("lu-multi-select-input", () => {
  it("draws the bound choice as chips with labelled remove buttons, and the empty label when none", async () => {
    const el = await mount(value(["b"]));
    expect(qa(el, "[data-chip]").map((c) => c.getAttribute("data-chip"))).toEqual(["b"]);
    expect(q(el, '[data-chip="b"] button')?.getAttribute("aria-label")).toBe("Remove Contract v2");
    const none = await mount(value([]));
    expect(q(none, "[data-empty]")?.textContent).toBe("All documents");
  });
  it("adds by mouse: the search lists unchosen options filtered by label, and one SELECT_MANY carries the whole new set", async () => {
    const acts: Act[] = [];
    const el = await mount(value(["b"]), (a) => void acts.push(a));
    q<HTMLButtonElement>(el, "[data-add]")?.click();
    await settle(el);
    // Every unchosen option is offered; a hint never hides one (the host decides what to offer).
    expect(qa(el, "[data-option]").map((o) => o.getAttribute("data-option"))).toEqual(["a", "c"]);
    const search = q<HTMLInputElement>(el, "input[data-search]") as HTMLInputElement;
    search.value = "q3";
    search.dispatchEvent(new Event("input"));
    await settle(el);
    expect(qa(el, "[data-option]").map((o) => o.getAttribute("data-option"))).toEqual(["a"]);
    q(el, '[data-option="a"]')?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );
    await settle(el);
    expect(acts).toHaveLength(1);
    expect(acts[0]?.type).toBe(SELECT_MANY_ACTION);
    expect(acts[0]?.widgetId).toBe("scope");
    expect(acts[0]?.payload.values).toEqual(["b", "a"]);
    expect(isSubmitKey(acts[0]?.payload.key)).toBe(true);
  });
  it("adds by keyboard (arrows + Enter), Escape closes, Backspace in an empty search removes the last chip", async () => {
    const acts: Act[] = [];
    const el = await mount(value(["a", "b"]), (a) => void acts.push(a));
    q<HTMLButtonElement>(el, "[data-add]")?.click();
    await settle(el);
    const search = q<HTMLInputElement>(el, "input[data-search]") as HTMLInputElement;
    expect(search.getAttribute("role")).toBe("combobox");
    key(search, "Backspace");
    await settle(el);
    expect(acts.at(-1)?.payload.values).toEqual(["a"]);
    key(search, "ArrowDown");
    key(search, "Enter");
    await settle(el);
    expect(acts.at(-1)?.payload.values).toEqual(["a", "b", "c"]);
    key(search, "Escape");
    await settle(el);
    expect(q(el, "input[data-search]")).toBeNull();
  });
  it("removing a chip sends the set without it; removing the last sends the empty set", async () => {
    const acts: Act[] = [];
    const el = await mount(value(["a"]), (a) => void acts.push(a));
    q<HTMLButtonElement>(el, '[data-chip="a"] button')?.click();
    await settle(el);
    expect(acts[0]?.payload.values).toEqual([]);
  });
  it("is busy while a choice is in flight (one send at a time), then shows the bound value; a refusal says so and keeps the bound value", async () => {
    let release: (v: unknown) => void = () => {};
    const el = await mount(
      value(["a"]),
      () =>
        new Promise((r) => {
          release = r;
        })
    );
    q<HTMLButtonElement>(el, '[data-chip="a"] button')?.click();
    await settle(el);
    expect(q(el, "[data-multi-select]")?.getAttribute("data-phase")).toBe("sending");
    expect(q<HTMLButtonElement>(el, "[data-add]")?.disabled).toBe(true);
    release({ ok: false, reason: "refused" });
    await settle(el);
    expect(q(el, "[data-multi-select]")?.getAttribute("data-phase")).toBe("failed");
    expect(qa(el, "[data-chip]").map((c) => c.getAttribute("data-chip"))).toEqual(["a"]);
    expect(q(el, "#status")?.getAttribute("role")).toBe("alert");
  });
  it("disables Add at maxSelected", async () => {
    const el = await mount(value(["a", "b"]), undefined, { maxSelected: 2 });
    expect(q<HTMLButtonElement>(el, "[data-add]")?.disabled).toBe(true);
  });
  it("shows the hint after a label and the note under the control, both as one-line text", async () => {
    const el = await mount(value(["c"], "Showing the 200 most recent documents"));
    expect(q(el, '[data-chip="c"]')?.textContent).toContain("Invoice March (processing)");
    expect(q(el, "[data-note]")?.textContent).toBe("Showing the 200 most recent documents");
  });
  it("a malformed bound value draws the contract's error state, never chips; no value yet draws loading", async () => {
    const bad = await mount({ options: [], selected: ["x"] });
    expect(qa(bad, "[data-chip]")).toHaveLength(0);
    const loading = await mount(undefined);
    expect(qa(loading, "[data-chip]")).toHaveLength(0);
  });
  it("no handler: Add still opens, a choice says chat is unavailable instead of pretending", async () => {
    const el = await mount(value([]));
    q<HTMLButtonElement>(el, "[data-add]")?.click();
    await settle(el);
    q(el, '[data-option="a"]')?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    );
    await settle(el);
    expect(q(el, "[data-multi-select]")?.getAttribute("data-phase")).toBe("unavailable");
  });
});
