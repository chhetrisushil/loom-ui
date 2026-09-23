import {
  type ContainerNode,
  type Experience,
  type MCPToolNode,
  type ProviderSpec,
  type SemanticNode,
  genesis,
} from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationCache } from "./cache";
import { type ControllerOptions, type DriftReport, HydrationController } from "./controller";
import { DEFAULT_TIME_RANGE } from "./params";
import { HydrationStore } from "./projection";
import { defineReshapers } from "./reshape";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

type McpIn = { toolName: string; args: Record<string, unknown>; expectedSchemaHash: string };
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const meta = { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" };

const node = (id: string, handle: string, priority: "P0" | "P1" | "P2" = "P0"): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  binding: { handle, priority },
});
const expWith = (nodes: SemanticNode[], providers: Record<string, ProviderSpec>): Experience => {
  const g = genesis({ experienceId: "exp-1", intent: { objective: "x", source: "user" }, meta });
  return {
    ...g,
    versionHash: "sha256:v1",
    root: { ...(g.root as ContainerNode), children: nodes },
    providers,
  };
};
/** A step reading one station over a window; all three arguments are overridable. */
const ranged = (tool: string, extra: Partial<MCPToolNode> = {}): MCPToolNode => ({
  ...mcpStep("s", tool, { from: "$now-1h", to: "$now", station: "ridge" }),
  overridable: ["from", "to", "station"],
  ...extra,
});
const echo = (input: unknown): unknown => (input as McpIn).args;
const argsOf = (inv: FakeInvoker) => inv.calls.map((c) => (c.input as McpIn).args);

function rig(handler: (input: unknown) => unknown, over: Partial<ControllerOptions> = {}) {
  const clock = new ManualClock();
  clock.advance(NOW);
  const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
  const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, handler);
  const drifts: DriftReport[] = [];
  const ctl = new HydrationController({
    invoker: inv,
    store,
    clock: clock.now,
    setTimer: clock.setTimer,
    onDrift: (r) => drifts.push(r),
    ...over,
  });
  return { clock, store, inv, ctl, drifts };
}

describe("HydrationController params", () => {
  it("time tokens resolve against the injected clock; defaultParams fill overridable arguments", async () => {
    const { inv, ctl, store } = rig(echo, { defaultParams: DEFAULT_TIME_RANGE });
    ctl.load(expWith([node("a", "h")], { h: providerSpec("h", [ranged("temps")]) }));
    await flush();
    expect(argsOf(inv)).toEqual([
      { from: "2026-09-22T12:00:00.000Z", to: "2026-09-23T12:00:00.000Z", station: "ridge" },
    ]);
    expect(store.status("h")?.state).toBe("ready");
  });

  it("setParams reloads only the handles whose declared params changed", async () => {
    const { inv, ctl, store } = rig(echo);
    ctl.load(
      expWith([node("a", "h"), node("b", "fixed")], {
        h: providerSpec("h", [ranged("temps")]),
        fixed: providerSpec("fixed", [mcpStep("s", "static", { station: "ridge" })]),
      })
    );
    await flush();
    expect(inv.calls).toHaveLength(2);
    expect(ctl.setParams({ station: "harbour" }).findings).toEqual([]);
    await flush();
    expect(inv.calls).toHaveLength(3);
    expect(argsOf(inv)[2]).toEqual({
      from: "2026-09-23T11:00:00.000Z",
      to: "2026-09-23T12:00:00.000Z",
      station: "harbour",
    });
    expect(store.value("h")).toMatchObject({ station: "harbour" });
  });

  it("a handle-scoped param reaches only that handle", async () => {
    const { inv, ctl } = rig(echo);
    ctl.load(
      expWith([node("a", "h1"), node("b", "h2")], {
        h1: providerSpec("h1", [ranged("t1")]),
        h2: providerSpec("h2", [ranged("t2")]),
      })
    );
    await flush();
    ctl.setParams({ station: "harbour" }, { handle: "h2" });
    await flush();
    expect(inv.calls).toHaveLength(3);
    expect((inv.calls[2]?.input as McpIn).toolName).toBe("t2");
    expect(argsOf(inv)[2]?.station).toBe("harbour");
  });

  it("going back to earlier params is served from cache: the key includes the params", async () => {
    const { inv, ctl, store } = rig(echo);
    ctl.load(expWith([node("a", "h")], { h: providerSpec("h", [ranged("temps")]) }));
    await flush();
    ctl.setParams({ station: "harbour" });
    await flush();
    expect(inv.calls).toHaveLength(2);
    ctl.setParams({});
    await flush();
    expect(inv.calls).toHaveLength(2);
    expect(store.value("h")).toMatchObject({ station: "ridge" });
  });

  it("a templated argument is never overridden, and the warning reaches the status", async () => {
    const { inv, ctl, store } = rig((input) => {
      const i = input as McpIn;
      return i.toolName === "fleet.list" ? { ids: ["v1"] } : i.args;
    });
    ctl.setParams({ id: "hijack" });
    ctl.load(
      expWith([node("a", "h")], {
        h: providerSpec("h", [
          mcpStep("list", "fleet.list"),
          {
            ...mcpStep("stats", "fleet.stats", { id: "{{steps.list.output.ids[0]}}" }, ["list"]),
            overridable: ["id"],
          },
        ]),
      })
    );
    await flush();
    expect(argsOf(inv)[1]).toEqual({ id: "v1" });
    expect(store.status("h")?.state).toBe("ready");
    expect(store.status("h")?.finding?.code).toBe("param-templated");
  });

  it("unrepresentable params are refused and nothing reloads", async () => {
    const { inv, ctl } = rig(echo);
    ctl.load(expWith([node("a", "h")], { h: providerSpec("h", [ranged("temps")]) }));
    await flush();
    expect(ctl.setParams({ station: Number.NaN }).findings.map((f) => f.code)).toEqual([
      "invalid-params",
    ]);
    await flush();
    expect(inv.calls).toHaveLength(1);
  });
});

