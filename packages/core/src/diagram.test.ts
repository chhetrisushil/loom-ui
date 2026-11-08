import { afterEach, describe, expect, it, vi } from "vitest";
import { diagramGraph } from "./diagramGraph";
import { MAX_DIAGRAM_EDGES, MAX_DIAGRAM_NODES, diagramProblems } from "./diagramStructure";
import { diagramOutline } from "./diagramText";
import { checkKindValueIssues as lite } from "./kindValues";
import type { TimeLabelWords } from "./timeWords";
import type { DiagramValue } from "./values";
import { kindValueContract } from "./values";

const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, ...extra });
const edge = (from: string, to: string, extra: Record<string, unknown> = {}) => ({
  from,
  to,
  ...extra,
});
const diagram = (
  layout: string,
  nodes: unknown[],
  edges: unknown[] = [],
  extra: Record<string, unknown> = {}
) => ({ layout, nodes, edges, ...extra });

/** What the zod contract and the zod-free checker each say, as [path, message] pairs. */
function verdicts(value: unknown): { zod: string[]; lite: string[] } {
  const r = (kindValueContract("Diagram") as { safeParse(v: unknown): unknown }).safeParse(
    value
  ) as { success: boolean; error?: { issues: { path: unknown[]; message: string }[] } };
  return {
    zod: r.success ? [] : (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`),
    lite: lite("Diagram", value).map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
/** Both checkers refuse with exactly `message` (at `path`), and agree entirely. */
function refused(value: unknown, path: string, message: string): void {
  const v = verdicts(value);
  expect(v.zod).toContain(`${path}: ${message}`);
  expect(v.lite).toEqual(v.zod);
}
function accepted(value: unknown): void {
  const v = verdicts(value);
  expect(v.zod).toEqual([]);
  expect(v.lite).toEqual([]);
}

const chain = (n: number) => ({
  nodes: Array.from({ length: n }, (_, i) => node(`n${i}`)),
  edges: Array.from({ length: n - 1 }, (_, i) => edge(`n${i}`, `n${i + 1}`)),
});

describe("Diagram contract: caps", () => {
  it("exports the caps", () => {
    expect(MAX_DIAGRAM_NODES).toBe(200);
    expect(MAX_DIAGRAM_EDGES).toBe(400);
  });
  it("200 nodes and 400 edges are accepted, 201 and 401 are refused whole (never truncated)", () => {
    const c = chain(200);
    accepted(diagram("tree", c.nodes, c.edges));
    const nodes = Array.from({ length: 200 }, (_, i) => node(`n${i}`));
    const edges400 = Array.from({ length: 400 }, (_, i) =>
      edge(`n${i % 200}`, `n${(i * 7 + 1) % 200}`)
    );
    accepted(diagram("network", nodes, edges400));
    const c201 = chain(201);
    refused(diagram("tree", c201.nodes, c201.edges), "nodes", "a diagram has at most 200 nodes");
    refused(
      diagram("network", nodes, [...edges400, edge("n0", "n1")]),
      "edges",
      "a diagram has at most 400 edges"
    );
  });
  it("an empty diagram is refused", () => {
    refused(diagram("network", []), "nodes", "a diagram needs at least 1 node");
  });
  it("an over-cap value is refused cheaply: the structural walk does not run", () => {
    const p = diagramProblems(diagram("tree", chain(201).nodes, [edge("zzz", "yyy")]));
    expect(p.map((x) => x.message)).toEqual(["a diagram has at most 200 nodes"]);
  });
});

describe("Diagram contract: ids and edges", () => {
  it("node ids are non-empty and unique", () => {
    refused(diagram("network", [node("")]), "nodes.0.id", "a node id must not be empty");
    refused(diagram("network", [node("a"), node("a")]), "nodes.1.id", "node ids must be unique");
  });
  it("every edge names existing nodes", () => {
    refused(
      diagram("flow", [node("a")], [edge("zz", "a")]),
      "edges.0.from",
      "an edge must start at an existing node"
    );
    refused(
      diagram("flow", [node("a")], [edge("a", "zz")]),
      "edges.0.to",
      "an edge must end at an existing node"
    );
  });
  it("the layout is one of the four", () => {
    expect(verdicts(diagram("radial", [node("a")])).zod.length).toBeGreaterThan(0);
    expect(verdicts(diagram("radial", [node("a")])).lite).toEqual(
      verdicts(diagram("radial", [node("a")])).zod
    );
  });
  it("flow may hold cycles and self-edges; a network is anything beyond the id rules", () => {
    accepted(
      diagram("flow", [node("a"), node("b")], [edge("a", "b"), edge("b", "a"), edge("a", "a")])
    );
    accepted(
      diagram("network", [node("a"), node("b")], [edge("a", "b"), edge("a", "b"), edge("b", "b")])
    );
  });
});

describe("Diagram contract: tree", () => {
  const msgRoot = "a tree has exactly one root (a node with no incoming edge)";
  it("accepts one rooted tree", () => {
    accepted(diagram("tree", [node("a"), node("b"), node("c")], [edge("a", "b"), edge("a", "c")]));
    accepted(diagram("tree", [node("a")]));
  });
  it("refuses two roots", () => {
    refused(diagram("tree", [node("a"), node("b")]), "edges", msgRoot);
  });
  it("refuses a tree with no root (a pure cycle)", () => {
    refused(
      diagram("tree", [node("a"), node("b")], [edge("a", "b"), edge("b", "a")]),
      "edges",
      msgRoot
    );
  });
  it("refuses a node with two parents", () => {
    refused(
      diagram(
        "tree",
        [node("a"), node("b"), node("c")],
        [edge("a", "c"), edge("b", "c"), edge("a", "b")]
      ),
      "nodes.2",
      "every node of a tree has exactly one parent"
    );
  });
  it("refuses a cycle detached from the root, and a self-edge", () => {
    refused(
      diagram(
        "tree",
        [node("a"), node("b"), node("c")],
        [edge("b", "c"), edge("c", "b"), edge("a", "a")]
      ),
      "edges.2",
      "a tree has no self-edge"
    );
    refused(
      diagram("tree", [node("a"), node("b"), node("c")], [edge("b", "c"), edge("c", "b")]),
      "edges",
      "a tree has no cycle: every node must be reachable from its root"
    );
  });
  it("a 200-deep chain is a valid tree, checked without recursion", () => {
    const c = chain(200);
    expect(diagramProblems(diagram("tree", c.nodes, c.edges))).toEqual([]);
  });
  it("the other layouts ignore tree rules", () => {
    accepted(diagram("flow", [node("a"), node("b")]));
  });
});

describe("Diagram contract: timeline", () => {
  it("every node needs a date that parses", () => {
    accepted(
      diagram("timeline", [
        node("a", { at: "2026-03-05" }),
        node("b", { at: "2026-03-06T10:00:00Z" }),
      ])
    );
    refused(diagram("timeline", [node("a")]), "nodes.0.at", "a timeline node needs `at`");
    refused(diagram("timeline", [node("a", { at: "soon" })]), "nodes.0.at", "`at` must be a date");
    refused(diagram("timeline", [node("a", { at: "" })]), "nodes.0.at", "`at` must be a date");
  });
  it("other layouts ignore `at`", () => {
    accepted(diagram("network", [node("a", { at: "not a date" })]));
  });
});

describe("Diagram contract: type errors abort like any contract", () => {
  it("wrong field types are refused identically", () => {
    for (const bad of [
      null,
      {},
      diagram("tree", "x" as never),
      diagram("tree", [{ id: 1, label: "x" }]),
      diagram("tree", [node("a")], [{ from: "a" }]),
      diagram("tree", [node("a")], [], { timeFormat: { granularity: "fortnight" } }),
    ]) {
      const v = verdicts(bad);
      expect(v.zod.length).toBeGreaterThan(0);
      expect(v.lite).toEqual(v.zod);
    }
  });
  it("diagramProblems is total on junk", () => {
    for (const j of [
      null,
      undefined,
      1,
      "s",
      [],
      {},
      { nodes: [null, 1, "x"], edges: [null, {}], layout: "tree" },
    ])
      expect(() => diagramProblems(j as never)).not.toThrow();
  });
});

describe("diagramGraph", () => {
  it("marks back-edges and layers the rest by longest path", () => {
    const g = diagramGraph({
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [edge("a", "b"), edge("b", "c"), edge("a", "c"), edge("c", "a"), edge("c", "d")],
    } as never);
    expect(g.layers).toEqual([0, 1, 2, 3]);
    expect(g.edges.map((e) => e.back)).toEqual([false, false, false, true, false]);
  });
  it("a 200-deep chain layers without recursion", () => {
    const c = chain(200);
    const g = diagramGraph(c as never);
    expect(g.layers[199]).toBe(199);
  });
});

const words: TimeLabelWords = (key, vars) =>
  ({ "lu.time.half": "H{n}", "lu.time.quarter": "Q{n}", "lu.time.weekOf": "Week of {date}" })[
    key
  ].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
const lines = (v: unknown): string[] =>
  diagramOutline(v as DiagramValue, "en-US", words).map((l) => `${"  ".repeat(l.depth)}${l.text}`);

describe("diagramOutline", () => {
  it("a tree is depth-first, children in edge order", () => {
    expect(
      lines(
        diagram(
          "tree",
          [node("r"), node("a"), node("b"), node("a1"), node("a2")],
          [edge("r", "b"), edge("r", "a"), edge("a", "a2"), edge("a", "a1")]
        )
      )
    ).toEqual(["r", "  b", "  a", "    a2", "    a1"]);
  });
  it("a 200-deep tree outlines without recursion", () => {
    const c = chain(200);
    const out = diagramOutline(diagram("tree", c.nodes, c.edges) as never, "en-US", words);
    expect(out).toHaveLength(200);
    expect(out[199]?.depth).toBe(199);
  });
  it("a flow lists edges by the layer of their source, then input order; edge-less nodes last", () => {
    expect(
      lines(
        diagram(
          "flow",
          [node("a"), node("b"), node("c"), node("lone")],
          [edge("b", "c", { label: "ok" }), edge("a", "b"), edge("c", "a")]
        )
      )
    ).toEqual(["a → b", "b → c (ok)", "c → a", "lone"]);
  });
  it("a network lists edges in input order, then the nodes with none", () => {
    expect(
      lines(diagram("network", [node("x"), node("y"), node("z")], [edge("y", "x", { label: "" })]))
    ).toEqual(["y → x", "z"]);
  });
  it("a timeline sorts by date (stable for ties) and formats it", () => {
    expect(
      lines(
        diagram(
          "timeline",
          [
            node("late", { at: "2026-03-05" }),
            node("early", { at: "2026-01-02" }),
            node("tie1", { at: "2026-02-01" }),
            node("tie2", { at: "2026-02-01" }),
          ],
          [],
          { timeFormat: { granularity: "month" } }
        )
      )
    ).toEqual(["Jan 2026 — early", "Feb 2026 — tie1", "Feb 2026 — tie2", "Mar 2026 — late"]);
  });
  describe("timeline dates do not move with the reader's zone", () => {
    afterEach(() => vi.unstubAllEnvs());
    it("date-only `at` reads the same in New York and Tokyo", () => {
      const v = diagram("timeline", [
        node("a", { at: "2026-03-05" }),
        node("b", { at: "2026-12-31" }),
      ]);
      const seen: string[][] = [];
      for (const zone of ["America/New_York", "Asia/Tokyo"]) {
        vi.stubEnv("TZ", zone);
        seen.push(lines(v));
      }
      expect(seen[0]).toEqual(["Mar 5, 2026 — a", "Dec 31, 2026 — b"]);
      expect(seen[1]).toEqual(seen[0]);
    });
  });
  it("labels are data: markup and control text pass through untouched", () => {
    expect(lines(diagram("network", [{ id: "a", label: "<img src=x onerror=alert(1)>" }]))).toEqual(
      ["<img src=x onerror=alert(1)>"]
    );
  });
  it("is total on an unchecked tree (cycle, dangling edge)", () => {
    expect(() =>
      lines(
        diagram("tree", [node("a"), node("b")], [edge("a", "b"), edge("b", "a"), edge("a", "q")])
      )
    ).not.toThrow();
    expect(
      lines(diagram("tree", [node("a"), node("b")], [edge("a", "b"), edge("b", "a")]))
    ).toHaveLength(2);
  });
});
