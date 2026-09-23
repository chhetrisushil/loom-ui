import { canonicalJson } from "@loom/core";
import { describe, expect, it } from "vitest";
import { genesis } from "./experience";
import { mintVersionHash } from "./log";
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

describe("setPlacement", () => {
  const must = (r: ReturnType<typeof apply>) => {
    if (!r.ok) throw new Error(r.finding.message);
    return r.value;
  };
  const withM1 = () => must(apply(g, { type: "insertNode", parentId: "root", node: node("m1") }));
  it("sets span and grid placement; a field the op does not name is unchanged", () => {
    const e1 = must(apply(withM1(), { type: "setPlacement", nodeId: "m1", span: 6, row: 2 }));
    expect(findNode(e1.root, "m1")).toMatchObject({ span: 6, row: 2 });
    const e2 = must(apply(e1, { type: "setPlacement", nodeId: "m1", column: 7, rowSpan: 3 }));
    expect(findNode(e2.root, "m1")).toMatchObject({ span: 6, row: 2, column: 7, rowSpan: 3 });
  });
  it("null clears a placement field: the key is gone, so the node hashes as if never placed", () => {
    const base = withM1();
    const e = must(
      replay(base, [
        { type: "setPlacement", nodeId: "m1", row: 2, column: 3 },
        { type: "setPlacement", nodeId: "m1", row: null, column: null, rowSpan: null },
      ])
    );
    const n = findNode(e.root, "m1");
    expect(n).toEqual(findNode(base.root, "m1"));
    expect(n && "row" in n).toBe(false);
    expect(n && "column" in n).toBe(false);
    expect(mintVersionHash({ ...e, parents: base.parents })).toBe(mintVersionHash(base));
  });
  it("span is required on a node, so it can be set but never cleared", () => {
    const r = apply(withM1(), { type: "setPlacement", nodeId: "m1", span: null } as never);
    expect(!r.ok && r.finding.code).toBe("invalid-operation");
  });
  it("validates the placed node as insertNode validates a node: out-of-range values are invalid-operation findings naming the node", () => {
    const e = withM1();
    const fields: Array<Partial<Record<"span" | "row" | "rowSpan" | "column", number>>> = [
      { span: 13 },
      { span: 0 },
      { row: 0 },
      { rowSpan: 1.5 },
      { column: -1 },
    ];
    const got = fields.map((f) => {
      const r = apply(e, { type: "setPlacement", nodeId: "m1", ...f });
      return r.ok ? "ok" : `${r.finding.code}@${r.finding.nodeId ?? ""}`;
    });
    expect(got).toEqual(fields.map(() => "invalid-operation@m1"));
  });
  it("an op naming no field would change nothing and is refused as empty-placement", () => {
    const r = apply(withM1(), { type: "setPlacement", nodeId: "m1" });
    expect(!r.ok && r.finding).toEqual(
      expect.objectContaining({ code: "empty-placement", nodeId: "m1" })
    );
  });
  it("the root is not a grid cell (root-immutable); an unknown node is missing-node", () => {
    const e = withM1();
    const codes = [
      apply(e, { type: "setPlacement", nodeId: "root", span: 6 }),
      apply(e, { type: "setPlacement", nodeId: "ghost", span: 6 }),
    ].map((r) => (r.ok ? "ok" : r.finding.code));
    expect(codes).toEqual(["root-immutable", "missing-node"]);
  });
  it("places a container the same way and keeps its children", () => {
    const e = must(
      replay(g, [
        {
          type: "insertNode",
          parentId: "root",
          node: {
            id: "c1",
            order: "a",
            kind: "container",
            direction: "row",
            span: 12,
            children: [node("m1")],
          },
        },
        { type: "setPlacement", nodeId: "c1", span: 8, row: 1 },
      ])
    );
    expect(findNode(e.root, "c1")).toMatchObject({ span: 8, row: 1 });
    expect(findNode(e.root, "m1")).toBeDefined();
  });
  it("never mutates the base, and a recorded op (nulls included) parses to exactly itself", () => {
    const base = withM1();
    const before = JSON.stringify(base);
    const op: Operation = { type: "setPlacement", nodeId: "m1", span: 3, row: null };
    must(apply(base, op));
    expect(JSON.stringify(base)).toBe(before);
    expect(canonicalJson(Operation.parse(op))).toBe(canonicalJson(op));
  });
});

