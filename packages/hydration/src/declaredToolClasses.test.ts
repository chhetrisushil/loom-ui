import { type ContainerNode, type Experience, type SemanticNode, genesis } from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationCache } from "./cache";
import { HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import { handleInventory, serveHandle, serveHandles } from "./split/index";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

// U10b: the host's DECLARED class per tool floors every handle calling it on every hydration read
// path. Every node below is stored UNCLASSIFIED; only `declaredToolClasses` says `tool.pay` is secret.

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const node = (id: string, handle: string): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  binding: { handle, priority: "P0" },
});
const exp = (): Experience => {
  const g = genesis({ experienceId: "exp-1", intent: { objective: "x", source: "user" }, meta });
  return {
    ...g,
    versionHash: "sha256:v1",
    root: { ...(g.root as ContainerNode), children: [node("a", "open"), node("b", "pay")] },
    providers: Object.fromEntries(
      ["open", "pay"].map((h) => [h, providerSpec(h, [mcpStep("s", `tool.${h}`)])])
    ),
  };
};
const declaredToolClasses = { "tool.pay": "secret" } as const;
const low = { clearance: "internal" } as const;

const rig = (extra: {
  declaredToolClasses?: typeof declaredToolClasses;
  viewer?: { clearance: "secret" | "internal" };
}) => {
  const clock = new ManualClock();
  const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
  const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (i) => ({
    v: (i as { toolName: string }).toolName,
  }));
  const ctl = new HydrationController({
    invoker: inv,
    store,
    clock: clock.now,
    setTimer: clock.setTimer,
    cache: new HydrationCache(clock.now),
    ...extra,
  });
  const toolsCalled = () => inv.calls.map((c) => (c.input as { toolName: string }).toolName).sort();
  return { store, ctl, inv, clock, toolsCalled };
};

describe("declaredToolClasses on the hydration read paths", () => {
  it("controller.load: the declared-secret tool is never invoked for a low viewer (and is without the table)", async () => {
    const open = rig({ viewer: low });
    open.ctl.load(exp());
    open.clock.advance(100);
    await flush();
    expect(open.toolsCalled()).toEqual(["tool.open", "tool.pay"]);

    const { store, ctl, clock, toolsCalled } = rig({ viewer: low, declaredToolClasses });
    ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(toolsCalled()).toEqual(["tool.open"]);
    expect(store.status("pay")).toBeUndefined();
    expect(store.handles()).not.toContain("pay");
  });

  it("controller.load with no viewer: refused too (no viewer is the most restrictive viewer)", async () => {
    const { ctl, clock, toolsCalled } = rig({ declaredToolClasses });
    const { findings } = ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(toolsCalled()).toEqual(["tool.open"]);
    expect(findings.map((f) => f.code)).toEqual(["viewer-not-supplied"]);
  });

  it("controller.recompose: a handle first bound by the new experience is refused", async () => {
    const { store, ctl, clock, toolsCalled } = rig({ viewer: low, declaredToolClasses });
    const g = exp();
    ctl.load({ ...g, root: { ...(g.root as ContainerNode), children: [node("a", "open")] } });
    clock.advance(100);
    await flush();
    ctl.recompose({ ...g, versionHash: "sha256:v2" });
    clock.advance(100);
    await flush();
    expect(toolsCalled()).toEqual(["tool.open"]);
    expect(store.status("pay")).toBeUndefined();
  });

  it("controller.setViewer: a cleared viewer loads it, a downgrade drops it", async () => {
    const { store, ctl, clock } = rig({ viewer: { clearance: "secret" }, declaredToolClasses });
    ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(store.value("pay")).toEqual({ v: "tool.pay" });
    ctl.setViewer(low);
    await flush();
    expect(store.value("pay")).toBeUndefined();
  });

  const revisionOf = (h: string, f: string) => `r-${h}-${f.length}-${f.charCodeAt(1)}`;
  it("handleInventory: the handle is neither named nor given a revision", () => {
    const withoutTable = handleInventory(exp(), { revisionOf, viewer: low });
    expect(withoutTable.inventory.handles.map((h) => h.handle)).toEqual(["open", "pay"]);
    const { inventory } = handleInventory(exp(), { revisionOf, viewer: low, declaredToolClasses });
    expect(inventory.handles.map((h) => h.handle)).toEqual(["open"]);
    expect(JSON.stringify(inventory)).not.toContain("pay");
    expect(
      handleInventory(exp(), { revisionOf, viewer: { clearance: "secret" }, declaredToolClasses })
        .inventory.handles.map((h) => h.handle)
        .sort()
    ).toEqual(["open", "pay"]);
  });

  const req = (e: Experience, handle: string) => ({
    experienceId: e.experienceId,
    versionHash: e.versionHash,
    handle,
    params: {},
  });
  it("serveHandles / serveHandle: a named handle is refused and never called", async () => {
    const e = exp();
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: 1 }));
    const logged: string[] = [];
    const [open, pay] = await serveHandles(e, [req(e, "open"), req(e, "pay")], {
      invoker: inv,
      now: 0,
      viewer: low,
      declaredToolClasses,
      onFinding: (_h, f) => logged.push(f.code),
    });
    expect(open?.state).toBe("ready");
    expect(pay?.state).toBe("error");
    expect(inv.calls).toHaveLength(1);
    expect(logged).toContain("restricted");
    const one = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: 1 }));
    expect(
      (
        await serveHandle(e, req(e, "pay"), {
          invoker: one,
          now: 0,
          viewer: low,
          declaredToolClasses,
        })
      ).state
    ).toBe("error");
    expect(one.calls).toHaveLength(0);
    expect((await serveHandle(e, req(e, "pay"), { invoker: one, now: 0, viewer: low })).state).toBe(
      "ready"
    );
  });
});
