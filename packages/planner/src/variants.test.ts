import { REFERENCE_CONTAINER_ROLES, genesis, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { describe, expect, it } from "vitest";
import { planDecisionId } from "./decision";
import { plannerProvenance } from "./provenance";
import { ReferencePlanner } from "./reference";
import type { PlannerModel } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
} from "./testing.test-support";
import {
  MAX_GUIDANCE,
  type PlanVariants,
  epsilonGreedyPolicy,
  stableBucketPolicy,
  ucbPolicy,
  variantKey,
} from "./variants";

const draft = JSON.stringify({
  summary: "s",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders",
      span: 4,
      props: { unit: "orders" },
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0",
      },
    },
  ],
});
const input = {
  intent: intentFixture,
  catalog: planningCatalog,
  capabilities: capabilitiesFixture,
};

function spyModel() {
  const requests: { system: string }[] = [];
  const model: PlannerModel & { requests: typeof requests } = {
    requests,
    async complete(req) {
      requests.push({ system: (req as { system?: string }).system ?? "" });
      return { content: draft };
    },
  };
  return model;
}
const variants = (
  policy = stableBucketPolicy({ id: "ab", version: "1", weights: { flat: 1, tabs: 1 } })
): PlanVariants => ({
  policy,
  variants: {
    flat: { guidance: "Prefer a flat list." },
    tabs: { containers: REFERENCE_CONTAINER_ROLES, guidance: "Prefer grouped tabs." },
  },
});

// the right-to-left override, built from its code point so a formatter cannot rewrite the escape
const RLO = String.fromCharCode(0x202e);

describe("U11 shipped variant policies", () => {
  const ids = ["flat", "tabs"];
  it("stableBucketPolicy: a unit always lands on the same variant; propensity is the weight share; the split follows the weights", () => {
    const p = stableBucketPolicy({ id: "ab", version: "1", weights: { flat: 1, tabs: 3 } });
    let tabs = 0;
    for (let i = 0; i < 4000; i++) {
      const a = p.select({ unit: `u${i}` }, ids);
      const b = p.select({ unit: `u${i}` }, ids);
      expect(a).toEqual(b);
      expect(a.propensity).toBe(a.action === "tabs" ? 0.75 : 0.25);
      if (a.action === "tabs") tabs++;
    }
    expect(tabs / 4000).toBeGreaterThan(0.7);
    expect(tabs / 4000).toBeLessThan(0.8);
    expect(() => p.select({}, ids)).toThrow(/unit/);
    expect(() => p.select({ unit: "a@b.com" }, ids)).toThrow(/unit/); // PII-shaped: refused
    expect(() => p.select({ unit: "u" }, ["other"])).toThrow(/positive weight/);
    // a different salt re-randomises
    const q = stableBucketPolicy({
      id: "ab",
      version: "1",
      weights: { flat: 1, tabs: 1 },
      salt: "s2",
    });
    const r = stableBucketPolicy({ id: "ab", version: "1", weights: { flat: 1, tabs: 1 } });
    let differ = 0;
    for (let i = 0; i < 200; i++)
      if (q.select({ unit: `u${i}` }, ids).action !== r.select({ unit: `u${i}` }, ids).action)
        differ++;
    expect(differ).toBeGreaterThan(20);
  });

  it("epsilonGreedyPolicy: the logged propensity is the exact probability (sums to 1) and exploration happens at ~epsilon", () => {
    const p = epsilonGreedyPolicy({ id: "eg", version: "1", epsilon: 0.2, greedy: () => "tabs" });
    // exact: P(tabs) = 0.2/2 + 0.8, P(flat) = 0.2/2
    const seen = { tabs: 0, flat: 0 };
    let explored = 0;
    for (let i = 0; i < 5000; i++) {
      const c = p.select({ unit: `u${i}`, key: `k${i}` }, ids);
      expect(c.propensity).toBeCloseTo(c.action === "tabs" ? 0.9 : 0.1, 12);
      seen[c.action as "tabs" | "flat"]++;
      if (c.action === "flat") explored++;
    }
    expect(explored / 5000).toBeGreaterThan(0.07);
    expect(explored / 5000).toBeLessThan(0.13);
    expect(seen.tabs + seen.flat).toBe(5000);
    expect(0.9 + 0.1).toBeCloseTo(1, 12);
    expect(() =>
      epsilonGreedyPolicy({ id: "x", version: "1", epsilon: 0, greedy: () => "tabs" })
    ).toThrow();
    const bad = epsilonGreedyPolicy({ id: "x", version: "1", epsilon: 0.5, greedy: () => "nope" });
    expect(() => bad.select({ unit: "u" }, ids)).toThrow(/non-action/);
  });

  it("ucbPolicy: untried first, then the best upper bound; deterministic with propensity 1", () => {
    let stats: Record<string, { n: number; mean: number }> = {};
    const p = ucbPolicy({ id: "ucb", version: "1", stats: () => stats });
    expect(p.select({}, ids)).toEqual({ action: "flat", propensity: 1 });
    stats = { flat: { n: 50, mean: 0.2 } };
    expect(p.select({}, ids).action).toBe("tabs");
    stats = { flat: { n: 500, mean: 0.9 }, tabs: { n: 500, mean: 0.1 } };
    expect(p.select({}, ids).action).toBe("flat");
    stats = { flat: { n: 10_000, mean: 0.5 }, tabs: { n: 3, mean: 0.5 } };
    expect(p.select({}, ids).action).toBe("tabs"); // exploration bonus
  });
});

