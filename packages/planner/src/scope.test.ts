import { describe, expect, it } from "vitest";
import { scopeInvoker } from "./scope";
import type { DecideContext, DecideScope } from "./spi";
import { recordingContext, stampingScope } from "./testing.test-support";

describe("DecideScope on the SPI", () => {
  it("a zero-arg decider still type-checks and runs", async () => {
    const ctx: DecideContext = recordingContext();
    const v = await ctx.decide("zero", () => 1);
    const w = await ctx.decide("zero-async", async () => 2);
    expect([v, w]).toEqual([1, 2]);
  });
  it("hands the decider the context's scope; calls through it carry the deciding identity", async () => {
    const scope = stampingScope("exec-7", (t) => `${t}!`);
    const ctx: DecideContext = recordingContext(scope);
    const out = await ctx.decide("d", (s: DecideScope) =>
      s.invokeTransient<string, string>("tool.x", "in")
    );
    expect(out).toBe("tool.x!");
    expect(scope.calls.map((c) => [c.toolId, c.identity])).toEqual([["tool.x", "exec-7"]]);
  });
});

describe("scopeInvoker", () => {
  it("is a TransientInvoker over the scope: toolId, input and signal pass through", async () => {
    const scope = stampingScope("exec-1", () => "ok");
    const ac = new AbortController();
    const inv = scopeInvoker(scope);
    expect(await inv.invokeTransient("t", { a: 1 }, { signal: ac.signal })).toBe("ok");
    expect(scope.calls).toHaveLength(1);
    expect(scope.calls[0]).toMatchObject({ toolId: "t", input: { a: 1 }, identity: "exec-1" });
    expect(scope.calls[0]?.signal).toBe(ac.signal);
  });
  it("refuses an identity the scope already fixes: principal, as, resources (a rejection)", async () => {
    const inv = scopeInvoker(stampingScope("e", () => 1));
    await expect(
      inv.invokeTransient("t", {}, { as: { workflowId: "w", executionId: "x" } })
    ).rejects.toThrow(/scope/);
    await expect(inv.invokeTransient("t", {}, { principal: {} as never })).rejects.toThrow(/scope/);
    await expect(inv.invokeTransient("t", {}, { resources: {} as never })).rejects.toThrow(/scope/);
  });
  it("a refused option never throws synchronously and never reaches the scope", async () => {
    const scope = stampingScope("e", () => 1);
    const inv = scopeInvoker(scope);
    let p: Promise<unknown> | undefined;
    expect(() => {
      p = inv.invokeTransient("t", {}, { principal: {} as never });
    }).not.toThrow();
    await expect(p).rejects.toBeInstanceOf(TypeError);
    expect(scope.calls).toHaveLength(0);
  });
  it("accepts a label (a trace tag) without forwarding it", async () => {
    const scope = stampingScope("e", () => 1);
    await scopeInvoker(scope).invokeTransient("t", {}, { label: "x" });
    expect(scope.calls).toHaveLength(1);
  });
});
