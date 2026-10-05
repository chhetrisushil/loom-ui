import {
  type ContainerNode,
  type SemanticNode,
  compile,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import type { Layout, Widget } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { frameworkKindContracts, litRegistry } from "../dom/litRegistry";
import "./index";

// U10: a node the viewer may not see compiles to a static `Note` placeholder. Both renderers draw
// it from the registry they already have — no new kind, no side channel — with an accessible name
// and text, and nothing of the node it replaced.

const note = frameworkKindContracts.find((c) => c.kind === "Note");
const catalog = defineSemanticCatalog({
  id: "u10",
  entries: [
    {
      name: "Figure",
      version: "1.0.0",
      props: ["unit"],
      binding: "required",
      surfaces: { web: { kind: "MetricCard", props: ["unit"], binding: "required" } },
    },
    {
      name: "Explainer",
      version: "1.0.0",
      props: [],
      binding: "none",
      surfaces: { web: { kind: "Note", props: [...(note?.props ?? [])], binding: "none" } },
    },
  ],
});
const g = genesis({
  experienceId: "u10",
  intent: { objective: "payroll review", source: "user" },
  meta: { author: "t", createdAt: "2026-10-05T00:00:00Z", sourceKind: "prompt" },
});
const children: SemanticNode[] = [
  {
    id: "pay",
    order: "A",
    kind: "semantic",
    type: "Figure",
    typeVersion: "1.0.0",
    span: 6,
    label: { key: "k", fallback: "Executive payroll" },
    props: { unit: "usd" },
    binding: { handle: "h-pay", priority: "P0", sensitivity: "sensitive" },
  },
];
const exp = {
  ...g,
  versionHash: "sha256:u10",
  root: { ...(g.root as ContainerNode), children },
  providers: {
    "h-pay": {
      handle: "h-pay",
      executionGraph: [],
      reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
      outputShapeHash: "sha256:o",
      cachePolicy: { ttlSeconds: 60, scope: "global" as const },
    },
  },
};

describe("a restricted node on the web surface", () => {
  const r = compile(exp, {
    surface: "web",
    catalog,
    hydrationProjectionId: "hydration",
    hydrationProjectionVersion: "1.0.0",
    registry: litRegistry,
    viewer: {},
  });
  const layout = r.blueprint.layout as Layout & { children: Array<{ node: Widget }> };
  const placeholder = (layout.children[0] as { node: Widget }).node;

  it("compiles clean against the Lit registry (Note is registered)", () => {
    expect(r.ok).toBe(true);
    expect(placeholder.kind).toBe("Note");
  });
  it("renders its accessible name and text, and none of the node it replaced", async () => {
    const el = document.createElement("lu-note") as HTMLElement & {
      widget: Widget;
      updateComplete: Promise<unknown>;
    };
    el.widget = placeholder;
    document.body.appendChild(el);
    await el.updateComplete;
    const root = el.shadowRoot as ShadowRoot;
    expect(root.querySelector("[role=note]")?.getAttribute("aria-label")).toBe("Restricted");
    expect(root.textContent).toContain("Restricted");
    for (const leak of ["Executive payroll", "usd", "h-pay", "payroll"])
      expect(root.textContent).not.toContain(leak);
    el.remove();
  });
});
