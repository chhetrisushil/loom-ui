import { type InteractionSignal, SIGNAL_VERSION } from "@loom-ui/core/signals";
import { describe, expect, it } from "vitest";
import type { ExposureCheck } from "./exposure";
import { RewardAccumulator, SignalIngestor, type Viewer } from "./ingest";
import { DecisionLinks, type DecisionRef } from "./links";
import { defaultReward } from "./rewards";

const REF: DecisionRef = { executionId: "exec-1", decisionId: "plan-variant:aaa" };
const REF2: DecisionRef = { executionId: "exec-2", decisionId: "plan-variant:bbb" };
const alice: Viewer = { id: "alice", tenant: "acme" };

function rig(
  opts: {
    tenant?: string;
    nodes?: Record<string, DecisionRef>;
    exposure?: ExposureCheck;
    rateLimit?: number;
    accumulatorMax?: number;
    maxRestrictedPerView?: number;
  } = {}
) {
  let now = 1_000_000;
  const links = new DecisionLinks();
  links.register("exp", "v1", {
    decisions: [REF],
    ...(opts.nodes !== undefined && { nodes: opts.nodes }),
    ...(opts.tenant !== undefined && { tenant: opts.tenant }),
  });
  const accumulator = new RewardAccumulator(opts.accumulatorMax);
  const ing = new SignalIngestor({
    links,
    accumulator,
    clock: () => now,
    windowMs: 1000,
    ...(opts.exposure !== undefined && { exposure: opts.exposure }),
    ...(opts.rateLimit !== undefined && { rateLimit: opts.rateLimit }),
    ...(opts.maxRestrictedPerView !== undefined && {
      maxRestrictedPerView: opts.maxRestrictedPerView,
    }),
  });
  let n = 0;
  const batch = (signals: unknown[], view = { experienceId: "exp", versionHash: "v1" }) => ({
    v: SIGNAL_VERSION,
    batchId: `b${++n}`,
    view,
    signals,
  });
  return {
    ing,
    accumulator,
    batch,
    advance: (ms: number) => {
      now += ms;
    },
    summary: (ref = REF) =>
      accumulator.closed(Number.MAX_SAFE_INTEGER).find((e) => e.ref.decisionId === ref.decisionId)
        ?.summary,
  };
}
const expo = (node: string): InteractionSignal => ({ kind: "exposure", node });

