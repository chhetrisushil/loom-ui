import {
  type ContainerNode,
  type Experience,
  type SemanticNode,
  compile,
  defineSemanticCatalog,
  genesis,
  hydrationPath,
  hydrationStatusPath,
} from "@loom-ui/core";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationStore,
} from "./projection";
import { mcpStep, providerSpec } from "./testing.test-support";

// ── The compiler's pin vs. what the runtime actually registers ────────────────
// `compile` writes `projectionVersions` into every blueprint (ADR 0095) from the id and version
// the CALLER hands it. This package owns both constants, and nothing in either package's own
// tests makes the two halves meet: a blueprint pinned to "hydration"/"1.0.0" while the store
// registers "loom-ui.hydration" is two green suites and a surface that renders nothing.
// `@loom-ui/core` cannot depend on `@loom-ui/hydration` (the dependency runs the other way), so
// the seam is asserted from here.

// `testCatalog` lives in core's `*.test-support.ts`, which is excluded from core's build and so
// is not reachable from another package — two entries, declared inline, are enough.
const catalog = defineSemanticCatalog({
  id: "wiring.semantic.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit"],
      binding: "required",
      surfaces: { web: { kind: "MetricCard" } },
    },
    {
      name: "Status",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: { web: { kind: "StatusBadge" } },
    },
  ],
});

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const sem = (id: string, type: string, handle: string): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type,
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle, priority: "P0" },
});

const experience = (): Experience => {
  const g = genesis({
    experienceId: "exp-1",
    intent: { objective: "Investigate checkout latency", source: "user" },
    meta,
  });
  return {
    ...g,
    versionHash: "sha256:v1",
    root: {
      ...(g.root as ContainerNode),
      children: [sem("p99", "Metric", "latency"), sem("health", "Status", "health")],
    },
    providers: {
      latency: providerSpec("latency", [mcpStep("s", "db.latency")]),
      health: providerSpec("health", [mcpStep("s", "db.health")]),
    },
  };
};

describe("compiler pin ↔ registered projection", () => {
  it("a blueprint's projectionVersions are exactly what registering the store pins", () => {
    const runtime = new InMemoryProjectionRuntime();
    new HydrationStore(runtime, { experienceId: "exp-1", principalId: "alice" });
    const r = compile(experience(), {
      surface: "web",
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(typeof runtime.pins).toBe("function"); // the comparison below must not be vacuous
    expect(r.blueprint.projectionVersions).toEqual(runtime.pins());
    expect(r.blueprint.projections).toEqual([HYDRATION_PROJECTION_ID]);
  });

  it("every bound widget's path names a handle this store publishes under", () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "exp-1", principalId: "alice" });
    const r = compile(experience(), {
      surface: "web",
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    });
    // Structural, to avoid a dependency on @loom/blueprint-runtime this package does not declare.
    // The root is a `column` container, so its children are widgets, not grid cells.
    const children = (r.blueprint.layout as { children: readonly unknown[] }).children;
    const bound = children.map(
      (c) =>
        (
          c as {
            binding?: { projectionId: string; path: string; status?: { path: string } };
          }
        ).binding
    );
    expect(bound.map((b) => b?.projectionId)).toEqual([
      HYDRATION_PROJECTION_ID,
      HYDRATION_PROJECTION_ID,
    ]);
    // Computed FORWARD from core's path helpers: the compiled paths must be the ones this store
    // publishes under, for both the value and the status channel (loom ADR 0097 D2).
    const handles = ["health", "latency"]; // `normalize` orders children by order key
    expect(bound.map((b) => b?.path)).toEqual(handles.map(hydrationPath));
    expect(bound.map((b) => b?.status?.path)).toEqual(handles.map(hydrationStatusPath));
    for (const h of handles) store.setValue(h, { v: h }, { state: "ready" });
    expect(store.state().values).toEqual({ latency: { v: "latency" }, health: { v: "health" } });
  });
});
