import { describe, expect, it, vi } from "vitest";
import { defineKpi } from "./define/lu-kpi";
import { defineAll } from "./defineAll";
import { defineElement, elementRenderer } from "./index";

// U20: registration is explicit. Importing the barrel registers nothing; `defineKpi()` registers one
// element, `defineAll()` the lot, both idempotently; mounting an undefined tag says so, once.

const DEFAULT_TAGS = [
  "lu-metric-card",
  "lu-status-badge",
  "lu-data-table",
  "lu-timeseries",
  "lu-bar-chart",
  "lu-kpi",
  "lu-table",
  "lu-status-card",
  "lu-note",
  "lu-a2ui-widget",
  "lu-sandbox-widget",
  "lu-a2ui-view",
  "lu-sandbox",
  "lu-media-missing",
  "lu-chat-missing",
  "lu-progress",
  "lu-alert",
  "lu-text",
  "lu-list",
  "lu-approval",
  "lu-locale-picker",
  "lu-time-range-picker",
  "lu-image",
  "lu-audio",
  "lu-video",
  "lu-file",
  "lu-media-input",
  "lu-chat",
  "lu-text-input",
  "lu-form-input",
  "lu-select-input",
];

describe("explicit registration", () => {
  it("importing the package defined nothing", () => {
    for (const t of DEFAULT_TAGS) expect(customElements.get(t), t).toBeUndefined();
  });

  it("an undefined tag warns ONCE with the fix, then draws an inert element", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = document.createElement("div");
    const render = elementRenderer("lu-kpi");
    const props = {
      widget: { id: "w", kind: "Kpi", title: "t", props: {} },
      value: undefined,
      status: undefined,
      onAction: undefined,
    } as never;
    render(host, props);
    render(host, props);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("@loom-ui/renderer-lit/register");
    warn.mockRestore();
  });

  it("defineKpi registers lu-kpi and only lu-kpi, idempotently", () => {
    defineKpi();
    defineKpi();
    expect(customElements.get("lu-kpi")).toBeDefined();
    expect(customElements.get("lu-note")).toBeUndefined();
  });

  it("defineElement leaves an already-defined tag alone", () => {
    class A extends HTMLElement {}
    class B extends HTMLElement {}
    defineElement("lu-test-twice", A);
    expect(() => defineElement("lu-test-twice", B)).not.toThrow();
    expect(customElements.get("lu-test-twice")).toBe(A);
  });

  it("defineAll registers every tag the default registries draw", () => {
    defineAll();
    defineAll();
    for (const t of DEFAULT_TAGS) expect(customElements.get(t), t).toBeDefined();
  });
});
