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

  it("an aborted queued call leaves the queue and never reaches inner; its freed slot still reaches the next caller", async () => {
    const release: Array<() => void> = [];
    const inner = new FakeInvoker().on(
      "t",
      () => new Promise((resolve) => release.push(() => resolve("ok")))
    );
    const limited = limitInvoker(inner, 1);
    const first = limited.invokeTransient("t", {}); // takes the only slot
    const ac = new AbortController();
    const queued = limited.invokeTransient("t", {}, { signal: ac.signal }); // queued behind the cap
    ac.abort();
    await expect(queued).rejects.toThrow("aborted");
    release.shift()?.(); // free the first call's slot
    await first;
    const third = limited.invokeTransient("t", {}); // must get in: the slot wasn't leaked to the dead queue entry
    release.shift()?.();
    await expect(third).resolves.toBe("ok");
    expect(inner.calls).toHaveLength(2); // first + third only — the aborted queued call never reached inner
  });

  it("refuses an already-aborted signal before ever taking a slot", async () => {
    const inner = new FakeInvoker().on("t", () => "ok");
    const limited = limitInvoker(inner, 1);
    const ac = new AbortController();
    ac.abort();
    await expect(limited.invokeTransient("t", {}, { signal: ac.signal })).rejects.toThrow(
      "aborted"
    );
    expect(inner.calls).toHaveLength(0); // refused before reaching inner, not just refused by inner
    // the slot was never taken: a normal call right after still gets in immediately
    await expect(limited.invokeTransient("t", {})).resolves.toBe("ok");
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

  it("two callers with different principals never share one call, and each reaches inner with its own", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input, opts) => ({
      input,
      principal: opts?.principal,
    }));
    const memo = memoInvoker(inner);
    const [a, b] = await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { principal: { actor: "alice" } }),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { principal: { actor: "bob" } }),
    ]);
    expect(inner.calls).toHaveLength(2);
    expect(a).toMatchObject({ principal: { actor: "alice" } });
    expect(b).toMatchObject({ principal: { actor: "bob" } });
  });

  it("nested-object and array key order do not affect the memo key", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ n: 1 }));
    const memo = memoInvoker(inner);
    await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { a: { x: 1, y: 2 }, list: [1, 2] })),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { list: [1, 2], a: { y: 2, x: 1 } })),
    ]);
    expect(inner.calls).toHaveLength(1);
  });

  it("an explicit undefined field and an absent field share a call, as JSON semantics treat them alike", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ n: 1 }));
    const memo = memoInvoker(inner);
    await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { a: 1, b: undefined })),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { a: 1 })),
    ]);
    expect(inner.calls).toHaveLength(1);
  });

  it("a leader's own abort does not cancel a shared call while another caller is still live: one upstream call, the joiner gets the value", async () => {
    let resolveInner: ((v: unknown) => void) | undefined;
    let innerSignalAborted = false;
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (_input, opts) => {
      opts?.signal?.addEventListener("abort", () => {
        innerSignalAborted = true;
      });
      return new Promise((resolve) => {
        resolveInner = resolve;
      });
    });
    const memo = memoInvoker(inner);
    const leader = new AbortController();
    const first = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { signal: leader.signal });
    const second = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"));
    leader.abort();
    await expect(first).rejects.toThrow("aborted");
    expect(innerSignalAborted).toBe(false); // a live joiner is still holding the shared call up
    resolveInner?.({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(inner.calls).toHaveLength(1);
  });

  it("a joiner's own abort rejects only that joiner; the leader still gets the value from the one shared call", async () => {
    let resolveInner: ((v: unknown) => void) | undefined;
    const inner = new FakeInvoker().on(
      MCP_INVOKE_TOOL_ID,
      () =>
        new Promise((resolve) => {
          resolveInner = resolve;
        })
    );
    const memo = memoInvoker(inner);
    const first = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"));
    const joiner = new AbortController();
    const second = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { signal: joiner.signal });
    joiner.abort();
    await expect(second).rejects.toThrow("aborted");
    resolveInner?.({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
    expect(inner.calls).toHaveLength(1);
  });

  it("once every caller of a shared call has aborted, the internal call is cancelled and the memo forgets it", async () => {
    let n = 0;
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (_input, opts) => {
      n += 1;
      if (n === 1)
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      return { fresh: true };
    });
    const memo = memoInvoker(inner);
    const leader = new AbortController();
    const joiner = new AbortController();
    const first = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { signal: leader.signal });
    const second = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { signal: joiner.signal });
    leader.abort();
    joiner.abort();
    await expect(first).rejects.toThrow("aborted");
    await expect(second).rejects.toThrow("aborted");
    await flush();
    expect(inner.calls).toHaveLength(1); // no extra call yet: the entry was only just cancelled
    const third = await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"));
    expect(third).toEqual({ fresh: true });
    expect(inner.calls).toHaveLength(2); // a fresh upstream call — the dead entry was not reused
  });

  it("an input canonicalJson cannot represent is passed through, not memoized", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => 1);
    const memo = memoInvoker(inner);
    await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { n: Number.NaN }));
    await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { n: Number.NaN }));
    expect(inner.calls).toHaveLength(2);
  });

  it("an input containing a Date/Map/Set/class instance bypasses the memo entirely: canonicalJson would silently collapse it to '{}'", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => input);
    const memo = memoInvoker(inner);
    await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { when: new Date(2020, 0, 1) }));
    await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { when: new Date(2021, 0, 1) }));
    expect(inner.calls).toHaveLength(2);
  });
});
