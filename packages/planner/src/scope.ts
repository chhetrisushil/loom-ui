import type { TransientInvoker } from "@loom-ui/hydration/client";
import type { DecideScope } from "./spi";

/**
 * Adapts the {@link DecideScope} a `ctx.decide` decider receives to loom-ui's `TransientInvoker`,
 * so everything written against that interface — the planner's own effect calls and the
 * `limitInvoker` / `signalInvoker` / `memoInvoker` wrappers — runs as the deciding execution
 * unchanged. Wrap the result: `memoInvoker(limitInvoker(scopeInvoker(scope), 4))`. A memo above
 * this adapter keys on everything but `signal` and the identity is fixed by the scope, so a
 * memo built per decider (the scope's lifetime) never serves a result across executions; do
 * not share one memo across scopes.
 *
 * Only `signal` is forwarded. The scope IS the identity, so options that would choose one —
 * `principal`, `as`, `resources` — are REFUSED (a rejected promise — the `TransientInvoker` contract is never a synchronous throw — and never a silent drop): a call that
 * believes it runs as someone else must not quietly run as the deciding execution instead.
 * `label` is a trace tag and is ignored.
 */
export function scopeInvoker(scope: DecideScope): TransientInvoker {
  return {
    invokeTransient<TIn = unknown, TOut = unknown>(
      toolId: string,
      input: TIn,
      opts?: {
        readonly signal?: AbortSignal;
        readonly label?: string;
        readonly principal?: unknown;
        readonly as?: unknown;
        readonly resources?: unknown;
      }
    ): Promise<TOut> {
      if (opts !== undefined) {
        for (const k of ["principal", "as", "resources"] as const)
          if (opts[k] !== undefined)
            return Promise.reject(
              new TypeError(
                `scopeInvoker: option "${k}" is fixed by the decide scope (the deciding execution) and cannot be overridden`
              )
            );
      }
      return scope.invokeTransient<TIn, TOut>(
        toolId,
        input,
        opts?.signal === undefined ? undefined : { signal: opts.signal }
      );
    },
  };
}
