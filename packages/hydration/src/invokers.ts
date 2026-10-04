import { canonicalJson } from "@loom/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import type { TransientInvoker } from "./invoker";

// ── Invoker wrappers: a call cap, an owner's lifetime signal, an in-pass step memo ─
// All are TransientInvokers wrapping a TransientInvoker, so they compose with each other and
// with loom's EffectRuntime without either knowing the other exists. The in-process controller
// builds ONE `limitInvoker` (the cap is controller-wide: it bounds every call it makes), ONE
// `signalInvoker` over it bound to its own lifetime (so `dispose` cancels every upstream call at
// once), and one `memoInvoker` PER PASS in front of both (a memo hit takes no slot). The split
// server (`serveHandles`, split.ts) composes a memo over a cap the same way, once per batch.
// None ever returns a promise it did not get from the inner invoker except to wait for a slot,
// so they add no settle latency on a free slot.

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

/** `call()`, with a synchronous throw turned into the rejected promise the contract promises. */
function callSafely<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * Every call through this invoker is ALSO cancelled, synchronously, when `signal` aborts — the
 * owner's lifetime (a controller's `dispose`), independent of any caller's own signal, which still
 * reaches `inner` too. Once `signal` has aborted, new calls reject `"aborted"` without reaching
 * `inner`. Leak-free on a long-lived `signal`: a call holds its listener only until it settles.
 */
export function signalInvoker(inner: TransientInvoker, signal: AbortSignal): TransientInvoker {
  return {
    invokeTransient<TIn = unknown, TOut = unknown>(
      toolId: string,
      input: TIn,
      opts?: TransientInvokeOptions
    ): Promise<TOut> {
      const own = opts?.signal;
      if (signal.aborted || own?.aborted === true) return Promise.reject(new Error("aborted"));
      const ac = new AbortController();
      const abort = (): void => ac.abort();
      signal.addEventListener("abort", abort, { once: true });
      own?.addEventListener("abort", abort, { once: true });
      const release = (): void => {
        signal.removeEventListener("abort", abort);
        own?.removeEventListener("abort", abort);
      };
      const p = callSafely(() =>
        inner.invokeTransient<TIn, TOut>(toolId, input, { ...opts, signal: ac.signal })
      );
      p.then(release, release);
      return p;
    },
  };
}

interface SharedCall {
  readonly promise: Promise<unknown>;
  /** Cancels the ONE upstream call `inner` is actually making — aborted only once every live
   * caller below has aborted; never by any single caller's own signal. */
  readonly controller: AbortController;
  /**
   * How many callers (leader included) have not yet aborted. Never decremented on a normal
   * settle — once the shared call settles, `live` stops mattering: a settled entry (see
   * `settled` below) is kept for the rest of the pass no matter what `live` says. This field
   * exists solely to answer one question — has the LAST live caller just aborted? — which is
   * the only time the still-in-flight upstream call should be cancelled.
   */
  live: number;
  /**
   * Set once, from a handler attached at entry-creation time (so it runs before any caller
   * added later), the instant `promise` settles — success or failure alike. Guards
   * `onCallerAbort`: an abort landing after the upstream has already settled, but before that
   * settlement handler has actually RUN (a real race — `resolve()`/`reject()` marks a promise
   * settled synchronously, while every `.then` callback, this one included, only runs on a later
   * microtask), must never cancel or evict a call whose result already exists.
   */
  settled: boolean;
}

/**
 * The shape `canonicalJson` actually understands — null/string/finite-number/boolean, and arrays
 * or plain objects (`Object.prototype` or `null` as the prototype) built from those, recursively.
 * `canonicalJson` does not THROW on a `Date`, `Map`, `Set` or a class instance — it silently reads
 * `Object.keys()` on it, which for most of those is `[]`, so two calls with DIFFERENT such
 * arguments would canonicalize to the same `"{}"` and collide on one memo key. Reject those before
 * a key is ever computed, not after: `memoInvoker` must never be the reason a value collapses.
 *
 * `seen` makes this cycle-safe: a hostile or accidental circular reference is walked at most once
 * per object (the second visit reports "not plain" rather than recursing forever), so a cyclic
 * argument bypasses the memo instead of throwing `RangeError: Maximum call stack size exceeded`
 * out of `invokeTransient`. Sharing one `seen` set across a whole call's plainness check is
 * deliberately conservative: a repeated (non-cyclic) reference is also flagged "not plain" and
 * bypasses sharing rather than being memoized — safe, since bypass just means no caching, never a
 * wrong answer.
 */
function isPlainJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || value === undefined) return true;
  const t = typeof value;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(value as number);
  if (t !== "object") return false; // function, bigint, symbol
  const obj = value as object;
  if (seen.has(obj)) return false;
  seen.add(obj);
  if (Array.isArray(value)) return value.every((v) => isPlainJsonValue(v, seen));
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every((v) => isPlainJsonValue(v, seen));
}

