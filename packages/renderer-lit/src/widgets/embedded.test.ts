import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import "../register";

const b = { projectionId: "hydration", path: "values.h" };
type Mounted = HTMLElement & { updateComplete: Promise<unknown> };
const mount = async (tag: string, props: Record<string, unknown>): Promise<Mounted> => {
  const el = document.createElement(tag) as Mounted;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};
const view = {
  nodes: [
    { id: "root", component: "Column", children: ["t", "go"] },
    { id: "t", component: "Text", text: { path: "/title" } },
    { id: "go", component: "Button", label: "Go", action: "go" },
  ],
};

describe("A2UIView kind", () => {
  it("mounts lu-a2ui-view with props.view and the bound value as data, and keeps it across updates", async () => {
    const el = await mount("lu-a2ui-widget", {
      widget: customWidget$({
        kind: "A2UIView",
        id: "a",
        title: "Form",
        binding: b,
        props: { view },
      }),
      value: { title: "Hello" },
    });
    const inner = el.shadowRoot?.querySelector("lu-a2ui-view") as Mounted;
    await inner.updateComplete;
    expect(inner.shadowRoot?.textContent).toContain("Hello");
    Object.assign(el, { value: { title: "World" } });
    await el.updateComplete;
    await inner.updateComplete;
    expect(el.shadowRoot?.querySelector("lu-a2ui-view")).toBe(inner);
    expect(inner.shadowRoot?.textContent).toContain("World");
  });
  it("is loading until a value arrives, and a2ui-action bubbles out of the widget host", async () => {
    const el = await mount("lu-a2ui-widget", {
      widget: customWidget$({
        kind: "A2UIView",
        id: "a2",
        title: "Form",
        binding: b,
        props: { view },
      }),
    });
    expect(el.shadowRoot?.querySelector("[data-state='loading']")).not.toBeNull();
    expect(el.shadowRoot?.querySelector("lu-a2ui-view")).toBeNull();
    Object.assign(el, { value: { title: "x" } });
    await el.updateComplete;
    const inner = el.shadowRoot?.querySelector("lu-a2ui-view") as Mounted;
    await inner.updateComplete;
    const seen: unknown[] = [];
    el.addEventListener("a2ui-action", (e) => seen.push((e as CustomEvent).detail));
    (inner.shadowRoot?.querySelector("button") as HTMLButtonElement).click();
    expect(seen).toEqual([{ action: "go", context: undefined }]);
  });
});

describe("SandboxView kind", () => {
  it("mounts lu-sandbox with props.code and the bound value as data, re-using it on a value change", async () => {
    const code = "root.textContent = JSON.stringify(data)";
    const el = await mount("lu-sandbox-widget", {
      widget: customWidget$({
        kind: "SandboxView",
        id: "s",
        title: "Custom",
        binding: b,
        props: { code },
      }),
      value: { n: 1 },
    });
    const inner = el.shadowRoot?.querySelector("lu-sandbox") as Mounted & {
      code: string;
      data: unknown;
    };
    expect(inner.code).toBe(code);
    expect(inner.data).toEqual({ n: 1 });
    Object.assign(el, { value: { n: 2 } });
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("lu-sandbox")).toBe(inner);
    expect(inner.data).toEqual({ n: 2 });
  });
  it("says so when the widget carries no code, rather than mounting an empty frame", async () => {
    const el = await mount("lu-sandbox-widget", {
      widget: customWidget$({ kind: "SandboxView", id: "s2", title: "Custom", binding: b }),
      value: { n: 1 },
    });
    expect(el.shadowRoot?.querySelector("lu-sandbox")).toBeNull();
    expect(el.shadowRoot?.textContent).toContain("no component code");
  });
});
