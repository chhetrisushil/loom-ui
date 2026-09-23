import { describe, expect, it } from "vitest";
import {
  type ContainerNode,
  ExperienceNode,
  GRID_COLUMNS,
  MAX_TREE_DEPTH,
  type SemanticNode,
  findNode,
  isContainer,
  isPlaced,
  nodeIds,
  normalize,
  placementOf,
  placementProblems,
  rebuild,
  treeDepth,
  walk,
} from "./node";

/** A left spine `levels` containers deep, built ITERATIVELY — the recursive helpers cannot. */
function chain(levels: number, leaf?: SemanticNode): ContainerNode {
  let node: ContainerNode = {
    id: "n0",
    order: "V",
    kind: "container",
    direction: "column",
    span: 12,
    children: leaf ? [leaf] : [],
  };
  for (let i = 1; i < levels; i++)
    node = {
      id: `n${i}`,
      order: "V",
      kind: "container",
      direction: "column",
      span: 12,
      children: [node],
    };
  return node;
}

const metric = (id: string, order: string): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  binding: { handle: `h-${id}`, priority: "P1" },
});

const root: ContainerNode = {
  id: "root",
  order: "V",
  kind: "container",
  direction: "row",
  span: 12,
  children: [metric("b", "b"), metric("a", "a")],
};

describe("ExperienceNode schema", () => {
  it("accepts a well-formed tree and rejects an unknown kind or a visual kind", () => {
    expect(ExperienceNode.safeParse(root).success).toBe(true);
    expect(ExperienceNode.safeParse({ ...root, kind: "widget" }).success).toBe(false);
    expect(
      ExperienceNode.safeParse({ ...metric("x", "x"), type: "" }).success,
      "an empty type is not a semantic type"
    ).toBe(false);
  });
  it("rejects an order key outside the base-62 alphabet the keys are minted from", () => {
    // Order keys are compared with a plain string compare; a character outside the alphabet
    // `order.ts` mints from sorts somewhere its author did not intend.
    expect(ExperienceNode.safeParse({ ...metric("x", "!"), order: "!" }).success).toBe(false);
    expect(ExperienceNode.safeParse({ ...metric("x", "a-b"), order: "a-b" }).success).toBe(false);
    expect(ExperienceNode.safeParse({ ...metric("x", "x"), order: "" }).success).toBe(false);
    expect(ExperienceNode.safeParse({ ...metric("x", "Vz09"), order: "Vz09" }).success).toBe(true);
  });
  it("rejects a span outside 1..12 and a priority outside P0..P2", () => {
    expect(ExperienceNode.safeParse({ ...metric("x", "x"), span: 0 }).success).toBe(false);
    expect(ExperienceNode.safeParse({ ...metric("x", "x"), span: 13 }).success).toBe(false);
    expect(
      ExperienceNode.safeParse({ ...metric("x", "x"), binding: { handle: "h", priority: "P3" } })
        .success
    ).toBe(false);
  });
  it("a binding may carry a sensitivity class; an unknown class is refused by the schema", () => {
    const ok = ExperienceNode.safeParse({
      id: "s",
      order: "V",
      kind: "semantic",
      type: "Metric",
      typeVersion: "1.0.0",
      span: 6,
      props: {},
      binding: { handle: "h", priority: "P1", sensitivity: "sensitive" },
    });
    expect(ok.success).toBe(true);
    const bad = ExperienceNode.safeParse({
      id: "s",
      order: "V",
      kind: "semantic",
      type: "Metric",
      typeVersion: "1.0.0",
      span: 6,
      props: {},
      binding: { handle: "h", priority: "P1", sensitivity: "top-secret" },
    });
    expect(bad.success).toBe(false);
  });
});

describe("tree helpers", () => {
  it("walk visits parent before children; findNode finds by id; nodeIds lists all", () => {
    const seen: string[] = [];
    walk(root, (n) => seen.push(n.id));
    expect(seen).toEqual(["root", "b", "a"]);
    expect(findNode(root, "a")?.id).toBe("a");
    expect(findNode(root, "zzz")).toBeUndefined();
    expect(nodeIds(root).sort()).toEqual(["a", "b", "root"]);
  });
  it("normalize sorts children by order at every level and does not mutate its input", () => {
    const n = normalize(root);
    expect(isContainer(n) && n.children.map((c) => c.id)).toEqual(["a", "b"]);
    expect(root.children.map((c) => c.id)).toEqual(["b", "a"]);
  });
  it("rebuild removes a node when the editor returns null and throws if the root is removed", () => {
    const out = rebuild(root, (n) => (n.id === "a" ? null : n));
    expect(nodeIds(out).sort()).toEqual(["b", "root"]);
    expect(() => rebuild(root, () => null)).toThrow(/root/);
  });
});

