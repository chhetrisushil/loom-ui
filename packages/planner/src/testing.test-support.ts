import {
  type Experience,
  type Intent,
  type SemanticCatalog,
  defineSemanticCatalog,
} from "@loom-ui/core";
import { tainted } from "@loom/classify";
import type {
  CapabilityRef,
  DecideContext,
  DecideOptionsLike,
  DecideScope,
  PlannerDelta,
  PlannerDeltaSink,
  PlannerModel,
  PlannerUsage,
} from "./spi";

export const planningCatalog: SemanticCatalog = defineSemanticCatalog({
  id: "test.planning.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: { web: { kind: "MetricCard" }, terminal: { kind: "MetricCard" } },
    },
    {
      name: "Collection",
      version: "1.0.0",
      props: ["columns"],
      binding: "required",
      // The ONLY entry here that lets a planner propose a confidentiality class; every other
      // entry leaves `sensitivity` absent, which means the documented default "caller".
      sensitivity: "model-may-set",
      surfaces: { web: { kind: "DataTable" }, terminal: { kind: "DataTable" } },
    },
    {
      name: "Insight",
      version: "1.0.0",
      props: ["tone"],
      binding: "none",
      // Unbound content has no legitimate builtin kind to resolve to: every one of loom's eight
      // built-ins (incl. StreamingText) hard-requires a binding, so a kind OUTSIDE the base
      // catalogue is the only way to declare a `binding: "none"` surface resolution — with its
      // own explicit contract (ADR 0088 D2).
      surfaces: {
        web: { kind: "Insight", props: ["tone"], binding: "none" },
        terminal: { kind: "Insight", props: ["tone"], binding: "none" },
      },
    },
    {
      name: "Status",
      version: "1.0.0",
      props: [],
      binding: "optional",
      surfaces: { web: { kind: "StatusBadge" }, terminal: { kind: "StatusBadge" } },
    },
  ],
});

export const capabilitiesFixture: CapabilityRef[] = [
  {
    handle: "orders_summary",
    toolName: "orders.summary",
    toolVersion: "2.1.0",
    toolSchemaHash: "sha256:orders-summary-2-1",
    description: "Order totals for a window",
    inputSchema: { type: "object", properties: { window: { type: "string" } } },
    sampleOutput: {
      window: "7d",
      totals: { count: 412, revenueCents: 1_234_500 },
      rows: [{ sku: "A1", units: 5 }],
    },
  },
  {
    handle: "incidents_open",
    toolName: "incidents.list",
    toolVersion: "1.0.0",
    toolSchemaHash: "sha256:incidents-list-1-0",
    description: "Open incidents",
    // NO sampleOutput on purpose — the planner must refuse to bind to it.
  },
];

export const intentFixture: Intent = {
  objective: "Show weekly order volume and the top SKUs",
  source: "user",
};
export const metaFixture: Experience["meta"] = {
  author: "test",
  createdAt: "2026-09-22T00:00:00Z",
  sourceKind: "test",
};

/** Replies in order; repeats the last one when exhausted. Counts calls. Reports `usage` on every reply when given. */
export function scriptedModel(
  responses: readonly string[],
  usage?: PlannerUsage
): PlannerModel & { calls: number } {
  const model = {
    calls: 0,
    async complete() {
      const i = Math.min(model.calls, responses.length - 1);
      model.calls += 1;
      return {
        content: responses[i] as string,
        ...(usage !== undefined && { usage: { ...usage } }),
      };
    },
  };
  return model;
}

