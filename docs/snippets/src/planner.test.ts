// The code of docs/guides/planners-and-learning.md (see mirror.test-support.ts).
import { describe, expect, it } from "vitest";
import { expectDocMirrors } from "./mirror.test-support";
// #region imports
import { defineSemanticCatalog, genesis, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { executeProvider } from "@loom-ui/hydration";
import type { DriftRecord, TransientInvoker } from "@loom-ui/hydration";
import {
  type CapabilityRef,
  type DecideContext,
  type PlannerModel,
  ReferencePlanner,
  checkPlannerConformance,
  declaredToolClassesFrom,
  plannerProvenance,
  reviseForDrift,
} from "@loom-ui/planner";
// #endregion imports

describe("docs/guides/planners-and-learning.md", () => {
  // #region inputs
  // The closed vocabulary a planner may name. A gap is a finding, never a guess.
  const catalog = defineSemanticCatalog({
    id: "example.planning.v1",
    entries: [
      {
        name: "Metric",
        version: "1.0.0",
        props: ["unit"],
        binding: "required",
        surfaces: { web: { kind: "Kpi", props: ["unit"], binding: "required" } },
      },
    ],
  });

  // Capabilities are an INPUT: the app resolves tools and pins their schema. A capability with no
  // `sampleOutput` is not bindable, because the planner pins the output shape from the sample.
  const capabilities: CapabilityRef[] = [
    {
      handle: "orders",
      toolName: "orders.summary",
      toolVersion: "2.1.0",
      toolSchemaHash: "sha256:orders-summary-2-1",
      description: "Order totals for a window",
      sampleOutput: { window: "7d", totals: { count: 412 } },
    },
  ];
  // #endregion inputs

  // The scripted model replies with these, in order, repeating the last.
  const draft = (path: string, label = "Orders (7d)", span = 6) =>
    JSON.stringify({
      summary: "Orders for the week",
      nodes: [
        {
          id: "orders",
          type: "Metric",
          label,
          span,
          props: { unit: "orders" },
          binding: {
            capability: "orders",
            arguments: { window: "7d" },
            path,
            priority: "P0",
          },
        },
      ],
    });
  const scripted = (replies: string[]) => {
    const model = {
      calls: 0,
      async complete() {
        const content = replies[Math.min(model.calls, replies.length - 1)] as string;
        model.calls += 1;
        return { content };
      },
    };
    return model satisfies PlannerModel;
  };
  const recording = () => {
    const decisions = new Map<string, unknown>();
    const ctx: DecideContext & { decisions: Map<string, unknown> } = {
      decisions,
      async decide(id, decider) {
        if (decisions.has(id)) return decisions.get(id) as never; // replay: no model call
        const value = await decider({
          invokeTransient: () => Promise.reject(new Error("no scope in this stub")),
        });
        decisions.set(id, JSON.parse(JSON.stringify(value)));
        return value;
      },
    };
    return ctx;
  };
  const meta = { author: "docs", createdAt: "2026-01-01T00:00:00Z", sourceKind: "example" };
  const intent = { objective: "Show weekly order volume", source: "user" } as const;

  it("composes and revises through operations, and replays without a model call", async () => {
    const model = scripted([draft("totals.count"), draft("totals.count", "Orders this week", 12)]);
    const ctx = recording();

    // #region compose
    // Any `@loom/llm` provider is a PlannerModel; `ctx` is your loom flow's ExecutionContext.
    const planner = new ReferencePlanner({ model, modelId: "my-model" });

    const plan = await planner.compose({ intent, catalog, capabilities }, ctx);
    // plan: { ops, findings, report, summary? }. Operations, never an Experience.

    const composed = replay(genesis({ experienceId: "weekly-orders", intent, meta }), plan.ops);
    if (!composed.ok) throw new Error(composed.finding.message);
    const v1 = seal(composed.value); // the APP persists it (see the lineage guide)

    // The same inputs on a recording context are served from the log: no second model call.
    await planner.compose({ intent, catalog, capabilities }, ctx);
    // #endregion compose
    expect(model.calls).toBe(1);
    expect(plan.findings.filter((f) => f.severity === "error")).toEqual([]);

    // #region revise
    // A revision is ONE `prompt` op; its materialized primitives replay to the same artifact.
    const revision = await planner.revise(
      { experience: v1, request: { text: "make the orders tile wider" }, catalog, capabilities },
      ctx
    );
    const revised = replay(v1, revision.ops);
    if (!revised.ok) throw new Error(revised.finding.message);

    // Stamp the ops with the model call that produced them.
    const by = plannerProvenance(revision, { agentId: "dashboard-planner" });
    // by: { source: "agent", modelId: "my-model", ... } -> Lineage.compose({ ..., by })
    // #endregion revise
    expect(revision.ops).toHaveLength(1);
    expect(revision.ops[0]?.type).toBe("prompt");
    expect(by.source).toBe("agent");
    expect(Object.keys(seal(revised.value).providers)).toHaveLength(1);

    // #region classes
    // The same capabilities the planner reads give the host's read-time floor, so the two agree.
    const declaredToolClasses = declaredToolClassesFrom(capabilities);
    // pass it as `readPolicy: { declaredToolClasses }` to Lineage, compile and serveHandles
    // #endregion classes
    expect(declaredToolClasses).toEqual({});
  });

  it("re-authors a provider after output drift", async () => {
    const model = scripted([draft("totals.count")]);
    const ctx = recording();
    const planner = new ReferencePlanner({ model, modelId: "my-model" });
    const plan = await planner.compose({ intent, catalog, capabilities }, ctx);
    const base = replay(genesis({ experienceId: "weekly-orders", intent, meta }), plan.ops);
    if (!base.ok) throw new Error(base.finding.message);
    const experience = seal(base.value);

    // #region drift
    // The tool now nests the count it used to return flat.
    const invoker: TransientInvoker = {
      async invokeTransient<TIn, TOut>(): Promise<TOut> {
        return { window: "7d", totals: { count: { value: 412 } } } as TOut;
      },
    };
    const handle = Object.keys(experience.providers)[0] as string;
    const outcome = await executeProvider(experience.providers[handle]!, {
      invoker,
      captureSample: true, // keep the raw output so the planner can re-pin against it
    });
    const drift: DriftRecord[] = outcome.ok ? [] : [...outcome.drift];

    // Output drift is repaired only by a planner: it re-paths the binding and re-pins the shape.
    const fixer = new ReferencePlanner({
      model: scripted([draft("totals.count.value")]),
      modelId: "my-model",
    });
    const repair = await reviseForDrift(fixer, { experience, drift, catalog, capabilities }, ctx);
    // repair.ops: one `prompt` op (remapProvider + bindProvider + removeProvider), node ids kept
    // #endregion drift
    expect(drift).toHaveLength(1);
    expect(repair.ops).toHaveLength(1);
    const again = replay(experience, repair.ops);
    expect(again.ok).toBe(true);
  });

  it("passes the conformance kit", async () => {
    const model = scripted([draft("totals.count"), draft("totals.count", "Orders this week", 12)]);
    const planner = new ReferencePlanner({ model, modelId: "my-model" });

    // #region conformance
    const findings = await checkPlannerConformance(planner, {
      intent,
      catalog,
      capabilities,
      meta,
      revision: { text: "make the orders tile wider" },
      ctx: recording(), // a FRESH recording context: the kit composes twice and expects a replay
      modelCalls: () => model.calls, // lets the kit assert the second compose made no model call
    });
    // findings === [] for a conforming planner
    // #endregion conformance
    expect(findings).toEqual([]);
  });

  it("keeps docs/guides/planners-and-learning.md in step with this file", () => {
    expectDocMirrors("docs/guides/planners-and-learning.md", "planner.test.ts");
  });
});
