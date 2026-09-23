import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { describe, expect, it } from "vitest";
import { limitInvoker, memoInvoker } from "./invokers";
import { FakeInvoker, flush } from "./testing.test-support";

const mcp = (toolName: string, args: Record<string, unknown> = {}, pin = `schema-${toolName}`) => ({
  toolName,
  args,
  expectedSchemaHash: pin,
});

describe("limitInvoker", () => {
  it("never has more than `max` calls in flight, across every caller", async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const inner = new FakeInvoker().on("t", () => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) =>
        release.push(() => {
          active -= 1;
          resolve("ok");
        })
      );
    });
    const limited = limitInvoker(inner, 2);
    const all = [1, 2, 3, 4].map(() => limited.invokeTransient("t", {}));
    await flush();
    expect(inner.calls).toHaveLength(2);
    release.shift()?.();
    await flush();
    expect(inner.calls).toHaveLength(3);
    while (release.length > 0) {
      release.shift()?.();
      await flush();
    }
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(inner.calls).toHaveLength(4);
  });

  it("a failed call frees its slot", async () => {
    let n = 0;
    const inner = new FakeInvoker().on("t", () => {
      n += 1;
      if (n === 1) throw new Error("down");
      return "ok";
    });
    const limited = limitInvoker(inner, 1);
    const first = limited.invokeTransient("t", {});
    const second = limited.invokeTransient("t", {});
    await expect(first).rejects.toThrow("down");
    await expect(second).resolves.toBe("ok");
  });

  it("a queued call whose signal aborts leaves the queue and never reaches the inner invoker", async () => {
    const inner = new FakeInvoker().on("t", () => new Promise(() => {}));
    const limited = limitInvoker(inner, 1);
    void limited.invokeTransient("t", {});
    const ac = new AbortController();
    const queued = limited.invokeTransient("t", {}, { signal: ac.signal });
    ac.abort();
    await expect(queued).rejects.toThrow("aborted");
    await flush();
    expect(inner.calls).toHaveLength(1);
  });

  it("refuses a cap that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() => limitInvoker(new FakeInvoker(), bad)).toThrow(RangeError);
  });
});

describe("memoInvoker", () => {
  it("identical MCP steps share ONE call; another argument or another pin is another call", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => ({ echo: input }));
    const memo = memoInvoker(inner);
    const [a, b] = await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("fleet.list", { region: "north", limit: 2 })),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("fleet.list", { limit: 2, region: "north" })),
    ]);
    expect(a).toEqual(b);
    expect(inner.calls).toHaveLength(1);
    await memo.invokeTransient(
      MCP_INVOKE_TOOL_ID,
      mcp("fleet.list", { region: "south", limit: 2 })
    );
    await memo.invokeTransient(
      MCP_INVOKE_TOOL_ID,
      mcp("fleet.list", { region: "north", limit: 2 }, "v2")
    );
    expect(inner.calls).toHaveLength(3);
  });

  it("a completed call is served again for the rest of the pass", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ n: 1 }));
    const memo = memoInvoker(inner);
    await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"));
    await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"));
    expect(inner.calls).toHaveLength(1);
  });

  it("only MCP steps are memoized: any other transient effect always runs", async () => {
    const inner = new FakeInvoker().on("sandbox.run", () => 1);
    const memo = memoInvoker(inner);
    await memo.invokeTransient("sandbox.run", { same: true });
    await memo.invokeTransient("sandbox.run", { same: true });
    expect(inner.calls).toHaveLength(2);
  });

  it("a shared failure is every joiner's failure", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
      throw new TypedFailure("rateLimited", { retryAfterMs: 10 });
    });
    const memo = memoInvoker(inner);
    const first = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"));
    const second = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"));
    await expect(first).rejects.toBeInstanceOf(TypedFailure);
    await expect(second).rejects.toBeInstanceOf(TypedFailure);
    expect(inner.calls).toHaveLength(1);
  });

  it("a joiner whose leader was aborted asks again for itself", async () => {
    let n = 0;
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (_input, opts) => {
      n += 1;
      if (n === 1)
        return new Promise((_resolve, reject) =>
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        );
      return { ok: true };
    });
    const memo = memoInvoker(inner);
    const leader = new AbortController();
    const first = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { signal: leader.signal });
    const second = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"));
    leader.abort();
    await expect(first).rejects.toThrow("aborted");
    await expect(second).resolves.toEqual({ ok: true });
    expect(inner.calls).toHaveLength(2);
  });

  it("an input canonicalJson cannot represent is passed through, not memoized", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => 1);
    const memo = memoInvoker(inner);
    await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { n: Number.NaN }));
    await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { n: Number.NaN }));
    expect(inner.calls).toHaveLength(2);
  });
});
