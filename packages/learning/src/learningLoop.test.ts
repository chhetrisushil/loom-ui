import { type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";
import { SIGNAL_VERSION } from "@loom-ui/core/signals";
import { ReferencePlanner, stableBucketPolicy } from "@loom-ui/planner";
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
import { RewardAccumulator, SignalIngestor } from "./ingest";
import { DecisionLinks } from "./links";
import { defaultReward, settleRewards } from "./rewards";

// The whole loop through the REAL kernel: the reference planner chooses a variant through
// `decideWithPolicy` inside a flow (recorded with propensity), the execution finishes, viewers'
// signals are ingested, rewards are recorded LATE with `runtime.recordOutcome` as the owner, and the
// variants are compared off-policy from the exported log with `@loom/learning`.

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
const alice = { tenant: "acme", actor: "alice" };
const mallory = { tenant: "evil", actor: "mallory" };

const planner = new ReferencePlanner({
  modelId: "m",
  model: { complete: async () => ({ content: draft }) },
  variants: {
    policy: stableBucketPolicy({ id: "ab", version: "1", weights: { flat: 1, tabs: 1 } }),
    variants: { flat: { guidance: "flat" }, tabs: { guidance: "tabs" } },
  },
});

type In = { unit: string; park?: boolean };
type Out = { variant: string | undefined; decisionId: string | undefined };
const io = { inputSchema: z.any(), outputSchema: z.any() };

function rig() {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
    executionAuthorizer: executionAccessPolicy(),
  });
  const runner: FlowRunner<In, Out> = async (ctx, input) => {
    const r = await planner.compose(
      { intent: { objective: "orders", source: "user" }, catalog, capabilities, unit: input.unit },
      ctx as never
    );
    if (input.park) await ctx.suspend({ on: "GO" });
    return { variant: r.report.variant?.id, decisionId: r.report.variant?.decisionId };
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
  } as unknown as RegisteredFlow<In, Out>;
  runtime.registerFlow(flow.definition, flow.runner);
  return { eventStore, runtime, flow };
}
/** The variant choice an execution recorded, read back from its log. */
async function variantOf(eventStore: InMemoryAsyncEventStore, executionId: string): Promise<Out> {
  const ev = (await eventStore.read(executionId)).find(
    (e) =>
      e.eventType === "DECISION_RECORDED" &&
      String((e.payload as { decisionId?: string }).decisionId).startsWith(VARIANT_DECISION_PREFIX)
  );
  const p = ev?.payload as { decisionId: string; choice: string };
  return { variant: p.choice, decisionId: p.decisionId };
}
const batch = (n: number, node: string, signals: unknown[], exp: string) => ({
  v: SIGNAL_VERSION,
  batchId: `b${n}`,
  view: { experienceId: exp, versionHash: "v1" },
  signals,
});

