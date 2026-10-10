import { type ContainerNode, type Experience, type SemanticNode, genesis } from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationCache } from "./cache";
import { type ControllerOptions, HydrationController, loadFingerprint } from "./controller";
import { HydrationStore } from "./projection";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const node = (id: string, handle: string, priority: "P0" | "P1" | "P2" = "P1"): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  binding: { handle, priority },
});
const withNodes = (nodes: SemanticNode[], handles: string[]): Experience => {
  const g = genesis({ experienceId: "exp-1", intent: { objective: "x", source: "user" }, meta });
  return {
    ...g,
    versionHash: "sha256:v1",
    root: { ...(g.root as ContainerNode), children: nodes },
    providers: Object.fromEntries(
      handles.map((h) => [h, providerSpec(h, [mcpStep("s", `tool.${h}`)])])
    ),
  };
};

function rig(
  handler?: (input: unknown) => unknown,
  over: Partial<ControllerOptions> = {}
): {
  clock: ManualClock;
  store: HydrationStore;
  inv: FakeInvoker;
  ctl: HydrationController;
  drifts: unknown[];
} {
  const clock = new ManualClock();
  const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
  const inv = new FakeInvoker().on(
    MCP_INVOKE_TOOL_ID,
    handler ?? ((input) => ({ v: (input as { toolName: string }).toolName }))
  );
  const drifts: unknown[] = [];
  const ctl = new HydrationController({
    contentRefArgs: "none" as const,
    invoker: inv,
    store,
    clock: clock.now,
    setTimer: clock.setTimer,
    onDrift: (r) => drifts.push(r),
    ...over,
  });
  return { clock, store, inv, ctl, drifts };
}

/** A tree past MAX_TREE_DEPTH — the shape both the `load` and the `recompose` guard refuse. */
const deepRoot = (): Experience["root"] => {
  let root: Experience["root"] = {
    id: "leaf",
    order: "V",
    kind: "container",
    direction: "row",
    span: 12,
    children: [],
  };
  for (let i = 0; i < 300; i++)
    root = {
      id: `c${i}`,
      order: "V",
      kind: "container",
      direction: "row",
      span: 12,
      children: [root],
    };
  return root;
};
const tools = (inv: FakeInvoker) =>
  inv.calls.map((c) => (c.input as { toolName: string }).toolName);

