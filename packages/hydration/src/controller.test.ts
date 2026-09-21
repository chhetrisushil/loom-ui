import { type Experience, type SemanticNode, genesis } from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationController } from "./controller";
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
    root: { ...g.root, children: nodes },
    providers: Object.fromEntries(
      handles.map((h) => [h, providerSpec(h, [mcpStep("s", `tool.${h}`)])])
    ),
  };
};

function rig(handler?: (input: unknown) => unknown) {
  const clock = new ManualClock();
  const store = new HydrationStore(new InMemoryProjectionRuntime(), "exp-1");
  const inv = new FakeInvoker().on(
    MCP_INVOKE_TOOL_ID,
    handler ?? ((input) => ({ v: (input as { toolName: string }).toolName }))
  );
  const drifts: unknown[] = [];
  const ctl = new HydrationController({
    invoker: inv,
    store,
    clock: clock.now,
    setTimer: clock.setTimer,
    onDrift: (r) => drifts.push(r),
  });
  return { clock, store, inv, ctl, drifts };
}
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
    expect(store.status("d")?.finding?.code).toBe("provider-failed");
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
    const exp = { ...withNodes([], []), root };
    const r = ctl.load(exp);
    await flush();
    expect(r.findings.map((f) => f.code)).toEqual(["tree-too-deep"]);
    expect(inv.calls).toEqual([]);
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