describe("HydrationController call budget", () => {
  it("maxConcurrentCalls caps calls across handles", async () => {
    const release: Array<() => void> = [];
    const { inv, ctl, store } = rig(
      () => new Promise((resolve) => release.push(() => resolve({ ok: true }))),
      { maxConcurrentCalls: 2 }
    );
    ctl.load(
      expWith([node("a", "x"), node("b", "y"), node("c", "z")], {
        x: providerSpec("x", [mcpStep("s", "tx")]),
        y: providerSpec("y", [mcpStep("s", "ty")]),
        z: providerSpec("z", [mcpStep("s", "tz")]),
      })
    );
    await flush();
    expect(inv.calls).toHaveLength(2);
    release.shift()?.();
    await flush();
    expect(inv.calls).toHaveLength(3);
    while (release.length > 0) {
      release.shift()?.();
      await flush();
    }
    expect(["x", "y", "z"].map((h) => store.status(h)?.state)).toEqual(["ready", "ready", "ready"]);
  });

  it("an identical step shared by two providers runs once in a pass", async () => {
    const { inv, ctl, store } = rig(() => ({ count: 2, names: ["n1", "n2"] }));
    ctl.load(
      expWith([node("a", "count"), node("b", "names")], {
        count: providerSpec("count", [mcpStep("s", "fleet.list", { region: "north" })], {
          reshaping: { engine: "JSONPath", scriptRef: "count" },
        }),
        names: providerSpec("names", [mcpStep("s", "fleet.list", { region: "north" })], {
          reshaping: { engine: "JSONPath", scriptRef: "names" },
        }),
      })
    );
    await flush();
    expect(inv.calls).toHaveLength(1);
    expect(store.value("count")).toBe(2);
    expect(store.value("names")).toEqual(["n1", "n2"]);
  });
});

