import { type Operation, genesis, replay, validateExperience } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { describe, expect, it } from "vitest";
import { ReferencePlanner } from "./reference";
import type { PlanPartial, PlannerModel } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
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

/** Chunks `text` into `size`-char pieces. Records calls, the signal it saw, and whether it was closed early. */
function streamingModel(replies: readonly string[], size = 11) {
  const m = {
    streamCalls: 0,
    completeCalls: 0,
    signals: [] as (AbortSignal | undefined)[],
    closedEarly: 0,
    async complete() {
      m.completeCalls += 1;
      return { content: replies[Math.min(m.completeCalls - 1, replies.length - 1)] as string };
    },
    stream(_req: unknown, opts?: { signal?: AbortSignal }) {
      const text = replies[Math.min(m.streamCalls, replies.length - 1)] as string;
      m.streamCalls += 1;
      m.signals.push(opts?.signal);
      return {
        [Symbol.asyncIterator]() {
          let i = 0;
          let finished = false;
          return {
            async next() {
              if (i >= text.length) {
                finished = true;
                return { done: true as const, value: undefined };
              }
              const value = text.slice(i, i + size);
              i += size;
              await Promise.resolve();
              return { done: false as const, value };
            },
            async return() {
              if (!finished) m.closedEarly += 1;
              return { done: true as const, value: undefined };
            },
          };
        },
      };
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
    expect(model.streamCalls).toBe(1);
    expect(model.completeCalls).toBe(0);
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
    expect(model.streamCalls).toBe(1);
    expect(ctx.deciderCalls).toBe(1);
  });

  it("streams only when someone listens and the model can: otherwise it is the whole-reply call", async () => {
    const m1 = streamingModel([draft("a")]);
    await new ReferencePlanner({ model: m1, modelId: "m" }).compose(input, recordingContext());
    expect([m1.streamCalls, m1.completeCalls]).toEqual([0, 1]);
    const m2 = scriptedModel([draft("a")]);
    const seen: PlanPartial[] = [];
    await new ReferencePlanner({ model: m2, modelId: "m" }).compose(input, recordingContext(), {
      onPartial: (p) => seen.push(p),
    });
    expect(m2.calls).toBe(1);
    expect(seen).toEqual([]);
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

  it("a stream that never ends is bounded: the reply cap is a model-output-invalid finding, not memory growth", async () => {
    const endless: PlannerModel = {
      async complete() {
        return { content: "" };
      },
      stream() {
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) yield "x".repeat(8192);
          },
        };
      },
    };
    const r = await new ReferencePlanner({ model: endless, modelId: "m", maxAttempts: 1 }).compose(
      input,
      recordingContext(),
      { onPartial: () => {} }
    );
    expect(r.ops).toEqual([]);
    expect(r.findings.map((f) => f.code)).toContain("plan-failed");
    expect(r.report.attempts[0]?.findings[0]?.code).toBe("model-output-invalid");
  });

  it("a stream that throws midway is a model-error attempt and the next attempt can succeed", async () => {
    let n = 0;
    const flaky: PlannerModel = {
      async complete() {
        return { content: "" };
      },
      stream() {
        n += 1;
        const first = n === 1;
        return {
          async *[Symbol.asyncIterator]() {
            yield draft("a").slice(0, 20);
            if (first) throw new Error("socket reset");
            yield draft("a").slice(20);
          },
        };
      },
    };
    const r = await new ReferencePlanner({ model: flaky, modelId: "m" }).compose(
      input,
      recordingContext(),
      {
        onPartial: () => {},
      }
    );
    expect(
      r.report.attempts.map((a) => a.findings.find((f) => f.severity === "error")?.code)
    ).toEqual(["model-error", undefined]);
    expect(r.ops.length).toBeGreaterThan(0);
  });
});

describe("streaming planner — cancellation", () => {
  it("aborting mid-stream rejects with AbortError, closes the stream, and RECORDS NOTHING", async () => {
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
    expect(got).toBe(1); // nothing is emitted after the abort
    expect(model.closedEarly).toBe(1);
    expect(model.signals[0]).toBe(ac.signal);
    expect(ctx.decisions.size).toBe(0);
    // the same input can be planned again: nothing was pinned
    const ok = await planner.compose(input, ctx, { onPartial: () => {} });
    expect(ok.ops.length).toBeGreaterThan(0);
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
    expect(model.streamCalls + model.completeCalls).toBe(0);
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
