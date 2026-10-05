import { type ContainerNode, type Experience, type SemanticNode, genesis } from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationCache } from "./cache";
import { HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import { handleInventory, serveHandle, serveHandles } from "./split/index";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const node = (
  id: string,
  handle: string,
  sensitivity?: "secret" | "sensitive" | "internal"
): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  binding: { handle, priority: "P0", ...(sensitivity && { sensitivity }) },
});
const exp = (): Experience => {
  const g = genesis({ experienceId: "exp-1", intent: { objective: "x", source: "user" }, meta });
  const handles = ["open", "pay", "audit"];
  return {
    ...g,
    versionHash: "sha256:v1",
    root: {
      ...(g.root as ContainerNode),
      children: [node("a", "open"), node("b", "pay", "sensitive"), node("c", "audit", "secret")],
    },
    providers: Object.fromEntries(
      handles.map((h) => [h, providerSpec(h, [mcpStep("s", `tool.${h}`)])])
    ),
  };
};
const rig = (viewer?: { clearance?: "secret" | "sensitive" | "internal" }) => {
  const clock = new ManualClock();
  const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
  const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (i) => ({
    v: (i as { toolName: string }).toolName,
  }));
  const cache = new HydrationCache(clock.now);
  const ctl = new HydrationController({
    invoker: inv,
    store,
    clock: clock.now,
    setTimer: clock.setTimer,
    cache,
    ...(viewer !== undefined && { viewer }),
  });
  const toolsCalled = () => inv.calls.map((c) => (c.input as { toolName: string }).toolName).sort();
  return { store, ctl, inv, clock, toolsCalled };
};

describe("HydrationController with a viewer (U10)", () => {
  it("never invokes the provider of a handle above the viewer's clearance; refuses it with a fixed finding", async () => {
    const { store, ctl, clock, toolsCalled } = rig({ clearance: "internal" });
    ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(toolsCalled()).toEqual(["tool.open"]);
    expect(store.value("open")).toEqual({ v: "tool.open" });
    for (const h of ["pay", "audit"]) {
      expect(store.value(h)).toBeUndefined();
      // nothing at all is written for it: a store projected to a client must not name it
      expect(store.status(h)).toBeUndefined();
      expect(store.handles()).not.toContain(h);
    }
  });
  it("a cleared viewer loads it", async () => {
    const { store, ctl, clock, toolsCalled } = rig({ clearance: "sensitive" });
    ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(toolsCalled()).toEqual(["tool.open", "tool.pay"]);
    expect(store.value("pay")).toEqual({ v: "tool.pay" });
    expect(store.status("audit")).toBeUndefined();
  });
  it("no viewer is the most restrictive viewer: classified handles are refused, with one advisory", async () => {
    const { store, ctl, clock, toolsCalled } = rig();
    const { findings } = ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(toolsCalled()).toEqual(["tool.open"]);
    expect(store.status("pay")).toBeUndefined();
    expect(store.handles()).not.toContain("pay");
    expect(findings.map((f) => f.code)).toEqual(["viewer-not-supplied"]);
  });
  it("unclassified experiences are unaffected: no advisory, same loads", async () => {
    const g = exp();
    const plain: Experience = {
      ...g,
      root: { ...(g.root as ContainerNode), children: [node("a", "open")] },
    };
    const { store, ctl, clock, toolsCalled } = rig();
    expect(ctl.load(plain).findings).toEqual([]);
    clock.advance(100);
    await flush();
    expect(toolsCalled()).toEqual(["tool.open"]);
    expect(store.status("open")?.state).toBe("ready");
  });
  it("a handle shared by an unclassified and a classified node is refused for both", async () => {
    const g = exp();
    const shared: Experience = {
      ...g,
      root: {
        ...(g.root as ContainerNode),
        children: [node("a", "pay"), node("b", "pay", "secret")],
      },
    };
    const { store, ctl, clock, toolsCalled } = rig({ clearance: "sensitive" });
    ctl.load(shared);
    clock.advance(100);
    await flush();
    expect(toolsCalled()).toEqual([]);
    expect(store.status("pay")).toBeUndefined();
    expect(store.handles()).not.toContain("pay");
  });
  it("a recompose that classifies a loaded handle drops its value", async () => {
    const { store, ctl, clock } = rig({ clearance: "internal" });
    const g = exp();
    const open: Experience = {
      ...g,
      root: { ...(g.root as ContainerNode), children: [node("a", "pay")] },
    };
    ctl.load(open);
    clock.advance(100);
    await flush();
    expect(store.value("pay")).toEqual({ v: "tool.pay" });
    const classified: Experience = {
      ...open,
      versionHash: "sha256:v2",
      root: { ...(g.root as ContainerNode), children: [node("a", "pay", "sensitive")] },
    };
    ctl.recompose(classified);
    clock.advance(100);
    await flush();
    expect(store.value("pay")).toBeUndefined();
    expect(store.status("pay")).toBeUndefined();
    expect(store.handles()).not.toContain("pay");
  });
});

