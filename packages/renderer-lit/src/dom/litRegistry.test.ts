import { FRAMEWORK_KINDS } from "@loom-ui/core";
import { MetricCard, builtinCatalog, catalogCoverage } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import {
  LIT_ONLY_KINDS,
  elementRenderer,
  frameworkKindContracts,
  litRegistry,
} from "./litRegistry";

describe("litRegistry parity", () => {
  it("covers every kind in loom's built-in catalogue, so one web compile renders on React or Lit", () => {
    const report = catalogCoverage(builtinCatalog, litRegistry);
    expect(report.missing).toEqual([]);
    expect(report.ok).toBe(true);
  });
  it("names the Lit-only kinds explicitly and declares their loom contracts", () => {
    expect([...LIT_ONLY_KINDS].sort()).toEqual([...FRAMEWORK_KINDS].sort());
    for (const k of FRAMEWORK_KINDS) expect(litRegistry.has(k)).toBe(true);
    expect(frameworkKindContracts.map((c) => c.kind).sort()).toEqual([...FRAMEWORK_KINDS].sort());
    // A Note is static text from props; every other framework kind renders bound data.
    for (const c of frameworkKindContracts)
      expect(c.binding).toBe(c.kind === "Note" ? "none" : "required");
  });
  it("the registry's extras beyond the catalogue are exactly the Lit-only kinds", () => {
    const report = catalogCoverage(builtinCatalog, litRegistry);
    expect([...report.extra].sort()).toEqual([...LIT_ONLY_KINDS].sort());
  });
  it("elementRenderer's handle patches the widget: the element's reactive `widget` property is replaced and it re-renders with the new title", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const renderer = elementRenderer("lu-metric-card");
    const widget = MetricCard({ id: "m", title: "Old", binding: { projectionId: "p", path: "v" } });
    const handle = renderer(host, { widget, value: 1 });
    const el = host.firstElementChild as HTMLElement & {
      widget: unknown;
      updateComplete: Promise<unknown>;
    };
    await el.updateComplete;
    expect(el.shadowRoot?.textContent).toContain("Old");
    expect(typeof handle.patch).toBe("function");
    handle.patch?.({ ...widget, title: "New" });
    await el.updateComplete;
    expect(el.widget).toEqual({ ...widget, title: "New" });
    expect(el.shadowRoot?.textContent).toContain("New");
    expect(host.firstElementChild).toBe(el); // same element instance
    handle.dispose();
    host.remove();
  });
});
