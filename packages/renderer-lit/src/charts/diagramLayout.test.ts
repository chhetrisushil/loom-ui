import type { DiagramValue } from "@loom-ui/core/browser";
import { describe, expect, it } from "vitest";
import {
  type DiagramGeometry,
  displayLabel,
  edgeMidpoint,
  edgePath,
  layoutDiagram,
  nodeWidth,
} from "./diagramLayout";

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, ...extra });
const edge = (from: string, to: string) => ({ from, to });
const value = (layout: string, nodes: unknown[], edges: unknown[] = [], extra = {}) =>
  ({ layout, nodes, edges, ...extra }) as unknown as DiagramValue;
const chain = (layout: string, n: number) =>
  value(
    layout,
    Array.from({ length: n }, (_, i) => node(`n${i}`)),
    Array.from({ length: n - 1 }, (_, i) => edge(`n${i}`, `n${i + 1}`))
  );

const overlap = (a: DiagramGeometry["nodes"][number], b: DiagramGeometry["nodes"][number]) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const anyOverlap = (g: DiagramGeometry): boolean =>
  g.nodes.some((a, i) => g.nodes.some((b, j) => j > i && overlap(a, b)));
const center = (g: DiagramGeometry, i: number): number => {
  const n = g.nodes[i] as DiagramGeometry["nodes"][number];
  return n.x + n.w / 2;
};

