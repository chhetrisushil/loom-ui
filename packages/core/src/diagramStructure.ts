// ── Diagram structure (the `Diagram` kind) ────────────────────────────────────────────────────────
// Zod-free and DOM-free: the zod contract (`values.ts`) and the browser checker (`kindValues.ts`)
// both call `diagramProblems`, so the two cannot disagree on a rule or on its words. Every rule is
// O(nodes + edges) with Map/Set lookups and ITERATIVE traversal (a 200-deep chain must not recurse),
// and over-cap input is refused before anything is walked: the cost of a refusal is bounded.

/** A diagram draws at most this many nodes / edges; more is REFUSED (never truncated). */
export const MAX_DIAGRAM_NODES = 200;
export const MAX_DIAGRAM_EDGES = 400;

export const DIAGRAM_LAYOUTS = ["tree", "flow", "timeline", "network"] as const;
export type DiagramLayout = (typeof DIAGRAM_LAYOUTS)[number];

export interface DiagramProblem {
  readonly path: (string | number)[];
  readonly message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Why `nodes` / `edges` do not make a `layout` diagram; empty when they do. Total on any input.
 * Messages never echo a value (ids and labels are data).
 */
export function diagramProblems(v: {
  layout?: unknown;
  nodes?: unknown;
  edges?: unknown;
}): DiagramProblem[] {
  const out: DiagramProblem[] = [];
  const rec: Record<string, unknown> = isRecord(v) ? v : {};
  const layout = rec.layout;
  const nodes: readonly unknown[] = Array.isArray(rec.nodes) ? rec.nodes : [];
  const edges: readonly unknown[] = Array.isArray(rec.edges) ? rec.edges : [];
  // The caps come first and stop the walk: an over-cap value is refused whole.
  if (nodes.length < 1) out.push({ path: ["nodes"], message: "a diagram needs at least 1 node" });
  if (nodes.length > MAX_DIAGRAM_NODES)
    out.push({
      path: ["nodes"],
      message: `a diagram has at most ${MAX_DIAGRAM_NODES} nodes`,
    });
  if (edges.length > MAX_DIAGRAM_EDGES)
    out.push({
      path: ["edges"],
      message: `a diagram has at most ${MAX_DIAGRAM_EDGES} edges`,
    });
  if (nodes.length > MAX_DIAGRAM_NODES || edges.length > MAX_DIAGRAM_EDGES) return out;

  // ── ids ──
  const index = new Map<string, number>();
  let idsOk = true;
  nodes.forEach((n, i) => {
    const id = isRecord(n) ? n.id : undefined;
    if (typeof id !== "string") return;
    if (id.length === 0) {
      out.push({ path: ["nodes", i, "id"], message: "a node id must not be empty" });
      idsOk = false;
    } else if (index.has(id)) {
      out.push({ path: ["nodes", i, "id"], message: "node ids must be unique" });
      idsOk = false;
    } else index.set(id, i);
  });

  // ── edges name existing nodes ──
  const from: number[] = [];
  const to: number[] = [];
  let edgesOk = true;
  edges.forEach((e, i) => {
    const f = isRecord(e) && typeof e.from === "string" ? index.get(e.from) : undefined;
    const t = isRecord(e) && typeof e.to === "string" ? index.get(e.to) : undefined;
    if (f === undefined) {
      out.push({ path: ["edges", i, "from"], message: "an edge must start at an existing node" });
      edgesOk = false;
    }
    if (t === undefined) {
      out.push({ path: ["edges", i, "to"], message: "an edge must end at an existing node" });
      edgesOk = false;
    }
    if (f !== undefined && t !== undefined) {
      if (layout === "tree" && f === t) {
        out.push({ path: ["edges", i], message: "a tree has no self-edge" });
        edgesOk = false;
      }
      from.push(f);
      to.push(t);
    }
  });

  // ── timeline: every node is dated ──
  if (layout === "timeline") {
    nodes.forEach((n, i) => {
      const at = isRecord(n) ? n.at : undefined;
      if (at === undefined)
        out.push({ path: ["nodes", i, "at"], message: "a timeline node needs `at`" });
      else if (typeof at === "string" && Number.isNaN(Date.parse(at)))
        out.push({ path: ["nodes", i, "at"], message: "`at` must be a date" });
    });
  }

  // ── tree: one root, one parent each, everything reachable ──
  if (layout === "tree" && idsOk && edgesOk) {
    const count = nodes.length;
    const indegree = new Array<number>(count).fill(0);
    const children: number[][] = Array.from({ length: count }, () => []);
    for (let e = 0; e < from.length; e++) {
      const t = to[e] as number;
      indegree[t] = (indegree[t] as number) + 1;
      (children[from[e] as number] as number[]).push(to[e] as number);
    }
    const roots: number[] = [];
    indegree.forEach((d, i) => {
      if (d === 0) roots.push(i);
    });
    let structural = true;
    if (roots.length !== 1) {
      out.push({
        path: ["edges"],
        message: "a tree has exactly one root (a node with no incoming edge)",
      });
      structural = false;
    }
    indegree.forEach((d, i) => {
      if (d > 1) {
        out.push({ path: ["nodes", i], message: "every node of a tree has exactly one parent" });
        structural = false;
      }
    });
    if (structural) {
      const seen = new Array<boolean>(count).fill(false);
      const stack = [roots[0] as number];
      seen[roots[0] as number] = true;
      let reached = 0;
      while (stack.length > 0) {
        const n = stack.pop() as number;
        reached++;
        for (const c of children[n] as number[])
          if (!seen[c]) {
            seen[c] = true;
            stack.push(c);
          }
      }
      if (reached !== count)
        out.push({
          path: ["edges"],
          message: "a tree has no cycle: every node must be reachable from its root",
        });
    }
  }
  return out;
}
