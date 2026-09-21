import type { TransientInvokeOptions } from "@loom/effect-runtime";

/**
 * The one thing hydration needs from loom's runtime: a one-shot, non-durable effect call.
 * `EffectRuntime` satisfies this structurally (ADR 0066 `invokeTransient`); tests use a fake.
 * Keeping it an interface is what makes the read path provably log-free — there is no `ctx`.
 */
export interface TransientInvoker {
  invokeTransient<TIn = unknown, TOut = unknown>(
    toolId: string,
    input: TIn,
    opts?: TransientInvokeOptions
  ): Promise<TOut>;
}