describe("setTitle", () => {
  const must = (r: ReturnType<typeof apply>) => {
    if (!r.ok) throw new Error(r.finding.message);
    return r.value;
  };
  const section = (): ContainerNode => ({
    id: "c1",
    order: "a",
    kind: "container",
    direction: "grid",
    span: 12,
    children: [node("m1")],
  });
  const withSection = () =>
    must(apply(g, { type: "insertNode", parentId: "root", node: section() }));
  const title = { key: "c1.title", fallback: "Throughput" };
  it("sets and replaces a container's title, and keeps its children", () => {
    const e1 = must(apply(withSection(), { type: "setTitle", nodeId: "c1", title }));
    expect(findNode(e1.root, "c1")).toMatchObject({ title });
    const e2 = must(
      apply(e1, { type: "setTitle", nodeId: "c1", title: { key: "c1.title", fallback: "Load" } })
    );
    expect(findNode(e2.root, "c1")).toMatchObject({ title: { fallback: "Load" } });
    expect(findNode(e2.root, "m1")).toBeDefined();
  });
  it("titles the root — the whole view's heading", () => {
    const e = must(apply(g, { type: "setTitle", nodeId: "root", title }));
    expect(e.root).toMatchObject({ title });
  });
  it("null clears the title: the key is gone, so the container hashes as if never titled", () => {
    const base = withSection();
    const e = must(
      replay(base, [
        { type: "setTitle", nodeId: "c1", title },
        { type: "setTitle", nodeId: "c1", title: null },
      ])
    );
    const c = findNode(e.root, "c1");
    expect(c && "title" in c).toBe(false);
    expect(c).toEqual(findNode(base.root, "c1"));
    expect(mintVersionHash({ ...e, parents: base.parents })).toBe(mintVersionHash(base));
  });
  it("a semantic node has no title (its heading is its label) — not-container; an unknown node is missing-node", () => {
    const e = withSection();
    const codes = [
      apply(e, { type: "setTitle", nodeId: "m1", title }),
      apply(e, { type: "setTitle", nodeId: "ghost", title }),
    ].map((r) => (r.ok ? "ok" : `${r.finding.code}@${r.finding.nodeId ?? ""}`));
    expect(codes).toEqual(["not-container@m1", "missing-node@ghost"]);
  });
  it("title is required — an op that omits it, or carries a malformed one, is invalid", () => {
    const e = withSection();
    const codes = [
      apply(e, { type: "setTitle", nodeId: "c1" } as never),
      apply(e, { type: "setTitle", nodeId: "c1", title: { key: "", fallback: "x" } }),
      apply(e, { type: "setTitle", nodeId: "c1", title: "Throughput" } as never),
    ].map((r) => (r.ok ? "ok" : r.finding.code));
    expect(codes).toEqual(["invalid-operation", "invalid-operation", "invalid-operation"]);
  });
});

describe("moveNode of a placed node", () => {
  const must = (r: ReturnType<typeof apply>) => {
    if (!r.ok) throw new Error(r.finding.message);
    return r.value;
  };
  const container = (id: string, direction: "row" | "column" | "grid"): ContainerNode => ({
    id,
    order: "a",
    kind: "container",
    direction,
    span: 12,
    children: [],
  });
  // root (grid) ⊃ { flow (row), grid2 (grid), m1 placed at row 2 / column 3 }
  const setup = () =>
    must(
      replay(g, [
        { type: "insertNode", parentId: "root", node: container("flow", "row") },
        { type: "insertNode", parentId: "root", node: container("grid2", "grid") },
        { type: "insertNode", parentId: "root", node: node("m1") },
        { type: "setPlacement", nodeId: "m1", row: 2, column: 3 },
      ])
    );
  it("into a container that does not lay out placement is refused (placement-outside-grid), naming the node; the base is untouched", () => {
    const base = setup();
    const before = JSON.stringify(base);
    const r = apply(base, { type: "moveNode", nodeId: "m1", newParentId: "flow", newOrder: "b" });
    expect(!r.ok && r.finding).toEqual(
      expect.objectContaining({ code: "placement-outside-grid", nodeId: "m1" })
    );
    expect(JSON.stringify(base)).toBe(before);
  });
  it("any one placement key is enough to refuse (rowSpan alone)", () => {
    const base = must(
      replay(g, [
        { type: "insertNode", parentId: "root", node: container("flow", "column") },
        { type: "insertNode", parentId: "root", node: node("m1") },
        { type: "setPlacement", nodeId: "m1", rowSpan: 2 },
      ])
    );
    const r = apply(base, { type: "moveNode", nodeId: "m1", newParentId: "flow", newOrder: "b" });
    expect(!r.ok && r.finding.code).toBe("placement-outside-grid");
  });
  it("succeeds once the caller clears the placement first", () => {
    const e = must(
      replay(setup(), [
        { type: "setPlacement", nodeId: "m1", row: null, column: null },
        { type: "moveNode", nodeId: "m1", newParentId: "flow", newOrder: "b" },
      ])
    );
    expect(findNode(e.root, "flow")).toMatchObject({
      children: [expect.objectContaining({ id: "m1" })],
    });
  });
  it("into another grid keeps the placement; an unplaced node moves into a flow container freely", () => {
    const e = must(
      replay(setup(), [
        { type: "moveNode", nodeId: "m1", newParentId: "grid2", newOrder: "b" },
        { type: "insertNode", parentId: "root", node: node("m2", "c") },
        { type: "moveNode", nodeId: "m2", newParentId: "flow", newOrder: "b" },
      ])
    );
    expect(findNode(e.root, "m1")).toMatchObject({ row: 2, column: 3 });
    expect(findNode(e.root, "flow")).toMatchObject({
      children: [expect.objectContaining({ id: "m2" })],
    });
  });
});