describe("HydrationController passes, the cap and principals", () => {
  const sharing = () =>
    expWith([node("a", "count"), node("b", "names")], {
      count: providerSpec("count", [mcpStep("s", "list", { region: "north" })], {
        reshaping: { engine: "JSONPath", scriptRef: "count" },
      }),
      names: providerSpec("names", [mcpStep("s", "list", { region: "north" })], {
        reshaping: { engine: "JSONPath", scriptRef: "names" },
      }),
    });

  it("the call cap holds across passes: a later pass's call waits for an earlier pass's slot", async () => {
    const release: Array<() => void> = [];
    const { inv, ctl, clock, store } = rig(
      () => new Promise((resolve) => release.push(() => resolve({ ok: true }))),
      { maxConcurrentCalls: 1 }
    );
    ctl.load(
      expWith([node("a", "x", "P0"), node("b", "y", "P1")], {
        x: providerSpec("x", [mcpStep("s", "tx")]),
        y: providerSpec("y", [mcpStep("s", "ty")]),
      })
    );
    await flush();
    clock.advance(50); // the P1 batch: a second pass
    await flush();
    expect(inv.calls).toHaveLength(1);
    release.shift()?.();
    await flush();
    expect(inv.calls).toHaveLength(2);
    release.shift()?.();
    await flush();
    expect(["x", "y"].map((h) => store.status(h)?.state)).toEqual(["ready", "ready"]);
  });

  it("a new pass gets a fresh memo: after invalidate the shared step is invoked again, once", async () => {
    const { inv, ctl, store } = rig(() => ({ count: 2, names: ["n1", "n2"] }));
    ctl.load(sharing());
    await flush();
    expect(inv.calls).toHaveLength(1);
    ctl.invalidate();
    await flush();
    expect(inv.calls).toHaveLength(2);
    expect(store.value("names")).toEqual(["n1", "n2"]);
  });

  it("two principals never share a call, even concurrently over one invoker and one cache", async () => {
    const release: Array<() => void> = [];
    const inv = new FakeInvoker().on(
      MCP_INVOKE_TOOL_ID,
      () => new Promise((resolve) => release.push(() => resolve({ count: 1, names: [] })))
    );
    const cache = new HydrationCache(() => NOW);
    const runtime = new InMemoryProjectionRuntime();
    const viewer = (id: string) =>
      new HydrationController({
        invoker: inv,
        store: new HydrationStore(runtime, { experienceId: "exp-1", principalId: id }),
        cache,
        clock: () => NOW,
        principal: { id, chain: { tenant: "t", actor: id } },
      });
    const exp = sharing();
    const scoped: Experience = {
      ...exp,
      providers: Object.fromEntries(
        Object.entries(exp.providers).map(([h, p]) => [
          h,
          { ...p, cachePolicy: { ttlSeconds: 60, scope: "principal" as const } },
        ])
      ),
    };
    viewer("p1").load(scoped);
    viewer("p2").load(scoped);
    await flush();
    expect(inv.calls.map((c) => c.opts?.principal)).toEqual([
      { tenant: "t", actor: "p1" },
      { tenant: "t", actor: "p2" },
    ]);
    for (const r of release) r();
    await flush();
  });

  it("scoped params set before a load, for a handle it does not bind, are forgotten at bind", async () => {
    const { ctl, store } = rig(echo);
    ctl.setParams({ station: "harbour" }, { handle: "h2" });
    ctl.load(expWith([node("a", "h1")], { h1: providerSpec("h1", [ranged("t1")]) }));
    await flush();
    ctl.recompose(
      expWith([node("a", "h1"), node("b", "h2")], {
        h1: providerSpec("h1", [ranged("t1")]),
        h2: providerSpec("h2", [ranged("t2")]),
      })
    );
    await flush();
    expect(store.value("h2")).toMatchObject({ station: "ridge" });
  });
});

describe("HydrationController: a question changed inside the batch window", () => {
  it("replaces the queued P1 load: only the new question is asked, and a later change re-runs", async () => {
    const { clock, inv, ctl, store } = rig(echo);
    ctl.load(
      expWith([node("a", "h", "P1")], {
        h: providerSpec("h", [{ ...mcpStep("s", "t", { x: 0 }), overridable: ["x"] }]),
      })
    );
    ctl.setParams({ x: 1 });
    clock.advance(50);
    await flush();
    expect(argsOf(inv)).toEqual([{ x: 1 }]);
    expect(store.value("h")).toEqual({ x: 1 });
    expect(store.status("h")?.state).toBe("ready");
    ctl.setParams({ x: 2 });
    clock.advance(50);
    await flush();
    expect(argsOf(inv)).toEqual([{ x: 1 }, { x: 2 }]);
    expect(store.value("h")).toEqual({ x: 2 });
  });

  it("invalidate inside the batch window starts the queued P1 load once, not again at the timer", async () => {
    const { clock, inv, ctl, store } = rig(echo);
    ctl.load(
      expWith([node("a", "h", "P1")], {
        h: providerSpec("h", [mcpStep("s", "t", { x: 0 })], {
          cachePolicy: { ttlSeconds: 0, scope: "global" },
        }),
      })
    );
    ctl.invalidate("h");
    await flush();
    clock.advance(50);
    await flush();
    expect(argsOf(inv)).toEqual([{ x: 0 }]);
    expect(store.status("h")?.state).toBe("ready");
  });

  it("a queued P1 handle promoted to P0 by a recompose leaves the queue: it is asked once", async () => {
    const { clock, inv, ctl, store } = rig(echo);
    const spec = providerSpec("h", [mcpStep("s", "t", { x: 0 })], {
      cachePolicy: { ttlSeconds: 0, scope: "global" },
    });
    ctl.load(expWith([node("a", "h", "P1")], { h: spec }));
    ctl.recompose(expWith([node("a", "h", "P0")], { h: spec }));
    await flush();
    clock.advance(50);
    await flush();
    expect(argsOf(inv)).toEqual([{ x: 0 }]);
    expect(store.status("h")?.state).toBe("ready");
  });
});

