import type { MCPToolNode, ProviderSpec } from "@loom-ui/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import type { TransientInvoker } from "./invoker";

export type Handler = (
  input: unknown,
  opts: TransientInvokeOptions | undefined
) => unknown | Promise<unknown>;

/** Records every call; dispatches by toolId; a handler may throw (e.g. a TypedFailure). */
export class FakeInvoker implements TransientInvoker {
  readonly calls: Array<{
    toolId: string;
    input: unknown;
    opts: TransientInvokeOptions | undefined;
  }> = [];
  private readonly handlers = new Map<string, Handler>();
  on(toolId: string, handler: Handler): this {
    this.handlers.set(toolId, handler);
    return this;
  }
  async invokeTransient<TIn, TOut>(
    toolId: string,
    input: TIn,
    opts?: TransientInvokeOptions
  ): Promise<TOut> {
    this.calls.push({ toolId, input, opts });
    if (opts?.signal?.aborted) throw new Error("aborted");
    const h = this.handlers.get(toolId);
    if (!h) throw new Error(`no fake handler for ${toolId}`);
    return (await h(input, opts)) as TOut;
  }
}

/** Deterministic clock + timer queue. `advance(ms)` fires timers due by then, in order. */
export class ManualClock {
  private t = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;
  now = (): number => this.t;
  setTimer = (fn: () => void, ms: number): (() => void) => {
    const id = this.nextId++;
    this.timers.push({ at: this.t + ms, fn, id });
    return () => {
      this.timers = this.timers.filter((x) => x.id !== id);
    };
  };
  advance(ms: number): void {
    const until = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due.id);
      this.t = due.at;
      due.fn();
    }
    this.t = until;
  }
}

export const mcpStep = (
  stepId: string,
  toolName: string,
  args: Record<string, unknown> = {},
  dependsOn: string[] = []
): MCPToolNode => ({
  stepId,
  toolName,
  toolVersion: "1",
  toolSchemaHash: `schema-${toolName}`,
  arguments: args,
  dependsOn,
  idempotent: true,
});

export const providerSpec = (
  handle: string,
  steps: MCPToolNode[],
  over: Partial<ProviderSpec> = {}
): ProviderSpec => ({
  handle,
  executionGraph: steps,
  reshaping: { engine: "JSONPath", scriptRef: "" },
  outputShapeHash: "",
  cachePolicy: { ttlSeconds: 60, scope: "global" },
  ...over,
});

/**
 * Settle every pending promise callback: one macrotask turn runs only after the microtask queue
 * is empty, so the number of promise hops between a call and its publish (wrappers, the
 * scheduler) can never make a test flaky. Timers stay manual (`ManualClock`); this is not one.
 */
export const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};
