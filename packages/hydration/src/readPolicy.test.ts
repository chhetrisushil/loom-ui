import { type ContainerNode, type Experience, type SemanticNode, genesis } from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationCache } from "./cache";
import { HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import { createServeSurface, handleInventory, serveHandle } from "./split/index";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

// U10b round 2: the serve surface binds the read policy ONCE, so the inventory and the loader cannot
// disagree about a handle because one call forgot the table; and `undeclared: "deny"`.

const meta = { author: "a", createdAt: "2026-10-07T00:00:00Z", sourceKind: "prompt" };
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
// `open` calls a LISTED tool (internal), `pay` a declared-secret one, `fresh` a tool nobody listed.
const exp = (): Experience => {
  const g = genesis({ experienceId: "exp-1", intent: { objective: "x", source: "user" }, meta });
  return {
    ...g,
    versionHash: "sha256:v1",
    root: {
      ...(g.root as ContainerNode),
      children: [node("a", "open"), node("b", "pay"), node("c", "fresh")],
    },
    providers: Object.fromEntries(
      ["open", "pay", "fresh"].map((h) => [h, providerSpec(h, [mcpStep("s", `tool.${h}`)])])
    ),
  };
};
const policy = { declaredToolClasses: { "tool.open": "internal", "tool.pay": "secret" } } as const;
const low = { clearance: "internal" } as const;
const high = { clearance: "secret" } as const;
const revisionOf = (h: string, f: string) => `r-${h}-${f.length}-${f.charCodeAt(1)}`;
const names = (r: { inventory: { handles: readonly { handle: string }[] } }) =>
  r.inventory.handles.map((h) => h.handle).sort();
const req = (e: Experience, handle: string) => ({
  experienceId: e.experienceId,
  versionHash: e.versionHash,
  handle,
  params: {},
});

describe("createServeSurface: the policy is bound once", () => {
  it("inventory and serve both apply it with NO per-call table (a low viewer)", async () => {
    const surface = createServeSurface(policy);
    const e = exp();
    expect(names(surface.handleInventory(e, { revisionOf, viewer: low }))).toEqual([
      "fresh",
      "open",
    ]);
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: 1 }));
    expect(
      (await surface.serveHandle(e, req(e, "pay"), { invoker: inv, now: 0, viewer: low })).state
    ).toBe("error");
    expect(inv.calls).toHaveLength(0);
    const [open] = await surface.serveHandles(e, [req(e, "open")], {
      invoker: inv,
      now: 0,
      viewer: low,
    });
    expect(open?.state).toBe("ready");
    // a cleared viewer still gets it
    expect(names(surface.handleInventory(e, { revisionOf, viewer: high }))).toEqual([
      "fresh",
      "open",
      "pay",
    ]);
    // ... while the LOW-LEVEL free functions without the table do not (the documented footgun)
    expect(names(handleInventory(e, { revisionOf, viewer: low }))).toContain("pay");
    expect((await serveHandle(e, req(e, "pay"), { invoker: inv, now: 0, viewer: low })).state).toBe(
      "ready"
    );
  });

  it("per-call {} / undefined / a lower table cannot lower it", async () => {
    const surface = createServeSurface(policy);
    const e = exp();
    for (const perCall of [
      {},
      { declaredToolClasses: undefined },
      { declaredToolClasses: {} },
      { declaredToolClasses: { "tool.pay": "internal" as const } },
      { undeclared: "allow" as const },
    ]) {
      expect(
        names(surface.handleInventory(e, { revisionOf, viewer: low, ...perCall } as never))
      ).not.toContain("pay");
      const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: 1 }));
      const r = await surface.serveHandle(e, req(e, "pay"), {
        invoker: inv,
        now: 0,
        viewer: low,
        ...perCall,
      } as never);
      expect(r.state).toBe("error");
      expect(inv.calls).toHaveLength(0);
    }
  });

  it("a per-call table adds to an empty surface; no policy = the experience's own classes", () => {
    const e = exp();
    expect(names(createServeSurface().handleInventory(e, { revisionOf, viewer: low }))).toContain(
      "pay"
    );
    expect(
      names(createServeSurface().handleInventory(e, { revisionOf, viewer: low, ...policy }))
    ).not.toContain("pay");
  });

  it('undeclared: "deny" bound once hides the unlisted tool\'s handle from every viewer; allow does not', async () => {
    const strict = createServeSurface({ ...policy, undeclared: "deny" });
    const e = exp();
    for (const viewer of [low, high]) {
      expect(names(strict.handleInventory(e, { revisionOf, viewer }))).not.toContain("fresh");
      const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: 1 }));
      expect(
        (await strict.serveHandle(e, req(e, "fresh"), { invoker: inv, now: 0, viewer })).state
      ).toBe("error");
      expect(inv.calls).toHaveLength(0);
    }
    expect(names(strict.handleInventory(e, { revisionOf, viewer: high }))).toEqual(["open", "pay"]);
    const lax = createServeSurface(policy);
    expect(names(lax.handleInventory(e, { revisionOf, viewer: high }))).toContain("fresh");
    // per-call deny adds
    expect(
      names(lax.handleInventory(e, { revisionOf, viewer: high, undeclared: "deny" }))
    ).not.toContain("fresh");
  });

  it("exposes the bound policy", () => {
    expect(createServeSurface(policy).policy).toEqual(policy);
    expect(createServeSurface().policy).toEqual({});
  });
});

describe("HydrationController: undeclared", () => {
  const run = async (undeclared?: "deny") => {
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
      viewer: high,
      declaredToolClasses: policy.declaredToolClasses,
      ...(undeclared !== undefined && { undeclared }),
    });
    ctl.load(exp());
    clock.advance(100);
    await flush();
    return inv.calls.map((c) => (c.input as { toolName: string }).toolName).sort();
  };
  it("allow loads the unlisted tool; deny never calls it, even for a cleared viewer", async () => {
    expect(await run()).toEqual(["tool.fresh", "tool.open", "tool.pay"]);
    expect(await run("deny")).toEqual(["tool.open", "tool.pay"]);
  });
});
