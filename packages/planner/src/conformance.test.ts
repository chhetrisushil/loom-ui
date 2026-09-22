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
  it("a planner whose report does not describe its own attempts fails report-invalid, and the rest of the contract is still checked", async () => {
    const reference = () => new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" });
    const lyingReport: Planner = {
      compose: async (i, ctx) => ({
        ...(await reference().compose(i, ctx)),
        // No attempts, no model named, and "clean on the first call" over zero calls.
        report: { decisionId: "x", attempts: [], firstAttemptValid: true, modelId: "" },
      }),
      revise: async (i, ctx) => {
        const r = await new ReferencePlanner({
          model: scriptedModel([revise]),
          modelId: "m",
        }).revise(i, ctx);
        return {
          ...r,
          report: {
            ...r.report,
            // Two attempts that both parsed, still claiming first-attempt-clean.
            attempts: [
              { parsed: true, findings: [] },
              { parsed: true, findings: [] },
            ],
            firstAttemptValid: true,
          },
        };
      },
    };
    const findings = await checkPlannerConformance(lyingReport, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add an insight" },
      ctx: recordingContext(),
    });
    const invalid = findings.filter((f) => f.code === "report-invalid");
    expect(invalid).toHaveLength(4); // compose: empty attempts, empty modelId, bad flag; revise: bad flag
    expect(invalid.map((f) => f.message).join("\n")).toContain("report.attempts is empty");
    expect(invalid.map((f) => f.message).join("\n")).toContain("report.modelId is empty");
    // Nothing else about this planner is wrong, so report-invalid is ALL that is reported.
    expect(findings.map((f) => f.code)).toEqual([
      "report-invalid",
      "report-invalid",
      "report-invalid",
      "report-invalid",
    ]);
  });
  it("a planner whose compose rejects resolves with a planner-threw finding naming the error, never a rejection", async () => {
    const throwing: Planner = {
      compose: async () => {
        throw new Error("boom");
      },
      revise: async () => ({
        ops: [],
        findings: [],
        report: { decisionId: "y", attempts: [], firstAttemptValid: true, modelId: "m" },
      }),
    };
    const findings = await checkPlannerConformance(throwing, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    const finding = findings.find((f) => f.code === "planner-threw");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("boom");
  });
  it("a planner whose compose works but whose revise rejects reports planner-threw, not revise-not-prompt", async () => {
    const composeOkReviseThrows: Planner = {
      compose: (i, ctx) =>
        new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" }).compose(i, ctx),
      revise: async () => {
        throw new Error("boom");
      },
    };
    const findings = await checkPlannerConformance(composeOkReviseThrows, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    expect(findings.map((f) => f.code)).toContain("planner-threw");
    expect(findings.map((f) => f.code)).not.toContain("revise-not-prompt");
  });
});
