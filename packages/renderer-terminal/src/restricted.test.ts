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
