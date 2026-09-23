import { describe, expect, it } from "vitest";
import { HydrationCache } from "./cache";
import { ManualClock, mcpStep, providerSpec } from "./testing.test-support";

describe("HydrationCache", () => {
  it("global scope is shared across principals and expires by ttl against the injected clock", () => {
    const clock = new ManualClock();
    const c = new HydrationCache(clock.now);
    const spec = providerSpec("h", [mcpStep("s", "t")], {
      cachePolicy: { ttlSeconds: 10, scope: "global" },
    });
    c.set(spec, "alice", 1);
    expect(c.get(spec, "bob")).toEqual({ value: 1 });
    clock.advance(9_999);
    expect(c.get(spec, undefined)).toEqual({ value: 1 });
    clock.advance(1);
    expect(c.get(spec, undefined)).toBeUndefined();
  });
  it("principal scope isolates principals and refuses to cache without one", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")], {
      cachePolicy: { ttlSeconds: 10, scope: "principal" },
    });
    c.set(spec, "alice", "A");
    expect(c.get(spec, "alice")).toEqual({ value: "A" });
    expect(c.get(spec, "bob")).toBeUndefined();
    c.set(spec, undefined, "anon");
    expect(c.get(spec, undefined)).toBeUndefined();
  });
  it("invalidate(handle) drops every scope of that handle; invalidate() drops all; ttl 0 never caches", () => {
    const c = new HydrationCache(() => 0);
    const g = providerSpec("h", [mcpStep("s", "t")]);
    const p = providerSpec("h", [mcpStep("s", "t")], {
      cachePolicy: { ttlSeconds: 10, scope: "principal" },
    });
    c.set(g, undefined, 1);
    c.set(p, "alice", 2);
    c.invalidate("h");
    expect(c.get(g, undefined)).toBeUndefined();
    expect(c.get(p, "alice")).toBeUndefined();
    c.set(
      providerSpec("z", [mcpStep("s", "t")], { cachePolicy: { ttlSeconds: 0, scope: "global" } }),
      undefined,
      3
    );
    expect(c.get(providerSpec("z", [mcpStep("s", "t")]), undefined)).toBeUndefined();
  });
  it("two SPECS for one handle are two entries — a repaired provider never reads the old spec's value", () => {
    const c = new HydrationCache(() => 0);
    const v1 = providerSpec("h", [mcpStep("s", "t")]);
    const v2 = providerSpec("h", [{ ...mcpStep("s", "t"), toolSchemaHash: "v2" }]);
    c.set(v1, undefined, 1);
    c.set(v2, undefined, 2);
    expect(c.get(v1, undefined)).toEqual({ value: 1 });
    expect(c.get(v2, undefined)).toEqual({ value: 2 });
    // The key is the spec's CONTENT, not its object identity: an equal spec hits the same entry.
    expect(c.get(providerSpec("h", [mcpStep("s", "t")]), undefined)).toEqual({ value: 1 });
    c.invalidate("h"); // still drops every spec-generation of the handle
    expect(c.get(v1, undefined)).toBeUndefined();
    expect(c.get(v2, undefined)).toBeUndefined();
  });
  it("invalidate(handle) never mis-hits a different handle that contains the delimiter as text", () => {
    const c = new HydrationCache(() => 0);
    const h = providerSpec("h", [mcpStep("s", "t")]);
    const xh = providerSpec("x:h", [mcpStep("s", "t")]);
    c.set(h, undefined, 1);
    c.set(xh, undefined, 2);
    c.invalidate("h");
    expect(c.get(h, undefined)).toBeUndefined();
    expect(c.get(xh, undefined)).toEqual({ value: 2 });
  });

  it("a contract-mode spec's key includes the checked kinds: different kinds are different entries", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")], { outputCheck: "contract" });
    c.set(spec, undefined, "kpi-only", ["Kpi"]);
    expect(c.get(spec, undefined, ["Kpi"])).toEqual({ value: "kpi-only" });
    // Not yet checked against this wider set: no entry, never the narrower one's value.
    expect(c.get(spec, undefined, ["Kpi", "MetricCard"])).toBeUndefined();
    c.set(spec, undefined, "widened", ["Kpi", "MetricCard"]);
    expect(c.get(spec, undefined, ["Kpi", "MetricCard"])).toEqual({ value: "widened" });
    // The narrower entry is untouched by the wider one.
    expect(c.get(spec, undefined, ["Kpi"])).toEqual({ value: "kpi-only" });
  });

  it("kinds are sorted and deduplicated before keying: order and repeats don't matter", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")], { outputCheck: "contract" });
    c.set(spec, undefined, "v", ["MetricCard", "Kpi"]);
    expect(c.get(spec, undefined, ["Kpi", "MetricCard"])).toEqual({ value: "v" });
    expect(c.get(spec, undefined, ["Kpi", "Kpi", "MetricCard"])).toEqual({ value: "v" });
  });

  it("a shape-mode spec's key ignores kinds entirely (existing behavior, unchanged)", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")]); // outputCheck unset
    c.set(spec, undefined, "v", ["Kpi"]);
    expect(c.get(spec, undefined, ["MetricCard"])).toEqual({ value: "v" });
    expect(c.get(spec, undefined)).toEqual({ value: "v" });
  });

  it("invalidate(handle) drops every kinds-generation of a contract spec too", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")], { outputCheck: "contract" });
    c.set(spec, undefined, "a", ["Kpi"]);
    c.set(spec, undefined, "b", ["Kpi", "MetricCard"]);
    c.invalidate("h");
    expect(c.get(spec, undefined, ["Kpi"])).toBeUndefined();
    expect(c.get(spec, undefined, ["Kpi", "MetricCard"])).toBeUndefined();
  });
});