describe("placement-outside-grid is refused by every op that could create it", () => {
  const must = (r: ReturnType<typeof apply>) => {
    if (!r.ok) throw new Error(r.finding.message);
    return r.value;
  };
  const container = (
    id: string,
    direction: "row" | "column" | "grid",
    children: ContainerNode["children"] = []
  ): ContainerNode => ({ id, order: "a", kind: "container", direction, span: 12, children });
  const refusal = (r: ReturnType<typeof apply>) =>
    r.ok ? "ok" : `${r.finding.code}@${r.finding.nodeId ?? ""}`;
  const withFlow = () =>
    must(
      replay(g, [
        { type: "insertNode", parentId: "root", node: container("flow", "row", [node("m1")]) },
      ])
    );

  it("setPlacement that SETS row, rowSpan or column under a non-grid parent is refused; the base is untouched", () => {
    const base = withFlow();
    const before = JSON.stringify(base);
    const got = [{ row: 1 }, { rowSpan: 2 }, { column: 3 }].map((f) =>
      refusal(apply(base, { type: "setPlacement", nodeId: "m1", ...f }))
    );
    expect(got).toEqual(Array(3).fill("placement-outside-grid@m1"));
    expect(JSON.stringify(base)).toBe(before);
  });
  it("span-only and clearing ops under a non-grid parent are always allowed", () => {
    const e = must(
      replay(withFlow(), [
        { type: "setPlacement", nodeId: "m1", span: 6 },
        { type: "setPlacement", nodeId: "m1", row: null, rowSpan: null, column: null },
      ])
    );
    expect(findNode(e.root, "m1")).toMatchObject({ span: 6 });
  });
  it("setPlacement under a grid parent (the root here) is allowed", () => {
    const e = must(
      replay(g, [
        { type: "insertNode", parentId: "root", node: node("m1") },
        { type: "setPlacement", nodeId: "m1", row: 1, column: 1 },
      ])
    );
    expect(findNode(e.root, "m1")).toMatchObject({ row: 1, column: 1 });
  });
  it("insertNode of a placed node under a non-grid parent is refused, naming the placed node", () => {
    const base = withFlow();
    const r = apply(base, {
      type: "insertNode",
      parentId: "flow",
      node: { ...node("m2"), column: 2 },
    });
    expect(refusal(r)).toBe("placement-outside-grid@m2");
  });
  it("insertNode of a subtree whose NESTED placed node sits under a non-grid container is refused", () => {
    const r = apply(g, {
      type: "insertNode",
      parentId: "root",
      node: container("c1", "grid", [container("c2", "column", [{ ...node("deep"), row: 1 }])]),
    });
    expect(refusal(r)).toBe("placement-outside-grid@deep");
  });
  it("insertNode of a placed subtree whose placements all sit in grids is allowed", () => {
    const e = must(
      apply(g, {
        type: "insertNode",
        parentId: "root",
        node: { ...container("c1", "grid", [{ ...node("m1"), row: 2 }]), column: 1 },
      })
    );
    expect(findNode(e.root, "m1")).toMatchObject({ row: 2 });
    expect(findNode(e.root, "c1")).toMatchObject({ column: 1 });
  });
});

