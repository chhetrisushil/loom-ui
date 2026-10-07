import { type ContainerNode, compile, defineSemanticCatalog, genesis } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { terminalRegistry } from "./registry";
import { renderExperience } from "./status";

// U10: the restricted state is a `Note` the terminal already draws. Even if the store HOLDS the
// value (a renderer is not the enforcement point), nothing binds the placeholder to it.

const catalog = defineSemanticCatalog({
  id: "u10",
  entries: [
    {
      name: "Figure",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { terminal: { kind: "MetricCard", props: [], binding: "required" } },
    },
    {
      name: "Explainer",
      version: "1.0.0",
      props: ["text"],
      binding: "none",
      surfaces: { terminal: { kind: "Note", props: ["text"], binding: "none" } },
    },
  ],
});
const g = genesis({
  experienceId: "u10",
  intent: { objective: "payroll review", source: "user" },
  meta: { author: "t", createdAt: "2026-10-05T00:00:00Z", sourceKind: "prompt" },
});
const exp = {
  ...g,
  versionHash: "sha256:u10",
  root: {
    ...(g.root as ContainerNode),
    children: [
      {
        id: "pay",
        order: "A",
        kind: "semantic" as const,
        type: "Figure",
        typeVersion: "1.0.0",
        span: 6,
        label: { key: "k", fallback: "Executive payroll" },
        props: {},
        binding: { handle: "h-pay", priority: "P0" as const, sensitivity: "sensitive" as const },
      },
    ],
  },
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
const opts = {
  surface: "terminal" as const,
  catalog,
  hydrationProjectionId: HYDRATION_PROJECTION_ID,
  hydrationProjectionVersion: "1.0.0",
  registry: terminalRegistry(),
};

describe("a restricted node in the terminal", () => {
  const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "u10" });
  store.setValue("h-pay", 987654, { state: "ready" });

  it("prints the restricted state, never the value or the label", () => {
    const r = compile(exp, { ...opts, viewer: { clearance: "internal" } });
    expect(r.ok).toBe(true);
    const out = renderExperience(r.blueprint, store);
    expect(out).toContain("Restricted");
    expect(out).not.toContain("987654");
    expect(out).not.toContain("Executive payroll");
  });
  it("a cleared viewer's compile renders the value as before", () => {
    const r = compile(exp, { ...opts, viewer: { clearance: "sensitive" } });
    expect(renderExperience(r.blueprint, store)).toContain("987654");
  });
});

// A container whose compiled children are all restricted is a bare placeholder: no title, no
// children, drawn exactly like a restricted node (U15 fix round 2).
describe("a container whose children are all restricted, in the terminal", () => {
  const figure = (id: string, sensitivity?: "sensitive") => ({
    ...(exp.root.children[0] as object),
    id,
    order: id,
    label: { key: id, fallback: `Label ${id}` },
    binding: { handle: `h-${id}`, priority: "P0" as const, ...(sensitivity && { sensitivity }) },
  });
  const section = (id: string, children: unknown[]) => ({
    id,
    order: id,
    kind: "container" as const,
    direction: "column" as const,
    span: 12,
    role: "tabs",
    title: { key: id, fallback: `Section ${id}` },
    children,
  });
  const build = (children: unknown[]) =>
    ({ ...exp, root: { ...exp.root, children: [...children, figure("pub")] } }) as never;
  const store2 = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "u10" });
  for (const h of ["h-a", "h-b", "h-pub"]) store2.setValue(h, 424242, { state: "ready" });

  it("prints one restricted state, no section title and no child label", () => {
    const e = build([section("s1", [figure("a", "sensitive"), figure("b", "sensitive")])]);
    const r = compile(e, { ...opts, viewer: { clearance: "internal" } });
    const out = renderExperience(r.blueprint, store2);
    expect(out).toContain("Restricted");
    expect(out).not.toContain("Section s1");
    expect(out).not.toContain("Label a");
    expect(out).toContain("Label pub");
  });
  it("keeps the title when a child is visible", () => {
    const e = build([section("s1", [figure("a", "sensitive"), figure("b")])]);
    const r = compile(e, { ...opts, viewer: { clearance: "internal" } });
    expect(renderExperience(r.blueprint, store2)).toContain("Section s1");
  });
});