describe("treeDepth / MAX_TREE_DEPTH", () => {
  it("counts the root as 1 and measures the deepest path", () => {
    expect(treeDepth(metric("x", "x"))).toBe(1);
    expect(treeDepth(root)).toBe(2);
    expect(MAX_TREE_DEPTH).toBe(256);
  });
  it("measures a tree far deeper than the call stack without recursing", () => {
    // The point of the iterative implementation: this is the guard that keeps `walk`, `rebuild`,
    // `normalize` and zod's recursive node schema from ever seeing a tree like this, so it must
    // survive one they could not.
    expect(treeDepth(chain(50_000))).toBe(50_000);
  });
  it("tolerates unparsed input — it runs before the schema does", () => {
    expect(treeDepth(undefined as never)).toBe(0);
    expect(treeDepth({ kind: "container" } as never)).toBe(1);
  });
});

describe("placement and titles (Blueprint IR 2.1.0)", () => {
  const placed: ContainerNode = {
    id: "sec",
    order: "V",
    kind: "container",
    direction: "grid",
    span: 12,
    row: 2,
    rowSpan: 1,
    column: 1,
    title: { key: "sec.title", fallback: "Section" },
    children: [{ ...metric("m", "a"), row: 1, column: 7 }],
  };

  it("parses and KEEPS row, rowSpan, column and a container's title", () => {
    const r = ExperienceNode.safeParse(placed);
    expect(r.success).toBe(true);
    expect(r.success && r.data).toEqual(placed);
  });

  it("adds no keys to a node that sets none of them", () => {
    expect(Object.keys(ExperienceNode.parse(metric("m", "a"))).sort()).toEqual([
      "binding",
      "id",
      "kind",
      "order",
      "props",
      "span",
      "type",
      "typeVersion",
    ]);
  });

  it("refuses a row or rowSpan below 1 or fractional, a column outside 1..12, and a title that is not LocalizedText", () => {
    for (const bad of [{ row: 0 }, { rowSpan: 1.5 }, { column: 0 }, { column: 13 }])
      expect(
        ExperienceNode.safeParse({ ...metric("m", "a"), ...bad }).success,
        JSON.stringify(bad)
      ).toBe(false);
    expect(ExperienceNode.safeParse({ ...placed, title: "Section" }).success).toBe(false);
  });
});

describe("placementOf / isPlaced / placementProblems", () => {
  const m = metric("m", "a"); // span 4

  it("placementOf copies exactly the keys the node sets", () => {
    expect(placementOf(m)).toStrictEqual({});
    expect(placementOf({ ...m, column: 3 })).toStrictEqual({ column: 3 });
    expect(placementOf({ ...m, row: 2, rowSpan: 3, column: 1 })).toStrictEqual({
      row: 2,
      rowSpan: 3,
      column: 1,
    });
  });

  it("isPlaced is true iff any placement key is set", () => {
    expect(isPlaced(m)).toBe(false);
    expect(isPlaced({ ...m, rowSpan: 2 })).toBe(true);
    expect(isPlaced({ ...m, row: 1 })).toBe(true);
    expect(isPlaced({ ...m, column: 1 })).toBe(true);
  });

  it("is loom's placement-out-of-range predicate against a 12-column grid", () => {
    expect(GRID_COLUMNS).toBe(12);
    expect(placementProblems({ ...m, row: 1, rowSpan: 2, column: 9 })).toEqual([]);
    expect(placementProblems({ ...m, column: 10 })).toEqual([
      "column 10 + span 4 overflows the 12-column grid",
    ]);
    expect(placementProblems({ ...m, column: 13 })).toEqual(["column 13 is outside 1..12"]);
    expect(placementProblems({ ...m, row: 0, rowSpan: 1.5 })).toEqual([
      "row 0 is not a positive integer",
      "rowSpan 1.5 is not a positive integer",
    ]);
    // An invalid span is loom's `span-out-of-range`, reported once — never again as an overflow.
    expect(placementProblems({ ...m, span: 20, column: 5 })).toEqual([]);
    expect(placementProblems({ ...m, column: 3 }, 4)).toEqual([
      "column 3 + span 4 overflows the 4-column grid",
    ]);
  });
});