/** Records the first decider result per id; serves it on every later call without running the decider. */
export function recordingContext(scope?: DecideScope): DecideContext & {
  decisions: Map<string, unknown>;
  opts: Map<string, DecideOptionsLike | undefined>;
  deciderCalls: number;
} {
  const ctx = {
    decisions: new Map<string, unknown>(),
    opts: new Map<string, DecideOptionsLike | undefined>(),
    deciderCalls: 0,
    async decide<T>(
      id: string,
      decider: (scope: DecideScope) => T | Promise<T>,
      opts?: DecideOptionsLike
    ): Promise<T> {
      if (ctx.decisions.has(id)) return ctx.decisions.get(id) as T;
      ctx.deciderCalls += 1;
      const value = await decider(scope ?? noScope);
      // Loom persists the choice as JSON — round-trip it so a non-serialisable value fails HERE.
      // The FIRST call returns the raw decider result (as loom's real ctx.decide does when it
      // actually runs the decider); only a cache hit (replay) returns the persisted JSON value.
      // Otherwise a caller whose value carries `undefined`-valued keys can never observe the
      // difference between "what the decider returned" and "what got persisted".
      const stored = JSON.parse(JSON.stringify(value)) as T;
      ctx.decisions.set(id, stored);
      ctx.opts.set(id, opts);
      return value;
    },
  };
  return ctx;
}

/** A scope for contexts that never expect the decider to call through it: any call is a test bug. */
const noScope: DecideScope = {
  invokeTransient: () => Promise.reject(new Error("this test context hands the decider no scope")),
};

export interface ScopeCall {
  readonly toolId: string;
  readonly input: unknown;
  readonly signal?: AbortSignal;
  /** The deciding execution this call was stamped as (a stand-in for loom's `as`). */
  readonly identity: string;
}

/**
 * A scope that stamps every call with `identity`, as loom's real `ctx.decide` scope stamps the
 * deciding execution's workflowId/executionId, and records it. `handler` answers the call.
 */
export function stampingScope(
  identity: string,
  handler: (toolId: string, input: unknown) => unknown | Promise<unknown>
): DecideScope & { calls: ScopeCall[] } {
  const scope = {
    calls: [] as ScopeCall[],
    async invokeTransient<TIn, TOut>(
      toolId: string,
      input: TIn,
      opts?: { readonly signal?: AbortSignal; readonly onDelta?: PlannerDeltaSink }
    ): Promise<TOut> {
      scope.calls.push({
        toolId,
        input,
        identity,
        ...(opts?.signal !== undefined && { signal: opts.signal }),
      });
      return (await handler(toolId, input)) as TOut;
    },
  };
  return scope;
}

/** A tainted live delta, as loom's runtime hands one to a sink (ADR 0119). */
export const textDelta = (text: string): PlannerDelta => ({
  delta: tainted(text, "llm:llm.complete"),
});

/**
 * A model that replies like {@link scriptedModel} and, when handed `onDelta`, ALSO streams the
 * same reply to it in `size`-char tainted chunks (then a terminal `done`) before returning it.
 */
export function streamingScriptedModel(
  responses: readonly string[],
  size = 13
): PlannerModel & { calls: number; deltaCalls: number } {
  const model = {
    calls: 0,
    deltaCalls: 0,
    plainCalls: 0,
    async complete(
      _req: unknown,
      opts?: { readonly signal?: AbortSignal; readonly onDelta?: PlannerDeltaSink }
    ) {
      // Two scripts walk independently (the whole-reply calls and the streamed ones), so a
      // streamed compose is handed the same reply the plain compose got.
      const streamed = opts?.onDelta !== undefined;
      const i = Math.min(streamed ? model.deltaCalls : model.plainCalls, responses.length - 1);
      model.calls += 1;
      if (streamed) model.deltaCalls += 1;
      else model.plainCalls += 1;
      const text = responses[i] as string;
      if (opts?.onDelta !== undefined) {
        for (let at = 0; at < text.length; at += size) {
          if (opts.signal?.aborted) break;
          await Promise.resolve();
          opts.onDelta(textDelta(text.slice(at, at + size)));
        }
        opts.onDelta({ ...textDelta(""), done: true });
      }
      return { content: text };
    },
  };
  return model;
}