describe("placement-out-of-range is refused by every op that could create it", () => {
  const must = (r: ReturnType<typeof apply>) => {
    if (!r.ok) throw new Error(r.finding.message);
    return r.value;
  };
  const container = (
    id: string,
    direction: "row" | "column" | "grid",
    children: ContainerNode["children"] = []
  ): ContainerNode => ({ id, order: "a", kind: "container", direction, span: 12, children });
  const refusal = (r: ReturnType<typeof apply>) =>
    r.ok ? "ok" : `${r.finding.code}@${r.finding.nodeId ?? ""}`;
  const withM1 = () => must(apply(g, { type: "insertNode", parentId: "root", node: node("m1") }));

  it("setPlacement whose column + span overflows the grid is refused; the base is untouched", () => {
    const base = withM1();
    const before = JSON.stringify(base);
    const r = apply(base, { type: "setPlacement", nodeId: "m1", column: 10, span: 6 });
    expect(refusal(r)).toBe("placement-out-of-range@m1");
    expect(!r.ok && r.finding.message).toMatch(/overflows the 12-column grid/);
    expect(JSON.stringify(base)).toBe(before);
  });
  it("a span-only change that makes an already-placed node overflow is refused", () => {
    const e = must(apply(withM1(), { type: "setPlacement", nodeId: "m1", column: 10, span: 3 }));
    expect(refusal(apply(e, { type: "setPlacement", nodeId: "m1", span: 12 }))).toBe(
      "placement-out-of-range@m1"
    );
    // …while one that still fits, or a clear of the column, is allowed.
    must(apply(e, { type: "setPlacement", nodeId: "m1", span: 2 }));
    must(apply(e, { type: "setPlacement", nodeId: "m1", column: null, span: 12 }));
  });
  it("a span-only change on an UNPLACED node is always allowed", () => {
    const e = must(apply(withM1(), { type: "setPlacement", nodeId: "m1", span: 12 }));
    expect(findNode(e.root, "m1")).toMatchObject({ span: 12 });
  });
  it("insertNode of an overflowing node, or of a subtree with an overflowing NESTED node, is refused", () => {
    const got = [
      apply(g, { type: "insertNode", parentId: "root", node: { ...node("m2"), column: 11 } }),
      apply(g, {
        type: "insertNode",
        parentId: "root",
        node: container("c1", "grid", [container("c2", "grid", [{ ...node("deep"), column: 12 }])]),
      }),
    ].map(refusal);
    expect(got).toEqual(["placement-out-of-range@m2", "placement-out-of-range@deep"]);
  });
  it("moveNode into a grid is refused when the node's placement overflows there", () => {
    // A placed node under a grid it fits; the overflow is built by hand (no op can create it)
    // to prove moveNode checks placement against the destination grid, not only its direction.
    const base = must(
      replay(g, [
        { type: "insertNode", parentId: "root", node: container("grid2", "grid") },
        { type: "insertNode", parentId: "root", node: node("m1") },
        { type: "setPlacement", nodeId: "m1", column: 9 },
      ])
    );
    const bad = {
      ...base,
      root: {
        ...base.root,
        children: (base.root as ContainerNode).children.map((c) =>
          c.id === "m1" ? { ...c, span: 6 } : c
        ),
      },
    } as typeof base;
    expect(
      refusal(apply(bad, { type: "moveNode", nodeId: "m1", newParentId: "grid2", newOrder: "b" }))
    ).toBe("placement-out-of-range@m1");
    must(apply(base, { type: "moveNode", nodeId: "m1", newParentId: "grid2", newOrder: "b" }));
  });
  it("every out-of-range refusal names the remedy for the op that raised it", () => {
    const message = (r: ReturnType<typeof apply>) => (r.ok ? "ok" : r.finding.message);
    expect(
      message(apply(withM1(), { type: "setPlacement", nodeId: "m1", column: 10, span: 6 }))
    ).toMatch(/; choose a column and span that fit the grid$/);
    expect(
      message(
        apply(g, { type: "insertNode", parentId: "root", node: { ...node("m2"), column: 11 } })
      )
    ).toMatch(/; insert it without row\/rowSpan\/column$/);
    const flowed = must(
      replay(g, [
        { type: "insertNode", parentId: "root", node: container("flow", "row") },
        { type: "insertNode", parentId: "root", node: node("m1") },
        { type: "setPlacement", nodeId: "m1", column: 2 },
      ])
    );
    expect(
      message(apply(flowed, { type: "moveNode", nodeId: "m1", newParentId: "flow", newOrder: "b" }))
    ).toMatch(/; clear it first with setPlacement \(row, column and rowSpan null\)$/);
  });
});