describe("HydrationController inputDrift, Named and the argument hook", () => {
  const drifting = (input: unknown): unknown => {
    const i = input as McpIn;
    if (i.expectedSchemaHash !== "v2")
      throw new TypedFailure("schemaDrift", {
        toolName: i.toolName,
        expectedSchemaHash: i.expectedSchemaHash,
        observedHash: "v2",
      });
    return { n: 1 };
  };
  const one = () => expWith([node("a", "h")], { h: providerSpec("h", [mcpStep("s", "t")]) });

  it("report-and-proceed publishes and reports the drift as proceeded", async () => {
    const { ctl, store, drifts } = rig(drifting, { inputDrift: "report-and-proceed" });
    ctl.load(one());
    await flush();
    expect(store.status("h")?.state).toBe("ready");
    expect(store.status("h")?.finding?.code).toBe("schema-drift-proceeded");
    expect(store.value("h")).toEqual({ n: 1 });
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      handle: "h",
      proceeded: true,
      drift: [{ kind: "input", observed: "v2" }],
    });
  });

  it("a proceeded result is never cached: a head sharing the cache still goes stale and reports the drift", async () => {
    const cache = new HydrationCache(() => NOW);
    const viewer = rig(drifting, { inputDrift: "report-and-proceed", cache });
    viewer.ctl.load(one());
    await flush();
    expect(viewer.store.status("h")?.state).toBe("ready");
    expect(viewer.drifts.map((d) => d.proceeded)).toEqual([true]);
    const head = rig(drifting, { cache });
    head.ctl.load(one());
    await flush();
    expect(head.store.status("h")?.state).toBe("stale");
    expect(head.store.value("h")).toBeUndefined();
    expect(head.drifts.map((d) => d.proceeded)).toEqual([false]);
    // The head asked the tool itself (once, on the pinned schema), not the viewer's cache entry.
    expect(head.inv.calls).toHaveLength(1);
    expect(viewer.inv.calls).toHaveLength(2);
  });

  it("the default goes stale and reports the drift as not proceeded", async () => {
    const { ctl, store, drifts } = rig(drifting);
    ctl.load(one());
    await flush();
    expect(store.status("h")?.state).toBe("stale");
    expect(drifts[0]?.proceeded).toBe(false);
  });

  it("Named reshapers and the argument hook reach every load", async () => {
    const { inv, ctl, store } = rig(echo, {
      reshapers: defineReshapers({ stationOnly: (raw) => (raw as { station: string }).station }),
      argumentHook: (args, ctx) => ({
        ...args,
        bucket: ctx.params.from === "$now-7d" ? "1h" : "5m",
      }),
    });
    ctl.load(
      expWith([node("a", "h")], {
        h: providerSpec("h", [ranged("temps")], {
          reshaping: { engine: "Named", scriptRef: "stationOnly" },
        }),
      })
    );
    await flush();
    expect(store.value("h")).toBe("ridge");
    expect(argsOf(inv)[0]?.bucket).toBe("5m");
    ctl.setParams({ from: "$now-7d" });
    await flush();
    expect(argsOf(inv)[1]?.bucket).toBe("1h");
    expect(argsOf(inv)[1]?.from).toBe("2026-09-16T12:00:00.000Z");
  });
});

