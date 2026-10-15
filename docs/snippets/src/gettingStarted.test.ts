// after dedenting, by the fenced block that follows `<!-- snippet: name -->` in that document;
// the last test fails when they drift (see mirror.test-support.ts). Edit both, or neither.
import { describe, expect, it, vi } from "vitest";
import { expectDocMirrors } from "./mirror.test-support";
// #region imports
import {
  type SemanticCatalog,
  apply,
  compile,
  defineSemanticCatalog,
  genesis,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationController,
  HydrationStore,
  type TransientInvoker,
  defineReshapers,
} from "@loom-ui/hydration";
import { renderExperience, watch } from "@loom-ui/renderer-terminal";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
// #endregion imports

describe("docs/getting-started.md", () => {
  it("composes, compiles, hydrates and renders the walkthrough", async () => {
    // #region catalogue
    const catalog: SemanticCatalog = defineSemanticCatalog({
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
    // #endregion catalogue

    // #region compose
    const start = genesis({
      experienceId: "checkout-latency",
      intent: { objective: "Watch checkout latency", source: "user" },
      meta: { author: "docs", createdAt: "2026-01-01T00:00:00Z", sourceKind: "example" },
    });

    const inserted = apply(start, {
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
      },
    });
    if (!inserted.ok) throw new Error(inserted.finding.message);
    // #endregion compose

    // #region bind
    const bound = replay(inserted.value, [
      {
        type: "remapProvider",
        handle: "latency-p99",
        spec: {
          handle: "latency-p99",
          executionGraph: [
            {
              stepId: "read",
              toolName: "metrics.query",
              toolVersion: "1.0.0",
              toolSchemaHash: "sha256:metrics-query-v1",
              arguments: { metric: "checkout.latency.p99" },
              dependsOn: [],
              idempotent: true,
            },
          ],
          reshaping: { engine: "Named", scriptRef: "to-kpi" },
          outputShapeHash: "",
          outputCheck: "contract",
          cachePolicy: { ttlSeconds: 30, scope: "global" },
        },
      },
      { type: "bindProvider", nodeId: "p99", handle: "latency-p99", priority: "P0" },
    ]);
    if (!bound.ok) throw new Error(bound.finding.message);
    const experience = seal(bound.value);
    // #endregion bind

    // #region compile
    const { blueprint, findings, ok } = compile(experience, {
      surface: "terminal",
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    });
    if (!ok) throw new Error(findings.map((f) => `${f.code}: ${f.message}`).join("\n"));
    // #endregion compile

    // #region hydrate
    // Stands in for your loom EffectRuntime: hydration only ever calls `invokeTransient`.
    const invoker: TransientInvoker = {
      async invokeTransient<TIn, TOut>(_toolId: string, _input: TIn): Promise<TOut> {
        return { p99Ms: 412.4 } as TOut;
      },
    };

    const store = new HydrationStore(new InMemoryProjectionRuntime(), {
      experienceId: experience.experienceId,
    });
    const controller = new HydrationController({
      invoker,
      store,
      contentRefArgs: "none",
      outputKinds: { catalog, surface: "terminal" },
      reshapers: defineReshapers({
        "to-kpi": (raw) => ({ value: (raw as { p99Ms: number }).p99Ms, unit: "ms" }),
      }),
    });
    controller.load(experience);
    // #endregion hydrate

    // #region render
    const frames: string[] = [];
    const stop = watch(blueprint, store, (frame: string) => frames.push(frame));
    // `frames` now holds the loading frame; the P0 handle lands a moment later.
    // #endregion render
    await vi.waitFor(() => expect(store.status("latency-p99")?.state).toBe("ready"));
    // #region once
    console.log(renderExperience(blueprint, store));
    // #endregion once
    stop();
    controller.dispose();

    expect(findings).toEqual([]);
    expect(frames[0]).toContain("⋯ p99 latency");
    expect(frames.at(-1)).toContain("p99 latency");
    expect(frames.at(-1)).toContain("412");
    expect(renderExperience(blueprint, store)).toContain("412");
  });

  it("keeps docs/getting-started.md in step with this file", () => {
    expectDocMirrors("docs/getting-started.md", "gettingStarted.test.ts");
  });
});
