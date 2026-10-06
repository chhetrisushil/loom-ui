import { describe, expect, it } from "vitest";
import { type Experience, genesis } from "./experience";
import type { SemanticNode } from "./node";
import { type Operation, apply } from "./operations";
import {
  MAX_SEEN_SOURCES,
  MAX_SEEN_TOTAL_BYTES,
  MAX_SEEN_VALUE_BYTES,
  type SeenEntry,
  redactSeen,
  seenToState,
  snapshotSeen,
} from "./seen";

const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const sem = (id: string, extra: Partial<SemanticNode> = {}): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  ...extra,
});
const bound = (id: string, handle: string, sensitivity?: "secret" | "internal") =>
  sem(id, { binding: { handle, priority: "P1", ...(sensitivity && { sensitivity }) } });
const build = (...nodes: SemanticNode[]): Experience => {
  let cur = genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta });
  for (const n of nodes) {
    const op: Operation = { type: "insertNode", parentId: "root", node: n };
    const r = apply(cur, op);
    if (!r.ok) throw new Error(r.finding.message);
    cur = r.value;
  }
  return { ...cur, versionHash: "sha256:v" };
};
const cleared = { clearance: "secret" as const };
const store = (m: Record<string, unknown>) => (s: { kind: string; handle?: string }) =>
  s.kind === "handle" && s.handle !== undefined && Object.hasOwn(m, s.handle)
    ? { found: true, value: m[s.handle], status: "ready" }
    : { found: false, status: "pending" };

