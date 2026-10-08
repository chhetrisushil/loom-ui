import { describe, expect, it } from "vitest";
import { RewardAccumulator, type WindowSummary } from "./ingest";
import type { DecisionRef } from "./links";
import { type OutcomeRuntime, defaultReward, settleRewards } from "./rewards";

const sum = (p: Partial<WindowSummary> = {}): WindowSummary => ({
  exposed: 10,
  clicked: 0,
  dwell: [0, 0, 0, 0],
  engaged: 0,
  feedbackCount: 0,
  feedbackSum: 0,
  outcomes: 0,
  outcomeSuccesses: 0,
  ...p,
});

describe("U11 defaultReward", () => {
  it("is bounded in [0,1] and undefined without exposure — over a sweep, including hostile counts", () => {
    const f = defaultReward();
    expect(f(sum({ exposed: 0, engaged: 5 }))).toBeUndefined();
    let seen = 0;
    for (const exposed of [1, 7, 100])
      for (const engaged of [0, 3, 1000])
        for (const [fc, fs] of [
          [0, 0],
          [2, 2],
          [2, 10],
          [3, 9999],
        ] as const)
          for (const [o, os] of [
            [0, 0],
            [4, 1],
            [4, 4],
            [2, 9],
          ] as const) {
            const r = f(
              sum({
                exposed,
                engaged,
                feedbackCount: fc,
                feedbackSum: fs,
                outcomes: o,
                outcomeSuccesses: os,
              })
            );
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThanOrEqual(1);
            seen++;
          }
    expect(seen).toBe(144);
  });
  it("weights the components that have data and leaves out those that do not", () => {
    expect(defaultReward()(sum({ engaged: 5 }))).toBe(0.5);
    // engagement 0.5 (w1) + rating 5 -> 1 (w2): (0.5 + 2) / 3
    expect(defaultReward()(sum({ engaged: 5, feedbackCount: 1, feedbackSum: 5 }))).toBe(0.833333);
    expect(
      defaultReward({ engagement: 0, feedback: 0, outcome: 1 })(sum({ engaged: 5 }))
    ).toBeUndefined();
    expect(
      defaultReward({ engagement: 0, outcome: 1 })(sum({ outcomes: 2, outcomeSuccesses: 1 }))
    ).toBe(0.5);
  });
});

const REF: DecisionRef = { executionId: "e1", decisionId: "plan-variant:x" };
type Call = {
  executionId: string;
  outcome: { decisionId: string; key: string; score?: number };
  options?: unknown;
};

function fakeRuntime(behave: (c: Call, n: number) => void = () => {}) {
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
  return { runtime, calls, store };
}
function filled(...windows: number[]) {
  const acc = new RewardAccumulator();
  for (const w of windows) {
    const b = acc.bucket(REF, w);
    if (b) {
      b.exposed = 4;
      b.engaged = 2;
    }
  }
  return acc;
}

describe("U11 settleRewards", () => {
  const base = {
    rewardId: "r1",
    reward: defaultReward(),
    authorize: () => ({ principal: "owner" }),
  };

  it("records ONE bounded score per closed (decision, window) under ui:<rewardId>:<window>, as the owner", async () => {
    const acc = filled(5, 6, 9);
    const f = fakeRuntime();
    const rep = await settleRewards({ ...base, accumulator: acc, runtime: f.runtime, before: 7 });
    expect(rep).toMatchObject({ appended: 2, duplicates: 0, empty: 0, deferred: 0, refused: [] });
    expect(f.calls.map((c) => c.outcome.key)).toEqual(["ui:r1:5", "ui:r1:6"]);
    expect(f.calls.every((c) => c.outcome.score === 0.5 && c.options !== undefined)).toBe(true);
    expect(f.calls[0]?.options).toEqual({ principal: "owner" });
    expect(acc.size).toBe(1); // the open window is untouched
  });

  it("is idempotent: re-running (a crash between record and forget) appends nothing new", async () => {
    const f = fakeRuntime();
    await settleRewards({ ...base, accumulator: filled(5), runtime: f.runtime, before: 7 });
    const rep = await settleRewards({
      ...base,
      accumulator: filled(5),
      runtime: f.runtime,
      before: 7,
    });
    expect(rep).toMatchObject({ appended: 0, duplicates: 1 });
    expect(f.store.size).toBe(1);
  });

  it("a still-running execution is deferred and retried; a refusal is dropped and reported", async () => {
    const acc = filled(5);
    let terminal = false;
    const f = fakeRuntime(() => {
      if (!terminal)
        throw Object.assign(new Error("running"), {
          name: "ExecutionNotTerminalError",
          retryable: false,
        });
    });
    const first = await settleRewards({ ...base, accumulator: acc, runtime: f.runtime, before: 7 });
    expect(first).toMatchObject({ deferred: 1, appended: 0 });
    expect(acc.size).toBe(1);
    terminal = true;
    expect(
      await settleRewards({ ...base, accumulator: acc, runtime: f.runtime, before: 7 })
    ).toMatchObject({ appended: 1 });
    expect(acc.size).toBe(0);

    const denied = fakeRuntime(() => {
      throw Object.assign(new Error("denied"), { name: "ExecutionDeniedError" });
    });
    const acc2 = filled(5);
    const rep = await settleRewards({
      ...base,
      accumulator: acc2,
      runtime: denied.runtime,
      before: 7,
    });
    expect(rep.refused).toHaveLength(1);
    expect(rep.refused[0]?.ref).toEqual(REF);
    expect(acc2.size).toBe(0); // not retried forever
  });

  it("a reward function outside [0,1] or non-finite cannot put a bad number in the log", async () => {
    for (const [out, expected] of [
      [7, 1],
      [-3, 0],
      [Number.NaN, undefined],
      [Number.POSITIVE_INFINITY, undefined],
    ] as const) {
      const f = fakeRuntime();
      const rep = await settleRewards({
        ...base,
        reward: () => out,
        accumulator: filled(5),
        runtime: f.runtime,
        before: 7,
      });
      if (expected === undefined) expect(rep.empty).toBe(1);
      else expect(f.calls[0]?.outcome.score).toBe(expected);
    }
    await expect(
      settleRewards({
        ...base,
        rewardId: "bad id",
        accumulator: filled(5),
        runtime: fakeRuntime().runtime,
        before: 7,
      })
    ).rejects.toThrow(/token/);
  });

  it("a window the function has nothing to say about records nothing", async () => {
    const f = fakeRuntime();
    const acc = new RewardAccumulator();
    acc.bucket(REF, 5); // zero exposure
    const rep = await settleRewards({ ...base, accumulator: acc, runtime: f.runtime, before: 7 });
    expect(rep.empty).toBe(1);
    expect(f.calls).toHaveLength(0);
  });
});
