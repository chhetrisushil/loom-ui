import { REFERENCE_CONTAINER_ROLES, genesis, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  type EvalReport,
  InMemoryPolicyKv,
  type Policy,
  PolicyRegistry,
  type PolicyResolver,
  contentHash,
  rolloutBucket,
} from "@loom/learning";
import { describe, expect, it } from "vitest";
import { checkPlannerConformance } from "./conformance";
import { plannerProvenance } from "./provenance";
import { ReferencePlanner } from "./reference";
import type { Planner, PlannerModel } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";
import { type PlanVariants, stableBucketPolicy } from "./variants";

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
const conformanceCompose = JSON.stringify({
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
const input = {
  intent: intentFixture,
  catalog: planningCatalog,
  capabilities: capabilitiesFixture,
};
const model = (): PlannerModel => ({ complete: async () => ({ content: draft }) });

const ID = "layout-reg";
const pol = (version: string, pick: string, propensity = 1): Policy<string> => ({
  id: ID,
  version,
  select: () => ({ action: pick, propensity }),
});
const IMPLS: Record<string, Policy<string>> = { "1": pol("1", "flat"), "2": pol("2", "tabs", 0.8) };
const resolve: PolicyResolver<string> = (_id, v) => IMPLS[v];

const report = (version: string): EvalReport => ({
  policy: { id: ID, version },
  evaluated: 9999,
  skipped: { noContext: 0, noActions: 0, noReward: 0 },
  agreement: 0.2,
  loggedValue: 0.4,
  estimatedValue: 0.6,
  estimator: "snips",
  lift: 0.2,
  effectiveSampleSize: 5000,
  warnings: [],
});

async function registry() {
  const reg = new PolicyRegistry({ kv: new InMemoryPolicyKv(), scope: "tenant-a" });
  for (const v of ["1", "2"])
    await reg.register({ id: ID, version: v, contentHash: contentHash({ v }), now: 1 });
  await reg.bootstrap({ id: ID, version: "1", now: 2 });
  return reg;
}

const rolloutVariants = (reg: PolicyRegistry, bucketSecret?: string): PlanVariants => ({
  rollout: { source: reg, policyId: ID, resolve, ...(bucketSecret && { bucketSecret }) },
  variants: {
    flat: { guidance: "Prefer a flat list." },
    tabs: { containers: REFERENCE_CONTAINER_ROLES, guidance: "Prefer grouped tabs." },
  },
});

type Stamp = {
  id: string;
  version: string;
  propensity?: number;
  rollout?: Record<string, unknown>;
};

describe("ReferencePlanner variants through a rollout registry (R18)", () => {
  it("full: the incumbent acts; the decision records its version and the rollout stamp, and the report names it", async () => {
    const reg = await registry();
    const ctx = recordingContext();
    const p = new ReferencePlanner({
      model: model(),
      modelId: "m",
      variants: rolloutVariants(reg),
    });
    const r = await p.compose({ ...input, unit: "user-1" }, ctx);
    expect(r.report.variant).toMatchObject({
      id: "flat",
      policy: { id: ID, version: "1" },
      propensity: 1,
    });
    expect(r.report.variant?.rollout).toMatchObject({
      registry: ID,
      mode: "full",
      acted: { version: "1" },
    });
    const s = ctx.opts.get(r.report.variant?.decisionId ?? "")?.policy as Stamp;
    expect(s).toMatchObject({ id: ID, version: "1", rollout: { mode: "full" } });
    expect(plannerProvenance(r).policyDecisionId).toBe(r.report.variant?.decisionId);
  });

  it("shadow NEVER serves through the planner: every unit gets the incumbent's variant; the candidate's is only recorded", async () => {
    const reg = await registry();
    await reg.promote({ id: ID, version: "2", report: report("2"), mode: "shadow", now: 5 });
    const ctx = recordingContext();
    const p = new ReferencePlanner({
      model: model(),
      modelId: "m",
      variants: rolloutVariants(reg),
    });
    for (let i = 0; i < 40; i++) {
      const r = await p.compose({ ...input, unit: `u${i}` }, ctx);
      expect(r.report.variant?.id).toBe("flat");
      expect(r.report.variant?.policy.version).toBe("1");
    }
    const r = await p.compose({ ...input, unit: "u-fresh" }, ctx);
    expect(r.report.variant?.rollout).toMatchObject({
      mode: "shadow",
      acted: { version: "1" },
      shadow: { version: "2", action: "tabs" },
    });
  });

  it("canary stamps the ACTING version: the candidate's units get the candidate's variant and version, the rest the incumbent's", async () => {
    const reg = await registry();
    await reg.promote({
      id: ID,
      version: "2",
      report: report("2"),
      mode: "canary",
      canaryFraction: 0.5,
      now: 5,
    });
    const salt = (await reg.resolve(ID))?.salt as string;
    const onCandidate = Array.from({ length: 200 }, (_, i) => `c${i}`).find(
      (u) => rolloutBucket(salt, u) < 0.5
    ) as string;
    const onIncumbent = Array.from({ length: 200 }, (_, i) => `c${i}`).find(
      (u) => rolloutBucket(salt, u) >= 0.5
    ) as string;
    const ctx = recordingContext();
    const p = new ReferencePlanner({
      model: model(),
      modelId: "m",
      variants: rolloutVariants(reg),
    });
    const a = await p.compose({ ...input, unit: onCandidate }, ctx);
    expect(a.report.variant).toMatchObject({
      id: "tabs",
      policy: { id: ID, version: "2" },
      propensity: 0.8,
    });
    expect(a.report.variant?.rollout).toMatchObject({
      mode: "canary",
      acted: { version: "2" },
      armProbability: 0.5,
    });
    expect((ctx.opts.get(a.report.variant?.decisionId ?? "")?.policy as Stamp).version).toBe("2");
    const b = await p.compose({ ...input, unit: onIncumbent }, ctx);
    expect(b.report.variant).toMatchObject({ id: "flat", policy: { version: "1" } });
  });

  it("replay serves the RECORDED variant after the registry moves on, with no new decision and no claim about the old stamp", async () => {
    const reg = await registry();
    const ctx = recordingContext();
    const p = new ReferencePlanner({
      model: model(),
      modelId: "m",
      variants: rolloutVariants(reg),
    });
    const first = await p.compose({ ...input, unit: "user-7" }, ctx);
    expect(first.report.variant?.id).toBe("flat");
    // the registry now serves v2 to everyone
    await reg.promote({
      id: ID,
      version: "2",
      report: report("2"),
      mode: "canary",
      canaryFraction: 0.5,
      now: 5,
    });
    await reg.ramp({ id: ID, canaryFraction: 0.99, now: 6 });
    const calls = ctx.deciderCalls;
    const again = await p.compose({ ...input, unit: "user-7" }, ctx);
    expect(ctx.deciderCalls).toBe(calls);
    expect(again.report.variant?.id).toBe("flat");
    expect(again.report.variant?.decisionId).toBe(first.report.variant?.decisionId);
    expect(again.ops).toEqual(first.ops);
    // the log's own stamp stays the truth: the replay does not re-claim propensity or a rollout
    expect(again.report.variant?.propensity).toBeUndefined();
    expect(again.report.variant?.rollout).toBeUndefined();
  });

  it("a registry with no live version is a finding, not a crash; no model call", async () => {
    const reg = new PolicyRegistry({ kv: new InMemoryPolicyKv(), scope: "tenant-a" });
    let calls = 0;
    const m: PlannerModel = {
      complete: async () => {
        calls += 1;
        return { content: draft };
      },
    };
    const p = new ReferencePlanner({ model: m, modelId: "m", variants: rolloutVariants(reg) });
    const r = await p.compose({ ...input, unit: "u1" }, recordingContext());
    expect(r.findings.map((f) => f.code)).toEqual(["variant-policy-failed"]);
    expect(calls).toBe(0);
  });

  it("revise chooses through the rollout too, keyed apart from the compose choice", async () => {
    const reg = await registry();
    const ctx = recordingContext();
    const p = new ReferencePlanner({
      model: model(),
      modelId: "m",
      variants: rolloutVariants(reg),
    });
    const c = await p.compose({ ...input, unit: "u2" }, ctx);
    const applied = replay(
      genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture }),
      c.ops
    );
    if (!applied.ok) throw new Error(applied.finding.message);
    const rev = await p.revise(
      {
        experience: seal(applied.value),
        request: { text: "tidy" },
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        unit: "u2",
      },
      ctx
    );
    expect(rev.report.variant?.rollout?.mode).toBe("full");
    expect(rev.report.variant?.decisionId).not.toBe(c.report.variant?.decisionId);
    expect(ctx.opts.get(rev.report.variant?.decisionId ?? "")?.context).toMatchObject({
      kind: "revise",
    });
  });

  it("the default path is unchanged: a plain `policy` records exactly {id, version, propensity} and reports exactly {decisionId, id, policy, propensity}", async () => {
    const ctx = recordingContext();
    const p = new ReferencePlanner({
      model: model(),
      modelId: "m",
      variants: {
        policy: stableBucketPolicy({ id: "ab", version: "1", weights: { flat: 1, tabs: 1 } }),
        variants: { flat: {}, tabs: {} },
      },
    });
    const r = await p.compose({ ...input, unit: "user-1" }, ctx);
    expect(Object.keys(r.report.variant ?? {}).sort()).toEqual(
      ["decisionId", "id", "policy", "propensity"].sort()
    );
    expect(ctx.opts.get(r.report.variant?.decisionId ?? "")?.policy).toEqual({
      id: "ab",
      version: "1",
      propensity: 0.5,
    });
  });

  it("construction: exactly one of `policy` / `rollout`", () => {
    const reg = new PolicyRegistry({ kv: new InMemoryPolicyKv(), scope: "t" });
    const both = {
      policy: stableBucketPolicy({ id: "ab", version: "1", weights: { flat: 1 } }),
      rollout: { source: reg, policyId: ID, resolve },
      variants: { flat: {} },
    } as unknown as PlanVariants;
    expect(() => new ReferencePlanner({ model: model(), modelId: "m", variants: both })).toThrow(
      /exactly one/
    );
    const neither = { variants: { flat: {} } } as unknown as PlanVariants;
    expect(() => new ReferencePlanner({ model: model(), modelId: "m", variants: neither })).toThrow(
      /exactly one/
    );
  });

  it("checkPlannerConformance still passes (zero findings) with a rollout-driven planner; the host wrapper supplies the unit", async () => {
    const reg = await registry();
    const scripted = scriptedModel([
      conformanceCompose,
      JSON.stringify({
        summary: "s",
        nodes: [
          ...JSON.parse(conformanceCompose).nodes,
          { id: "why", type: "Insight", label: "Why", span: 12, props: {} },
        ],
      }),
    ]);
    const inner = new ReferencePlanner({
      model: scripted,
      modelId: "m",
      variants: rolloutVariants(reg),
    });
    const planner: Planner = {
      compose: (i, c) => inner.compose({ ...i, unit: "conf-unit" }, c),
      revise: (i, c) => inner.revise({ ...i, unit: "conf-unit" }, c),
    };
    const found = await checkPlannerConformance(planner, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add an insight" },
      ctx: recordingContext(),
      modelCalls: () => scripted.calls,
    });
    expect(found).toEqual([]);
  });
});