describe("HydrationController scheduling", () => {
  it("P0 loads immediately, P1 waits for the batch window, P2 waits for markVisible", async () => {
    const { clock, inv, ctl, store } = rig();
    ctl.load(
      withNodes(
        [node("a", "p0", "P0"), node("b", "p1", "P1"), node("c", "p2", "P2")],
        ["p0", "p1", "p2"]
      )
    );
    await flush();
    expect(tools(inv)).toEqual(["tool.p0"]);
    expect(store.status("p0")?.state).toBe("ready");
    expect(store.status("p1")?.state).toBe("pending");
    expect(store.status("p2")).toBeUndefined();
    clock.advance(49);
    await flush();
    expect(tools(inv)).toEqual(["tool.p0"]);
    clock.advance(1);
    await flush();
    expect(tools(inv)).toEqual(["tool.p0", "tool.p1"]);
    ctl.markVisible("p2");
    await flush();
    expect(tools(inv)).toEqual(["tool.p0", "tool.p1", "tool.p2"]);
    expect(store.value("p2")).toEqual({ v: "tool.p2" });
  });

  it("a handle bound by several nodes loads once at the highest priority", async () => {
    const { inv, ctl } = rig();
    ctl.load(withNodes([node("a", "h", "P2"), node("b", "h", "P0")], ["h"]));
    await flush();
    expect(tools(inv)).toEqual(["tool.h"]);
  });

  it("a bound handle with no provider is an error status and an unknown-handle finding; the rest still load", async () => {
    const { inv, ctl, store } = rig();
    const r = ctl.load(withNodes([node("a", "h", "P0"), node("b", "ghost", "P0")], ["h"]));
    await flush();
    expect(r.findings.map((f) => f.code)).toEqual(["unknown-handle"]);
    expect(store.status("ghost")?.state).toBe("error");
    expect(tools(inv)).toEqual(["tool.h"]);
  });

  it("schema drift → stale with the finding, no value, one DriftReport to the app; other failures → error", async () => {
    const { ctl, store, drifts } = rig((input) => {
      const t = (input as { toolName: string }).toolName;
      if (t === "tool.d")
        throw new TypedFailure("schemaDrift", {
          toolName: t,
          expectedSchemaHash: "schema-tool.d",
          observedHash: "v2",
        });
      throw new Error("down");
    });
    ctl.load(withNodes([node("a", "d", "P0"), node("b", "e", "P0")], ["d", "e"]));
    await flush();
    expect(store.status("d")?.state).toBe("stale");
    expect(store.status("d")?.finding?.code).toBe("schema-drift");
    expect(store.value("d")).toBeUndefined();
    expect(store.status("e")?.state).toBe("error");
    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({
      experienceId: "exp-1",
      versionHash: "sha256:v1",
      handle: "d",
      drift: [{ kind: "input", observed: "v2" }],
    });
  });

  it("a cached result is served without invoking; invalidate(handle) reloads it", async () => {
    const { inv, ctl, store } = rig();
    const exp = withNodes([node("a", "h", "P0")], ["h"]);
    ctl.load(exp);
    await flush();
    store.remove("h"); // forget the published value but keep the cache entry
    ctl.recompose(exp);
    await flush();
    expect(tools(inv)).toEqual(["tool.h"]); // re-published from cache: no second invocation
    expect(store.status("h")?.state).toBe("ready");
    ctl.invalidate("h");
    await flush();
    expect(tools(inv)).toEqual(["tool.h", "tool.h"]);
    expect(store.status("h")?.state).toBe("ready");
  });

  it("an evicted handle re-fetches from the provider (a bounded cache is a miss, never a wrong answer)", async () => {
    const cache = new HydrationCache(undefined, { maxEntries: 1 });
    const { inv, ctl, store } = rig(undefined, { cache });
    const exp = withNodes([node("a", "h1", "P0"), node("b", "h2", "P0")], ["h1", "h2"]);
    ctl.load(exp);
    await flush();
    expect(tools(inv).sort()).toEqual(["tool.h1", "tool.h2"]);
    expect(cache.size).toBe(1); // one of the two was evicted
    store.remove("h1");
    store.remove("h2");
    ctl.recompose(exp);
    await flush();
    // Exactly one handle was answered from the cache; the evicted one went back to the provider.
    expect(tools(inv)).toHaveLength(3);
    expect(store.status("h1")?.state).toBe("ready");
    expect(store.status("h2")?.state).toBe("ready");
    expect(store.value("h1")).toEqual({ v: "tool.h1" });
    expect(store.value("h2")).toEqual({ v: "tool.h2" });
  });

  it("recompose aborts in-flight loads for handles no longer bound and removes them; keeps the rest; loads new ones", async () => {
    let release: (() => void) | undefined;
    const { inv, ctl, store } = rig((input) => {
      const t = (input as { toolName: string }).toolName;
      if (t === "tool.a-slow")
        return new Promise((res) => {
          release = () => res({ v: "late" });
        });
      return { v: t };
    });
    ctl.load(
      withNodes([node("a", "a-slow", "P0"), node("b", "b-keep", "P0")], ["a-slow", "b-keep"])
    );
    await flush();
    expect(ctl.inFlight()).toEqual(["a-slow"]);
    expect(inv.calls[0]?.opts?.signal?.aborted).toBe(false);
    ctl.recompose(
      withNodes([node("b", "b-keep", "P0"), node("c", "c-fresh", "P0")], ["b-keep", "c-fresh"])
    );
    await flush();
    expect(inv.calls[0]?.opts?.signal?.aborted).toBe(true);
    expect(store.status("a-slow")).toBeUndefined();
    expect(store.status("b-keep")?.state).toBe("ready");
    expect(store.status("c-fresh")?.state).toBe("ready");
    expect(tools(inv)).toEqual(["tool.a-slow", "tool.b-keep", "tool.c-fresh"]);
    release?.();
    await flush();
    expect(store.status("a-slow")).toBeUndefined(); // a late result for an aborted handle is dropped
  });

  it("refuses a too-deep experience with a finding and loads nothing", async () => {
    const { inv, ctl } = rig();
    const exp = { ...withNodes([], []), root: deepRoot() };
    const r = ctl.load(exp);
    await flush();
    expect(r.findings.map((f) => f.code)).toEqual(["tree-too-deep"]);
    expect(inv.calls).toEqual([]);
  });

  it("a handle promoted out of P2 by recompose has one owner; a later markVisible is a no-op", async () => {
    const { inv, ctl } = rig();
    ctl.load(withNodes([node("a", "h", "P2")], ["h"]));
    await flush();
    expect(tools(inv)).toEqual([]);
    ctl.recompose(withNodes([node("a", "h", "P0")], ["h"]));
    await flush();
    expect(tools(inv)).toEqual(["tool.h"]);
    ctl.markVisible("h");
    await flush();
    expect(tools(inv)).toEqual(["tool.h"]);
  });

  it("a reserved handle is refused with invalid-handle and never invoked", async () => {
    const { inv, ctl, store } = rig();
    const r = ctl.load(withNodes([node("a", "__proto__", "P0")], ["__proto__"]));
    await flush();
    expect(r.findings.map((f) => f.code)).toEqual(["invalid-handle"]);
    expect(inv.calls).toEqual([]);
    expect(store.status("__proto__")).toBeUndefined();
  });

  it("dispose aborts everything in flight and cancels the pending batch timer", async () => {
    const { clock, inv, ctl } = rig(() => new Promise(() => {}));
    ctl.load(withNodes([node("a", "x", "P0"), node("b", "y", "P1")], ["x", "y"]));
    await flush();
    ctl.dispose();
    expect(inv.calls[0]?.opts?.signal?.aborted).toBe(true);
    clock.advance(100);
    await flush();
    expect(tools(inv)).toEqual(["tool.x"]);
  });
});

