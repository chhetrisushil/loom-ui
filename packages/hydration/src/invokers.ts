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
    // Checked before capacity: an already-aborted caller must never take a slot (or reach
    // `inner`) just because one happened to be free — that slot belongs to the next live caller.
    if (signal?.aborted === true) return Promise.reject(new Error("aborted"));
    if (active < max) {
      active += 1;
      return undefined;
    }
    return new Promise<void>((resolve, reject) => {
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

interface SharedCall {
  readonly promise: Promise<unknown>;
  /** Cancels the ONE upstream call `inner` is actually making — aborted only once every live
   * caller below has aborted; never by any single caller's own signal. */
  readonly controller: AbortController;
  /** How many callers (leader included) have not yet either aborted or seen this settle. */
  live: number;
}

/**
 * The shape `canonicalJson` actually understands — null/string/finite-number/boolean, and arrays
 * or plain objects (`Object.prototype` or `null` as the prototype) built from those, recursively.
 * `canonicalJson` does not THROW on a `Date`, `Map`, `Set` or a class instance — it silently reads
 * `Object.keys()` on it, which for most of those is `[]`, so two calls with DIFFERENT such
 * arguments would canonicalize to the same `"{}"` and collide on one memo key. Reject those before
 * a key is ever computed, not after: `memoInvoker` must never be the reason a value collapses.
 */
function isPlainJsonValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (t !== "object") return false; // function, bigint, symbol
  if (Array.isArray(value)) return value.every(isPlainJsonValue);
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isPlainJsonValue);
}

/**
 * One call per identical MCP step for this invoker's lifetime (a PASS): same tool, same resolved
 * arguments, same schema pin, same principal — the canonical JSON of `[principal, mcp.invoke's
 * input]`, so argument key order does not matter and two callers never share a result they were
 * authorized for under different principals (loom's per-call authorizer still sees every joiner,
 * since a joiner never bypasses its own `invokeTransient` — it just doesn't cause a SECOND
 * upstream call). Settled results stay (a step in a later wave is still served) and failures are
 * shared. Other effects (a sandbox reshape) always run, uncached.
 *
 * Cancellation is ref-counted, not leader-owned: `inner` is called once, through an internal
 * `AbortController` this function owns — never a caller's own signal directly — so any ONE
 * caller's abort only ever settles that caller's OWN returned promise (a race against the shared
 * promise). The upstream call itself is cancelled, and the entry forgotten, only once every live
 * caller has aborted; a caller that arrives after that finds no entry and starts a fresh call.
 */
export function memoInvoker(inner: TransientInvoker): TransientInvoker {
  const memo = new Map<string, SharedCall>();

  const onCallerAbort = (key: string, hit: SharedCall): void => {
    hit.live -= 1;
    if (hit.live > 0) return;
    hit.controller.abort();
    if (memo.get(key) === hit) memo.delete(key);
  };

  const join = <TOut>(
    key: string,
    hit: SharedCall,
    signal: AbortSignal | undefined
  ): Promise<TOut> => {
    if (signal?.aborted === true) {
      onCallerAbort(key, hit);
      return Promise.reject(new Error("aborted"));
    }
    return new Promise<TOut>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        onCallerAbort(key, hit);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      hit.promise.then(
        (v) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(v as TOut);
        },
        (e: unknown) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        }
      );
    });
  };

  return {
    invokeTransient<TIn = unknown, TOut = unknown>(
      toolId: string,
      input: TIn,
      opts?: TransientInvokeOptions
    ): Promise<TOut> {
      if (toolId !== MCP_INVOKE_TOOL_ID)
        return inner.invokeTransient<TIn, TOut>(toolId, input, opts);
      const principal = opts?.principal ?? null;
      if (!isPlainJsonValue(principal) || !isPlainJsonValue(input))
        return inner.invokeTransient<TIn, TOut>(toolId, input, opts);
      let key: string;
      try {
        key = canonicalJson([principal, input]);
      } catch {
        return inner.invokeTransient<TIn, TOut>(toolId, input, opts);
      }
      const hit = memo.get(key);
      if (hit !== undefined) {
        hit.live += 1;
        return join<TOut>(key, hit, opts?.signal);
      }
      const controller = new AbortController();
      const promise = inner.invokeTransient<TIn, TOut>(toolId, input, {
        ...opts,
        signal: controller.signal,
      });
      const entry: SharedCall = { promise, controller, live: 1 };
      memo.set(key, entry);
      return join<TOut>(key, entry, opts?.signal);
    },
  };
}
