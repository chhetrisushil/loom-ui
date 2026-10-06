import { type Operation, genesis, replay, validateExperience } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { describe, expect, it } from "vitest";
import { ReferencePlanner } from "./reference";
import { scopeInvoker } from "./scope";
import type { DecideScope, PlanPartial, PlannerDeltaSink, PlannerModel, PlannerUsage } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
  textDelta,
} from "./testing.test-support";

const metric = (id: string) => ({
  id,
  type: "Metric",
  label: id,
  span: 4,
  props: {},
  binding: {
    capability: "orders_summary",
    arguments: { window: "7d" },
    path: "totals.count",
    priority: "P0",
  },
});
const draft = (...ids: string[]) =>
  JSON.stringify({
    summary: "Orders overview",
    nodes: [...ids.map(metric), { id: "why", type: "Insight", label: "Why", span: 12, props: {} }],
  });
const input = {
  intent: intentFixture,
  catalog: planningCatalog,
  capabilities: capabilitiesFixture,
};

/**
 * Streams each reply to the `onDelta` the planner hands `complete`, in `size`-char tainted chunks
 * (then a `done`), and returns the whole reply. Records calls, the opts it saw, and the deltas sent.
 */
function streamingModel(replies: readonly string[], size = 11, usage?: PlannerUsage) {
  const m = {
    completeCalls: 0,
    withSink: 0,
    signals: [] as (AbortSignal | undefined)[],
    async complete(_req: unknown, opts?: { signal?: AbortSignal; onDelta?: PlannerDeltaSink }) {
      const text = replies[Math.min(m.completeCalls, replies.length - 1)] as string;
      m.completeCalls += 1;
      m.signals.push(opts?.signal);
      if (opts?.onDelta !== undefined) {
        m.withSink += 1;
        for (let i = 0; i < text.length; i += size) {
          await Promise.resolve();
          opts.onDelta(textDelta(text.slice(i, i + size)));
        }
        opts.onDelta({ ...textDelta(""), done: true, ...(usage && { usage }) });
      }
      return { content: text, ...(usage && { usage }) };
    },
  };
  return m satisfies PlannerModel;
}

const g = genesis({ experienceId: "scratch", intent: intentFixture, meta: metaFixture });

