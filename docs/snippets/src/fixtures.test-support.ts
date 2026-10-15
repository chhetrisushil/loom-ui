import {
  type Experience,
  type ProviderSpec,
  type SemanticCatalog,
  compile,
  defineSemanticCatalog,
  genesis,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationStore,
} from "@loom-ui/hydration/client";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";

// A small board shared by the snippet tests whose doc text starts from "the experience and
// blueprint from the walkthrough" rather than re-deriving them. Not mirrored into any doc.

export const meta = { author: "docs", createdAt: "2026-01-01T00:00:00Z", sourceKind: "example" };

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.quickstart.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: {
        web: { kind: "Kpi", props: ["unit", "format"], binding: "required" },
        terminal: { kind: "Kpi", props: ["unit", "format"], binding: "required" },
      },
    },
  ],
});

export const kpiProvider = (handle: string, tool = "metrics.query"): ProviderSpec => ({
  handle,
  executionGraph: [
    {
      stepId: "read",
      toolName: tool,
      toolVersion: "1.0.0",
      toolSchemaHash: "sha256:metrics-query-v1",
      arguments: { metric: handle },
      dependsOn: [],
      idempotent: true,
    },
  ],
  reshaping: { engine: "Named", scriptRef: "to-kpi" },
  outputShapeHash: "",
  outputCheck: "contract",
  cachePolicy: { ttlSeconds: 30, scope: "global" },
});

export function boardExperience(): Experience {
  const r = replay(
    genesis({
      experienceId: "checkout-latency",
      intent: { objective: "Watch checkout latency", source: "user" },
      meta,
    }),
    [
      { type: "remapProvider", handle: "latency-p99", spec: kpiProvider("latency-p99") },
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "p99",
          order: "V",
          kind: "semantic",
          type: "Metric",
          typeVersion: "1.0.0",
          span: 6,
          label: { key: "latency.p99", fallback: "p99 latency" },
          props: { unit: "ms" },
          binding: { handle: "latency-p99", priority: "P0" },
        },
      },
    ]
  );
  if (!r.ok) throw new Error(r.finding.message);
  return seal(r.value);
}

export function boardBlueprint(surface: "web" | "terminal", exp = boardExperience()) {
  return compile(exp, {
    surface,
    catalog,
    hydrationProjectionId: HYDRATION_PROJECTION_ID,
    hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
  });
}

export function boardStore() {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "checkout-latency" });
  store.setValue("latency-p99", { value: 412.4, unit: "ms" }, { state: "ready" });
  return { runtime, store };
}
