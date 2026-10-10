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
    c.set(spec, undefined, "kpi-only", { kinds: ["Kpi"] });
    expect(c.get(spec, undefined, { kinds: ["Kpi"] })).toEqual({ value: "kpi-only" });
    // Not yet checked against this wider set: no entry, never the narrower one's value.
    expect(c.get(spec, undefined, { kinds: ["Kpi", "MetricCard"] })).toBeUndefined();
    c.set(spec, undefined, "widened", { kinds: ["Kpi", "MetricCard"] });
    expect(c.get(spec, undefined, { kinds: ["Kpi", "MetricCard"] })).toEqual({ value: "widened" });
    // The narrower entry is untouched by the wider one.
    expect(c.get(spec, undefined, { kinds: ["Kpi"] })).toEqual({ value: "kpi-only" });
  });

  it("kinds are sorted and deduplicated before keying: order and repeats don't matter", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")], { outputCheck: "contract" });
    c.set(spec, undefined, "v", { kinds: ["MetricCard", "Kpi"] });
    expect(c.get(spec, undefined, { kinds: ["Kpi", "MetricCard"] })).toEqual({ value: "v" });
    expect(c.get(spec, undefined, { kinds: ["Kpi", "Kpi", "MetricCard"] })).toEqual({ value: "v" });
  });

  it("a shape-mode spec's key ignores kinds entirely (existing behavior, unchanged)", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")]); // outputCheck unset
    c.set(spec, undefined, "v", { kinds: ["Kpi"] });
    expect(c.get(spec, undefined, { kinds: ["MetricCard"] })).toEqual({ value: "v" });
    expect(c.get(spec, undefined)).toEqual({ value: "v" });
  });

  it("invalidate(handle) drops every kinds-generation of a contract spec too", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")], { outputCheck: "contract" });
    c.set(spec, undefined, "a", { kinds: ["Kpi"] });
    c.set(spec, undefined, "b", { kinds: ["Kpi", "MetricCard"] });
    c.invalidate("h");
    expect(c.get(spec, undefined, { kinds: ["Kpi"] })).toBeUndefined();
    expect(c.get(spec, undefined, { kinds: ["Kpi", "MetricCard"] })).toBeUndefined();
  });
});
describe("HydrationCache variants", () => {
  it("params are part of the key: another param set misses, the same set in any key order hits", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")]);
    c.set(spec, undefined, "ridge-7d", { params: { station: "ridge", from: "$now-7d" } });
    expect(c.get(spec, undefined, { params: { from: "$now-7d", station: "ridge" } })).toEqual({
      value: "ridge-7d",
    });
    expect(
      c.get(spec, undefined, { params: { station: "harbour", from: "$now-7d" } })
    ).toBeUndefined();
    expect(c.get(spec, undefined)).toBeUndefined();
  });

  it("the checked kinds are part of the key (for a contract spec)", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")], { outputCheck: "contract" });
    c.set(spec, undefined, 1, { kinds: ["Kpi"] });
    expect(c.get(spec, undefined, { kinds: ["Kpi"] })).toEqual({ value: 1 });
    expect(c.get(spec, undefined, { kinds: ["MetricCard"] })).toBeUndefined();
  });

  it("invalidate(handle) drops every variant of that handle", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")]);
    c.set(spec, undefined, 1, { params: { a: 1 } });
    c.set(spec, undefined, 2, { params: { a: 2 } });
    c.invalidate("h");
    expect(c.get(spec, undefined, { params: { a: 1 } })).toBeUndefined();
    expect(c.get(spec, undefined, { params: { a: 2 } })).toBeUndefined();
  });

  it("params that cannot be keyed are never cached", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")]);
    c.set(spec, undefined, 1, { params: { a: Number.NaN } });
    expect(c.get(spec, undefined, { params: { a: Number.NaN } })).toBeUndefined();
  });
});

describe("HydrationCache variants — params and kinds together", () => {
  it("time tokens are keyed AS DECLARED: $now-7d is one key across instants; freshness is the TTL", () => {
    let t = 0;
    const c = new HydrationCache(() => t);
    const spec = providerSpec("h", [mcpStep("s", "t")]);
    c.set(spec, undefined, "v", { params: { from: "$now-7d" } });
    t = 30_000;
    expect(c.get(spec, undefined, { params: { from: "$now-7d" } })).toEqual({ value: "v" });
    t = 60_000;
    expect(c.get(spec, undefined, { params: { from: "$now-7d" } })).toBeUndefined();
  });

  it("a contract spec keys params AND kinds; kinds are normalised", () => {
    const c = new HydrationCache(() => 0);
    const spec = providerSpec("h", [mcpStep("s", "t")], { outputCheck: "contract" });
    c.set(spec, undefined, "v", { params: { a: 1 }, kinds: ["MetricCard", "Kpi"] });
    expect(
      c.get(spec, undefined, { params: { a: 1 }, kinds: ["Kpi", "Kpi", "MetricCard"] })
    ).toEqual({
      value: "v",
    });
    expect(
      c.get(spec, undefined, { params: { a: 2 }, kinds: ["Kpi", "MetricCard"] })
    ).toBeUndefined();
    expect(c.get(spec, undefined, { kinds: ["Kpi", "MetricCard"] })).toBeUndefined();
  });
});

describe("HydrationCache is bounded (U17)", () => {
  const spec = (h: string) =>
    providerSpec(h, [mcpStep("s", `t.${h}`)], { cachePolicy: { ttlSeconds: 10, scope: "global" } });

  it("evicts the least recently used entry past maxEntries; a get promotes", () => {
    const c = new HydrationCache(() => 0, { maxEntries: 2 });
    c.set(spec("a"), undefined, 1);
    c.set(spec("b"), undefined, 2);
    expect(c.get(spec("a"), undefined)).toEqual({ value: 1 }); // a is now the most recent
    c.set(spec("c"), undefined, 3); // evicts b, not a
    expect(c.size).toBe(2);
    expect(c.get(spec("b"), undefined)).toBeUndefined();
    expect(c.get(spec("a"), undefined)).toEqual({ value: 1 });
    expect(c.get(spec("c"), undefined)).toEqual({ value: 3 });
  });

  it("never exceeds the cap however many distinct questions are asked", () => {
    const c = new HydrationCache(() => 0, { maxEntries: 50 });
    for (let i = 0; i < 5_000; i++) c.set(spec(`h${i}`), undefined, i);
    expect(c.size).toBe(50);
    expect(c.get(spec("h4999"), undefined)).toEqual({ value: 4999 });
    expect(c.get(spec("h0"), undefined)).toBeUndefined();
  });

  it("re-setting a key does not grow the cache or evict a neighbour", () => {
    const c = new HydrationCache(() => 0, { maxEntries: 2 });
    c.set(spec("a"), undefined, 1);
    c.set(spec("b"), undefined, 2);
    c.set(spec("b"), undefined, 3);
    expect(c.size).toBe(2);
    expect(c.get(spec("a"), undefined)).toEqual({ value: 1 });
  });

  it("has a generous default and refuses a nonsensical cap", () => {
    expect(() => new HydrationCache(() => 0, { maxEntries: 0 })).toThrow(RangeError);
    expect(() => new HydrationCache(() => 0, { maxEntries: 1.5 })).toThrow(RangeError);
    const c = new HydrationCache(() => 0);
    for (let i = 0; i < 2_000; i++) c.set(spec(`h${i}`), undefined, i);
    expect(c.size).toBe(2_000); // small data: nothing is evicted
  });
});