describe("U11 SignalIngestor", () => {
  it("counts exposure, engagement, dwell, feedback and outcome against the decision, once each", async () => {
    const r = rig();
    const res = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([
        { kind: "engagement", action: "click", count: 3, node: "a" }, // listed BEFORE the exposure: still judged after it
        expo("a"),
        expo("a"),
        { kind: "engagement", action: "dwell", bucket: 3, node: "a" },
        { kind: "feedback", rating: 5 },
        { kind: "outcome", name: "approved", success: true },
      ]),
    });
    expect(res.refused).toBeUndefined();
    expect(res.accepted).toBe(5);
    expect(res.rejected).toEqual({ duplicate: 1 });
    expect(r.summary()).toEqual({
      exposed: 1,
      clicked: 1,
      dwell: [0, 0, 0, 1],
      engaged: 1,
      feedbackCount: 1,
      feedbackSum: 5,
      outcomes: 1,
      outcomeSuccesses: 1,
    });
    expect(defaultReward()(r.summary() as never)).toBe(1);
  });

  it("a signal for a node the viewer was never exposed to is not rewarded", async () => {
    const r = rig();
    const res = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([
        expo("a"),
        { kind: "engagement", action: "click", count: 1, node: "b" }, // never exposed
        { kind: "feedback", rating: 5, node: "b" },
      ]),
    });
    expect(res.accepted).toBe(1);
    expect(res.rejected).toEqual({ unexposed: 2 });
    expect(r.summary()?.engaged).toBe(0);
    expect(r.summary()?.feedbackCount).toBe(0);
    // nor is a surface-level outcome from a viewer who exposed NOTHING
    const r2 = rig();
    const only = await r2.ing.ingest({
      viewer: alice,
      raw: r2.batch([{ kind: "outcome", name: "approved", success: true }]),
    });
    expect(only.rejected).toEqual({ unexposed: 1 });
    expect(r2.accumulator.size).toBe(0);
  });

  it("the host's authoritative exposure check can veto everything, the exposure signal included", async () => {
    const calls: string[] = [];
    const r = rig({
      exposure: {
        saw: (q) => {
          calls.push(q.node ?? "-");
          return q.node === "real";
        },
      },
    });
    const res = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([
        expo("real"),
        expo("claimed-only"),
        { kind: "engagement", action: "click", count: 1, node: "claimed-only" },
      ]),
    });
    expect(res.accepted).toBe(1);
    expect(res.rejected).toEqual({ unexposed: 2 });
    expect(r.summary()?.exposed).toBe(1);
  });

  it("repeating yourself raises nothing: duplicate batches, duplicate signals, a second rating", async () => {
    const r = rig();
    const raw = r.batch([expo("a"), { kind: "feedback", rating: 5, node: "a" }]);
    expect((await r.ing.ingest({ viewer: alice, raw })).accepted).toBe(2);
    expect((await r.ing.ingest({ viewer: alice, raw })).refused).toBe("duplicate-batch");
    const again = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([
        expo("a"),
        { kind: "feedback", rating: 1, node: "a" },
        { kind: "feedback", rating: 1, node: "a" },
      ]),
    });
    expect(again.accepted).toBe(0);
    expect(again.rejected).toEqual({ duplicate: 3 });
    expect(r.summary()?.feedbackSum).toBe(5);
    // the same batchId from a DIFFERENT viewer is theirs, not a replay
    expect((await r.ing.ingest({ viewer: { id: "bob", tenant: "acme" }, raw })).accepted).toBe(2);
    expect(r.summary()?.exposed).toBe(2);
  });

  it("a forged identity in the payload is ignored: the viewer is the session's", async () => {
    const r = rig();
    const raw = {
      ...(r.batch([expo("a")]) as object),
      viewer: "bob",
      viewerId: "bob",
      tenant: "other",
    };
    await r.ing.ingest({ viewer: alice, raw });
    const raw2 = { ...(r.batch([expo("a")]) as object), viewerId: "alice" };
    // a second, different viewer exposing the same node counts separately: identity comes from `viewer` only
    await r.ing.ingest({ viewer: { id: "carol", tenant: "acme" }, raw: raw2 });
    expect(r.summary()?.exposed).toBe(2);
  });

  it("another tenant's view is indistinguishable from an unknown one, and earns nothing", async () => {
    const r = rig({ tenant: "acme" });
    const foreign = await r.ing.ingest({
      viewer: { id: "mallory", tenant: "evil" },
      raw: r.batch([expo("a")]),
    });
    const unknown = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([expo("a")], { experienceId: "exp", versionHash: "never-registered" }),
    });
    const anon = await r.ing.ingest({ viewer: { id: "x" }, raw: r.batch([expo("a")]) });
    expect(foreign).toEqual({ accepted: 0, rejected: {}, refused: "unknown-view" });
    expect(unknown).toEqual(foreign);
    expect(anon).toEqual(foreign);
    expect(r.accumulator.size).toBe(0);
    expect((await r.ing.ingest({ viewer: alice, raw: r.batch([expo("a")]) })).accepted).toBe(1);
  });

  it("node-level credit follows the node's decision; a node the link does not list earns nothing", async () => {
    const r = rig({ nodes: { a: REF, b: REF2 } });
    const res = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([
        expo("a"),
        expo("b"),
        expo("human-edited"),
        { kind: "engagement", action: "click", count: 1, node: "b" },
      ]),
    });
    expect(res.rejected).toEqual({ "unknown-node": 1 });
    expect(r.summary(REF)?.exposed).toBe(1);
    expect(r.summary(REF2)).toMatchObject({ exposed: 1, engaged: 1 });
  });

  it("restricted nodes credit the VERSION's decisions, and only a few distinct ones count", async () => {
    const r = rig({ nodes: { a: REF }, maxRestrictedPerView: 2 });
    const res = await r.ing.ingest({
      viewer: alice,
      raw: r.batch(
        [1, 2, 3, 4].map((i) => ({ kind: "exposure", node: `r_alias${i}`, restricted: true }))
      ),
    });
    expect(res.accepted).toBe(2);
    expect(res.rejected).toEqual({ "restricted-cap": 2 });
    expect(r.summary()?.exposed).toBe(2);
  });

  it("is rate limited per viewer: an over-budget batch is refused whole and may be retried later", async () => {
    const r = rig({ rateLimit: 10 });
    const sig = (i: number) => expo(`n${i}`);
    const first = r.batch(Array.from({ length: 8 }, (_, i) => sig(i)));
    expect((await r.ing.ingest({ viewer: alice, raw: first })).accepted).toBe(8);
    const second = r.batch(Array.from({ length: 8 }, (_, i) => sig(i + 8)));
    expect((await r.ing.ingest({ viewer: alice, raw: second })).refused).toBe("rate-limited");
    // someone else has their own budget
    expect(
      (await r.ing.ingest({ viewer: { id: "bob", tenant: "acme" }, raw: r.batch([sig(0)]) }))
        .accepted
    ).toBe(1);
    // the refused batch was NOT remembered: the same batch is accepted once the window passes
    r.advance(61_000);
    expect((await r.ing.ingest({ viewer: alice, raw: second })).accepted).toBe(8);
  });

  it("malformed and oversized batches are refused whole", async () => {
    const r = rig();
    for (const raw of [
      null,
      "x",
      [],
      { v: 9 },
      r.batch(Array.from({ length: 65 }, () => expo("a"))),
    ])
      expect((await r.ing.ingest({ viewer: alice, raw })).refused).toBe("batch-invalid");
    const mixed = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([expo("a"), { kind: "evil", text: "hi" }]),
    });
    expect(mixed).toEqual({ accepted: 1, rejected: { invalid: 1 } });
  });

  it("accumulator capacity is a hard bound: a signal that needs a new bucket past it is refused", async () => {
    const r = rig({ accumulatorMax: 1, nodes: { a: REF, b: REF2 } });
    const res = await r.ing.ingest({ viewer: alice, raw: r.batch([expo("a"), expo("b")]) });
    expect(res.accepted).toBe(1);
    expect(res.rejected).toEqual({ capacity: 1 });
    expect(r.accumulator.size).toBe(1);
  });

  it("windows follow the injected clock, never the wall clock", async () => {
    const r = rig();
    await r.ing.ingest({ viewer: alice, raw: r.batch([expo("a")]) });
    r.advance(5_000);
    await r.ing.ingest({ viewer: alice, raw: r.batch([expo("b")]) });
    const w = r.accumulator
      .closed(Number.MAX_SAFE_INTEGER)
      .map((e) => e.window)
      .sort();
    expect(w).toEqual([1000, 1005]);
    expect(r.accumulator.closed(1001)).toHaveLength(1);
  });
});