/**
 * One call per identical MCP step for this invoker's lifetime (a PASS): same tool, same resolved
 * arguments, same schema pin, same call options — the canonical JSON of `[principal, every other
 * option except signal and label, mcp.invoke's input]`, so key order does not matter. A joiner is
 * served straight from the shared promise — it never calls `inner` itself, so it never passes
 * through whatever per-call authorizer `inner` enforces. That is safe ONLY because every
 * authorization input is part of the key: the principal, and also the stamped execution identity
 * (`as` — an authorizer may grant by workflow) and anything else in the options. Every joiner
 * sharing one entry was, by construction, asking with the exact inputs the leader's own (sole)
 * call to `inner` was authorized for; an option that is not plain JSON passes through, uncached. Settled results stay (a step in a later wave is still
 * served) and failures are shared. Other effects (a sandbox reshape) always run, uncached.
 *
 * Cancellation is ref-counted, not leader-owned: `inner` is called once, through an internal
 * `AbortController` this function owns — never a caller's own signal directly — so any ONE
 * caller's abort only ever settles that caller's OWN returned promise (a race against the shared
 * promise). The upstream call itself is cancelled, and the entry forgotten, only once every live
 * caller has aborted AND the call had not already settled; a caller that arrives after a real
 * cancellation finds no entry and starts a fresh call.
 */
export function memoInvoker(inner: TransientInvoker): TransientInvoker {
  const memo = new Map<string, SharedCall>();

  const onCallerAbort = (key: string, hit: SharedCall): void => {
    hit.live -= 1;
    if (hit.live > 0) return;
    // Deferred one microtask: `hit.settled` is set by a handler attached at entry-creation time,
    // which — because it was attached first — runs before this check for any settlement the memo
    // can observe, even when the abort lands in the very same synchronous turn as `hit.promise`
    // settling. Checking `hit.settled` synchronously right here would miss exactly that race.
    // "The memo can observe" is `hit.promise` — `inner`'s promise — not the raw upstream: behind
    // a queued `limitInvoker` (or any wrapper that settles a few hops after its own inner call),
    // an all-abort landing after the RAW upstream settled but before `hit.promise` does still
    // cancels and evicts, so a later caller re-fetches. A wasted call, never a wrong answer.
    //
    // Both conditions below are RE-READ at that later point, not captured now, because either can
    // change in the gap between "live just dropped to 0" and "the microtask actually runs": a
    // fresh caller with no signal of its own can join in the very same synchronous turn (bumping
    // `live` back above 0 before this ever executes), and the upstream can settle in that same
    // window (flipping `settled` true). A snapshot taken at decrement time would race both ways —
    // this is why the check happens here, once, right before the one place that acts on it.
    //
    // Invariant: the controller is aborted, and the entry deleted, AT MOST ONCE per entry — and
    // only when, at the moment this specific check runs, `settled` is still false AND `live` is
    // still <= 0 (no one re-joined). Either condition failing means someone still needs this call
    // to keep going (or already has its answer), so it is left alone.
    queueMicrotask(() => {
      if (hit.settled || hit.live > 0) return;
      // Forget the entry BEFORE aborting: `abort()` runs `inner`'s listeners synchronously, and a
      // caller re-entering with the same key from one of them must start a fresh call, not join
      // this dying one.
      if (memo.get(key) === hit) memo.delete(key);
      hit.controller.abort();
    });
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
      // Every pass-through is guarded like the leader's call: a synchronous throw from `inner`
      // must come back as a rejected promise, never escape `invokeTransient`.
      const passThrough = (): Promise<TOut> =>
        callSafely(() => inner.invokeTransient<TIn, TOut>(toolId, input, opts));
      if (toolId !== MCP_INVOKE_TOOL_ID) return passThrough();
      // Everything in `opts` except the two fields that cannot change the answer (`signal`,
      // `label`) is part of the key: the principal, the stamped identity (`as`, which an
      // authorizer may key grants on), the budget snapshot, and any option added later. Keying
      // on the remainder rather than a list of known fields is what keeps a joiner from being
      // served a result authorized for a different input this function has never heard of.
      const { signal: _signal, label: _label, principal = null, ...rest } = opts ?? {};
      let key: string;
      try {
        const seen = new WeakSet<object>();
        if (
          !isPlainJsonValue(principal, seen) ||
          !isPlainJsonValue(rest, seen) ||
          !isPlainJsonValue(input, seen)
        )
          return passThrough();
        key = canonicalJson([principal, rest, input]);
      } catch {
        return passThrough();
      }
      const hit = memo.get(key);
      if (hit !== undefined) {
        hit.live += 1;
        return join<TOut>(key, hit, opts?.signal);
      }
      // Mirrors limitInvoker's fast path: an already-aborted caller must never become the leader
      // — that would call `inner`, create an entry nobody asked to keep, and (since nothing here
      // would yet be subscribed to the resulting promise) risk an unhandled rejection.
      if (opts?.signal?.aborted === true) return Promise.reject(new Error("aborted"));
      const controller = new AbortController();
      let promise: Promise<TOut>;
      try {
        // `inner.invokeTransient` is typed to return a Promise, but a misbehaving implementation
        // can still throw synchronously; the interface contract (and every caller of THIS
        // function) requires a rejected promise instead, never a thrown exception. No entry is
        // created for a call that never actually started.
        promise = inner.invokeTransient<TIn, TOut>(toolId, input, {
          ...opts,
          signal: controller.signal,
        });
      } catch (e) {
        return Promise.reject(e);
      }
      const entry: SharedCall = { promise, controller, live: 1, settled: false };
      const onSettle = (): void => {
        entry.settled = true;
      };
      // Attached at entry-creation time — before any joiner's own `.then` — so `entry.settled`
      // is set before `onCallerAbort`'s deferred check can run (see there). Also the
      // backstop: attaching a rejection handler here means NO path can ever leave `promise`
      // unhandled, even if a future caller subscribes late or never at all.
      promise.then(onSettle, onSettle);
      memo.set(key, entry);
      return join<TOut>(key, entry, opts?.signal);
    },
  };
}
