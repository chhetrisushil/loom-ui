import { TypedFailure } from "@loom/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { describe, expect, it } from "vitest";
import type { TransientInvoker } from "./invoker";
import { limitInvoker, memoInvoker, signalInvoker } from "./invokers";
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

  it("two callers stamped as different executions never share one call (the identity is an authz input)", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (_input, opts) => ({ as: opts?.as }));
    const memo = memoInvoker(inner);
    const principal = { actor: "alice" };
    const [a, b] = await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), {
        principal,
        as: { workflowId: "granted-flow", executionId: "e1" },
      }),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), {
        principal,
        as: { workflowId: "denied-flow", executionId: "e2" },
      }),
    ]);
    expect(inner.calls).toHaveLength(2);
    expect(a).toMatchObject({ as: { workflowId: "granted-flow" } });
    expect(b).toMatchObject({ as: { workflowId: "denied-flow" } });
  });

  it("the same stamped identity still shares one call; only the signal is not part of the key", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ n: 1 }));
    const memo = memoInvoker(inner);
    const as = { workflowId: "f", executionId: "e1" };
    await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { as, label: "l" }),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), {
        as: { executionId: "e1", workflowId: "f" },
        label: "l",
        signal: new AbortController().signal,
      }),
    ]);
    expect(inner.calls).toHaveLength(1);
  });

  it("different labels never share: without `as` the label names the transient execution an authorizer may grant by", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (_input, opts) => ({
      label: opts?.label,
    }));
    const memo = memoInvoker(inner);
    const [a, b] = await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { label: "allowed" }),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { label: "denied" }),
    ]);
    expect(inner.calls).toHaveLength(2);
    expect(a).toEqual({ label: "allowed" });
    expect(b).toEqual({ label: "denied" });
    // conservative even when `as` names the execution: still a different key
    await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), {
        as: { workflowId: "f", executionId: "e" },
        label: "x",
      }),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), {
        as: { workflowId: "f", executionId: "e" },
        label: "y",
      }),
    ]);
    expect(inner.calls).toHaveLength(4);
  });

  it("the same identity under different principals, or different budget snapshots, never shares", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ n: 1 }));
    const memo = memoInvoker(inner);
    const as = { workflowId: "f", executionId: "e1" };
    await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { as, principal: { actor: "alice" } }),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { as, principal: { actor: "bob" } }),
    ]);
    expect(inner.calls).toHaveLength(2);
    const withSpend = (usd: number) =>
      ({ as, resources: { costUsd: usd } }) as unknown as TransientInvokeOptions;
    await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), withSpend(0)),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), withSpend(100)),
    ]);
    expect(inner.calls).toHaveLength(4);
  });

  it("any other option is part of the key too, so an input this memo does not know about never shares", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ n: 1 }));
    const memo = memoInvoker(inner);
    const opts = (v: number) => ({ futureAuthzInput: v }) as unknown as TransientInvokeOptions;
    await Promise.all([
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), opts(1)),
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), opts(2)),
    ]);
    expect(inner.calls).toHaveLength(2);
  });

  it("an option that is not plain JSON passes through, uncached", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ n: 1 }));
    const memo = memoInvoker(inner);
    const opts = { futureAuthzInput: () => 1 } as unknown as TransientInvokeOptions;
    await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), opts);
    await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), opts);
    expect(inner.calls).toHaveLength(2);
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

  it("a pre-aborted leader never calls inner, and never leaks an unhandled rejection", async () => {
    const inner = new FakeInvoker().on(
      MCP_INVOKE_TOOL_ID,
      (_input, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const memo = memoInvoker(inner);
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const ac = new AbortController();
      ac.abort();
      await expect(
        memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { signal: ac.signal })
      ).rejects.toThrow("aborted");
      expect(inner.calls).toHaveLength(0); // refused before ever reaching inner
      await flush();
      await new Promise((resolve) => setImmediate(resolve)); // give Node a full turn to detect a leak
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    expect(unhandled).toHaveLength(0);
  });

  it("a cyclic input bypasses the memo instead of throwing out of invokeTransient", async () => {
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => input);
    const memo = memoInvoker(inner);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(
      memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t", { cyclic }))
    ).resolves.toBeDefined();
    expect(inner.calls).toHaveLength(1);
  });

  it("an abort that lands the instant the upstream settles — before any .then has run — does not cancel or evict a successful entry", async () => {
    let resolveInner: ((v: unknown) => void) | undefined;
    const rawPromise = new Promise<unknown>((resolve) => {
      resolveInner = resolve;
    });
    let calls = 0;
    const rawInvoker: TransientInvoker = {
      invokeTransient<TIn = unknown, TOut = unknown>(
        _toolId: string,
        _input: TIn,
        _opts?: TransientInvokeOptions
      ): Promise<TOut> {
        calls += 1;
        return rawPromise as Promise<TOut>;
      },
    };
    const memo = memoInvoker(rawInvoker);
    const ac = new AbortController();
    const call = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { signal: ac.signal });
    resolveInner?.({ ok: true }); // settles the shared promise's internal state...
    ac.abort(); // ...before any of its `.then` callbacks — including the entry's own settlement
    // marker — has had a chance to run: the exact race this test exists to close.
    await expect(call).rejects.toThrow("aborted"); // this caller still sees its own abort
    await flush();
    const again = await memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"));
    expect(again).toEqual({ ok: true }); // served from the still-live entry, not re-fetched
    expect(calls).toBe(1);
  });

  it("a fresh caller with no signal joining the very same turn the only other caller aborts still gets the upstream value: the internal controller is never aborted", async () => {
    let resolveInner: ((v: unknown) => void) | undefined;
    let rejectInner: ((e: unknown) => void) | undefined;
    let controllerAborted = false;
    const inner = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (_input, opts) => {
      opts?.signal?.addEventListener("abort", () => {
        controllerAborted = true;
        rejectInner?.(new Error("upstream-cancelled"));
      });
      return new Promise((resolve, reject) => {
        resolveInner = resolve;
        rejectInner = reject;
      });
    });
    const memo = memoInvoker(inner);
    const ac = new AbortController();
    const leader = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { signal: ac.signal });
    ac.abort(); // drops `live` to 0 synchronously; the cancel-and-delete itself is deferred
    const joiner = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t")); // no signal — same turn
    await expect(leader).rejects.toThrow("aborted");
    expect(controllerAborted).toBe(false); // the deferred check must see the joiner and skip
    resolveInner?.({ ok: true });
    await expect(joiner).resolves.toEqual({ ok: true });
    expect(inner.calls).toHaveLength(1);
  });

  it("a leader whose call to inner throws synchronously still returns a rejected promise, not a thrown exception, and a retry calls inner again", async () => {
    let n = 0;
    const rawInvoker: TransientInvoker = {
      invokeTransient<TIn = unknown, TOut = unknown>(): Promise<TOut> {
        n += 1;
        if (n === 1) throw new Error("sync boom");
        return Promise.resolve({ ok: true } as TOut);
      },
    };
    const memo = memoInvoker(rawInvoker);
    await expect(memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"))).rejects.toThrow("sync boom");
    await expect(memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"))).resolves.toEqual({
      ok: true,
    });
    expect(n).toBe(2);
  });

  it("a caller re-entering with the same key from inside the upstream abort starts a fresh call: it never joins the dying entry", async () => {
    let n = 0;
    let reentered: Promise<unknown> | undefined;
    const memo: TransientInvoker = memoInvoker(
      new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (_input, opts) => {
        n += 1;
        if (n > 1) return { fresh: true };
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            // Synchronously, from inside the internal controller's abort.
            reentered = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"));
            reject(new Error("upstream-cancelled"));
          });
        });
      })
    );
    const ac = new AbortController();
    const first = memo.invokeTransient(MCP_INVOKE_TOOL_ID, mcp("t"), { signal: ac.signal });
    ac.abort();
    await expect(first).rejects.toThrow("aborted");
    await flush();
    expect(reentered).toBeDefined();
    await expect(reentered).resolves.toEqual({ fresh: true });
    expect(n).toBe(2);
  });

  describe("a synchronous throw from inner on a pass-through path is a rejected promise", () => {
    const throwing: TransientInvoker = {
      invokeTransient<TIn = unknown, TOut = unknown>(): Promise<TOut> {
        throw new Error("sync boom");
      },
    };
    const deep = (levels: number): unknown => {
      let v: unknown = 1;
      for (let i = 0; i < levels; i++) v = { v };
      return v;
    };
    const cases: Array<[string, string, unknown]> = [
      ["a non-MCP tool", "sandbox.run", { x: 1 }],
      ["an input that is not plain JSON", MCP_INVOKE_TOOL_ID, mcp("t", { at: new Date(0) })],
      [
        "an input canonicalJson refuses (too deep)",
        MCP_INVOKE_TOOL_ID,
        mcp("t", { d: deep(2000) }),
      ],
    ];
    for (const [what, toolId, input] of cases)
      it(what, async () => {
        const memo = memoInvoker(throwing);
        let p: Promise<unknown> | undefined;
        expect(() => {
          p = memo.invokeTransient(toolId, input);
        }).not.toThrow();
        await expect(p).rejects.toThrow("sync boom");
      });
  });
});

