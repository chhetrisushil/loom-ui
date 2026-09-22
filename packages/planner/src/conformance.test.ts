import { isContainer } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { checkPlannerConformance } from "./conformance";
import { ReferencePlanner } from "./reference";
import type { Planner } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";

const compose = JSON.stringify({
  summary: "s",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders",
      span: 4,
      props: {},
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0",
      },
    },
  ],
});
const revise = JSON.stringify({
  summary: "s",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders",
      span: 4,
      props: {},
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0",
      },
    },
    { id: "why", type: "Insight", label: "Why", span: 12, props: {} },
  ],
});

describe("checkPlannerConformance", () => {
  it("the reference planner on a scripted model passes with zero findings", async () => {
    const model = scriptedModel([compose, revise]);
    const planner = new ReferencePlanner({ model, modelId: "m" });
    const findings = await checkPlannerConformance(planner, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add an insight" },
      ctx: recordingContext(),
      modelCalls: () => model.calls,
    });
    expect(findings).toEqual([]);
  });
  it("a planner that returns an experience-shaped blob instead of ops fails with op-invalid", async () => {
    const bad: Planner = {
      compose: async () => ({
        ops: [{ type: "setExperience" } as never],
        findings: [],
        report: { decisionId: "x", attempts: [], firstAttemptValid: true, modelId: "bad" },
      }),
      revise: async () => ({
        ops: [],
        findings: [],
        report: { decisionId: "y", attempts: [], firstAttemptValid: true, modelId: "bad" },
      }),
    };
    const findings = await checkPlannerConformance(bad, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    expect(findings.map((f) => f.code)).toContain("op-invalid");
  });
  it("a revise that returns primitives instead of one prompt op fails with revise-not-prompt; a prompt whose materialized does not reproduce the artifact fails with prompt-replay-mismatch", async () => {
    const primitives: Planner = {
      compose: (i, ctx) =>
        new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" }).compose(i, ctx),
      revise: async (input) => {
        const root = input.experience.root;
        if (!isContainer(root)) throw new Error("experience root is not a container");
        return {
          ops: [{ type: "removeNode", nodeId: root.children[0]!.id }],
          findings: [],
          report: { decisionId: "y", attempts: [], firstAttemptValid: true, modelId: "m" },
        };
      },
    };
    const f1 = await checkPlannerConformance(primitives, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    expect(f1.map((f) => f.code)).toContain("revise-not-prompt");
    const lying: Planner = {
      compose: (i, ctx) =>
        new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" }).compose(i, ctx),
      // A prompt op whose materialized list is empty while the planner CLAIMS a change happened cannot be detected by replay alone;
      // the detectable lie is a materialized list that fails to apply.
      revise: async () => ({
        ops: [
          {
            type: "prompt",
            text: "x",
            materialized: [{ type: "removeNode", nodeId: "does-not-exist" }],
          },
        ],
        findings: [],
        report: { decisionId: "y", attempts: [], firstAttemptValid: true, modelId: "m" },
      }),
    };
    const f2 = await checkPlannerConformance(lying, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    expect(f2.map((f) => f.code)).toContain("prompt-replay-failed");
  });
  it("a planner whose second compose calls the model again fails replay-recalled-model", async () => {
    const model = scriptedModel([compose, revise, compose]);
    const noDecide: Planner = {
      // Bypasses ctx.decide on purpose.
      compose: async (input) => {
        await model.complete({ messages: [] });
        return new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" }).compose(
          input,
          recordingContext()
        );
      },
      revise: (i, ctx) =>
        new ReferencePlanner({ model: scriptedModel([revise]), modelId: "m" }).revise(i, ctx),
    };
    const findings = await checkPlannerConformance(noDecide, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add" },
      ctx: recordingContext(),
      modelCalls: () => model.calls,
    });
    expect(findings.map((f) => f.code)).toContain("replay-recalled-model");
  });
  it("a revision that drops a node fails dropped-node unless the fixture expects removal", async () => {
    const dropping = JSON.stringify({
      summary: "s",
      nodes: [{ id: "why", type: "Insight", label: "Why", span: 12, props: {} }],
    });
    const planner = new ReferencePlanner({
      model: scriptedModel([compose, dropping]),
      modelId: "m",
    });
    const f1 = await checkPlannerConformance(planner, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "replace" },
      ctx: recordingContext(),
    });
    expect(f1.map((f) => f.code)).toContain("dropped-node");
    const planner2 = new ReferencePlanner({
      model: scriptedModel([compose, dropping]),
      modelId: "m",
    });
    const f2 = await checkPlannerConformance(planner2, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "replace", expectRemoval: true },
      ctx: recordingContext(),
    });
    expect(f2).toEqual([]);
  });
});