describe("restricted handles leave no trace; class changes mid-flight (U10 fix round 1)", () => {
  const gated = () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const clock = new ManualClock();
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const cache = new HydrationCache(clock.now);
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, async (i) => {
      await gate;
      return { v: (i as { toolName: string }).toolName };
    });
    const mk = (viewer?: { clearance?: "secret" | "sensitive" | "internal" }) =>
      new HydrationController({
        invoker: inv,
        store,
        clock: clock.now,
        setTimer: clock.setTimer,
        cache,
        ...(viewer !== undefined && { viewer }),
      });
    return { store, clock, cache, release: () => release(), mk, inv };
  };
  const only = (sens?: "sensitive"): Experience => {
    const g = exp();
    return {
      ...g,
      root: { ...(g.root as ContainerNode), children: [node("a", "pay", sens)] },
    };
  };

  it("raising a handle's class while its load is IN FLIGHT: the late value never lands", async () => {
    const { store, clock, release, mk } = gated();
    const ctl = mk({ clearance: "internal" });
    ctl.load(only());
    clock.advance(100);
    await flush();
    expect(ctl.inFlight()).toEqual(["pay"]);
    ctl.recompose({ ...only("sensitive"), versionHash: "sha256:v2" });
    release();
    clock.advance(100);
    await flush();
    expect(store.value("pay")).toBeUndefined();
    expect(store.status("pay")).toBeUndefined();
    expect(store.handles()).not.toContain("pay");
    expect(ctl.inFlight()).toEqual([]);
  });

  it("setViewer downgrade drops a loaded value; an upgrade loads it", async () => {
    const { store, clock, release, mk } = gated();
    release();
    const ctl = mk({ clearance: "sensitive" });
    ctl.load(only("sensitive"));
    clock.advance(100);
    await flush();
    expect(store.value("pay")).toEqual({ v: "tool.pay" });
    ctl.setViewer({ clearance: "internal" });
    expect(store.value("pay")).toBeUndefined();
    expect(store.handles()).not.toContain("pay");
    ctl.setViewer({ clearance: "secret" });
    clock.advance(100);
    await flush();
    expect(store.value("pay")).toEqual({ v: "tool.pay" });
  });

  it("mutating the caller's viewer object after construction changes nothing", async () => {
    const { store, clock, release, mk } = gated();
    release();
    const viewer: { clearance?: "secret" | "sensitive" | "internal" } = { clearance: "internal" };
    const ctl = mk(viewer);
    viewer.clearance = "secret"; // a live read would now see everything
    ctl.load(only("sensitive"));
    clock.advance(100);
    await flush();
    expect(store.value("pay")).toBeUndefined();
  });

  it("a lower-cleared controller on a store that already holds the value removes it", async () => {
    const { store, clock, release, mk } = gated();
    release();
    mk({ clearance: "secret" }).load(only("sensitive"));
    clock.advance(100);
    await flush();
    expect(store.value("pay")).toEqual({ v: "tool.pay" });
    mk({ clearance: "internal" }).load(only("sensitive"));
    expect(store.value("pay")).toBeUndefined();
    expect(store.handles()).not.toContain("pay");
  });

  it("a refused server request is reported to onFinding once, as the true reason", async () => {
    const e = exp();
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: 1 }));
    const logged: string[] = [];
    const res = await serveHandle(
      e,
      { experienceId: e.experienceId, versionHash: e.versionHash, handle: "audit", params: {} },
      {
        invoker: inv,
        now: 0,
        viewer: { clearance: "internal" },
        onFinding: (_h, f) => logged.push(f.code),
      }
    );
    expect(res.finding?.code).toBe("unknown-handle");
    expect(logged).toEqual(["restricted"]);
  });
});