describe("HydrationController: one load per SPEC", () => {
  const withProviders = (exp: Experience, providers: Experience["providers"]): Experience => ({
    ...exp,
    providers,
  });

  it("recomposing with a changed provider re-runs the handle; recomposing with the same one does not", async () => {
    const { inv, ctl, store } = rig();
    const exp = withNodes([node("a", "h", "P0")], ["h"]);
    ctl.load(exp);
    await flush();
    expect(tools(inv)).toEqual(["tool.h"]);
    ctl.recompose(exp); // byte-identical spec: the question has not changed
    await flush();
    expect(tools(inv)).toEqual(["tool.h"]);
    const changed = withProviders(exp, { h: providerSpec("h", [mcpStep("s", "tool.h2")]) });
    ctl.recompose(changed);
    await flush();
    expect(tools(inv)).toEqual(["tool.h", "tool.h2"]);
    expect(store.value("h")).toEqual({ v: "tool.h2" });
  });

  it("a stale handle is not re-invoked while the spec stands, and re-runs once when the repaired spec arrives", async () => {
    const { inv, ctl, store, drifts } = rig((input) => {
      const i = input as { toolName: string; expectedSchemaHash: string };
      if (i.expectedSchemaHash === "schema-tool.h")
        throw new TypedFailure("schemaDrift", {
          toolName: i.toolName,
          expectedSchemaHash: i.expectedSchemaHash,
          observedHash: "v2",
        });
      return { v: i.toolName };
    });
    const exp = withNodes([node("a", "h", "P0")], ["h"]);
    ctl.load(exp);
    await flush();
    expect(store.status("h")?.state).toBe("stale");
    // Every re-load of the SAME experience: a stale handle is not a retry trigger.
    ctl.load(exp);
    ctl.recompose(exp);
    await flush();
    expect(tools(inv)).toEqual(["tool.h"]);
    expect(drifts).toHaveLength(1);
    // What the app's durable repair produces (remapOperation's op, applied): the observed pin.
    const repaired = withProviders(exp, {
      h: providerSpec("h", [{ ...mcpStep("s", "tool.h"), toolSchemaHash: "v2" }]),
    });
    ctl.recompose(repaired);
    await flush();
    expect(tools(inv)).toEqual(["tool.h", "tool.h"]);
    expect(store.status("h")?.state).toBe("ready");
    expect(store.value("h")).toEqual({ v: "tool.h" });
    expect(drifts).toHaveLength(1);
  });
});

