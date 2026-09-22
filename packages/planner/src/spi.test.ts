import { describe, expect, it } from "vitest";
import type { DecideContext, PlannerModel } from "./spi";
import { recordingContext, scriptedModel } from "./testing.test-support";

describe("SPI seams", () => {
  it("recordingContext serves a recorded decision without re-running the decider", async () => {
    const ctx: DecideContext = recordingContext();
    let runs = 0;
    const first = await ctx.decide("d1", () => ({ n: ++runs }));
    const second = await ctx.decide("d1", () => ({ n: ++runs }));
    expect(first).toEqual({ n: 1 });
    expect(second).toEqual({ n: 1 });
    expect(runs).toBe(1);
  });
  it("returns the raw decider value on the first call and the JSON-persisted value on replay", async () => {
    const ctx: DecideContext = recordingContext();
    const first = await ctx.decide("d2", () => ({ a: 1, b: undefined }));
    const second = await ctx.decide("d2", () => ({ a: 1, b: undefined }));
    expect(first).toEqual({ a: 1, b: undefined });
    expect(second).toEqual({ a: 1 });
  });
  it("scriptedModel repeats its last reply and counts calls", async () => {
    const m: PlannerModel & { calls: number } = scriptedModel(["a", "b"]);
    expect((await m.complete({ messages: [] })).content).toBe("a");
    expect((await m.complete({ messages: [] })).content).toBe("b");
    expect((await m.complete({ messages: [] })).content).toBe("b");
    expect(m.calls).toBe(3);
  });
});
