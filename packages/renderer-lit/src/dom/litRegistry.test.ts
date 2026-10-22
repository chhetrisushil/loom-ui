import {
  type ContainerNode,
  FRAMEWORK_KINDS,
  type SemanticNode,
  compile,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { MetricCard, builtinCatalog, catalogCoverage } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import {
  LIT_ONLY_KINDS,
  elementRenderer,
  frameworkKindContracts,
  litRegistry,
} from "./litRegistry";
import "../register";

// The opt-in entries' kinds (`@loom-ui/renderer-lit/media`, `/chat`): the default registry draws a fixed placeholder for them.
const MEDIA = new Set<string>([
  "Image",
  "Audio",
  "Video",
  "File",
  "MediaInput",
  "Chat",
  "TextInput",
  "FormInput",
  "SelectInput",
  "MultiSelectInput",
]);

describe("litRegistry parity", () => {
  it("covers every kind in loom's built-in catalogue, so one web compile renders on React or Lit", () => {
    const report = catalogCoverage(builtinCatalog, litRegistry);
    expect(report.missing).toEqual([]);
    expect(report.ok).toBe(true);
  });
  it("names the Lit-only kinds explicitly and declares their loom contracts", () => {
    // The media kinds are framework kinds too, drawn by the opt-in `@loom-ui/renderer-lit/media`
    // entry (see media.test.ts for their registry parity), so the DEFAULT registry omits them.
    const defaultKinds = FRAMEWORK_KINDS.filter((k) => !MEDIA.has(k));
    expect([...LIT_ONLY_KINDS].sort()).toEqual([...defaultKinds].sort());
    for (const k of defaultKinds) expect(litRegistry.has(k)).toBe(true);
    // ...but it draws a fixed "not loaded" placeholder for them, never a hole.
    for (const k of MEDIA) expect(litRegistry.has(k)).toBe(true);
    expect(frameworkKindContracts.map((c) => c.kind).sort()).toEqual([...defaultKinds].sort());
    // A Note is static text from props; every other framework kind renders bound data.
    for (const c of frameworkKindContracts)
      expect(c.binding).toBe(c.kind === "Note" ? "none" : "required");
  });
  it("the registry's extras beyond the catalogue are exactly the Lit-only kinds", () => {
    const report = catalogCoverage(builtinCatalog, litRegistry);
    expect([...report.extra].sort()).toEqual([...LIT_ONLY_KINDS, ...MEDIA].sort());
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

// A regression guard over the whole framework-kind set: not expected to fail before any change
// here — it compiles one node per declared `frameworkKindContracts` entry against `litRegistry`
// and asserts zero findings, so adding a framework kind without a matching Lit renderer (or a
// contract that compile rejects) breaks this test rather than surfacing only in an app that
// happens to use that kind.
describe("framework kinds end to end", () => {
  it("every framework kind compiles clean against its declared contract and has a Lit renderer", () => {
    const catalog = defineSemanticCatalog({
      id: "framework.v1",
      entries: frameworkKindContracts.map((c) => ({
        name: `Sem${c.kind}`,
        version: "1.0.0",
        props: [...c.props],
        binding: c.binding,
        surfaces: { web: { kind: c.kind, props: [...c.props], binding: c.binding } },
      })),
    });
    const g = genesis({
      experienceId: "fw",
      intent: { objective: "every framework kind", source: "user" },
      meta: { author: "t", createdAt: "2026-09-23T00:00:00Z", sourceKind: "prompt" },
    });
    const children: SemanticNode[] = frameworkKindContracts.map((c, i) => ({
      id: `n${i}`,
      order: String.fromCharCode(65 + i),
      kind: "semantic",
      type: `Sem${c.kind}`,
      typeVersion: "1.0.0",
      span: 6,
      props: {},
      ...(c.binding !== "none" && { binding: { handle: `h${i}`, priority: "P1" as const } }),
    }));
    // A plain loop, not Object.fromEntries over flatMap: that infers `(string | {…})[][]`, not
    // entry tuples, and fails `typecheck:tests`.
    const providers: Record<
      string,
      {
        handle: string;
        executionGraph: never[];
        reshaping: { engine: "JSONPath"; scriptRef: string };
        outputShapeHash: string;
        cachePolicy: { ttlSeconds: number; scope: "global" };
      }
    > = {};
    for (const n of children)
      if (n.binding)
        providers[n.binding.handle] = {
          handle: n.binding.handle,
          executionGraph: [],
          reshaping: { engine: "JSONPath", scriptRef: "sha256:s" },
          outputShapeHash: "sha256:o",
          cachePolicy: { ttlSeconds: 60, scope: "global" },
        };
    const r = compile(
      { ...g, root: { ...(g.root as ContainerNode), children }, providers },
      {
        surface: "web",
        catalog,
        hydrationProjectionId: "hydration",
        hydrationProjectionVersion: "1.0.0",
        registry: litRegistry,
      }
    );
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