describe("HydrationController lifecycle", () => {
  it("invalidate aborts the in-flight load it supersedes and starts a fresh one", async () => {
    const { inv, ctl } = rig(() => new Promise(() => {}));
    ctl.load(withNodes([node("a", "h", "P0")], ["h"]));
    await flush();
    expect(inv.calls[0]?.opts?.signal?.aborted).toBe(false);
    ctl.invalidate("h");
    await flush();
    expect(inv.calls[0]?.opts?.signal?.aborted).toBe(true);
    expect(tools(inv)).toEqual(["tool.h", "tool.h"]);
    expect(inv.calls[1]?.opts?.signal?.aborted).toBe(false);
  });

  it("invalidate re-queues a lazy (P2) handle instead of fetching for an off-screen widget", async () => {
    const { inv, ctl, store } = rig();
    ctl.load(withNodes([node("a", "h", "P2")], ["h"]));
    await flush();
    ctl.markVisible("h");
    await flush();
    expect(tools(inv)).toEqual(["tool.h"]);
    const before = store.status("h");
    ctl.invalidate("h");
    await flush();
    expect(tools(inv)).toEqual(["tool.h"]); // still off-screen as far as the surface said
    expect(store.status("h")).toEqual(before); // status untouched: the last value stays on screen
    ctl.markVisible("h");
    await flush();
    expect(tools(inv)).toEqual(["tool.h", "tool.h"]);
  });

  it("a too-deep recompose is refused before anything is torn down", async () => {
    const { inv, ctl, store } = rig();
    ctl.load(withNodes([node("a", "h", "P0")], ["h"]));
    await flush();
    const r = ctl.recompose({ ...withNodes([], []), root: deepRoot() });
    await flush();
    expect(r.findings.map((f) => f.code)).toEqual(["tree-too-deep"]);
    expect(store.status("h")?.state).toBe("ready"); // the current experience is untouched
    expect(store.value("h")).toEqual({ v: "tool.h" });
    expect(tools(inv)).toEqual(["tool.h"]);
  });

  it("dispose is terminal: an in-flight handle ends in error, and every later call is a disposed finding", async () => {
    const { inv, ctl, store } = rig(() => new Promise(() => {}));
    ctl.load(withNodes([node("a", "x", "P0")], ["x"]));
    await flush();
    ctl.dispose();
    expect(store.status("x")?.state).toBe("error");
    expect(store.status("x")?.finding?.code).toBe("disposed");
    const r = ctl.load(withNodes([node("b", "y", "P0")], ["y"]));
    await flush();
    expect(r.findings.map((f) => f.code)).toEqual(["disposed"]);
    expect(ctl.recompose(withNodes([node("b", "y", "P0")], ["y"])).findings[0]?.code).toBe(
      "disposed"
    );
    expect(ctl.invalidate().findings[0]?.code).toBe("disposed");
    ctl.markVisible("x");
    await flush();
    expect(tools(inv)).toEqual(["tool.x"]); // nothing started after dispose
  });

  it("dispose error-statuses batch-queued (P1) handles too, not just in-flight ones", async () => {
    const { clock, inv, ctl, store } = rig(() => new Promise(() => {}));
    ctl.load(withNodes([node("a", "x", "P0"), node("b", "y", "P1")], ["x", "y"]));
    await flush();
    expect(store.status("y")?.state).toBe("pending"); // batch-queued, not yet started
    ctl.dispose();
    expect(store.status("x")?.state).toBe("error");
    expect(store.status("x")?.finding?.code).toBe("disposed");
    expect(store.status("y")?.state).toBe("error");
    expect(store.status("y")?.finding?.code).toBe("disposed");
    clock.advance(100);
    await flush();
    expect(tools(inv)).toEqual(["tool.x"]); // the batch timer was cancelled: "y" is never invoked
  });

  it("a store subscriber that throws on the first `pending` publish still lands `start` on an error status", async () => {
    const { ctl, store } = rig();
    // Unsubscribed once the throwing episode is over: recomposing away from a handle whose
    // last-published slice still has a live listener is a separate, pre-existing gap
    // (`recompose`'s own `store.remove` is not guarded) — not what this test is about.
    const unsubscribe = store.subscribe("h", () => {
      throw new Error("subscriber boom");
    });
    ctl.load(withNodes([node("a", "h", "P0")], ["h"]));
    await flush(); // resolving at all is part of the assertion: no unhandled rejection
    expect(store.status("h")?.state).toBe("error");
    expect(store.status("h")?.finding?.code).toBe("hydration-internal");
    expect(ctl.inFlight()).toEqual([]);
    unsubscribe();
    // The controller itself is not wedged by the throwing subscriber: a fresh handle works.
    ctl.load(withNodes([node("b", "k", "P0")], ["k"]));
    await flush();
    expect(store.status("k")?.state).toBe("ready");
  });

  it("a second load replaces the first experience: handles it no longer binds are dropped", async () => {
    const { inv, ctl, store } = rig();
    ctl.load(withNodes([node("n1", "a", "P0")], ["a"]));
    await flush();
    expect(store.status("a")?.state).toBe("ready");
    ctl.load(withNodes([node("n2", "b", "P0")], ["b"]));
    await flush();
    expect(store.status("a")).toBeUndefined();
    expect(store.status("b")?.state).toBe("ready");
    expect(tools(inv)).toEqual(["tool.a", "tool.b"]);
  });

  it("an invoker failure whose payload cannot be serialized lands as an error status, not a rejection", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { ctl, store } = rig(() => {
      throw new TypedFailure("rateLimited", cyclic);
    });
    ctl.load(withNodes([node("a", "h", "P0")], ["h"]));
    await flush();
    // Resolving at all is the assertion: a throw inside the finding's message would have come
    // back as an unhandled rejection with the handle left on a spinner.
    expect(store.status("h")?.state).toBe("error");
    expect(store.status("h")?.finding?.code).toBe("provider-failed");
  });
});