describe("split hydration with a viewer (U10)", () => {
  const revisionOf = (h: string, f: string) => `r-${h}-${f.length}-${f.charCodeAt(1)}`;
  it("omits restricted handles from the inventory: neither name nor revision is listed", () => {
    const { inventory, findings } = handleInventory(exp(), {
      revisionOf,
      viewer: { clearance: "internal" },
    });
    expect(inventory.handles.map((h) => h.handle)).toEqual(["open"]);
    expect(JSON.stringify(inventory)).not.toMatch(/pay|audit/);
    expect(findings).toEqual([]);
  });
  it("no viewer: classified handles omitted, one advisory", () => {
    const { inventory, findings } = handleInventory(exp(), { revisionOf });
    expect(inventory.handles.map((h) => h.handle)).toEqual(["open"]);
    expect(findings.map((f) => f.code)).toEqual(["viewer-not-supplied"]);
  });
  it("a cleared viewer's inventory lists them", () => {
    const { inventory } = handleInventory(exp(), { revisionOf, viewer: { clearance: "secret" } });
    expect(inventory.handles.map((h) => h.handle)).toEqual(["audit", "open", "pay"]);
  });
  const req = (e: Experience, handle: string) => ({
    experienceId: e.experienceId,
    versionHash: e.versionHash,
    handle,
    params: {},
  });
  it("the server refuses a classified handle a client names anyway, never calling or caching it", async () => {
    const e = exp();
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: 1 }));
    const logged: string[] = [];
    const cache = new HydrationCache(() => 0);
    const [open, pay, ghost] = await serveHandles(
      e,
      [req(e, "open"), req(e, "pay"), req(e, "nope")],
      {
        invoker: inv,
        now: 0,
        cache,
        viewer: { clearance: "internal" },
        onFinding: (_h, f) => logged.push(f.code),
      }
    );
    expect(open?.state).toBe("ready");
    expect(inv.calls).toHaveLength(1);
    // indistinguishable from a handle the experience does not bind: no oracle
    expect(pay?.state).toBe("error");
    expect(pay).toEqual({
      ...ghost,
      finding: {
        ...ghost?.finding,
        message: (ghost?.finding?.message ?? "").replace("nope", "pay"),
      },
    });
    expect(logged).toContain("restricted");
  });
  it("serveHandle with no viewer refuses classified handles (fail-closed), serves unclassified", async () => {
    const e = exp();
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: 1 }));
    expect((await serveHandle(e, req(e, "audit"), { invoker: inv, now: 0 })).state).toBe("error");
    expect(inv.calls).toHaveLength(0);
    expect((await serveHandle(e, req(e, "open"), { invoker: inv, now: 0 })).state).toBe("ready");
    expect(
      (
        await serveHandle(e, req(e, "audit"), {
          invoker: inv,
          now: 0,
          viewer: { clearance: "secret" },
        })
      ).state
    ).toBe("ready");
  });
});
