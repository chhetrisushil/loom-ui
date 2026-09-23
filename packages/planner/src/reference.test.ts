import {
  type Operation,
  defineSemanticCatalog,
  genesis,
  isContainer,
  replay,
  validateExperience,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { describe, expect, it } from "vitest";
import { planDecisionId } from "./decision";
import { REFERENCE_POLICY, ReferencePlanner } from "./reference";
import type { PlanResult, PlannerModel } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";
import { isPlannerUsage } from "./usage";

const goodDraft = JSON.stringify({
  summary: "Weekly orders and top SKUs",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders (7d)",
      span: 4,
      props: { unit: "orders" },
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0",
      },
    },
    {
      id: "top_skus",
      type: "Collection",
      label: "Top SKUs",
      span: 8,
      props: { columns: ["sku", "units"] },
      binding: { capability: "orders_summary", arguments: { window: "7d" }, path: "rows" },
    },
  ],
});
const badType = JSON.stringify({
  summary: "s",
  nodes: [{ id: "g", type: "Gauge", label: "x", props: {} }],
});
const input = {
  intent: intentFixture,
  catalog: planningCatalog,
  capabilities: capabilitiesFixture,
};

describe("ReferencePlanner.compose", () => {
  it("returns ops that replay to a valid experience, a clean report, and records ONE decision with the policy stamp", async () => {
    const model = scriptedModel([goodDraft]);
    const ctx = recordingContext();
    const planner = new ReferencePlanner({ model, modelId: "scripted-1" });
    const result = await planner.compose(input, ctx);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.report.firstAttemptValid).toBe(true);
    expect(result.report.attempts).toHaveLength(1);
    expect(result.report.modelId).toBe("scripted-1");
    expect(model.calls).toBe(1);
    const id = planDecisionId("compose", input);
    expect(result.report.decisionId).toBe(id);
    expect(ctx.decisions.has(id)).toBe(true);
    expect(ctx.opts.get(id)?.policy).toEqual(REFERENCE_POLICY);
    expect(ctx.opts.get(id)?.source).toBe("loom-ui.planner.reference");
    const exp = replay(
      genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture }),
      result.ops
    );
    expect(exp.ok && validateExperience(exp.value, planningCatalog, "web").ok).toBe(true);
  });
  it("replay serves the recorded ops and never re-calls the model", async () => {
    const model = scriptedModel([goodDraft]);
    const ctx = recordingContext();
    const planner = new ReferencePlanner({ model, modelId: "m" });
    const first = await planner.compose(input, ctx);
    const second = await planner.compose(input, ctx);
    expect(second).toEqual(first);
    expect(model.calls).toBe(1);
    expect(ctx.deciderCalls).toBe(1);
  });
  it("feeds contract issues back and succeeds on the second attempt; the report says it was not first-attempt valid", async () => {
    const model = scriptedModel([badType, goodDraft]);
    const planner = new ReferencePlanner({ model, modelId: "m" });
    const result = await planner.compose(input, recordingContext());
    expect(model.calls).toBe(2);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.report.firstAttemptValid).toBe(false);
    expect(result.report.attempts.map((a) => a.parsed)).toEqual([false, true]);
    expect(result.report.attempts[0]?.findings[0]?.code).toBe("model-output-invalid");
    expect(result.report.attempts[0]?.findings[0]?.message).toContain("Gauge");
  });
  it("feeds VALIDATION findings back (a parsed draft that binds an unsampled capability) and gives up after maxAttempts with plan-failed and empty ops — never throws", async () => {
    const unsampled = JSON.stringify({
      summary: "s",
      nodes: [
        {
          id: "inc",
          type: "Metric",
          label: "Incidents",
          props: {},
          binding: { capability: "incidents_open", arguments: {}, path: "" },
        },
      ],
    });
    const model = scriptedModel([unsampled]);
    const planner = new ReferencePlanner({ model, modelId: "m", maxAttempts: 3 });
    const result = await planner.compose(input, recordingContext());
    expect(model.calls).toBe(3);
    expect(result.ops).toEqual([]);
    expect(result.report.attempts).toHaveLength(3);
    expect(result.report.attempts.every((a) => a.parsed)).toBe(true);
    expect(result.findings.map((f) => f.code)).toContain("plan-failed");
    expect(result.findings.map((f) => f.code)).toContain("capability-unsampled");
    expect(result.findings.map((f) => f.code)).toContain("missing-binding");
  });
  it("a model that throws yields a plan-failed result with the error text, not a rejection", async () => {
    const model = {
      calls: 0,
      complete: async () => {
        throw new Error("rate limited");
      },
    };
    const planner = new ReferencePlanner({ model, modelId: "m" });
    const result = await planner.compose(input, recordingContext());
    expect(result.ops).toEqual([]);
    expect(
      result.findings.some((f) => f.code === "model-error" && f.message.includes("rate limited"))
    ).toBe(true);
  });
  it("a catalogue that cannot resolve to a loom catalogue fails BEFORE the model is called — a catalogue defect is not the model's to fix", async () => {
    // `binding: "none"` against builtin StreamingText, which hard-requires a binding: no draft
    // the model could write satisfies both sides, so retrying it only burns calls.
    const brokenCatalog = defineSemanticCatalog({
      id: "test.broken.v1",
      entries: [
        {
          name: "Note",
          version: "1.0.0",
          props: [],
          binding: "none",
          surfaces: { web: { kind: "StreamingText" }, terminal: { kind: "StreamingText" } },
        },
      ],
    });
    const model = scriptedModel([goodDraft]);
    const planner = new ReferencePlanner({ model, modelId: "m", maxAttempts: 3 });
    const result = await planner.compose(
      { intent: intentFixture, catalog: brokenCatalog, capabilities: capabilitiesFixture },
      recordingContext()
    );
    expect(model.calls).toBe(0);
    expect(result.ops).toEqual([]);
    expect(result.report.attempts).toEqual([]);
    expect(result.report.firstAttemptValid).toBe(false);
    expect(result.findings.map((f) => f.code)).toEqual([
      "binding-contract-conflict",
      "catalog-invalid",
    ]);
  });
  it("the recorded decision is JSON (no undefined-only fields, no functions)", async () => {
    const ctx = recordingContext();
    const planner = new ReferencePlanner({ model: scriptedModel([goodDraft]), modelId: "m" });
    const result = await planner.compose(input, ctx);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("ReferencePlanner.revise", () => {
  const composed = async () => {
    const planner = new ReferencePlanner({ model: scriptedModel([goodDraft]), modelId: "m" });
    const r = await planner.compose(input, recordingContext());
    const exp = replay(
      genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture }),
      r.ops
    );
    if (!exp.ok) throw new Error(exp.finding.message);
    return seal(exp.value);
  };
  const revisedDraft = JSON.stringify({
    summary: "Added an insight",
    nodes: [
      ...(JSON.parse(goodDraft) as { nodes: unknown[] }).nodes,
      {
        id: "why",
        type: "Insight",
        label: "Why volume moved",
        span: 12,
        props: { tone: "neutral" },
      },
    ],
  });
  it("returns exactly ONE prompt op whose materialized primitives replay to the same artifact as the prompt op itself; only the new id is new", async () => {
    const exp = await composed();
    const planner = new ReferencePlanner({ model: scriptedModel([revisedDraft]), modelId: "m" });
    const ctx = recordingContext();
    const result = await planner.revise(
      {
        experience: exp,
        request: { text: "add an insight explaining the trend" },
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
      },
      ctx
    );
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.ops).toHaveLength(1);
    const op = result.ops[0] as Operation & { type: "prompt" };
    expect(op.type).toBe("prompt");
    expect(op.text).toBe("add an insight explaining the trend");
    expect(op.materialized.map((o) => o.type)).toEqual(["insertNode"]);
    const viaPrompt = replay(exp, [op]);
    const viaPrimitives = replay(exp, op.materialized);
    expect(viaPrompt.ok && viaPrimitives.ok).toBe(true);
    if (viaPrompt.ok && viaPrimitives.ok) {
      expect(seal(viaPrompt.value).versionHash).toBe(seal(viaPrimitives.value).versionHash);
      expect(seal(viaPrompt.value).versionHash).not.toBe(exp.versionHash);
      const before = isContainer(exp.root) ? exp.root.children.map((c) => c.id) : [];
      const after = isContainer(viaPrompt.value.root)
        ? viaPrompt.value.root.children.map((c) => c.id)
        : [];
      expect(after.filter((id) => !before.includes(id))).toEqual(["why"]);
    }
    expect(result.report.decisionId).toBe(
      planDecisionId("revise", {
        versionHash: exp.versionHash,
        request: { text: "add an insight explaining the trend" },
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
      })
    );
  });
  it("a revision that materialises nothing still returns one prompt op (an empty materialized list), so the lineage records the ask", async () => {
    const exp = await composed();
    const planner = new ReferencePlanner({ model: scriptedModel([goodDraft]), modelId: "m" }); // identical draft → no changes
    const result = await planner.revise(
      {
        experience: exp,
        request: { text: "no-op" },
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
      },
      recordingContext()
    );
    expect(result.ops).toHaveLength(1);
    expect((result.ops[0] as { materialized: unknown[] }).materialized).toEqual([]);
    expect(result.findings.map((f) => f.code)).toContain("no-change");
  });
  it("refuses to revise an unsealed experience", async () => {
    const planner = new ReferencePlanner({ model: scriptedModel([goodDraft]), modelId: "m" });
    const unsealed = genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture });
    const result = await planner.revise(
      {
        experience: unsealed,
        request: { text: "x" },
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
      },
      recordingContext()
    );
    expect(result.ops).toEqual([]);
    expect(result.findings.map((f) => f.code)).toEqual(["unsealed-base"]);
  });
});