describe("U11 the learning loop through the kernel", () => {
  it("records variants with propensity, rewards them late as the owner, and picks the winner off-policy", async () => {
    const { eventStore, runtime, flow } = rig();
    const links = new DecisionLinks();
    const accumulator = new RewardAccumulator();
    let now = 0;
    const ing = new SignalIngestor({ links, accumulator, clock: () => now, windowMs: 1000 });
    const executions: string[] = [];
    const chosen = { flat: 0, tabs: 0 };

    for (let i = 0; i < 80; i++) {
      const unit = `u${i}`;
      const run = await runtime.start(flow, { unit }, { executionId: `ex-${i}`, principal: alice });
      await run.waitForCompletion();
      const out = await variantOf(eventStore, `ex-${i}`);
      executions.push(`ex-${i}`);
      chosen[out.variant as "flat" | "tabs"]++;
      const exp = `exp-${i}`;
      links.register(exp, "v1", {
        tenant: "acme",
        decisions: [{ executionId: `ex-${i}`, decisionId: out.decisionId as string }],
        nodes: { orders: { executionId: `ex-${i}`, decisionId: out.decisionId as string } },
      });
      const good = out.variant === "tabs";
      const res = await ing.ingest({
        viewer: { id: unit, tenant: "acme" },
        raw: batch(
          i,
          "orders",
          [
            { kind: "exposure", node: "orders" },
            ...(good
              ? [
                  { kind: "engagement", action: "click", count: 2, node: "orders" },
                  { kind: "engagement", action: "dwell", bucket: 3, node: "orders" },
                  { kind: "feedback", rating: 5 },
                ]
              : [{ kind: "feedback", rating: 2 }]),
          ],
          exp
        ),
      });
      expect(res.refused).toBeUndefined();
    }
    expect(chosen.flat).toBeGreaterThan(20);
    expect(chosen.tabs).toBeGreaterThan(20);

    // the variant decision is a learnable decision: alternatives, context and propensity are in the log
    const log = (await Promise.all(executions.map((e) => eventStore.read(e)))).flat();
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
    expect(JSON.stringify(rec?.payload)).not.toMatch(/@/); // no PII-shaped value in the context

    // nothing is settled while the window is open
    const open = await settleRewards({
      accumulator,
      runtime,
      reward: defaultReward(),
      rewardId: "r1",
      before: ing.windowOf(now),
      authorize: () => ({ principal: alice }),
    });
    expect(open.appended).toBe(0);

    // close the window; an UNAUTHORIZED principal cannot reward anyone's decision (log untouched)
    now += 5_000;
    const before = (await eventStore.read("ex-0")).length;
    const denied = await settleRewards({
      accumulator,
      runtime,
      reward: defaultReward(),
      rewardId: "r1",
      before: ing.windowOf(now),
      authorize: () => ({ principal: mallory }),
    });
    expect(denied.appended).toBe(0);
    expect(denied.refused).toHaveLength(80);
    expect((await eventStore.read("ex-0")).length).toBe(before);
    expect(accumulator.size).toBe(0); // refused entries are dropped, not retried forever

    // …so re-ingest nothing; settle properly on a fresh accumulator is covered below. Rebuild the signals:
    // (the denied pass consumed them, which is the documented fail-closed behaviour)
    now += 5_000;
    const settledAt = now;
    const acc2 = new RewardAccumulator();
    const ing2 = new SignalIngestor({ links, accumulator: acc2, clock: () => now, windowMs: 1000 });
    for (let i = 0; i < 80; i++) {
      const out = await variantOf(eventStore, `ex-${i}`);
      const good = out.variant === "tabs";
      await ing2.ingest({
        viewer: { id: `u${i}`, tenant: "acme" },
        raw: batch(
          1000 + i,
          "orders",
          [
            { kind: "exposure", node: "orders" },
            ...(good
              ? [
                  { kind: "engagement", action: "click", count: 2, node: "orders" },
                  { kind: "engagement", action: "dwell", bucket: 3, node: "orders" },
                  { kind: "feedback", rating: 5 },
                ]
              : [{ kind: "feedback", rating: 2 }]),
          ],
          `exp-${i}`
        ),
      });
    }
    now += 5_000;
    const opts = {
      accumulator: acc2,
      runtime,
      reward: defaultReward(),
      rewardId: "r1",
      before: ing2.windowOf(now),
      authorize: () => ({ principal: alice }),
    };
    const rep = await settleRewards(opts);
    expect(rep).toMatchObject({ appended: 80, duplicates: 0, deferred: 0, refused: [] });

    // late, owner-stamped, status unchanged; the reward is exactly the function's bounded score
    const state = await runtime.loadState("ex-0", { principal: alice });
    expect(state?.status).toBe("completed");
    const outcomes =
      (state?.variables as { _outcomes?: Array<Record<string, unknown>> })._outcomes ?? [];
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ late: true, recordedBy: "alice" });
    expect(String(outcomes[0]?.key)).toMatch(/^ui:r1:\d+$/);

    // idempotent end to end: the SAME signals in the same window record nothing new…
    const replayed = async (rating: (variant: string | undefined) => number) => {
      const acc = new RewardAccumulator();
      const again = new SignalIngestor({
        links,
        accumulator: acc,
        clock: () => settledAt,
        windowMs: 1000,
      });
      for (let i = 0; i < 3; i++) {
        const out = await variantOf(eventStore, `ex-${i}`);
        const good = out.variant === "tabs";
        await again.ingest({
          viewer: { id: `u${i}`, tenant: "acme" },
          raw: batch(
            3000 + i,
            "orders",
            [
              { kind: "exposure", node: "orders" },
              ...(good
                ? [
                    { kind: "engagement", action: "click", count: 2, node: "orders" },
                    { kind: "engagement", action: "dwell", bucket: 3, node: "orders" },
                  ]
                : []),
              { kind: "feedback", rating: rating(out.variant) },
            ],
            `exp-${i}`
          ),
        });
      }
      return settleRewards({ ...opts, accumulator: acc });
    };
    expect(await replayed((v) => (v === "tabs" ? 5 : 2))).toMatchObject({
      appended: 0,
      duplicates: 3,
      refused: [],
    });
    // …and a DIFFERENT score for the same (decision, window) is refused by the kernel, never overwritten
    const eventsBefore = (await eventStore.read("ex-0")).length;
    const conflicting = await replayed(() => 1);
    expect(conflicting.appended).toBe(0);
    expect(conflicting.refused.length).toBeGreaterThan(0);
    expect((await eventStore.read("ex-0")).length).toBe(eventsBefore);

    // off-policy comparison straight from the exported log
    const log2 = (await Promise.all(executions.map((e) => eventStore.read(e)))).flat();
    const ts = trajectories(log2, { terminalReward: () => undefined });
    expect(
      ts
        .flatMap((t) => t.steps)
        .filter(
          (s) => s.decisionId.startsWith(VARIANT_DECISION_PREFIX) && s.rewardSource === "direct"
        )
    ).toHaveLength(80);
    const evaluation = evaluateVariants(log2, {
      thresholds: { minSteps: 40, minEffectiveSamples: 5, minUnits: 20 },
    });
    expect(evaluation.winner).toBe("tabs");
    const [top, second] = evaluation.rows;
    expect(top?.variant).toBe("tabs");
    expect(top?.report.estimator).toBe("snips");
    expect(top?.report.units).toBeGreaterThanOrEqual(20);
    expect(
      (top?.report.estimatedValue ?? 0) - (second?.report.estimatedValue ?? 1)
    ).toBeGreaterThan(0.5);
    expect(evaluation.steps).toBe(80);
    // a gate that demands more evidence than exists names no winner — never a guess
    expect(evaluateVariants(log2, { thresholds: { minSteps: 10_000 } }).winner).toBeUndefined();
  });

  it("a decision of a still-running execution is deferred, with the kernel's real error name", async () => {
    const { runtime, flow } = rig();
    const run = await runtime.start(
      flow,
      { unit: "u-park", park: true },
      { executionId: "ex-park", principal: alice }
    );
    await new Promise((r) => setTimeout(r, 20));
    const links = new DecisionLinks();
    const accumulator = new RewardAccumulator();
    const state = await runtime.loadState("ex-park", { principal: alice });
    const decisionId = (state?.variables as { _decisions?: Record<string, unknown> })._decisions
      ? Object.keys((state?.variables as { _decisions: Record<string, unknown> })._decisions).find(
          (k) => k.startsWith(VARIANT_DECISION_PREFIX)
        )
      : undefined;
    expect(decisionId).toBeDefined();
    links.register("exp-p", "v1", {
      tenant: "acme",
      decisions: [{ executionId: "ex-park", decisionId: decisionId as string }],
    });
    let now = 0;
    const ing = new SignalIngestor({ links, accumulator, clock: () => now, windowMs: 1000 });
    await ing.ingest({
      viewer: { id: "u", tenant: "acme" },
      raw: batch(1, "x", [{ kind: "exposure", node: "n" }], "exp-p"),
    });
    now += 5_000;
    const rep = await settleRewards({
      accumulator,
      runtime,
      reward: defaultReward(),
      rewardId: "r1",
      before: ing.windowOf(now),
      authorize: () => ({ principal: alice }),
    });
    expect(rep).toMatchObject({ deferred: 1, appended: 0, refused: [] });
    expect(accumulator.size).toBe(1); // kept for the next settlement
    await runtime.cancel?.("ex-park", { principal: alice }).catch(() => undefined);
    void run;
  });
});