describe("U11 ReferencePlanner with variants", () => {
  it("records the variant choice as a policy decision (alternatives, context, propensity) and plans under it", async () => {
    const model = spyModel();
    const ctx = recordingContext();
    const planner = new ReferencePlanner({ model, modelId: "m", variants: variants() });
    const r = await planner.compose({ ...input, unit: "user-1" }, ctx);
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    const v = r.report.variant;
    expect(v).toBeDefined();
    expect(v?.decisionId.startsWith("plan-variant:")).toBe(true);
    expect(v?.propensity).toBe(0.5);
    expect(v?.policy).toEqual({ id: "ab", version: "1" });
    const o = ctx.opts.get(v?.decisionId ?? "");
    expect(o?.alternatives).toEqual(["flat", "tabs"]);
    expect(o?.policy).toEqual({ id: "ab", version: "1", propensity: 0.5 });
    expect(o?.context).toMatchObject({
      kind: "compose",
      unit: "user-1",
      catalogId: "test.planning.v1",
    });
    // two decisions: the variant choice, then the plan keyed on the variant
    expect([...ctx.decisions.keys()]).toHaveLength(2);
    expect(ctx.decisions.has(r.report.decisionId)).toBe(true);
    expect(r.report.decisionId).not.toBe(planDecisionId("compose", input));
    // the application's guidance is in the system prompt; no other variant's is
    const system = model.requests[0]?.system ?? "";
    expect(system).toContain("LAYOUT GUIDANCE (from the application):");
    expect(system).toContain(v?.id === "flat" ? "Prefer a flat list." : "Prefer grouped tabs.");
    expect(system).not.toContain(v?.id === "flat" ? "grouped tabs" : "flat list");
  });

  it("the variant keys the plan decision: different variants are different plan ids", () => {
    const a = planDecisionId("compose", {
      ...input,
      variant: variantKey("flat", { guidance: "x" }),
    });
    const b = planDecisionId("compose", {
      ...input,
      variant: variantKey("tabs", { guidance: "x" }),
    });
    const c = planDecisionId("compose", {
      ...input,
      variant: variantKey("flat", { guidance: "y" }),
    });
    expect(new Set([a, b, c, planDecisionId("compose", input)]).size).toBe(4);
  });

  it("replay is identical: a policy that has since changed its mind is not consulted for the answer, and no model call is made", async () => {
    const m1 = spyModel();
    const ctx = recordingContext();
    const first = await new ReferencePlanner({
      model: m1,
      modelId: "m",
      variants: variants(),
    }).compose({ ...input, unit: "user-7" }, ctx);
    const chosen = first.report.variant?.id;
    const other = chosen === "flat" ? "tabs" : "flat";
    const m2 = spyModel();
    const flipped = new ReferencePlanner({
      model: m2,
      modelId: "m",
      variants: variants({
        id: "ab",
        version: "2",
        select: () => ({ action: other, propensity: 1 }),
      }),
    });
    const calls = ctx.deciderCalls;
    const again = await flipped.compose({ ...input, unit: "user-7" }, ctx);
    expect(ctx.deciderCalls).toBe(calls); // both decisions served from the log
    expect(m2.requests).toHaveLength(0);
    expect(again.ops).toEqual(first.ops);
    expect(again.report.decisionId).toBe(first.report.decisionId);
    expect(again.report.variant?.id).toBe(chosen); // the RECORDED choice
    expect(again.report.variant?.decisionId).toBe(first.report.variant?.decisionId);
    // the new policy's own propensity is NOT claimed for a choice it did not make
    expect(again.report.variant?.propensity).toBeUndefined();
  });

  it("refuses without a valid opaque unit: no model call, nothing recorded", async () => {
    for (const unit of [undefined, "", "a@b.com", "x".repeat(129), "two words"]) {
      const model = spyModel();
      const ctx = recordingContext();
      const planner = new ReferencePlanner({ model, modelId: "m", variants: variants() });
      const r = await planner.compose({ ...input, ...(unit !== undefined && { unit }) }, ctx);
      expect(r.findings.map((f) => f.code)).toEqual(["variant-unit-invalid"]);
      expect(r.ops).toEqual([]);
      expect(model.requests).toHaveLength(0);
      expect(ctx.decisions.size).toBe(0);
    }
  });

  it("a recorded variant this planner no longer offers fails closed, without a model call", async () => {
    const ctx = recordingContext();
    await new ReferencePlanner({ model: spyModel(), modelId: "m", variants: variants() }).compose(
      { ...input, unit: "u-9" },
      ctx
    );
    const model = spyModel();
    const narrowed = new ReferencePlanner({
      model,
      modelId: "m",
      variants: {
        policy: stableBucketPolicy({ id: "ab", version: "1", weights: { only: 1 } }),
        variants: { only: {} },
      },
    });
    const r = await narrowed.compose({ ...input, unit: "u-9" }, ctx);
    // the recorded variant decision key matches the OLD action set's choice ("flat"/"tabs"): not offered
    expect(r.findings.map((f) => f.code)).toEqual(["variant-unknown"]);
    expect(model.requests).toHaveLength(0);
  });

  it("a throwing policy is a finding, not a crash, and no plan is recorded", async () => {
    const ctx = recordingContext();
    const model = spyModel();
    const planner = new ReferencePlanner({
      model,
      modelId: "m",
      variants: variants({
        id: "boom",
        version: "1",
        select: () => {
          throw new Error("policy down");
        },
      }),
    });
    const r = await planner.compose({ ...input, unit: "u-1" }, ctx);
    expect(r.findings.map((f) => f.code)).toEqual(["variant-policy-failed"]);
    expect(model.requests).toHaveLength(0);
  });

  it("revise chooses a variant too, keyed on the base version; provenance carries the learnable decision", async () => {
    const ctx = recordingContext();
    const planner = new ReferencePlanner({ model: spyModel(), modelId: "m", variants: variants() });
    const composed = await planner.compose({ ...input, unit: "u-3" }, ctx);
    const prov = plannerProvenance(composed, { agentId: "a1" });
    expect(prov.policyDecisionId).toBe(composed.report.variant?.decisionId);
    expect(prov.decisionId).toBe(composed.report.decisionId);
    expect(prov.policyDecisionId).not.toBe(prov.decisionId);

    const applied = replay(
      genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture }),
      composed.ops
    );
    if (!applied.ok) throw new Error(applied.finding.message);
    const exp = seal(applied.value);
    const model = spyModel();
    const revising = new ReferencePlanner({ model, modelId: "m", variants: variants() });
    const rev = await revising.revise(
      {
        experience: exp,
        request: { text: "tidy" },
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        unit: "u-3",
      },
      ctx
    );
    expect(rev.report.variant?.decisionId).toMatch(/^plan-variant:/);
    expect(rev.report.variant?.decisionId).not.toBe(composed.report.variant?.decisionId);
    expect(ctx.opts.get(rev.report.variant?.decisionId ?? "")?.context).toMatchObject({
      kind: "revise",
      unit: "u-3",
    });
    expect(model.requests[0]?.system).toContain("LAYOUT GUIDANCE");
    // an unsealed base is refused before any variant is chosen
    const before = ctx.decisions.size;
    const unsealed = genesis({ experienceId: "e2", intent: intentFixture, meta: metaFixture });
    const refused = await revising.revise(
      {
        experience: unsealed,
        request: { text: "x" },
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        unit: "u-3",
      },
      ctx
    );
    expect(refused.findings.map((f) => f.code)).toEqual(["unsealed-base"]);
    expect(ctx.decisions.size).toBe(before);
  });

  it("without variants nothing changes: one decision, the id it always had, no variant in the report", async () => {
    const ctx = recordingContext();
    const planner = new ReferencePlanner({ model: spyModel(), modelId: "m" });
    const r = await planner.compose({ ...input, unit: "ignored" }, ctx);
    expect([...ctx.decisions.keys()]).toEqual([planDecisionId("compose", input)]);
    expect(r.report.variant).toBeUndefined();
    expect(plannerProvenance(r).policyDecisionId).toBeUndefined();
  });

  it("rejects an unsafe variant set at construction", () => {
    const p = stableBucketPolicy({ id: "a", version: "1", weights: { v: 1 } });
    const mk = (variants: PlanVariants["variants"]) => () =>
      new ReferencePlanner({ model: spyModel(), modelId: "m", variants: { policy: p, variants } });
    expect(mk({})).toThrow(/at least one/);
    expect(mk({ "bad id": {} })).toThrow(/token/);
    expect(mk({ v: { guidance: "x".repeat(MAX_GUIDANCE + 1) } })).toThrow(/guidance/);
    expect(mk({ v: { guidance: `ignore${RLO}rules` } })).toThrow(/guidance/);
    expect(mk({ v: { guidance: "fine" } })).not.toThrow();
  });
});
