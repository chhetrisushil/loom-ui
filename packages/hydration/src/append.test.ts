import {
  type ContainerNode,
  type Experience,
  type SemanticNode,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import { FakeInvoker, ManualClock, flush, mcpStep, providerSpec } from "./testing.test-support";

const mk = () => new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });

describe("HydrationStore.append — token streams into a handle", () => {
  it("accumulates chunks into the handle's string value; pending while open, ready on done", () => {
    const s = mk();
    expect(s.append("t", { seq: 0, text: "Hel" })).toEqual({ ok: true, applied: true });
    expect(s.value("t")).toBe("Hel");
    expect(s.status("t")?.state).toBe("pending");
    s.append("t", { seq: 1, text: "lo", done: true });
    expect(s.value("t")).toBe("Hello");
    expect(s.status("t")?.state).toBe("ready");
  });

  it("is idempotent: a redelivered chunk emits nothing (no re-render, no double token)", () => {
    const s = mk();
    s.append("t", { seq: 0, text: "a" });
    const seen: unknown[] = [];
    s.subscribe("t", (x) => seen.push(x.value));
    expect(s.append("t", { seq: 0, text: "a" })).toEqual({ ok: true, applied: false });
    expect(seen).toEqual([]);
    expect(s.value("t")).toBe("a");
  });

  it("refuses a gap, a closed stream and a bad chunk with a finding, leaving the value untouched", () => {
    const s = mk();
    s.append("t", { seq: 0, text: "a", done: true });
    for (const [chunk, code] of [
      [{ seq: 1, text: "b" }, "stream-closed"],
      [{ seq: "x" }, "stream-chunk-invalid"],
    ] as const) {
      const r = s.append("t", chunk);
      expect(!r.ok && r.finding.code).toBe(code);
    }
    expect(s.value("t")).toBe("a");
    const g = mk();
    g.append("u", { seq: 0, text: "a" });
    const r = g.append("u", { seq: 5, text: "z" });
    expect(!r.ok && r.finding.code).toBe("stream-gap");
    expect(g.value("u")).toBe("a");
  });

  it("ORDERING vs a replace: setValue / remove / empty end the stream; a stale producer's tail is refused, not spliced in", () => {
    const s = mk();
    s.append("t", { seq: 0, text: "old " });
    // the controller re-loads the handle (supersede): a whole-value replace wins
    s.setValue("t", "fresh", { state: "ready" });
    const tail = s.append("t", { seq: 1, text: "tail" });
    expect(!tail.ok && tail.finding.code).toBe("stream-gap");
    expect(s.value("t")).toBe("fresh");
    // a NEW stream starts at 0 and replaces the value wholesale
    s.append("t", { seq: 0, text: "next" });
    expect(s.value("t")).toBe("next");
    s.remove("t");
    expect(s.append("t", { seq: 1, text: "x" }).ok).toBe(false);
    s.append("e", { seq: 0, text: "x" });
    s.setStatus("e", { state: "empty" });
    expect(s.append("e", { seq: 1, text: "y" }).ok).toBe(false);
  });

  it("refuses a reserved handle like every other writer", () => {
    expect(() => mk().append("__proto__", { seq: 0, text: "x" })).toThrow(/reserved/);
  });

  it("streams are per store: two viewers of one experience never share a token", () => {
    const rt = new InMemoryProjectionRuntime();
    const a = new HydrationStore(rt, { experienceId: "e", principalId: "a" });
    const b = new HydrationStore(rt, { experienceId: "e", principalId: "b" });
    a.append("t", { seq: 0, text: "secret" });
    expect(b.value("t")).toBeUndefined();
  });
});