describe("signalInvoker", () => {
  it("aborting the bound signal aborts every in-flight call at once, and refuses new ones", async () => {
    const inner = new FakeInvoker().on("t", () => new Promise(() => {}));
    const life = new AbortController();
    const bound = signalInvoker(inner, life.signal);
    const caller = new AbortController();
    const p = bound.invokeTransient("t", {}, { signal: caller.signal });
    p.catch(() => {});
    expect(inner.calls[0]?.opts?.signal?.aborted).toBe(false);
    life.abort();
    expect(inner.calls[0]?.opts?.signal?.aborted).toBe(true); // synchronously
    await expect(bound.invokeTransient("t", {})).rejects.toThrow("aborted");
    expect(inner.calls).toHaveLength(1);
  });

  it("a caller's own abort still reaches inner, and a settled call lets go of the bound signal", async () => {
    const inner = new FakeInvoker().on("t", () => ({ ok: true }));
    const life = new AbortController();
    const bound = signalInvoker(inner, life.signal);
    await expect(bound.invokeTransient("t", {})).resolves.toEqual({ ok: true });
    life.abort();
    // The listener was removed on settle: aborting the bound signal later touches nothing.
    expect(inner.calls[0]?.opts?.signal?.aborted).toBe(false);

    const hanging = new FakeInvoker().on("t", () => new Promise(() => {}));
    const b2 = signalInvoker(hanging, new AbortController().signal);
    const caller = new AbortController();
    b2.invokeTransient("t", {}, { signal: caller.signal }).catch(() => {});
    caller.abort();
    expect(hanging.calls[0]?.opts?.signal?.aborted).toBe(true);
  });

  it("a synchronous throw from inner is a rejected promise", async () => {
    const throwing: TransientInvoker = {
      invokeTransient<TIn = unknown, TOut = unknown>(): Promise<TOut> {
        throw new Error("sync boom");
      },
    };
    const bound = signalInvoker(throwing, new AbortController().signal);
    await expect(bound.invokeTransient("t", {})).rejects.toThrow("sync boom");
  });
});