describe("layoutDiagram", () => {
  it("is deterministic for every layout: the same value gives the same coordinates", () => {
    const base = [node("a"), node("b"), node("c"), node("d", { at: "2026-02-01" })];
    const timed = base.map((n, i) => ({ ...n, at: `2026-0${i + 1}-01` }));
    for (const v of [
      value("tree", base, [edge("a", "b"), edge("a", "c"), edge("c", "d")]),
      value("flow", base, [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("a", "d")]),
      value("timeline", timed, [edge("a", "b")]),
      value("network", base, [edge("a", "b"), edge("d", "d")]),
    ])
      expect(layoutDiagram(structuredClone(v))).toEqual(layoutDiagram(v));
  });

  it("every layout keeps all numbers finite and the canvas around every node", () => {
    for (const layout of ["tree", "flow", "network"]) {
      const g = layoutDiagram(chain(layout, 7));
      for (const n of g.nodes) {
        for (const num of [n.x, n.y, n.w, n.h]) expect(Number.isFinite(num)).toBe(true);
        expect(n.x).toBeGreaterThanOrEqual(0);
        expect(n.y).toBeGreaterThanOrEqual(0);
        expect(n.x + n.w).toBeLessThanOrEqual(g.width);
        expect(n.y + n.h).toBeLessThanOrEqual(g.height);
      }
    }
  });

  describe("tree", () => {
    const v = value(
      "tree",
      ["r", "a", "b", "a1", "a2", "b1"].map((id) => node(id)),
      [edge("r", "a"), edge("r", "b"), edge("a", "a1"), edge("a", "a2"), edge("b", "b1")]
    );
    const g = layoutDiagram(v);
    const at = (id: string) => v.nodes.findIndex((n) => n.id === id);
    it("a parent is centred over its first and last child", () => {
      expect(center(g, at("a"))).toBeCloseTo((center(g, at("a1")) + center(g, at("a2"))) / 2);
      expect(center(g, at("r"))).toBeCloseTo((center(g, at("a")) + center(g, at("b"))) / 2);
      expect(center(g, at("b"))).toBeCloseTo(center(g, at("b1")));
    });
    it("depth is the row and children sit in input order, left to right", () => {
      const y = (id: string) => (g.nodes[at(id)] as { y: number }).y;
      expect(y("r")).toBeLessThan(y("a"));
      expect(y("a")).toBe(y("b"));
      expect(y("a")).toBeLessThan(y("a1"));
      expect(center(g, at("a1"))).toBeLessThan(center(g, at("a2")));
      expect(center(g, at("a2"))).toBeLessThan(center(g, at("b1")));
    });
    it("no two nodes overlap, and every edge runs top-down between its nodes", () => {
      expect(anyOverlap(g)).toBe(false);
      for (const e of g.edges) {
        expect(e.back).toBe(false);
        const [from, to] = e.pts as unknown as [{ y: number }, { y: number }];
        expect(to.y).toBeGreaterThan(from.y);
      }
    });
  });

  describe("flow", () => {
    const v = value(
      "flow",
      ["a", "b", "c", "d", "e"].map((id) => node(id)),
      [
        edge("a", "b"),
        edge("a", "c"),
        edge("b", "d"),
        edge("c", "d"),
        edge("d", "a"), // closes a cycle: a back-edge
        edge("d", "e"),
      ]
    );
    const g = layoutDiagram(v);
    const x = (id: string) => (g.nodes[v.nodes.findIndex((n) => n.id === id)] as { x: number }).x;
    it("layers run left to right along every edge except the back-edge, which is marked", () => {
      for (const e of g.edges) {
        const f = v.edges[e.edge] as { from: string; to: string };
        if (e.back) expect(f).toEqual({ from: "d", to: "a" });
        else expect(x(f.to)).toBeGreaterThan(x(f.from));
      }
      expect(g.edges.filter((e) => e.back)).toHaveLength(1);
      expect(edgePath(g.edges.find((e) => e.back) as never)).toMatch(/^M[\d.,-]+C/);
    });
    it("no two nodes overlap, in a layer or anywhere", () => {
      expect(anyOverlap(g)).toBe(false);
    });
    it("barycenter ordering removes a crossing a naive order has", () => {
      // a -> y, b -> x with x listed before y: input order would cross the edges.
      const crossing = layoutDiagram(
        value(
          "flow",
          [node("a"), node("b"), node("x"), node("y")],
          [edge("a", "y"), edge("b", "x")]
        )
      );
      const ny = (id: string, ids: string[]) =>
        (crossing.nodes[ids.indexOf(id)] as { y: number }).y;
      const ids = ["a", "b", "x", "y"];
      expect(ny("y", ids) < ny("x", ids)).toBe(ny("a", ids) < ny("b", ids));
    });
    it("a self-loop is a back-edge curve", () => {
      const s = layoutDiagram(value("flow", [node("a")], [edge("a", "a")]));
      expect(s.edges[0]?.back).toBe(true);
      expect(s.edges[0]?.pts).toHaveLength(4);
    });
  });

  describe("timeline", () => {
    const v = value("timeline", [
      node("late", { at: "2026-03-01" }),
      node("early", { at: "2026-01-01" }),
      node("mid", { at: "2026-02-01" }),
      node("mid2", { at: "2026-02-01" }),
    ]);
    const g = layoutDiagram(v);
    it("x is linear in time, ordered chronologically", () => {
      const cx = (i: number) => center(g, i);
      expect(cx(1)).toBeLessThan(cx(2));
      expect(cx(2)).toBeLessThan(cx(0));
      const span = cx(0) - cx(1);
      // 31 of 59 days between Jan 1 and Mar 1
      expect((cx(2) - cx(1)) / span).toBeCloseTo(31 / 59, 2);
    });
    it("nodes at the same instant are stacked in rows, never overlapping", () => {
      expect(center(g, 2)).toBeCloseTo(center(g, 3));
      expect((g.nodes[2] as { y: number }).y).not.toBe((g.nodes[3] as { y: number }).y);
      expect(anyOverlap(g)).toBe(false);
    });
    it("has axis ticks spanning the first to the last instant, as ISO instants", () => {
      expect(g.ticks).toHaveLength(5);
      expect(g.ticks[0]?.iso).toBe("2026-01-01T00:00:00.000Z");
      expect(g.ticks[4]?.iso).toBe("2026-03-01T00:00:00.000Z");
      expect(g.axisY).toBeDefined();
      expect(g.ticks[0]?.x).toBeCloseTo(center(g, 1));
    });
    it("a single instant has one tick", () => {
      expect(
        layoutDiagram(value("timeline", [node("a", { at: "2026-01-01" })])).ticks
      ).toHaveLength(1);
    });
  });

  describe("network", () => {
    it("places nodes on a circle in input order, none overlapping", () => {
      const ids = Array.from({ length: 12 }, (_, i) => `node-number-${i}`);
      const v = value(
        "network",
        ids.map((id) => node(id)),
        [edge(ids[0] as string, ids[5] as string)]
      );
      const g = layoutDiagram(v);
      expect(anyOverlap(g)).toBe(false);
      const mid = g.nodes.map((n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 }));
      const cx = mid.reduce((s, p) => s + p.x, 0) / mid.length;
      const cy = mid.reduce((s, p) => s + p.y, 0) / mid.length;
      const radii = mid.map((p) => Math.hypot(p.x - cx, p.y - cy));
      for (const r of radii) expect(r).toBeCloseTo(radii[0] as number, 0);
      expect((mid[0] as { y: number }).y).toBeLessThan(cy); // the first node is at the top
    });
    it("one and two nodes are fine", () => {
      expect(layoutDiagram(value("network", [node("a")])).nodes).toHaveLength(1);
      expect(
        anyOverlap(layoutDiagram(value("network", [node("a"), node("b")], [edge("a", "b")])))
      ).toBe(false);
    });
  });

  it("a 200-node chain lays out without a stack overflow, in every layout", () => {
    for (const layout of ["tree", "flow", "network"]) {
      const g = layoutDiagram(chain(layout, 200));
      expect(g.nodes).toHaveLength(200);
      expect(g.edges).toHaveLength(199);
    }
    const timed = value(
      "timeline",
      Array.from({ length: 200 }, (_, i) =>
        node(`n${i}`, { at: `2026-01-${String((i % 28) + 1).padStart(2, "0")}` })
      )
    );
    expect(layoutDiagram(timed).nodes).toHaveLength(200);
  });

  it("a 200-node chain as a tree is 200 rows deep, none overlapping", () => {
    const g = layoutDiagram(chain("tree", 200));
    expect(anyOverlap(g)).toBe(false);
    expect(new Set(g.nodes.map((n) => n.y)).size).toBe(200);
  });
});

describe("labels and edges", () => {
  it("a long label is cut with an ellipsis and never splits a surrogate pair", () => {
    expect(displayLabel("short")).toBe("short");
    const long = "x".repeat(40);
    expect(displayLabel(long)).toBe(`${"x".repeat(27)}…`);
    const emoji = `${"x".repeat(26)}😀${"y".repeat(10)}`;
    expect(displayLabel(emoji)).toBe(`${"x".repeat(26)}…`);
    expect(nodeWidth(long)).toBe(nodeWidth("y".repeat(60)));
    expect(nodeWidth("")).toBe(56);
  });
  it("an edge is a line or a cubic, with a midpoint", () => {
    const line = {
      edge: 0,
      back: false,
      pts: [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ],
    };
    expect(edgePath(line)).toBe("M0,0L10,20");
    expect(edgeMidpoint(line)).toEqual({ x: 5, y: 10 });
    const curve = {
      edge: 0,
      back: true,
      pts: [
        { x: 0, y: 0 },
        { x: 0, y: -8 },
        { x: 8, y: -8 },
        { x: 8, y: 0 },
      ],
    };
    expect(edgePath(curve)).toBe("M0,0C0,-8 8,-8 8,0");
    expect(edgeMidpoint(curve)).toEqual({ x: 4, y: -6 });
  });
});
