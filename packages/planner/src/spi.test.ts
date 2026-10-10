import { tainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import {
  type DecideContext,
  type PlannerMessage,
  type PlannerModel,
  plannerMessageText,
} from "./spi";
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
  it("scriptedModel reports a usage on every reply when given one, and none otherwise", async () => {
    const withUsage = scriptedModel(["a"], { inputTokens: 7, outputTokens: 3 });
    expect(await withUsage.complete({ messages: [] })).toEqual({
      content: "a",
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    const without = await scriptedModel(["a"]).complete({ messages: [] });
    expect("usage" in without).toBe(false);
  });
});

describe("PlannerMessage content is text or parts (loom R5)", () => {
  it("reads the text of a parts message, never [object Object]", () => {
    const m: PlannerMessage = {
      role: "user",
      content: [
        { type: "text", text: "show " },
        { type: "image", mediaType: "image/png", source: { kind: "data", data: "AAAA" } },
        { type: "tool_use", id: "t1", name: "x", input: {} },
        { type: "tool_result", toolUseId: "t1", content: [{ type: "text", text: "revenue" }] },
        { type: "tool_result", toolUseId: "t2", content: " by day" },
      ],
    };
    const text = plannerMessageText(m.content);
    expect(text).toBe("show revenue by day");
    expect(text).not.toContain("[object Object]");
    expect(plannerMessageText("plain")).toBe("plain");
  });
  it("refuses a tainted wrapper instead of flattening it", () => {
    expect(() => plannerMessageText(tainted("evil", "mcp:x") as never)).toThrow(/tainted/);
    expect(() =>
      plannerMessageText([{ type: "text", text: tainted("evil", "mcp:x") as never }])
    ).toThrow(/tainted/);
  });
});