describe("ReferencePlanner usage", () => {
  const u = { inputTokens: 120, outputTokens: 30 };
  it("records each attempt's usage and their sum on the report, INSIDE the decision", async () => {
    const model = scriptedModel([badType, goodDraft], u);
    const ctx = recordingContext();
    const result = await new ReferencePlanner({ model, modelId: "m" }).compose(input, ctx);
    expect(result.report.attempts.map((a) => a.usage)).toEqual([u, u]);
    expect(result.report.usage).toEqual({ inputTokens: 240, outputTokens: 60 });
    const recorded = ctx.decisions.get(planDecisionId("compose", input)) as PlanResult;
    expect(recorded.report.usage).toEqual({ inputTokens: 240, outputTokens: 60 });
  });
  it("replay serves the recorded usage without calling the model", async () => {
    const model = scriptedModel([goodDraft], u);
    const ctx = recordingContext();
    const planner = new ReferencePlanner({ model, modelId: "m" });
    const first = await planner.compose(input, ctx);
    const second = await planner.compose(input, ctx);
    expect(second.report.usage).toEqual(first.report.usage);
    expect(second.report.usage).toEqual(u);
    expect(model.calls).toBe(1);
  });
  it("a revision reports its own usage", async () => {
    const exp = replay(
      genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture }),
      (
        await new ReferencePlanner({ model: scriptedModel([goodDraft]), modelId: "m" }).compose(
          input,
          recordingContext()
        )
      ).ops
    );
    if (!exp.ok) throw new Error(exp.finding.message);
    const r = await new ReferencePlanner({
      model: scriptedModel([goodDraft], { inputTokens: 9, outputTokens: 2 }),
      modelId: "m",
    }).revise(
      {
        experience: seal(exp.value),
        request: { text: "keep it" },
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
      },
      recordingContext()
    );
    expect(r.report.usage).toEqual({ inputTokens: 9, outputTokens: 2 });
  });
  it("a model that reports no usage leaves no usage key anywhere", async () => {
    const result = await new ReferencePlanner({
      model: scriptedModel([goodDraft]),
      modelId: "m",
    }).compose(input, recordingContext());
    expect("usage" in result.report).toBe(false);
    expect(result.report.attempts.every((a) => !("usage" in a))).toBe(true);
  });
  it("a usage that is not two non-negative integers is dropped with a usage-invalid warn, never recorded", async () => {
    const model: PlannerModel = {
      async complete() {
        return { content: goodDraft, usage: { inputTokens: -1, outputTokens: Number.NaN } };
      },
    };
    const ctx = recordingContext();
    const result = await new ReferencePlanner({ model, modelId: "m" }).compose(input, ctx);
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect("usage" in result.report).toBe(false);
    expect(result.report.attempts[0]?.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "usage-invalid", severity: "warn" })])
    );
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it("a provider that sends usage: null still plans (treated as unreported), never model-error", async () => {
    const model = {
      async complete() {
        return { content: goodDraft, usage: null };
      },
    } as unknown as PlannerModel;
    const result = await new ReferencePlanner({ model, modelId: "m" }).compose(
      input,
      recordingContext()
    );
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.ops.length).toBeGreaterThan(0);
    expect("usage" in result.report).toBe(false);
    expect(result.report.attempts.every((a) => !("usage" in a))).toBe(true);
  });
  it("extra provider fields on usage are not recorded — only the two counts", async () => {
    const model = {
      async complete() {
        return {
          content: goodDraft,
          usage: { inputTokens: 3, outputTokens: 4, costUsd: 0.1, raw: { x: 1 } },
        };
      },
    } as unknown as PlannerModel;
    const result = await new ReferencePlanner({ model, modelId: "m" }).compose(
      input,
      recordingContext()
    );
    expect(result.report.attempts[0]?.usage).toStrictEqual({ inputTokens: 3, outputTokens: 4 });
    expect(result.report.usage).toStrictEqual({ inputTokens: 3, outputTokens: 4 });
  });
  it("usage never changes the ops, so the composed experience's content address is identical", async () => {
    const plain = await new ReferencePlanner({
      model: scriptedModel([goodDraft]),
      modelId: "m",
    }).compose(input, recordingContext());
    const counted = await new ReferencePlanner({
      model: scriptedModel([goodDraft], u),
      modelId: "m",
    }).compose(input, recordingContext());
    expect(counted.ops).toEqual(plain.ops);
    const g = () => genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture });
    const a = replay(g(), plain.ops);
    const b = replay(g(), counted.ops);
    if (!a.ok || !b.ok) throw new Error("replay failed");
    expect(seal(b.value).versionHash).toBe(seal(a.value).versionHash);
  });
});

