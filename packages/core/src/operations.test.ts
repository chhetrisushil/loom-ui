import { describe, expect, it } from "vitest";
import { genesis } from "./experience";
import { type ContainerNode, MAX_TREE_DEPTH, type SemanticNode, findNode } from "./node";
import { Operation, apply, replay } from "./operations";

const meta = { author: "alice", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const g = genesis({ experienceId: "exp-1", intent: { objective: "x", source: "user" }, meta });
const node = (id: string, order = "V"): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
});
/** A left spine `levels` containers deep, built ITERATIVELY — the recursive helpers cannot. */
const chain = (levels: number, idPrefix = "n"): ContainerNode => {
  let out: ContainerNode = {
    id: `${idPrefix}0`,
    order: "V",
    kind: "container",
    direction: "column",
    span: 12,
    children: [],
  };
  for (let i = 1; i < levels; i++)
    out = {
      id: `${idPrefix}${i}`,
      order: "V",
      kind: "container",
      direction: "column",
      span: 12,
      children: [out],
    };
  return out;
};

const spec = {
  handle: "h1",
  executionGraph: [],
  reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
  outputShapeHash: "sha256:o",
  cachePolicy: { ttlSeconds: 60, scope: "global" as const },
};

describe("Operation schema", () => {
  it("has no operation that can touch intent", () => {
    expect(
      Operation.safeParse({ type: "setIntent", intent: { objective: "y", source: "user" } }).success
    ).toBe(false);
  });
});