describe("HydrationController principals", () => {
  const chainFor = (actor: string): TransientInvokeOptions["principal"] => ({
    tenant: "acme",
    actor,
  });
  const scoped = (scope: "principal" | "global"): Experience => {
    const exp = withNodes([node("a", "h", "P0")], ["h"]);
    return {
      ...exp,
      providers: {
        h: providerSpec("h", [mcpStep("s", "tool.h")], {
          cachePolicy: { ttlSeconds: 60, scope },
        }),
      },
    };
  };

  /** Two viewers of ONE experience: one runtime, one cache, one invoker — separate stores. */
  const viewers = () => {
    const runtime = new InMemoryProjectionRuntime();
    const cache = new HydrationCache(() => 0);
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => ({
      v: (input as { toolName: string }).toolName,
    }));
    const mk = (id: string) => {
      const store = new HydrationStore(runtime, { experienceId: "exp-1", principalId: id });
      const ctl = new HydrationController({
        contentRefArgs: "none" as const,
        invoker: inv,
        store,
        cache,
        clock: () => 0,
        principal: { id, chain: chainFor(id) },
      });
      return { store, ctl };
    };
    return { inv, alice: mk("alice"), bob: mk("bob") };
  };

  it("a principal-scoped result is never served to another viewer, and the chain reaches the invoker", async () => {
    const { inv, alice, bob } = viewers();
    alice.ctl.load(scoped("principal"));
    await flush();
    bob.ctl.load(scoped("principal"));
    await flush();
    expect(inv.calls).toHaveLength(2); // no cross-principal cache hit
    expect(inv.calls[0]?.opts?.principal).toEqual(chainFor("alice"));
    expect(inv.calls[1]?.opts?.principal).toEqual(chainFor("bob"));
    expect(alice.store.value("h")).toEqual({ v: "tool.h" });
    expect(bob.store.value("h")).toEqual({ v: "tool.h" });
  });

  it("a global-scoped result IS shared: the second viewer is served from cache", async () => {
    const { inv, alice, bob } = viewers();
    alice.ctl.load(scoped("global"));
    await flush();
    bob.ctl.load(scoped("global"));
    await flush();
    expect(inv.calls).toHaveLength(1);
    expect(bob.store.value("h")).toEqual({ v: "tool.h" });
  });
});

describe("loadFingerprint", () => {
  it("normalises kinds exactly as the cache key does: reordering or repeating kinds is not a new question", () => {
    const spec = providerSpec("h", [mcpStep("s", "t")], { outputCheck: "contract" });
    const base = loadFingerprint(spec, ["Kpi", "MetricCard"]);
    expect(loadFingerprint(spec, ["MetricCard", "Kpi"])).toBe(base);
    expect(loadFingerprint(spec, ["Kpi", "MetricCard", "Kpi"])).toBe(base);
    expect(loadFingerprint(spec, ["Kpi"])).not.toBe(base);
  });
});