describe("snapshotSeen", () => {
  it("captures the delivered value per source, one entry for nodes sharing a handle, classified", () => {
    const exp = build(bound("a", "h"), bound("b", "h"), bound("c", "k", "internal"));
    const snap = snapshotSeen(exp, { viewer: cleared, read: store({ h: { n: 1 }, k: [2] }) });
    expect(snap.versionHash).toBe("sha256:v");
    expect(snap.entries).toEqual([
      {
        source: { kind: "handle", handle: "h" },
        nodeIds: ["a", "b"],
        class: "unclassified",
        state: "seen",
        value: { n: 1 },
        bytes: 7,
        status: "ready",
      },
      {
        source: { kind: "handle", handle: "k" },
        nodeIds: ["c"],
        class: "internal",
        state: "seen",
        value: [2],
        bytes: 3,
        status: "ready",
      },
    ]);
    expect(snap.restricted).toBe(false);
  });

  it("never READS a source the viewer may not see, and says only that something was restricted", () => {
    const exp = build(bound("a", "h"), bound("s", "hs", "secret"));
    const asked: string[] = [];
    const snap = snapshotSeen(exp, {
      viewer: { clearance: "internal" },
      read: (src) => {
        asked.push(src.kind === "handle" ? src.handle : "?");
        return { found: true, value: "v" };
      },
    });
    expect(asked).toEqual(["h"]);
    expect(snap.entries.map((e) => e.nodeIds)).toEqual([["a"]]);
    expect(snap.restricted).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("hs");
  });

  it("no viewer is the most restrictive viewer", () => {
    const exp = build(bound("s", "hs", "internal"));
    const snap = snapshotSeen(exp, { read: store({ hs: 1 }) });
    expect(snap.entries).toEqual([]);
    expect(snap.restricted).toBe(true);
  });

  it("is bounded: an oversize value is not kept, the total budget is enforced, sources are capped", () => {
    const big = "x".repeat(MAX_SEEN_VALUE_BYTES + 1);
    const exp = build(bound("a", "a"), bound("b", "b"));
    const s1 = snapshotSeen(exp, { viewer: cleared, read: store({ a: big, b: 1 }) });
    expect(s1.entries[0]).toMatchObject({ state: "oversize" });
    expect(s1.entries[0]).not.toHaveProperty("value");
    expect(s1.entries[1]).toMatchObject({ state: "seen" });

    const chunk = "y".repeat(MAX_SEEN_VALUE_BYTES - 10);
    const n = Math.ceil(MAX_SEEN_TOTAL_BYTES / (MAX_SEEN_VALUE_BYTES - 10)) + 2;
    const nodes = Array.from({ length: n }, (_, i) =>
      bound(`n${i}`, `h${String(i).padStart(3, "0")}`)
    );
    const s2 = snapshotSeen(build(...nodes), {
      viewer: cleared,
      read: () => ({ found: true, value: chunk }),
    });
    expect(s2.entries.some((e) => e.state === "over-budget")).toBe(true);
    const kept = s2.entries
      .filter((e) => e.state === "seen")
      .reduce((t, e) => t + (e.bytes ?? 0), 0);
    expect(kept).toBeLessThanOrEqual(MAX_SEEN_TOTAL_BYTES);

    const many = Array.from({ length: MAX_SEEN_SOURCES + 5 }, (_, i) => bound(`m${i}`, `s${i}`));
    // 24 flat nodes is the planner's rule, not core's: core accepts them
    const s3 = snapshotSeen(build(...many), {
      viewer: cleared,
      read: () => ({ found: true, value: 1 }),
    });
    expect(s3.entries).toHaveLength(MAX_SEEN_SOURCES);
    expect(s3.omitted).toBe(5);
  });

  it("a throwing, cyclic or bigint value is unreadable, never a throw; absent keeps the host's status", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    const exp = build(bound("a", "a"), bound("b", "b"), bound("c", "c"), bound("d", "d"));
    const snap = snapshotSeen(exp, {
      viewer: cleared,
      read: (s) => {
        if (s.kind !== "handle") return undefined;
        if (s.handle === "a") return { found: true, value: cyc };
        if (s.handle === "b") return { found: true, value: 1n };
        if (s.handle === "c") throw new Error("boom");
        return { found: false, status: "pen\u202eding" };
      },
    });
    expect(snap.entries.map((e) => e.state)).toEqual([
      "unreadable",
      "unreadable",
      "unreadable",
      "absent",
    ]);
    expect(snap.entries[3]?.status).toBe("pen ding");
  });

  it("values are detached copies", () => {
    const v = { n: 1 };
    const snap = snapshotSeen(build(bound("a", "a")), { viewer: cleared, read: store({ a: v }) });
    v.n = 2;
    expect((snap.entries[0] as { value: { n: number } }).value.n).toBe(1);
  });

  it("projection-bound nodes need the host's catalogue: absent = hidden", () => {
    const exp = build(sem("p", { projection: { id: "pr", path: "x", version: "1" } }));
    const snap = snapshotSeen(exp, { viewer: cleared, read: () => ({ found: true, value: 1 }) });
    expect(snap.entries).toEqual([]);
    expect(snap.restricted).toBe(true);
    const offered = snapshotSeen(exp, {
      viewer: cleared,
      projections: [{ id: "pr", version: "1" }] as never,
      read: () => ({ found: true, value: 1 }),
    });
    expect(offered.entries[0]?.source).toEqual({
      kind: "projection",
      id: "pr",
      path: "x",
      version: "1",
    });
  });
});

