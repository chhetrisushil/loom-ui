import { type ContainerNode, type Experience, type SemanticNode, genesis } from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationCache } from "./cache";
import { HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import { handleInventory, serveHandle, serveHandles } from "./split/index";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

// A broadcast surface (`compile({ audience: "broadcast" })`) withholds every classified binding
// whoever asked. The data boundary must agree: a handle compile withheld is refused if a client
// names it, even with a fully cleared viewer, and its provider is never called.

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const node = (id: string, handle: string, sensitivity?: "secret" | "sensitive"): SemanticNode => ({
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
const req = (e: Experience, handle: string) => ({
  experienceId: e.experienceId,
  versionHash: e.versionHash,
  handle,
  params: {},
});
const cleared = { clearance: "secret" as const };

describe("audience at the data boundary", () => {
  it("the controller loads only unclassified handles for a broadcast audience, even for a cleared viewer", async () => {
    const clock = new ManualClock();
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (i) => ({
      v: (i as { toolName: string }).toolName,
    }));
    const ctl = new HydrationController({
      contentRefArgs: "none" as const,
      invoker: inv,
      store,
      clock: clock.now,
      setTimer: clock.setTimer,
      cache: new HydrationCache(clock.now),
      viewer: cleared,
      audience: "broadcast",
    });
    const { findings } = ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(inv.calls.map((c) => (c.input as { toolName: string }).toolName)).toEqual(["tool.open"]);
    for (const h of ["pay", "audit"]) {
      expect(store.value(h)).toBeUndefined();
      expect(store.status(h)).toBeUndefined();
      expect(store.handles()).not.toContain(h);
    }
    // The viewer is not what is missing: no advisory about it.
    expect(findings.map((f) => f.code)).not.toContain("viewer-not-supplied");
    // setViewer cannot lift the ceiling.
    ctl.setViewer(cleared);
    clock.advance(100);
    await flush();
    expect(store.value("pay")).toBeUndefined();
    expect(inv.calls).toHaveLength(1);
  });

  it("control: the same cleared viewer without an audience loads everything", async () => {
    const clock = new ManualClock();
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: 1 }));
    const ctl = new HydrationController({
      contentRefArgs: "none" as const,
      invoker: inv,
      store,
      clock: clock.now,
      setTimer: clock.setTimer,
      cache: new HydrationCache(clock.now),
      viewer: cleared,
    });
    ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(inv.calls).toHaveLength(3);
  });

  it("the inventory omits withheld handles for a broadcast audience, neither name nor revision", () => {
    const revisionOf = (h: string) => `r-${h}`;
    const { inventory, findings } = handleInventory(exp(), {
      revisionOf,
      viewer: cleared,
      audience: "broadcast",
    });
    expect(inventory.handles.map((h) => h.handle)).toEqual(["open"]);
    expect(JSON.stringify(inventory)).not.toMatch(/pay|audit/);
    expect(findings).toEqual([]);
    expect(
      handleInventory(exp(), { revisionOf, viewer: cleared }).inventory.handles.map((h) => h.handle)
    ).toEqual(["audit", "open", "pay"]);
  });

  it("serveHandles refuses a handle a client names that the audience may not see, as unknown-handle, never calling it", async () => {
    const e = exp();
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: 1 }));
    const logged: string[] = [];
    const [open, pay, ghost] = await serveHandles(
      e,
      [req(e, "open"), req(e, "pay"), req(e, "nope")],
      {
        contentRefArgs: "none" as const,
        invoker: inv,
        now: 0,
        cache: new HydrationCache(() => 0),
        viewer: cleared,
        audience: "broadcast",
        onFinding: (_h, f) => logged.push(f.code),
      }
    );
    expect(open?.state).toBe("ready");
    expect(inv.calls).toHaveLength(1);
    expect(pay?.state).toBe("error");
    expect(pay?.finding?.code).toBe(ghost?.finding?.code);
    expect(pay?.finding?.code).toBe("unknown-handle");
    expect(logged).toContain("restricted");
    // serveHandle agrees, and the unaudienced control serves it.
    const one = await serveHandle(e, req(e, "audit"), {
      contentRefArgs: "none" as const,
      invoker: inv,
      now: 0,
      viewer: cleared,
      audience: "broadcast",
    });
    expect(one.state).toBe("error");
    expect(inv.calls).toHaveLength(1);
    const ok = await serveHandle(e, req(e, "audit"), {
      contentRefArgs: "none" as const,
      invoker: inv,
      now: 0,
      viewer: cleared,
    });
    expect(ok.state).toBe("ready");
  });
});