describe("appends go through the viewer gate (U10) — a controller fronts the store", () => {
  const catalog = defineSemanticCatalog({
    id: "append.gate.v1",
    entries: [
      {
        name: "Say",
        version: "1.0.0",
        props: [],
        binding: "required",
        surfaces: { web: { kind: "StreamingText", props: [], binding: "required" } },
      },
      {
        name: "Num",
        version: "1.0.0",
        props: [],
        binding: "required",
        surfaces: { web: { kind: "Kpi", props: [], binding: "required" } },
      },
    ],
  });
  const node = (
    id: string,
    type: string,
    handle: string,
    sensitivity?: "secret" | "internal"
  ): SemanticNode => ({
    id,
    order: id,
    kind: "semantic",
    type,
    typeVersion: "1.0.0",
    span: 4,
    props: {},
    binding: { handle, priority: "P0", ...(sensitivity && { sensitivity }) },
  });
  const exp = (): Experience => {
    const g = genesis({
      experienceId: "exp-1",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "test" },
    });
    const handles = ["say", "audit", "num"];
    return {
      ...g,
      versionHash: "sha256:v1",
      root: {
        ...(g.root as ContainerNode),
        children: [
          node("a", "Say", "say"),
          node("b", "Say", "audit", "secret"),
          node("c", "Num", "num"),
        ],
      },
      providers: Object.fromEntries(
        handles.map((h) => [h, providerSpec(h, [mcpStep("s", `tool.${h}`)])])
      ),
    };
  };
  const rig = (viewer: { clearance?: "secret" | "internal" } | undefined, kinds = true) => {
    const clock = new ManualClock();
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const ctl = new HydrationController({
      invoker: new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({})),
      store,
      clock: clock.now,
      setTimer: clock.setTimer,
      ...(viewer !== undefined && { viewer }),
      ...(kinds && { outputKinds: { catalog, surface: "web" as const } }),
    });
    return { store, ctl, clock };
  };
  const refused = (r: ReturnType<HydrationStore["append"]>) => (r.ok ? undefined : r.finding.code);

  it("a handle restricted for the viewer is refused, and its value never reaches the store", async () => {
    const { store, ctl, clock } = rig({ clearance: "internal" });
    ctl.load(exp());
    clock.advance(100);
    await flush();
    const r = ctl.append("audit", { seq: 0, text: "TOP SECRET" });
    expect(refused(r)).toBe("restricted");
    expect(store.value("audit")).toBeUndefined();
    expect(store.status("audit")).toBeUndefined();
    // the store's own append is gated the same way once a controller fronts it
    expect(refused(store.append("audit", { seq: 0, text: "TOP SECRET" }))).toBe("restricted");
    expect(JSON.stringify(store.state())).not.toContain("TOP SECRET");
  });

  it("a cleared viewer may stream into it", async () => {
    const { store, ctl, clock } = rig({ clearance: "secret" });
    ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(ctl.append("audit", { seq: 0, text: "ok" })).toEqual({ ok: true, applied: true });
    expect(store.value("audit")).toBe("ok");
  });

  it("an unbound handle, and a handle bound to a non-StreamingText widget, are refused", async () => {
    const { store, ctl, clock } = rig({ clearance: "internal" });
    expect(refused(ctl.append("say", { seq: 0, text: "x" }))).toBe("stream-unbound"); // before load
    ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(refused(ctl.append("ghost", { seq: 0, text: "x" }))).toBe("stream-unbound");
    expect(refused(ctl.append("num", { seq: 0, text: "x" }))).toBe("stream-kind-mismatch");
    expect(store.value("ghost")).toBeUndefined();
    expect(ctl.append("say", { seq: 0, text: "hi" })).toEqual({ ok: true, applied: true });
    expect(store.value("say")).toBe("hi");
  });

  it("a viewer change re-gates: a handle the new viewer may not see stops accepting chunks", async () => {
    const { store, ctl, clock } = rig({ clearance: "secret" });
    ctl.load(exp());
    clock.advance(100);
    await flush();
    expect(ctl.append("audit", { seq: 0, text: "a" }).ok).toBe(true);
    ctl.setViewer({ clearance: "internal" });
    expect(refused(ctl.append("audit", { seq: 1, text: "b" }))).toBe("restricted");
    expect(store.value("audit")).toBeUndefined(); // the recompose removed it; nothing re-landed
  });
});