describe("apply", () => {
  it("insertNode yields a new unpersisted artifact whose parent is the base hash, and never mutates the base", () => {
    const sealedBase = { ...g, versionHash: "sha256:base" };
    const r = apply(sealedBase, { type: "insertNode", parentId: "root", node: node("m1") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.versionHash).toBe("");
    expect(r.value.parents).toEqual(["sha256:base"]);
    expect(r.value.root.kind === "container" && r.value.root.children.map((c) => c.id)).toEqual([
      "m1",
    ]);
    expect(g.root.kind === "container" && g.root.children).toEqual([]);
    expect(r.value.intent).toEqual(sealedBase.intent);
  });
  it("refuses with a finding: duplicate id, missing parent, non-container parent, removing/moving the root, moving into own subtree", () => {
    const withM1 = apply(g, { type: "insertNode", parentId: "root", node: node("m1") });
    if (!withM1.ok) throw new Error("setup");
    const e = withM1.value;
    const codes = [
      apply(e, { type: "insertNode", parentId: "root", node: node("m1") }),
      apply(e, { type: "insertNode", parentId: "nope", node: node("m2") }),
      apply(e, { type: "insertNode", parentId: "m1", node: node("m2") }),
      apply(e, { type: "removeNode", nodeId: "root" }),
      apply(e, { type: "moveNode", nodeId: "root", newParentId: "root", newOrder: "a" }),
    ].map((r) => (r.ok ? "ok" : r.finding.code));
    expect(codes).toEqual([
      "duplicate-node-id",
      "missing-parent",
      "not-a-container",
      "root-immutable",
      "root-immutable",
    ]);
  });
  it("setProps merges, setLabel replaces, bindProvider defaults priority to P1, remapProvider requires matching handles", () => {
    let e = g;
    for (const op of [
      { type: "insertNode", parentId: "root", node: node("m1") },
      { type: "setProps", nodeId: "m1", patch: { unit: "ms" } },
      { type: "setLabel", nodeId: "m1", label: { key: "k", fallback: "p99" } },
      { type: "bindProvider", nodeId: "m1", handle: "h1" },
      { type: "remapProvider", handle: "h1", spec },
    ] as const) {
      const r = apply(e, op);
      if (!r.ok) throw new Error(r.finding.message);
      e = r.value;
    }
    const m1 = e.root.kind === "container" ? e.root.children[0] : undefined;
    expect(m1 && m1.kind === "semantic" && m1.props).toEqual({ unit: "ms" });
    expect(m1 && m1.kind === "semantic" && m1.label).toEqual({ key: "k", fallback: "p99" });
    expect(m1 && m1.kind === "semantic" && m1.binding).toEqual({ handle: "h1", priority: "P1" });
    expect(e.providers.h1).toEqual(spec);
    const bad = apply(e, { type: "remapProvider", handle: "h2", spec });
    expect(!bad.ok && bad.finding.code).toBe("handle-mismatch");
  });
  it("bindProvider carries a sensitivity class, keeps an existing one, and refuses an unknown one", () => {
    const must = (r: ReturnType<typeof apply>) => {
      if (!r.ok) throw new Error(r.finding.message);
      return r.value;
    };
    const bindingOf = (e: typeof g) => {
      const n = e.root.kind === "container" ? e.root.children[0] : undefined;
      return n && n.kind === "semantic" ? n.binding : undefined;
    };
    const inserted = must(apply(g, { type: "insertNode", parentId: "root", node: node("m1") }));
    const bound = must(
      apply(inserted, { type: "bindProvider", nodeId: "m1", handle: "h1", sensitivity: "secret" })
    );
    expect(bindingOf(bound)).toEqual({ handle: "h1", priority: "P1", sensitivity: "secret" });
    // Merge semantics, like `priority`: an op that says nothing about sensitivity keeps the one
    // the node already carries rather than silently declassifying it.
    const rebound = must(apply(bound, { type: "bindProvider", nodeId: "m1", handle: "h2" }));
    expect(bindingOf(rebound)).toEqual({ handle: "h2", priority: "P1", sensitivity: "secret" });
    const bad = apply(bound, {
      type: "bindProvider",
      nodeId: "m1",
      handle: "h1",
      sensitivity: "x",
    } as never);
    expect(!bad.ok && bad.finding.code).toBe("invalid-operation");
  });
  it("rejects a structurally invalid operation with a finding rather than a throw", () => {
    const r = apply(g, {
      type: "insertNode",
      parentId: "root",
      node: { ...node("m1"), span: 99 },
    } as never);
    expect(!r.ok && r.finding.code).toBe("invalid-operation");
  });
  it("refuses missing-node, cyclic-move and not-semantic with their codes", () => {
    const withTree = replay(g, [
      {
        type: "insertNode",
        parentId: "root",
        node: { id: "c1", order: "a", kind: "container", direction: "row", span: 12, children: [] },
      },
      { type: "insertNode", parentId: "c1", node: node("m1") },
    ]);
    if (!withTree.ok) throw new Error("setup");
    const e = withTree.value;
    const codes = [
      apply(e, { type: "removeNode", nodeId: "ghost" }),
      apply(e, { type: "moveNode", nodeId: "ghost", newParentId: "root", newOrder: "b" }),
      apply(e, { type: "moveNode", nodeId: "c1", newParentId: "m1", newOrder: "b" }), // m1 is not a container → not-a-container
      apply(e, { type: "setProps", nodeId: "c1", patch: {} }),
    ].map((r) => (r.ok ? "ok" : r.finding.code));
    expect(codes).toEqual(["missing-node", "missing-node", "not-a-container", "not-semantic"]);
    // cyclic-move: a container into its own descendant container
    const nested = apply(e, {
      type: "insertNode",
      parentId: "c1",
      node: { id: "c2", order: "z", kind: "container", direction: "row", span: 12, children: [] },
    });
    if (!nested.ok) throw new Error("setup");
    const cyc = apply(nested.value, {
      type: "moveNode",
      nodeId: "c1",
      newParentId: "c2",
      newOrder: "a",
    });
    expect(!cyc.ok && cyc.finding.code).toBe("cyclic-move");
  });
  it("applies schema defaults from the parsed op (remapProvider's executionGraph entries get dependsOn/idempotent)", () => {
    const specWithDefaults = {
      handle: "h1",
      executionGraph: [
        {
          stepId: "s1",
          toolName: "t1",
          toolVersion: "1.0.0",
          toolSchemaHash: "sha256:h",
          arguments: {},
        },
      ],
      reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
      outputShapeHash: "sha256:o",
      cachePolicy: { ttlSeconds: 60, scope: "global" as const },
    } as never;
    const r = apply(g, { type: "remapProvider", handle: "h1", spec: specWithDefaults });
    if (!r.ok) throw new Error(r.finding.message);
    const remapped = r.value.providers.h1;
    if (remapped === undefined) throw new Error("remapProvider did not write providers.h1");
    expect(remapped.executionGraph[0]).toEqual({
      stepId: "s1",
      toolName: "t1",
      toolVersion: "1.0.0",
      toolSchemaHash: "sha256:h",
      arguments: {},
      dependsOn: [],
      idempotent: true,
    });
  });
});

describe("tree depth", () => {
  // I1. `Operation.safeParse` is itself recursive over `insertNode.node`, so the probe has to
  // run before the parse or the refusal never happens — a RangeError escapes instead.
  it("refuses an insert that would nest past the cap, and does not throw", () => {
    const r = apply(g, { type: "insertNode", parentId: "root", node: chain(300) });
    expect(!r.ok && r.finding.code).toBe("tree-too-deep");
    expect(!r.ok && r.finding.message).toMatch(/300-level subtree/);
  });
  it("accepts a chain that stays under the cap", () => {
    const r = apply(g, { type: "insertNode", parentId: "root", node: chain(200) });
    expect(r.ok).toBe(true);
  });
  it("refuses any op once the BASE tree is past the cap", () => {
    const deep = { ...g, root: chain(MAX_TREE_DEPTH + 1) };
    const r = apply(deep, { type: "removeNode", nodeId: "n0" });
    expect(!r.ok && r.finding.code).toBe("tree-too-deep");
  });
});

describe("replay", () => {
  it("folds a prompt's materialized primitives with no planner present, deterministically", () => {
    const ops = [
      {
        type: "prompt" as const,
        text: "add a metric",
        materialized: [{ type: "insertNode" as const, parentId: "root", node: node("m1") }],
      },
      { type: "setProps" as const, nodeId: "m1", patch: { unit: "ms" } },
    ];
    const a = replay(g, ops);
    const b = replay(g, ops);
    expect(a.ok && b.ok && JSON.stringify(a.value)).toBe(b.ok && JSON.stringify(b.value));
    expect(a.ok && a.value.experienceId).toBe("exp-1");
  });
  // A prompt that materialised NOTHING is still an event in the lineage. `replay` over an empty
  // list returns its argument unchanged, which would hand back the SEALED base and make the op
  // indistinguishable from never having happened.
  it("a prompt with no materialized primitives still produces an unsealed child", () => {
    const sealed = { ...g, versionHash: "sha256:base" };
    const r = apply(sealed, { type: "prompt", text: "do nothing", materialized: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.versionHash).toBe("");
    expect(r.value.parents).toEqual(["sha256:base"]);
    expect(r.value.root).toEqual(sealed.root);
  });
  it("stops at the first failing op and names its index", () => {
    const r = replay(g, [{ type: "removeNode", nodeId: "ghost" }]);
    expect(!r.ok && r.finding.message).toMatch(/op #0 \(removeNode\)/);
  });
  it("keeps the sealed ancestor as parent across a multi-op fold", () => {
    const sealed = { ...g, versionHash: "sha256:base" };
    const r = replay(sealed, [
      { type: "insertNode", parentId: "root", node: node("m1") },
      { type: "setProps", nodeId: "m1", patch: { unit: "ms" } },
    ]);
    expect(r.ok && r.value.parents).toEqual(["sha256:base"]);
    expect(r.ok && r.value.versionHash).toBe("");
  });
});

describe("insertNode keeps placement and titles (Blueprint IR 2.1.0)", () => {
  it("the op's schema parse does not strip a node's grid lines or a container's title", () => {
    const r = apply(g, {
      type: "insertNode",
      parentId: "root",
      node: {
        id: "sec",
        order: "V",
        kind: "container",
        direction: "grid",
        span: 12,
        row: 2,
        column: 1,
        title: { key: "sec.title", fallback: "Section" },
        children: [{ ...node("m"), row: 1, rowSpan: 2, column: 5 }],
      },
    });
    if (!r.ok) throw new Error(r.finding.message);
    expect(findNode(r.value.root, "sec")).toMatchObject({
      row: 2,
      column: 1,
      title: { key: "sec.title", fallback: "Section" },
    });
    expect(findNode(r.value.root, "m")).toMatchObject({ row: 1, rowSpan: 2, column: 5 });
  });

  it("refuses grid lines off the grid as an invalid operation", () => {
    for (const bad of [{ column: 13 }, { row: 0 }, { rowSpan: 0 }]) {
      const r = apply(g, { type: "insertNode", parentId: "root", node: { ...node("m"), ...bad } });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.finding.code).toBe("invalid-operation");
    }
  });
});

describe("removeProvider", () => {
  const must = (r: ReturnType<typeof apply>) => {
    if (!r.ok) throw new Error(r.finding.message);
    return r.value;
  };
  const bound = () =>
    must(
      replay(g, [
        { type: "remapProvider", handle: "h1", spec },
        {
          type: "insertNode",
          parentId: "root",
          node: { ...node("m1"), binding: { handle: "h1", priority: "P1" } },
        },
      ])
    );
  it("removes a provider no node binds, as a new unsealed child, never mutating the base", () => {
    const sealed = {
      ...must(apply(g, { type: "remapProvider", handle: "h1", spec })),
      versionHash: "sha256:base",
    };
    const r = apply(sealed, { type: "removeProvider", handle: "h1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.providers).toEqual({});
    expect(r.value.versionHash).toBe("");
    expect(r.value.parents).toEqual(["sha256:base"]);
    expect(sealed.providers.h1).toEqual(spec);
  });
  it("is refused while a node still binds the handle — a finding naming the binder, never a throw", () => {
    const r = apply(bound(), { type: "removeProvider", handle: "h1" });
    expect(!r.ok && r.finding).toEqual(
      expect.objectContaining({ code: "provider-still-bound", severity: "error", nodeId: "m1" })
    );
  });
  it("a binder nested inside a container still holds the provider", () => {
    const e = must(
      replay(g, [
        { type: "remapProvider", handle: "h1", spec },
        {
          type: "insertNode",
          parentId: "root",
          node: {
            id: "c1",
            order: "a",
            kind: "container",
            direction: "row",
            span: 12,
            children: [{ ...node("deep"), binding: { handle: "h1", priority: "P1" } }],
          },
        },
      ])
    );
    const r = apply(e, { type: "removeProvider", handle: "h1" });
    expect(!r.ok && r.finding.code).toBe("provider-still-bound");
    expect(!r.ok && r.finding.nodeId).toBe("deep");
  });
  it("succeeds once the last binder is gone: removeNode, then removeProvider", () => {
    const r = replay(bound(), [
      { type: "removeNode", nodeId: "m1" },
      { type: "removeProvider", handle: "h1" },
    ]);
    expect(r.ok && r.value.providers).toEqual({});
  });
  it("an unknown handle is missing-provider, including names only the prototype has", () => {
    const e = bound();
    const codes = ["ghost", "toString", "__proto__"].map((handle) => {
      const r = apply(e, { type: "removeProvider", handle });
      return r.ok ? "ok" : r.finding.code;
    });
    expect(codes).toEqual(["missing-provider", "missing-provider", "missing-provider"]);
  });
  it("an empty handle is an invalid operation", () => {
    const r = apply(g, { type: "removeProvider", handle: "" });
    expect(!r.ok && r.finding.code).toBe("invalid-operation");
  });
  it("remap then remove leaves the providers exactly as they were", () => {
    const r = replay(g, [
      { type: "remapProvider", handle: "h1", spec },
      { type: "removeProvider", handle: "h1" },
    ]);
    expect(r.ok && r.value.providers).toEqual(g.providers);
  });
});