describe("ReferencePlanner usage from a hostile adapter", () => {
  const modelOf = (reply: () => unknown, contents = [goodDraft]): PlannerModel => {
    let calls = 0;
    return {
      async complete() {
        const content = contents[Math.min(calls, contents.length - 1)] as string;
        calls += 1;
        // Descriptors, not Object.assign: a getter must reach the planner un-invoked.
        return Object.defineProperties(
          { content },
          Object.getOwnPropertyDescriptors(reply() as object)
        ) as never;
      },
    };
  };
  const compose = async (model: PlannerModel) => {
    const ctx = recordingContext();
    const result = await new ReferencePlanner({ model, modelId: "m" }).compose(input, ctx);
    return { result, ctx };
  };
  const invalidOf = (r: PlanResult) => r.findings.filter((f) => f.code === "usage-invalid");

  it("describes a refused value by kind, never by content — a huge string is not journaled", async () => {
    const huge = "x".repeat(1_000_000);
    const { result, ctx } = await compose(
      modelOf(() => ({ usage: { inputTokens: huge, outputTokens: 1 } }))
    );
    expect(invalidOf(result)).toHaveLength(1);
    expect(invalidOf(result)[0]?.message).toContain("inputTokens is a string");
    const recorded = JSON.stringify(ctx.decisions.get(planDecisionId("compose", input)));
    expect(recorded.length).toBeLessThan(20_000);
  });
  it("a field whose toString throws is only usage-invalid, never model-error", async () => {
    const { result } = await compose(
      modelOf(() => ({
        usage: {
          inputTokens: {
            toString() {
              throw new Error("boom");
            },
          },
          outputTokens: 1,
        },
      }))
    );
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(invalidOf(result)[0]?.message).toContain("inputTokens is an object");
    expect(result.ops.length).toBeGreaterThan(0);
  });
  it("a throwing getter on a count, or on usage itself, is only usage-invalid", async () => {
    for (const reply of [
      () => ({
        usage: {
          get inputTokens(): number {
            throw new Error("boom");
          },
          outputTokens: 1,
        },
      }),
      () => ({
        get usage(): unknown {
          throw new Error("boom");
        },
      }),
    ]) {
      const { result } = await compose(modelOf(reply));
      expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
      expect(invalidOf(result)).toHaveLength(1);
      expect("usage" in result.report).toBe(false);
    }
  });
  it("each count is read ONCE: a getter that changes after validation cannot reach the journal", async () => {
    let reads = 0;
    const { result, ctx } = await compose(
      modelOf(() => ({
        usage: {
          get inputTokens() {
            reads += 1;
            return reads === 1 ? 1 : -5;
          },
          outputTokens: 1,
        },
      }))
    );
    expect(reads).toBe(1);
    expect(result.report.usage).toStrictEqual({ inputTokens: 1, outputTokens: 1 });
    const recorded = ctx.decisions.get(planDecisionId("compose", input)) as PlanResult;
    expect(recorded.report.usage).toStrictEqual({ inputTokens: 1, outputTokens: 1 });
  });
  it("an attempt usage that would overflow the plan total is refused; the total stays exact and valid", async () => {
    const big = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 };
    const { result } = await compose(modelOf(() => ({ usage: big }), [badType, goodDraft]));
    expect(result.report.attempts.map((a) => a.usage)).toEqual([big, undefined]);
    expect(result.report.attempts[1]?.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "usage-invalid",
          severity: "warn",
          message: expect.stringContaining("would overflow the plan total"),
        }),
      ])
    );
    expect(result.report.usage).toStrictEqual(big);
    expect(isPlannerUsage(result.report.usage)).toBe(true);
  });
  it("-0 is recorded as 0", async () => {
    const { result } = await compose(
      modelOf(() => ({ usage: { inputTokens: -0, outputTokens: 1 } }))
    );
    expect(Object.is(result.report.usage?.inputTokens, 0)).toBe(true);
    expect(Object.is(result.report.attempts[0]?.usage?.inputTokens, 0)).toBe(true);
  });
});