describe("redactSeen", () => {
  const exp = build(bound("a", "h"), bound("s", "hs", "internal"));
  const entry = (over: Partial<SeenEntry>): SeenEntry => ({
    source: { kind: "handle", handle: "h" },
    nodeIds: ["a"],
    class: "unclassified",
    state: "seen",
    value: 1,
    ...over,
  });

  it("withholds what the reader may not see, with no count", () => {
    const r = redactSeen(
      [
        entry({}),
        entry({ source: { kind: "handle", handle: "hs" }, nodeIds: ["s"], class: "internal" }),
      ],
      exp,
      {}
    );
    expect(r.entries.map((e) => e.nodeIds)).toEqual([["a"]]);
    expect(r.restricted).toBe(true);
  });

  it("takes the STRICTER of the stamp and the artifact: a stale 'unclassified' stamp cannot launder", () => {
    const r = redactSeen(
      [entry({ source: { kind: "handle", handle: "hs" }, nodeIds: ["s"], class: "unclassified" })],
      exp,
      {}
    );
    expect(r.entries).toEqual([]);
    const shown = redactSeen(
      [entry({ source: { kind: "handle", handle: "hs" }, nodeIds: ["s"], class: "unclassified" })],
      exp,
      { viewer: { clearance: "internal" } }
    );
    expect(shown.entries[0]?.class).toBe("internal"); // restamped
  });

  it("a missing or unknown stamp, an unknown node, a missing artifact: all withheld (fail closed)", () => {
    const bad = [
      entry({ class: undefined as never }),
      entry({ class: "public" as never }),
      entry({ nodeIds: ["ghost"] }),
      entry({ nodeIds: [] }),
    ];
    for (const e of bad)
      expect(redactSeen([e], exp, { viewer: { clearance: "secret" } }).entries).toEqual([]);
    expect(redactSeen([entry({})], undefined, { viewer: { clearance: "secret" } })).toEqual({
      entries: [],
      restricted: true,
      indexes: [],
    });
  });

  it("an entry is judged by what its nodes ACTUALLY bind: a node listed for another source withholds it", () => {
    const e = redactSeen(
      [entry({ source: { kind: "handle", handle: "hs" }, nodeIds: ["a"], class: "unclassified" })],
      exp,
      {}
    );
    expect(e.entries).toEqual([]);
    expect(e.restricted).toBe(true);
    // the right pairing (and a projection with the wrong path) behave as before
    expect(redactSeen([entry({})], exp, {}).entries).toHaveLength(1);
    const px = build(
      sem("p", { projection: { id: "pr", path: "x", version: "1" } }),
      bound("a", "h")
    );
    const forged = entry({
      source: { kind: "projection", id: "pr", path: "OTHER", version: "1" },
      nodeIds: ["p"],
    });
    expect(
      redactSeen([forged], px, { projections: [{ id: "pr", version: "1" }] as never }).entries
    ).toEqual([]);
    expect(redactSeen([entry({ source: { kind: "handle" } as never })], exp, {}).entries).toEqual(
      []
    );
  });

  it("reports the input position of every kept entry", () => {
    const r = redactSeen(
      [
        entry({ source: { kind: "handle", handle: "hs" }, nodeIds: ["s"], class: "internal" }),
        entry({}),
      ],
      exp,
      {}
    );
    expect(r.indexes).toEqual([1]);
  });

  it("is total over hostile input", () => {
    expect(() => redactSeen([null as never, 3 as never], exp, {})).not.toThrow();
    expect(redactSeen("x" as never, exp, {}).restricted).toBe(true);
  });
});

describe("seenToState", () => {
  it("rebuilds the hydration-store shape from what was seen", () => {
    const st = seenToState([
      {
        source: { kind: "handle", handle: "h" },
        nodeIds: ["a"],
        class: "unclassified",
        state: "seen",
        value: { n: 1 },
        status: "ready",
      },
      {
        source: { kind: "handle", handle: "g" },
        nodeIds: ["b"],
        class: "unclassified",
        state: "absent",
        status: "pending",
      },
      {
        source: { kind: "projection", id: "p", path: "x", version: "1" },
        nodeIds: ["c"],
        class: "unclassified",
        state: "seen",
        value: 5,
      },
    ]);
    expect({ ...st.values }).toEqual({ h: { n: 1 } });
    expect({ ...st.status }).toEqual({ h: "ready", g: "pending" });
    expect(st.projections).toEqual([{ id: "p", path: "x", version: "1", value: 5 }]);
  });
  it("a handle named __proto__ cannot set a prototype", () => {
    const st = seenToState([
      {
        source: { kind: "handle", handle: "__proto__" },
        nodeIds: ["a"],
        class: "unclassified",
        state: "seen",
        value: { polluted: 1 },
      },
    ]);
    expect(({} as { polluted?: number }).polluted).toBeUndefined();
    expect(Object.keys(st.values)).toEqual(["__proto__"]);
  });
});
