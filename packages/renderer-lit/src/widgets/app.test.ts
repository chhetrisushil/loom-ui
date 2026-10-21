import { describe, expect, it } from "vitest";
import { currentLocale, setLocale } from "../i18n";
import { frameMessage } from "../sandbox/protocol";
import "../register";

const mount = async <T extends HTMLElement>(
  tag: string,
  props: Record<string, unknown> = {}
): Promise<T> => {
  const el = document.createElement(tag) as T & { updateComplete: Promise<unknown> };
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};

describe("app-level elements", () => {
  it("lu-time-range-picker dispatches lu-time-range with a preset", async () => {
    const el = await mount<HTMLElement>("lu-time-range-picker");
    const seen: unknown[] = [];
    el.addEventListener("lu-time-range", (e) => seen.push((e as CustomEvent).detail));
    const btn = el.shadowRoot?.querySelector("button[data-preset='7d']") as HTMLButtonElement;
    btn.click();
    expect(seen).toEqual([{ preset: "7d" }]);
  });
  it("lu-locale-picker lists locales and switches the shim's locale", async () => {
    setLocale("en-US");
    const el = await mount<HTMLElement>("lu-locale-picker", { locales: ["en-US", "de-DE"] });
    const select = el.shadowRoot?.querySelector("select") as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    select.value = "de-DE";
    select.dispatchEvent(new Event("change"));
    expect(currentLocale()).toBe("de-DE");
    setLocale("en-US");
  });
  it("lu-a2ui-view renders a Text primitive bound to data and a Button dispatches a2ui-action", async () => {
    // The brief's fixture used a { root, nodes: {...} } shape with $pointer bindings and
    // props.text; the real A2UIView (src/a2ui/plan.ts, ported from a prior a2ui.ts) is an
    // adjacency-list ARRAY with exactly one node id "root", a `component` key (not `type`),
    // props directly on the node (not under `props`), and a `{ path }` JSON-Pointer binding
    // (not `$pointer`). Adjusted per the brief's own instruction to fix the fixture, not the
    // assertions.
    const view = {
      nodes: [
        { id: "root", component: "Column", children: ["t", "b"] },
        { id: "t", component: "Text", text: { path: "/title" } },
        { id: "b", component: "Button", label: "Go", action: "go" },
      ],
    };
    const el = await mount<HTMLElement>("lu-a2ui-view", { view, data: { title: "Hello" } });
    expect(el.shadowRoot?.textContent).toContain("Hello");
    const seen: unknown[] = [];
    el.addEventListener("a2ui-action", (e) => seen.push((e as CustomEvent).detail));
    (el.shadowRoot?.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toHaveLength(1);
  });
  it("lu-sandbox mounts a null-origin iframe with allow-scripts only", async () => {
    const el = await mount<HTMLElement>("lu-sandbox", { code: "root.textContent = 'x'", data: {} });
    const frame = el.shadowRoot?.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc.length).toBeGreaterThan(0);
  });
  it("lu-sandbox clamps the height the untrusted frame reports for itself", async () => {
    const el = await mount<HTMLElement>("lu-sandbox", { code: "root.textContent = 'x'", data: {} });
    const frame = el.shadowRoot?.querySelector("iframe") as HTMLIFrameElement;
    const report = async (height: number): Promise<string> => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: frameMessage({ type: "resize", height }),
          source: frame.contentWindow,
        })
      );
      await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
      return (
        (el.shadowRoot?.querySelector("iframe") as HTMLIFrameElement).getAttribute("style") ?? ""
      );
    };
    expect(await report(320)).toContain("height: 320px");
    // The frame's own report goes straight into the host's layout: a million-pixel (or negative,
    // or NaN) claim must not.
    expect(await report(1e9)).toContain("height: 4000px");
    expect(await report(-50)).toContain("height: 0px");
    expect(await report(Number.NaN)).toContain("height: 0px");
  });
});
