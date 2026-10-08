import { type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";
import { SIGNAL_VERSION } from "@loom-ui/core/signals";
import { eventStoreLineageStore } from "@loom-ui/lineage";
import { ReferencePlanner, stableBucketPolicy, ucbPolicy } from "@loom-ui/planner";
import { recordOutcome } from "@loom/analytics";
import { step$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { trajectories } from "@loom/learning";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  type FlowRunner,
  type RegisteredFlow,
  WorkflowRuntime,
  executionAccessPolicy,
} from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { VARIANT_DECISION_PREFIX, evaluateVariants } from "./evaluate";
import { SignalIngestor } from "./ingest";
import { VoteLedger, unitAlias } from "./ledger";
import { DecisionLinks, type DecisionRef } from "./links";
import { defaultReward, settleRewards } from "./rewards";

// The whole loop through the REAL kernel: the reference planner chooses a variant through
// `decideWithPolicy` inside a flow (recorded with propensity), the execution finishes, viewers'
// signals are ingested into a DURABLE vote log, one pooled reward per decision is recorded LATE with
// `runtime.recordOutcome` by a reward-pipeline principal, and the variants are compared off-policy
// from the exported log with `@loom/learning`.

const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "learn.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit"],
      binding: "required",
      surfaces: { web: { kind: "MetricCard" }, terminal: { kind: "MetricCard" } },
    },
  ],
});
const capabilities = [
  {
    handle: "orders_summary",
    toolName: "orders.summary",
    toolVersion: "1.0.0",
    toolSchemaHash: "sha256:o",
    sampleOutput: { totals: { count: 4 } },
    sensitivity: "internal" as const,
  },
];
const draft = JSON.stringify({
  summary: "s",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders",
      span: 12,
      props: { unit: "orders" },
      binding: {
        capability: "orders_summary",
        arguments: {},
        path: "totals.count",
        priority: "P0",
      },
    },
  ],
});
const owner = { tenant: "acme", actor: "alice" };
const pipeline = { tenant: "acme", actor: "reward-pipeline" };
const mallory = { tenant: "evil", actor: "mallory" };
const KEY = "0123456789abcdef0123456789abcdef";

const model = { complete: async () => ({ content: draft }) };
const abPlanner = new ReferencePlanner({
  modelId: "m",
  model,
  variants: {
    policy: stableBucketPolicy({ id: "ab", version: "1", weights: { flat: 1, tabs: 1 } }),
    variants: { flat: { guidance: "flat" }, tabs: { guidance: "tabs" } },
  },
});

type In = { unit: string; park?: boolean; csat?: boolean };
const io = { inputSchema: z.any(), outputSchema: z.any() };

function rig(planner: ReferencePlanner, annotate: "tenant" | "owner" = "tenant") {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    executionAuthorizer: executionAccessPolicy({ rules: { annotate } }),
  });
  const runner: FlowRunner<In, unknown> = async (ctx, input) => {
    const r = await planner.compose(
      { intent: { objective: "orders", source: "user" }, catalog, capabilities, unit: input.unit },
      ctx as never
    );
    // a userspace emit that IMITATES this pipeline's key on the very decision the reward lands on:
    // it is not kernel-stamped, so the evaluation must not count it
    if (input.csat && r.report.variant)
      recordOutcome(ctx, {
        key: "ui:r1:forged",
        score: r.report.variant.id === "flat" ? 1 : 0,
        decisionId: r.report.variant.decisionId,
      });
    if (input.park) await ctx.suspend({ on: "GO" });
    return {};
  };
  const flow = {
    definition: {
      _tag: "FlowDefinition" as const,
      id: "plan-flow",
      name: "plan",
      version: "1.0.0",
      ...io,
      steps: [step$({ id: "noop", name: "n", toolId: "noop", ...io })],
    },
    runner,
  } as unknown as RegisteredFlow<In, unknown>;
  runtime.registerFlow(flow.definition, flow.runner);
  return { eventStore, runtime, flow };
}

/** The variant choice an execution recorded, read back from its log. */
async function variantOf(eventStore: InMemoryAsyncEventStore, executionId: string) {
  const ev = (await eventStore.read(executionId)).find(
    (e) =>
      e.eventType === "DECISION_RECORDED" &&
      String((e.payload as { decisionId?: string }).decisionId).startsWith(VARIANT_DECISION_PREFIX)
  );
  const p = ev?.payload as { decisionId: string; choice: string };
  return { variant: p.choice, decisionId: p.decisionId };
}
const batch = (n: string, exp: string, signals: unknown[]) => ({
  v: SIGNAL_VERSION,
  batchId: n,
  view: { experienceId: exp, versionHash: "v1" },
  signals,
});