describe("streaming planner — compose", () => {
  it("emits incremental VALIDATED partials, growing in order, each applicable to the base", async () => {
    const text = draft("a", "b", "c");
    const model = streamingModel([text]);
    const planner = new ReferencePlanner({ model, modelId: "m" });
    const partials: PlanPartial[] = [];
    const r = await planner.compose(input, recordingContext(), {
      onPartial: (p) => partials.push(p),
    });
    expect(partials.length).toBeGreaterThanOrEqual(3);
    const counts = partials.map((p) => p.nodes);
    expect(counts).toEqual([...counts].sort((x, y) => x - y));
    expect(new Set(counts).size).toBe(counts.length); // one partial per newly completed node
    for (const p of partials) {
      const applied = replay(g, p.ops as Operation[]);
      expect(applied.ok).toBe(true);
      if (applied.ok)
        expect(
          validateExperience(applied.value, planningCatalog, "web").findings.filter(
            (f) => f.severity === "error"
          )
        ).toEqual([]);
      expect(p.findings.filter((f) => f.severity === "error")).toEqual([]);
      expect("summary" in p).toBe(false); // a partial never carries the model's summary (U7)
    }
    // every node closed before the object did, so the last partial IS the final plan's ops
    expect(partials[partials.length - 1]?.ops).toEqual(r.ops);
    expect(model.completeCalls).toBe(1); // ONE call: the stream rides it, there is no second path
    expect(model.withSink).toBe(1);
  });

  it("the FINAL result is identical to the non-streaming planner's for the same model output", async () => {
    const text = draft("a", "b");
    const streamed = await new ReferencePlanner({
      model: streamingModel([text]),
      modelId: "m",
    }).compose(input, recordingContext(), { onPartial: () => {} });
    const whole = await new ReferencePlanner({
      model: scriptedModel([text]),
      modelId: "m",
    }).compose(input, recordingContext());
    expect(streamed).toEqual(whole);
  });

  it("a replay serves the recorded final: no model call, no partials", async () => {
    const model = streamingModel([draft("a")]);
    const planner = new ReferencePlanner({ model, modelId: "m" });
    const ctx = recordingContext();
    const first = await planner.compose(input, ctx, { onPartial: () => {} });
    const seen: PlanPartial[] = [];
    const again = await planner.compose(input, ctx, { onPartial: (p) => seen.push(p) });
    expect(again).toEqual(first);
    expect(seen).toEqual([]);
    expect(model.completeCalls).toBe(1);
    expect(ctx.deciderCalls).toBe(1);
  });

  it("hands the model a sink only when someone listens; a model with no deltas simply completes without partials", async () => {
    const m1 = streamingModel([draft("a")]);
    await new ReferencePlanner({ model: m1, modelId: "m" }).compose(input, recordingContext());
    expect([m1.completeCalls, m1.withSink]).toEqual([1, 0]);
    const m2 = scriptedModel([draft("a")]); // never calls onDelta (non-streaming / sink refused)
    const seen: PlanPartial[] = [];
    const r = await new ReferencePlanner({ model: m2, modelId: "m" }).compose(
      input,
      recordingContext(),
      { onPartial: (p) => seen.push(p) }
    );
    expect(m2.calls).toBe(1);
    expect(seen).toEqual([]);
    expect(r.ops.length).toBeGreaterThan(0);
  });

  it("usage comes from what complete RETURNS (the old stream path lost it)", async () => {
    const r = await new ReferencePlanner({
      model: streamingModel([draft("a")], 11, { inputTokens: 3, outputTokens: 4 }),
      modelId: "m",
    }).compose(input, recordingContext(), { onPartial: () => {} });
    expect(r.report.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
    expect(r.report.attempts[0]?.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it("a streamed node the contract refuses is never shown as a partial; the final path still reports and retries", async () => {
    const bad = JSON.stringify({
      summary: "s",
      nodes: [
        metric("a"),
        { id: "g", type: "Gauge", label: "x", props: {} }, // not in the catalogue
        { ...metric("c"), binding: { ...metric("c").binding, sensitivity: "secret" } }, // class the entry does not let a model set
      ],
    });
    const model = streamingModel([bad, draft("a")]);
    const partials: PlanPartial[] = [];
    const r = await new ReferencePlanner({ model, modelId: "m" }).compose(
      input,
      recordingContext(),
      {
        onPartial: (p) => partials.push(p),
      }
    );
    const ids = (p: PlanPartial) => JSON.stringify(p.ops).match(/"id":"(g|c)"/g) ?? [];
    for (const p of partials.filter((p) => p.attempt === 0)) expect(ids(p)).toEqual([]);
    expect(r.report.attempts).toHaveLength(2);
    expect(r.report.firstAttemptValid).toBe(false);
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    // a retry starts over: the consumer is told to drop what attempt 0 showed
    const reset = partials.find((p) => p.attempt === 1 && p.ops.length === 0);
    expect(reset).toBeDefined();
  });

  it("a throwing consumer does not poison the plan", async () => {
    const r = await new ReferencePlanner({
      model: streamingModel([draft("a")]),
      modelId: "m",
    }).compose(input, recordingContext(), {
      onPartial: () => {
        throw new Error("ui blew up");
      },
    });
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.ops.length).toBeGreaterThan(0);
  });

  it("a call that throws midway is a model-error attempt and the next attempt can succeed", async () => {
    let n = 0;
    const flaky: PlannerModel = {
      async complete(_r, opts) {
        n += 1;
        opts?.onDelta?.(textDelta(draft("a").slice(0, 20)));
        if (n === 1) throw new Error("socket reset");
        opts?.onDelta?.(textDelta(draft("a").slice(20)));
        return { content: draft("a") };
      },
    };
    const r = await new ReferencePlanner({ model: flaky, modelId: "m" }).compose(
      input,
      recordingContext(),
      { onPartial: () => {} }
    );
    expect(
      r.report.attempts.map((a) => a.findings.find((f) => f.severity === "error")?.code)
    ).toEqual(["model-error", undefined]);
    expect(r.ops.length).toBeGreaterThan(0);
  });

  it("a runtime `reset` (the call retried) clears the view: an empty partial, then the new text from scratch", async () => {
    const model: PlannerModel = {
      async complete(_r, opts) {
        const t = draft("a", "b");
        opts?.onDelta?.(textDelta(t.slice(0, t.indexOf('"id":"b"') - 2))); // node "a" closed
        opts?.onDelta?.({ delta: textDelta("").delta, reset: true, attempt: 2 });
        opts?.onDelta?.(textDelta(t));
        return { content: t };
      },
    };
    const partials: PlanPartial[] = [];
    await new ReferencePlanner({ model, modelId: "m" }).compose(input, recordingContext(), {
      onPartial: (p) => partials.push(p),
    });
    const at = partials.findIndex((p) => p.ops.length === 0);
    expect(at).toBeGreaterThan(0);
    // the retried text is shown from scratch (a stale `seen` set would have swallowed it)
    expect(partials[at - 1]?.nodes).toBe(1);
    expect(partials[at + 1]?.nodes).toBe(3);
  });

  it("a malformed delta is a model-error attempt, not silently skipped", async () => {
    let n = 0;
    const model: PlannerModel = {
      async complete(_r, opts) {
        n += 1;
        if (n === 1) opts?.onDelta?.({ delta: 42 } as never);
        return { content: draft("a") };
      },
    };
    const r = await new ReferencePlanner({ model, modelId: "m" }).compose(
      input,
      recordingContext(),
      { onPartial: () => {} }
    );
    expect(r.report.attempts[0]?.findings.map((f) => f.code)).toContain("model-error");
    expect(r.ops.length).toBeGreaterThan(0); // attempt 2 is clean
  });
});

describe("streaming planner — governance (ADR 0119): one governed call", () => {
  /** A scope-routed model, as the README shows: the delta sink rides `scope.invokeTransient`. */
  const routed = (scope: DecideScope): PlannerModel => {
    const inv = scopeInvoker(scope);
    return { complete: (req, o) => inv.invokeTransient("llm.complete", req, o) };
  };

  it("a DENYING scope + onPartial: rejects with the denial, records nothing, emits nothing, and the call went through the scope", async () => {
    const denied = Object.assign(new Error("denied by scope"), { name: "CapabilityDeniedError" });
    const calls: string[] = [];
    const scope: DecideScope = {
      invokeTransient: (id) => {
        calls.push(id);
        return Promise.reject(denied);
      },
    };
    const ctx = recordingContext(scope);
    const partials: PlanPartial[] = [];
    await expect(
      new ReferencePlanner({ model: routed, modelId: "m" }).compose(input, ctx, {
        onPartial: (p) => partials.push(p),
      })
    ).rejects.toBe(denied);
    expect(calls).toEqual(["llm.complete"]);
    expect(ctx.decisions.size).toBe(0);
    expect(partials).toEqual([]);
  });

  it("the sink rides the scope call: the scope sees onDelta, and its deltas become partials", async () => {
    const text = draft("a", "b");
    let sawSink = false;
    const scope: DecideScope = {
      async invokeTransient(_id, _in, opts) {
        sawSink = opts?.onDelta !== undefined;
        for (let i = 0; i < text.length; i += 9) opts?.onDelta?.(textDelta(text.slice(i, i + 9)));
        return { content: text } as never;
      },
    };
    const partials: PlanPartial[] = [];
    const r = await new ReferencePlanner({ model: routed, modelId: "m" }).compose(
      input,
      recordingContext(scope),
      { onPartial: (p) => partials.push(p) }
    );
    expect(sawSink).toBe(true);
    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(r.ops.length).toBeGreaterThan(0);
  });

  it("without onPartial the scope call carries no sink", async () => {
    let sawSink: boolean | undefined;
    const scope: DecideScope = {
      async invokeTransient(_id, _in, opts) {
        sawSink = opts?.onDelta !== undefined;
        return { content: draft("a") } as never;
      },
    };
    await new ReferencePlanner({ model: routed, modelId: "m" }).compose(
      input,
      recordingContext(scope)
    );
    expect(sawSink).toBe(false);
  });
});

describe("streaming planner — cancellation", () => {
  it("aborting from a partial rejects with AbortError and RECORDS NOTHING; nothing is emitted after", async () => {
    const model = streamingModel([draft("a", "b", "c")], 5);
    const ac = new AbortController();
    const ctx = recordingContext();
    const planner = new ReferencePlanner({ model, modelId: "m" });
    let got = 0;
    const p = planner.compose(input, ctx, {
      signal: ac.signal,
      onPartial: () => {
        got += 1;
        ac.abort();
      },
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(got).toBe(1);
    expect(model.signals[0]).toBe(ac.signal);
    expect(ctx.decisions.size).toBe(0);
    // the same input can be planned again: nothing was pinned
    const ok = await planner.compose(input, ctx, { onPartial: () => {} });
    expect(ok.ops.length).toBeGreaterThan(0);
  });

  it("a model that IGNORES the signal cannot hold an aborted turn: it rejects promptly", async () => {
    const ac = new AbortController();
    const model: PlannerModel = {
      complete: () => new Promise(() => {}), // never settles, never looks at the signal
    };
    const ctx = recordingContext();
    const p = new ReferencePlanner({ model, modelId: "m" }).compose(input, ctx, {
      signal: ac.signal,
      onPartial: () => {},
    });
    setTimeout(() => ac.abort(), 5);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(ctx.decisions.size).toBe(0);
  });

  it("an already-aborted signal never calls the model", async () => {
    const model = streamingModel([draft("a")]);
    const ac = new AbortController();
    ac.abort();
    const ctx = recordingContext();
    await expect(
      new ReferencePlanner({ model, modelId: "m" }).compose(input, ctx, {
        signal: ac.signal,
        onPartial: () => {},
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(model.completeCalls).toBe(0);
    expect(ctx.decisions.size).toBe(0);
  });

  it("the signal reaches a whole-reply model too, and an abort after the reply is still not recorded", async () => {
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const model: PlannerModel = {
      async complete(_r, opts) {
        seen = opts?.signal;
        ac.abort();
        return { content: draft("a") };
      },
    };
    const ctx = recordingContext();
    await expect(
      new ReferencePlanner({ model, modelId: "m" }).compose(input, ctx, { signal: ac.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toBe(ac.signal);
    expect(ctx.decisions.size).toBe(0);
  });
});

describe("streaming planner — revise", () => {
  it("partials are the same single `prompt` op the final is, and the final equals the whole-reply result", async () => {
    const base = seal(genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture }));
    const text = draft("a", "b");
    const rin = { ...input, experience: base, request: { text: "add two metrics" } };
    const partials: PlanPartial[] = [];
    const streamed = await new ReferencePlanner({
      model: streamingModel([text]),
      modelId: "m",
    }).revise(rin, recordingContext(), { onPartial: (p) => partials.push(p) });
    const whole = await new ReferencePlanner({ model: scriptedModel([text]), modelId: "m" }).revise(
      rin,
      recordingContext()
    );
    expect(streamed).toEqual(whole);
    expect(partials.length).toBeGreaterThan(0);
    for (const p of partials) {
      expect(p.ops).toHaveLength(1);
      expect(p.ops[0]?.type).toBe("prompt");
      expect(replay(base, p.ops as Operation[]).ok).toBe(true);
    }
  });
});
