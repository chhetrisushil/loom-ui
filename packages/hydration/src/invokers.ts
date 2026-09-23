import { canonicalJson } from "@loom/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import type { TransientInvoker } from "./invoker";

// ── Invoker wrappers: a call cap and an in-pass step memo ─────────────────────
// Both are TransientInvokers wrapping a TransientInvoker, so they compose with each other and
// with loom's EffectRuntime without either knowing the other exists. The in-process controller
// builds ONE `limitInvoker` (the cap is controller-wide: it bounds every call it makes) and one
// `memoInvoker` PER PASS in front of it (a memo hit takes no slot). A server hydrating several
// handles per request composes them the same way. Neither ever returns a promise it did not get
// from the inner invoker except to wait for a slot, so they add no settle latency on a free slot.

/**
 * At most `max` calls in flight through this invoker, across every caller. A queued call whose
 * signal aborts leaves the queue and rejects `"aborted"` without ever reaching `inner`. FIFO: a
 * finished call hands its slot straight to the oldest waiter.
 */
export function limitInvoker(inner: TransientInvoker, max: number): TransientInvoker {
  if (!Number.isInteger(max) || max < 1)
    throw new RangeError(`limitInvoker: the cap must be a positive integer, got ${String(max)}`);
  let active = 0;
  // Insertion-ordered: the first entry is the oldest waiter; add/delete are O(1).
  const waiting = new Set<() => void>();
  const release = (): void => {
    const next = waiting.values().next();
    if (next.done === true) {
      active -= 1;
      return;
    }
    waiting.delete(next.value);
    next.value(); // the slot passes to the waiter: `active` is unchanged
  };
  const acquire = (signal: AbortSignal | undefined): Promise<void> | undefined => {
    if (active < max) {
      active += 1;
      return undefined;
    }
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error("aborted"));
        return;
      }
      const onAbort = (): void => {
        waiting.delete(grant);
        reject(new Error("aborted"));
      };
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      waiting.add(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
  const run = <TOut>(call: () => Promise<TOut>): Promise<TOut> => {
    let p: Promise<TOut>;
    try {
      p = call();
    } catch (e) {
      release();
      return Promise.reject(e);
    }
    p.then(release, release);
    return p;
  };
  return {
    invokeTransient<TIn = unknown, TOut = unknown>(
      toolId: string,
      input: TIn,
      opts?: TransientInvokeOptions
    ): Promise<TOut> {
      const call = (): Promise<TOut> => inner.invokeTransient<TIn, TOut>(toolId, input, opts);
      const slot = acquire(opts?.signal);
      return slot === undefined ? run(call) : slot.then(() => run(call));
    },
  };
}

interface MemoEntry {
  readonly promise: Promise<unknown>;
  readonly signal: AbortSignal | undefined;
}

/**
 * One call per identical MCP step for this invoker's lifetime (a PASS): same tool, same resolved
 * arguments, same schema pin — the canonical JSON of `mcp.invoke`'s input, so argument key order
 * does not matter. Settled results stay (a step in a later wave is still served), failures are
 * shared, and a joiner whose LEADER was aborted asks again for itself instead of inheriting a
 * cancellation it never asked for. Other effects (a sandbox reshape) always run. One memo must
 * never span principals: a result is only as shareable as the caller that fetched it.
 */
export function memoInvoker(inner: TransientInvoker): TransientInvoker {
  const memo = new Map<string, MemoEntry>();
  return {
    invokeTransient<TIn = unknown, TOut = unknown>(
      toolId: string,
      input: TIn,
      opts?: TransientInvokeOptions
    ): Promise<TOut> {
      if (toolId !== MCP_INVOKE_TOOL_ID)
        return inner.invokeTransient<TIn, TOut>(toolId, input, opts);
      let key: string;
      try {
        key = canonicalJson(input);
      } catch {
        return inner.invokeTransient<TIn, TOut>(toolId, input, opts);
      }
      const hit = memo.get(key);
      if (hit !== undefined)
        return (hit.promise as Promise<TOut>).catch((e: unknown) => {
          if (hit.signal?.aborted === true && opts?.signal?.aborted !== true)
            return inner.invokeTransient<TIn, TOut>(toolId, input, opts);
          throw e;
        });
      const promise = inner.invokeTransient<TIn, TOut>(toolId, input, opts);
      const entry: MemoEntry = { promise, signal: opts?.signal };
      memo.set(key, entry);
      // A cancelled leader's entry is useless to the next caller: forget it (the joiners above
      // already re-ask). This handler also keeps the memo's own copy from ever being unhandled.
      promise.catch(() => {
        if (entry.signal?.aborted === true && memo.get(key) === entry) memo.delete(key);
      });
      return promise;
    },
  };
}