describe("U11 the learning loop through the kernel", () => {
  it("records variants with propensity, pools viewers into ONE late reward per decision, and picks the winner off-policy", async () => {
    const { eventStore, runtime, flow } = rig(abPlanner);
    const links = new DecisionLinks();
    const now = 1_000;
    // the vote log is DURABLE: loom's EventStore behind the lineage seam, a second store than the runtime's
    const votes = eventStoreLineageStore(new InMemoryAsyncEventStore(), {
      streamPrefix: "__loom_ui_votes__:",
      workflowId: "loom-ui.votes",
    });
    const ledger = new VoteLedger({
      log: votes,
      pseudonymKey: KEY,
      clock: () => now,
      outcomes: ["approved"],
    });
    const ing = new SignalIngestor({ links, ledger, clock: () => now, exposure: "client-claimed" });
    const refs: DecisionRef[] = [];
    const chosen = { flat: 0, tabs: 0 };

    for (let i = 0; i < 80; i++) {
      const unit = unitAlias(KEY, `user-${i}@example.com`);
      const run = await runtime.start(
        flow,
        { unit, csat: true },
        { executionId: `ex-${i}`, principal: owner }
      );
      await run.waitForCompletion();
      const out = await variantOf(eventStore, `ex-${i}`);
      chosen[out.variant as "flat" | "tabs"]++;
      const ref = { executionId: `ex-${i}`, decisionId: out.decisionId };
      refs.push(ref);
      links.register(`exp-${i}`, "v1", {
        tenant: "acme",
        decisions: [ref],
        nodes: { orders: ref },
      });
      const good = out.variant === "tabs";
      // five viewers per surface; repeats and a hostile extra batch change nothing
      for (let v = 0; v < 5; v++) {
        const viewer = { id: `${unit}-v${v}`, tenant: "acme" };
        const signals = [
          { kind: "exposure", node: "orders" },
          ...(good
            ? [
                { kind: "engagement", action: "click", count: 2, node: "orders" },
                { kind: "engagement", action: "dwell", bucket: 3, node: "orders" },
                { kind: "feedback", rating: 5 },
              ]
            : [{ kind: "feedback", rating: 2 }]),
        ];
        expect(
          (await ing.ingest({ viewer, raw: batch(`b${i}-${v}`, `exp-${i}`, signals) })).refused
        ).toBeUndefined();
        await ing.ingest({ viewer, raw: batch(`r${i}-${v}`, `exp-${i}`, signals) });
      }
    }
    expect(chosen.flat).toBeGreaterThan(20);
    expect(chosen.tabs).toBeGreaterThan(20);

    // the variant decision is a learnable decision, and its unit is an opaque alias, never the user id
    const log = (await Promise.all(refs.map((r) => eventStore.read(r.executionId)))).flat();
    const rec = log.find(
      (e) =>
        e.eventType === "DECISION_RECORDED" &&
        String((e.payload as { decisionId?: string }).decisionId).startsWith(
          VARIANT_DECISION_PREFIX
        )
    );
    expect(rec?.payload).toMatchObject({
      alternatives: ["flat", "tabs"],
      policy: { id: "ab", version: "1", propensity: 0.5 },
      context: { kind: "compose" },
    });
    expect(JSON.stringify(rec?.payload)).not.toMatch(/@|user-/);

    const settle = (decisions: DecisionRef[], principal: object, extra: object = {}) =>
      settleRewards({
        ledger,
        runtime,
        decisions,
        reward: defaultReward(),
        rewardId: "r1",
        closeId: "end",
        clock: () => now,
        authorize: () => ({ principal }),
        ...extra,
      });

    // a principal of another tenant cannot reward anyone's decision: refused, log untouched
    const before = (await eventStore.read("ex-0")).length;
    const denied = await settle(refs.slice(0, 3), mallory);
    expect(denied.refused).toHaveLength(3);
    expect(denied.appended).toBe(0);
    expect((await eventStore.read("ex-0")).length).toBe(before);

    // the reward pipeline (annotate: tenant) settles the rest; one score each, status unchanged
    const rep = await settle(refs.slice(3), pipeline);
    expect(rep).toMatchObject({
      appended: 77,
      duplicates: 0,
      deferred: 0,
      refused: [],
      abandoned: [],
    });
    const state = await runtime.loadState("ex-5", { principal: owner });
    expect(state?.status).toBe("completed");
    const uiOutcomes = (
      (state?.variables as { _outcomes?: Array<Record<string, unknown>> })._outcomes ?? []
    ).filter((o) => String(o.key).startsWith("ui:r1:end"));
    expect(uiOutcomes).toHaveLength(1);
    expect(uiOutcomes[0]).toMatchObject({ late: true, recordedBy: "reward-pipeline" });
    expect(String(uiOutcomes[0]?.key)).toBe(`ui:r1:end:${ledger.specHash}`);

    // a KERNEL-stamped late outcome from another pipeline (a CSAT import, say) that favours `flat`
    for (const ref of refs.slice(3)) {
      const v = (await variantOf(eventStore, ref.executionId)).variant;
      await runtime.recordOutcome(
        ref.executionId,
        { decisionId: ref.decisionId, key: "csat-late", score: v === "flat" ? 1 : 0 },
        { principal: pipeline }
      );
    }

    // re-running settles nothing new (already settled), and a second replica over the same log agrees
    expect((await settle(refs.slice(3), pipeline)).alreadySettled).toBe(77);
    const replica = new VoteLedger({
      log: votes,
      pseudonymKey: KEY,
      clock: () => now,
      outcomes: ["approved"],
    });
    expect((await replica.fold(refs[10] as DecisionRef)).summary).toEqual(
      (await ledger.fold(refs[10] as DecisionRef)).summary
    );

    // P2-10: the unrelated CSAT outcome (which favours `flat`) is on the same decisions, and
    // `trajectories` WOULD average it in - evaluateVariants must not
    const events = (await Promise.all(refs.map((r) => eventStore.read(r.executionId)))).flat();
    const raw = trajectories(events, { terminalReward: () => undefined })
      .flatMap((t) => t.steps)
      .filter((s) => s.decisionId.startsWith(VARIANT_DECISION_PREFIX));
    const tabsRaw = raw
      .filter((s) => s.action === "tabs" && s.rewardSource === "direct")
      .map((s) => s.reward as number);
    expect(Math.max(...tabsRaw)).toBeLessThan(0.7); // tabs' ui reward (~1) is dragged down by csat 0: the contamination is real
    const evaluation = evaluateVariants(events, {
      rewardId: "r1",
      thresholds: { minSteps: 40, minEffectiveSamples: 5, minUnits: 20 },
    });
    expect(evaluation.winner).toBe("tabs");
    expect(evaluation.deterministicLogging).toBe(false);
    const [top, second] = evaluation.rows;
    expect(top?.report.estimator).toBe("snips");
    expect(top?.report.units).toBeGreaterThanOrEqual(20);
    expect(
      (top?.report.estimatedValue ?? 0) - (second?.report.estimatedValue ?? 1)
    ).toBeGreaterThan(0.4);
    expect(evaluation.steps).toBe(80);
    // another reward pipeline's id sees none of these rewards
    expect(evaluateVariants(events, { rewardId: "other" }).winner).toBeUndefined();
    // a gate that demands more evidence than exists names no winner - never a guess
    expect(
      evaluateVariants(events, { rewardId: "r1", thresholds: { minSteps: 10_000 } }).winner
    ).toBeUndefined();
  });

  it("the default ADR 0116 rule is owner: a pipeline principal that is not the owner is refused until the host opts in", async () => {
    const { eventStore, runtime, flow } = rig(abPlanner, "owner");
    await (
      await runtime.start(flow, { unit: "u_x" }, { executionId: "ex-o", principal: owner })
    ).waitForCompletion();
    const out = await variantOf(eventStore, "ex-o");
    const ref = { executionId: "ex-o", decisionId: out.decisionId };
    const links = new DecisionLinks();
    links.register("e", "v1", { tenant: "acme", decisions: [ref] });
    const ledger = new VoteLedger({
      log: eventStoreLineageStore(new InMemoryAsyncEventStore(), {
        streamPrefix: "__loom_ui_votes__:",
      }),
      pseudonymKey: KEY,
      clock: () => 0,
    });
    const ing = new SignalIngestor({ links, ledger, clock: () => 0, exposure: "client-claimed" });
    await ing.ingest({
      viewer: { id: "v", tenant: "acme" },
      raw: batch("b", "e", [{ kind: "exposure", node: "n" }]),
    });
    const mk = (principal: object) => ({
      ledger,
      runtime,
      decisions: [ref],
      reward: defaultReward(),
      rewardId: "r1",
      closeId: "end",
      clock: () => 0,
      authorize: () => ({ principal }),
    });
    expect((await settleRewards(mk(pipeline))).refused).toHaveLength(1);
  });

  it("a decision of a still-running execution is deferred (the kernel's real error name), then abandoned past maxDeferralMs", async () => {
    const { eventStore, runtime, flow } = rig(abPlanner);
    await runtime.start(
      flow,
      { unit: "u_p", park: true },
      { executionId: "ex-park", principal: owner }
    );
    await new Promise((r) => setTimeout(r, 20));
    const out = await variantOf(eventStore, "ex-park");
    const ref = { executionId: "ex-park", decisionId: out.decisionId };
    const links = new DecisionLinks();
    links.register("exp-p", "v1", { tenant: "acme", decisions: [ref] });
    let now = 0;
    const ledger = new VoteLedger({
      log: eventStoreLineageStore(new InMemoryAsyncEventStore(), {
        streamPrefix: "__loom_ui_votes__:",
      }),
      pseudonymKey: KEY,
      clock: () => now,
    });
    const ing = new SignalIngestor({ links, ledger, clock: () => now, exposure: "client-claimed" });
    await ing.ingest({
      viewer: { id: "u", tenant: "acme" },
      raw: batch("b1", "exp-p", [{ kind: "exposure", node: "n" }]),
    });
    const opts = {
      ledger,
      runtime,
      decisions: [ref],
      reward: defaultReward(),
      rewardId: "r1",
      closeId: "end",
      clock: () => now,
      authorize: () => ({ principal: pipeline }),
      maxDeferralMs: 1_000,
    };
    expect(await settleRewards(opts)).toMatchObject({ deferred: 1, appended: 0, refused: [] });
    now += 5_000;
    const rep = await settleRewards(opts);
    expect(rep.abandoned).toHaveLength(1);
    expect((await settleRewards(opts)).alreadySettled).toBe(1);
  });

  it("P3-3: when every variant choice was deterministic (UCB, propensity 1) no winner is named unless explicitly allowed", async () => {
    const ucb = new ReferencePlanner({
      modelId: "m",
      model,
      variants: {
        policy: ucbPolicy({ id: "ucb", version: "1", stats: () => ({}) }),
        variants: { flat: {}, tabs: {} },
      },
    });
    const { eventStore, runtime, flow } = rig(ucb);
    const links = new DecisionLinks();
    const ledger = new VoteLedger({
      log: eventStoreLineageStore(new InMemoryAsyncEventStore(), {
        streamPrefix: "__loom_ui_votes__:",
      }),
      pseudonymKey: KEY,
      clock: () => 0,
    });
    const ing = new SignalIngestor({ links, ledger, clock: () => 0, exposure: "client-claimed" });
    const refs: DecisionRef[] = [];
    for (let i = 0; i < 6; i++) {
      await (
        await runtime.start(flow, { unit: `u_${i}` }, { executionId: `ex-u${i}`, principal: owner })
      ).waitForCompletion();
      const ref = {
        executionId: `ex-u${i}`,
        decisionId: (await variantOf(eventStore, `ex-u${i}`)).decisionId,
      };
      refs.push(ref);
      links.register(`e${i}`, "v1", { tenant: "acme", decisions: [ref] });
      await ing.ingest({
        viewer: { id: "v", tenant: "acme" },
        raw: batch(`b${i}`, `e${i}`, [
          { kind: "exposure", node: "n" },
          { kind: "feedback", rating: 5 },
        ]),
      });
    }
    await settleRewards({
      ledger,
      runtime,
      decisions: refs,
      reward: defaultReward(),
      rewardId: "r1",
      closeId: "end",
      clock: () => 0,
      authorize: () => ({ principal: pipeline }),
    });
    const events = (await Promise.all(refs.map((r) => eventStore.read(r.executionId)))).flat();
    const thresholds = { minSteps: 3, minEffectiveSamples: 1 };
    const strict = evaluateVariants(events, { rewardId: "r1", thresholds });
    expect(strict.deterministicLogging).toBe(true);
    expect(strict.winner).toBeUndefined();
    expect(strict.reasons[0]).toMatch(/deterministic/);
    expect(
      evaluateVariants(events, { rewardId: "r1", thresholds, allowDeterministicLogging: true })
        .deterministicLogging
    ).toBe(true);
  });
});