describe("HydrationController params: edges", () => {
  it("setParams refuses a reserved handle and changes nothing; a disposed controller refuses too", async () => {
    const { inv, ctl } = rig(echo);
    ctl.load(expWith([node("a", "h")], { h: providerSpec("h", [ranged("temps")]) }));
    await flush();
    expect(ctl.setParams({ station: "harbour" }, { handle: "__proto__" }).findings[0]?.code).toBe(
      "invalid-handle"
    );
    await flush();
    expect(inv.calls).toHaveLength(1);
    ctl.dispose();
    expect(ctl.setParams({ station: "harbour" }).findings[0]?.code).toBe("disposed");
  });

  it("the constructor refuses unrepresentable defaultParams and a cap that is not a positive integer", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const invoker = new FakeInvoker();
    expect(
      () => new HydrationController({ invoker, store, defaultParams: { from: Number.NaN } })
    ).toThrow(RangeError);
    expect(() => new HydrationController({ invoker, store, maxConcurrentCalls: 0 })).toThrow(
      RangeError
    );
  });

  it("a pass reads the clock once: every handle in it resolves $now to the same instant", async () => {
    let t = NOW;
    const { inv, ctl } = rig(echo, { clock: () => t++ });
    ctl.load(
      expWith([node("a", "h1"), node("b", "h2")], {
        h1: providerSpec("h1", [ranged("t1")]),
        h2: providerSpec("h2", [ranged("t2")]),
      })
    );
    await flush();
    const tos = argsOf(inv).map((a) => a.to);
    expect(tos).toHaveLength(2);
    expect(tos[0]).toBe(tos[1]);
  });

  it("a lazy (P2) handle whose params change keeps its value and waits for its next markVisible", async () => {
    const { inv, ctl, store } = rig(echo);
    ctl.load(expWith([node("a", "h", "P2")], { h: providerSpec("h", [ranged("temps")]) }));
    await flush();
    expect(inv.calls).toHaveLength(0);
    ctl.markVisible("h");
    await flush();
    expect(store.value("h")).toMatchObject({ station: "ridge" });
    ctl.setParams({ station: "harbour" });
    await flush();
    expect(inv.calls).toHaveLength(1);
    expect(store.status("h")?.state).toBe("ready");
    expect(store.value("h")).toMatchObject({ station: "ridge" });
    ctl.markVisible("h");
    await flush();
    expect(inv.calls).toHaveLength(2);
    expect(store.value("h")).toMatchObject({ station: "harbour" });
  });

  it("an unrelated param change re-runs nothing — not even a handle that ended on an error", async () => {
    const { inv, ctl, store } = rig((input) => {
      if ((input as McpIn).toolName === "broken") throw new Error("down");
      return echo(input);
    });
    ctl.load(
      expWith([node("a", "h"), node("b", "bad")], {
        h: providerSpec("h", [ranged("temps")]),
        bad: providerSpec("bad", [mcpStep("s", "broken")]),
      })
    );
    await flush();
    expect(store.status("bad")?.state).toBe("error");
    expect(inv.calls).toHaveLength(2);
    ctl.setParams({ unrelated: 1 });
    await flush();
    expect(inv.calls).toHaveLength(2);
  });

  it("a recompose forgets the scoped params of a handle it no longer binds", async () => {
    const { ctl, store } = rig(echo);
    const both = expWith([node("a", "h1"), node("b", "h2")], {
      h1: providerSpec("h1", [ranged("t1")]),
      h2: providerSpec("h2", [ranged("t2")]),
    });
    ctl.load(both);
    await flush();
    ctl.setParams({ station: "harbour" }, { handle: "h2" });
    await flush();
    ctl.recompose(expWith([node("a", "h1")], { h1: providerSpec("h1", [ranged("t1")]) }));
    await flush();
    ctl.recompose(both);
    await flush();
    // Back to the unscoped question (served from cache), not the forgotten "harbour" one.
    expect(store.value("h2")).toMatchObject({ station: "ridge" });
  });

  it("dispose cancels an upstream call at once, even one queued behind the call cap", async () => {
    const { inv, ctl } = rig(() => new Promise(() => {}), { maxConcurrentCalls: 1 });
    ctl.load(
      expWith([node("a", "x"), node("b", "y")], {
        x: providerSpec("x", [mcpStep("s", "tx")]),
        y: providerSpec("y", [mcpStep("s", "ty")]),
      })
    );
    await flush();
    expect(inv.calls).toHaveLength(1);
    ctl.dispose();
    expect(inv.calls[0]?.opts?.signal?.aborted).toBe(true);
    await flush();
    expect(inv.calls).toHaveLength(1); // the queued call never reached the invoker
  });
});
