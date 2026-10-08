import { describe, expect, it } from "vitest";
import { InMemoryVoteLog, VoteLedger, type VoteSummary } from "./ledger";
import type { DecisionRef } from "./links";
import { type OutcomeRuntime, defaultReward, isNotTerminal, settleRewards } from "./rewards";

const sum = (p: Partial<VoteSummary> = {}): VoteSummary => ({
  viewers: 10,
  engagementSum: 0,
  feedbackViewers: 0,
  feedbackSum: 0,
  outcomeViewers: 0,
  outcomeSum: 0,
  overflowViewers: 0,
  ...p,
});

describe("U11 defaultReward", () => {
  it("is bounded in [0,1] and undefined without a viewer - over a sweep, including hostile sums", () => {
    const f = defaultReward();
    expect(f(sum({ viewers: 0 }))).toBeUndefined();
    let seen = 0;
    for (const viewers of [1, 7, 100])
      for (const engagementSum of [0, 3, 1e9, -5])
        for (const [fv, fs] of [
          [0, 0],
          [2, 2],
          [2, 99],
          [3, -4],
        ] as const)
          for (const [ov, os] of [
            [0, 0],
            [4, 1],
            [4, 4],
            [2, 9e9],
          ] as const) {
            const r = f(
              sum({
                viewers,
                engagementSum,
                feedbackViewers: fv,
                feedbackSum: fs,
                outcomeViewers: ov,
                outcomeSum: os,
              })
            );
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThanOrEqual(1);
            seen++;
          }
    expect(seen).toBe(192);
  });
  it("weights the components that have data (mean of per-viewer terms) and leaves out those that do not", () => {
    expect(defaultReward()(sum({ engagementSum: 5 }))).toBe(0.5);
    expect(defaultReward()(sum({ engagementSum: 5, feedbackViewers: 1, feedbackSum: 1 }))).toBe(
      0.833333
    );
    expect(
      defaultReward({ engagement: 0, feedback: 0, outcome: 1 })(sum({ engagementSum: 5 }))
    ).toBeUndefined();
    expect(
      defaultReward({ engagement: 0, outcome: 1 })(sum({ outcomeViewers: 2, outcomeSum: 1 }))
    ).toBe(0.5);
  });
});

let uniq = 0;
const fresh = (): DecisionRef => ({ executionId: `e${++uniq}`, decisionId: "plan-variant:x" });
type Call = {
  executionId: string;
  outcome: { decisionId: string; key: string; score?: number };
  options?: unknown;
};

