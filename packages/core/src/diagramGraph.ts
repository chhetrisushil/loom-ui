// ── Diagram graph helpers: cycle breaking and layering, shared by the outline and the web layout ──
// Zod-free. Iterative everywhere (a 200-deep chain must not recurse), O(nodes + edges). The text
// outline (`diagramText.ts`) and the drawn flow (renderer-lit) both read the layers from HERE, so
// the order a reader hears is the order a sighted reader sees.

import type { DiagramValue } from "./values";

export interface ResolvedEdge {
  /** Index in `value.edges`. */
  readonly edge: number;
  /** Node indexes in `value.nodes`. */
  readonly from: number;
  readonly to: number;
  /** A DFS back-edge (or self-edge): it closes a cycle, so layering ignores it and it is drawn apart. */
  readonly back: boolean;
}

export interface DiagramGraph {
  readonly edges: readonly ResolvedEdge[];
  /** Longest-path layer per node, over the edges that are not back-edges. 0 = a source. */
  readonly layers: readonly number[];
}

/**
 * The resolved edges (an edge naming an unknown node is dropped: a checked value has none), which
 * of them are back-edges, and every node's longest-path layer. DFS starts at the nodes with no
 * incoming edge, then at the rest in input order, so the result depends only on the input order.
 */
export function diagramGraph(value: Pick<DiagramValue, "nodes" | "edges">): DiagramGraph {
  const n = value.nodes.length;
  const index = new Map<string, number>();
  value.nodes.forEach((node, i) => {
    if (!index.has(node.id)) index.set(node.id, i);
  });
  const raw: { edge: number; from: number; to: number }[] = [];
  value.edges.forEach((e, i) => {
    const f = index.get(e.from);
    const t = index.get(e.to);
    if (f !== undefined && t !== undefined) raw.push({ edge: i, from: f, to: t });
  });

  const out: number[][] = Array.from({ length: n }, () => []); // raw edge positions per source
  const indegree = new Array<number>(n).fill(0);
  raw.forEach((e, k) => {
    (out[e.from] as number[]).push(k);
    indegree[e.to] = (indegree[e.to] as number) + 1;
  });

  // Iterative DFS with colours: 0 unvisited, 1 on the stack, 2 done. An edge into a node on the
  // stack closes a cycle.
  const back = new Array<boolean>(raw.length).fill(false);
  const colour = new Array<number>(n).fill(0);
  const starts: number[] = [];
  for (let i = 0; i < n; i++) if (indegree[i] === 0) starts.push(i);
  for (let i = 0; i < n; i++) if (indegree[i] !== 0) starts.push(i);
  for (const s of starts) {
    if (colour[s] !== 0) continue;
    const stack: { node: number; next: number }[] = [{ node: s, next: 0 }];
    colour[s] = 1;
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { node: number; next: number };
      const outs = out[top.node] as number[];
      if (top.next >= outs.length) {
        colour[top.node] = 2;
        stack.pop();
        continue;
      }
      const k = outs[top.next++] as number;
      const t = (raw[k] as { to: number }).to;
      if (colour[t] === 1) back[k] = true;
      else if (colour[t] === 0) {
        colour[t] = 1;
        stack.push({ node: t, next: 0 });
      }
    }
  }

  // Longest-path layering over the acyclic remainder (Kahn's order).
  const layers = new Array<number>(n).fill(0);
  const remaining = new Array<number>(n).fill(0);
  raw.forEach((e, k) => {
    if (!back[k]) remaining[e.to] = (remaining[e.to] as number) + 1;
  });
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (remaining[i] === 0) queue.push(i);
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head] as number;
    for (const k of out[u] as number[]) {
      if (back[k]) continue;
      const t = (raw[k] as { to: number }).to;
      layers[t] = Math.max(layers[t] as number, (layers[u] as number) + 1);
      remaining[t] = (remaining[t] as number) - 1;
      if (remaining[t] === 0) queue.push(t);
    }
  }
  return {
    edges: raw.map((e, k) => ({ ...e, back: back[k] as boolean })),
    layers,
  };
}