function rig(behave: (c: Call, n: number) => void = () => {}) {
  let now = 1_000_000;
  const ledger = new VoteLedger({
    log: new InMemoryVoteLog(),
    pseudonymKey: "0123456789abcdef0123456789abcdef",
    clock: () => now,
    outcomes: ["approved"],
  });
  const calls: Call[] = [];
  const store = new Map<string, number>();
  const runtime: OutcomeRuntime = {
    async recordOutcome(executionId, outcome, options) {
      const call = { executionId, outcome, options } as Call;
      calls.push(call);
      behave(call, calls.length);
      const k = `${executionId}|${outcome.decisionId}|${outcome.key}`;
      const had = store.get(k);
      if (had !== undefined) {
        if (had !== outcome.score)
          throw Object.assign(new Error("conflict"), { name: "OutcomeRefusedError" });
        return { appended: false };
      }
      store.set(k, outcome.score as number);
      return { appended: true };
    },
  };
  const vote = async (ref: DecisionRef, n: number, engaged = true) => {
    for (let i = 0; i < n; i++)
      await ledger.recordVote(ref, {
        v: `v${i}`,
        b: "b",
        s: [
          { k: "x", n: "n:a" },
          ...(engaged ? [{ k: "c" as const, n: "n:a", a: "click" as const, c: 1 }] : []),
        ],
      });
  };
  const base = (ref: DecisionRef) => ({
    ledger,
    runtime,
    decisions: [ref],
    reward: defaultReward(),
    rewardId: "r1",
    closeId: "end",
    clock: () => now,
    authorize: () => ({ principal: "pipeline" }),
  });
  return {
    ledger,
    runtime,
    calls,
    store,
    vote,
    base,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("U11 settleRewards (once per decision, at a close)", () => {
  it("freezes the ledger, records ONE pooled score under ui:<rewardId>:<closeId>:<specHash>, as the host-supplied principal", async () => {
    const r = rig();
    const ref = fresh();
    await r.vote(ref, 4);
    const rep = await settleRewards(r.base(ref));
    expect(rep).toMatchObject({
      appended: 1,
      duplicates: 0,
      empty: 0,
      deferred: 0,
      refused: [],
      abandoned: [],
    });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.outcome.key).toBe(`ui:r1:end:${r.ledger.specHash}`);
    expect(r.calls[0]?.outcome.score).toBe(1); // all 4 viewers engaged: engagement 1
    expect(r.calls[0]?.options).toEqual({ principal: "pipeline" });
    // votes after the close change nothing and are refused at the door
    expect(await r.ledger.recordVote(ref, { v: "late", b: "b", s: [{ k: "x", n: "n:a" }] })).toBe(
      "closed"
    );
  });

  it("pools COUNTS, not window means: 1 unengaged viewer among 99 engaged weighs 1/100", async () => {
    const r = rig();
    const ref = fresh();
    await r.vote(ref, 99, true);
    await r.ledger.recordVote(ref, { v: "lonely", b: "b", s: [{ k: "x", n: "n:a" }] });
    await settleRewards(r.base(ref));
    expect(r.calls[0]?.outcome.score).toBe(0.99);
  });

  it("is idempotent and replica-safe: concurrent settlements compute the same frozen score; the kernel appends once", async () => {
    const r = rig();
    const ref = fresh();
    await r.vote(ref, 5);
    const reps = await Promise.all([
      settleRewards(r.base(ref)),
      settleRewards(r.base(ref)),
      settleRewards(r.base(ref)),
    ]);
    expect(new Set(r.calls.map((c) => c.outcome.score)).size).toBe(1);
    expect(r.store.size).toBe(1);
    expect(reps.reduce((n, x) => n + x.appended, 0)).toBe(1);
    const again = await settleRewards(r.base(ref));
    expect(again.alreadySettled).toBe(1);
  });

  it("a changed reward spec records under a NEW key: it cannot reuse or collide with an old number", () => {
    const a = rig();
    const b = new VoteLedger({
      log: new InMemoryVoteLog(),
      pseudonymKey: "0123456789abcdef0123456789abcdef",
      clock: () => 0,
      outcomes: ["approved", "refunded"],
    });
    expect(b.specHash).not.toBe(a.ledger.specHash);
    const c = new VoteLedger({
      log: new InMemoryVoteLog(),
      pseudonymKey: "0123456789abcdef0123456789abcdef",
      clock: () => 0,
      outcomes: ["approved"],
      maxNodesPerViewer: 8,
    });
    expect(c.specHash).not.toBe(a.ledger.specHash);
  });

  it("not terminal: deferred (the ledger stays frozen), then recorded once the execution ends", async () => {
    let terminal = false;
    const r = rig(() => {
      if (!terminal)
        throw Object.assign(new Error("running"), { name: "ExecutionNotTerminalError" });
    });
    const ref = fresh();
    await r.vote(ref, 2);
    expect(
      isNotTerminal(Object.assign(new Error("x"), { name: "ExecutionNotTerminalError" }))
    ).toBe(true);
    expect(await settleRewards(r.base(ref))).toMatchObject({ deferred: 1, appended: 0 });
    terminal = true;
    expect(await settleRewards(r.base(ref))).toMatchObject({ appended: 1, deferred: 0 });
  });

  it("P2-9: a deferral does not live forever: past maxDeferralMs it is abandoned, marked, and reported", async () => {
    const r = rig(() => {
      throw Object.assign(new Error("running"), { name: "ExecutionNotTerminalError" });
    });
    const ref = fresh();
    await r.vote(ref, 2);
    expect((await settleRewards({ ...r.base(ref), maxDeferralMs: 1000 })).deferred).toBe(1);
    r.advance(5_000);
    const rep = await settleRewards({ ...r.base(ref), maxDeferralMs: 1000 });
    expect(rep.abandoned).toHaveLength(1);
    expect(rep.abandoned[0]?.reason).toMatch(/maxDeferralMs/);
    expect((await settleRewards({ ...r.base(ref), maxDeferralMs: 1000 })).alreadySettled).toBe(1);
  });

  it("P2-8: a transient failure is NOT a permanent drop: it is retried, and only abandoned after maxAttempts", async () => {
    let fail = 2;
    const r = rig(() => {
      if (fail-- > 0) throw new Error("connection reset");
    });
    const ref = fresh();
    await r.vote(ref, 3);
    expect(await settleRewards({ ...r.base(ref), maxAttempts: 5 })).toMatchObject({
      deferred: 1,
      refused: [],
    });
    expect(await settleRewards({ ...r.base(ref), maxAttempts: 5 })).toMatchObject({ deferred: 1 });
    expect(await settleRewards({ ...r.base(ref), maxAttempts: 5 })).toMatchObject({ appended: 1 });
    // a failure that never clears is abandoned after the bound
    const r2 = rig(() => {
      throw new Error("db down");
    });
    const ref2 = fresh();
    await r2.vote(ref2, 3);
    const outs = [];
    for (let i = 0; i < 3; i++)
      outs.push(await settleRewards({ ...r2.base(ref2), maxAttempts: 3 }));
    expect(outs.map((o) => o.deferred)).toEqual([1, 1, 0]);
    expect(outs[2]?.abandoned).toHaveLength(1);
  });

  it("a typed permanent refusal (unauthorized, conflicting score) is marked settled and reported, not retried", async () => {
    const r = rig(() => {
      throw Object.assign(new Error("denied"), { name: "ExecutionDeniedError" });
    });
    const ref = fresh();
    await r.vote(ref, 2);
    const rep = await settleRewards(r.base(ref));
    expect(rep.refused).toHaveLength(1);
    expect(rep.refused[0]?.ref).toEqual(ref);
    expect((await settleRewards(r.base(ref))).alreadySettled).toBe(1);
    expect(r.calls).toHaveLength(1);
  });

  it("a reward outside [0,1] or non-finite cannot put a bad number in the log; an empty decision records nothing", async () => {
    for (const [out, expected] of [
      [7, 1],
      [-3, 0],
    ] as const) {
      const r = rig();
      const ref = fresh();
      await r.vote(ref, 2);
      await settleRewards({ ...r.base(ref), reward: () => out });
      expect(r.calls[0]?.outcome.score).toBe(expected);
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = rig();
      const ref = fresh();
      await r.vote(ref, 2);
      expect((await settleRewards({ ...r.base(ref), reward: () => bad })).empty).toBe(1);
      expect(r.calls).toHaveLength(0);
    }
    const none = rig();
    const ref = fresh();
    expect((await settleRewards(none.base(ref))).empty).toBe(1);
    expect(none.calls).toHaveLength(0);
    expect((await settleRewards({ ...none.base(fresh()), minViewers: 5 })).empty).toBe(1);
    await expect(settleRewards({ ...none.base(ref), rewardId: "bad id" })).rejects.toThrow(/token/);
    await expect(settleRewards({ ...none.base(ref), closeId: "x".repeat(33) })).rejects.toThrow(
      /token/
    );
  });
});
