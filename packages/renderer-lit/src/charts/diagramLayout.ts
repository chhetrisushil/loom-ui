// Pure layout math for the `Diagram` widget: DOM-free, deterministic (the same value gives the same
// coordinates), iterative (a 200-deep chain must not recurse), no dependencies. The widget draws
// what this returns; `diagramGraph` (core) supplies the cycle breaking and layering the text outline
// reads too, so the drawn flow and the spoken one agree.

import { type DiagramValue, diagramGraph } from "@loomwork/ui-core/browser";

export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface PlacedNode {
  /** Index in `value.nodes`. */
  readonly index: number;
  /** Top-left corner and size. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export interface PlacedEdge {
  /** Index in `value.edges`. */
  readonly edge: number;
  /** Closes a cycle (flow): drawn apart, dashed. */
  readonly back: boolean;
  /** Line: [from, to]. Cubic curve (a back-edge, a self-loop): [from, control, control, to]. */
  readonly pts: readonly Point[];
}
export interface PlacedTick {
  readonly x: number;
  /** An ISO instant; the widget labels it (the host's timeFormat, in the reader's locale). */
  readonly iso: string;
}
export interface DiagramGeometry {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly PlacedEdge[];
  /** A timeline's axis ticks; empty for every other layout. */
  readonly ticks: readonly PlacedTick[];
  /** Where a timeline's axis line is drawn (y), else undefined. */
  readonly axisY?: number;
}

export const NODE_H = 28;
const GAP_X = 16;
const GAP_Y = 22;
const PAD = 16;
const MAX_LABEL = 28;
const CHAR_W = 7;

/** The label as drawn: a long one is cut with an ellipsis (the full text is the node's tooltip and the outline's). */
export function displayLabel(label: string): string {
  if (label.length <= MAX_LABEL) return label;
  let cut = MAX_LABEL - 1;
  const last = label.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--; // never split a surrogate pair
  return `${label.slice(0, cut)}…`;
}

export function nodeWidth(label: string): number {
  return Math.max(56, displayLabel(label).length * CHAR_W + 24);
}

interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** Where the line from a box's centre toward (tx, ty) leaves the box. */
function border(b: Box, tx: number, ty: number): Point {
  const dx = tx - b.cx;
  const dy = ty - b.cy;
  if (dx === 0 && dy === 0) return { x: b.cx, y: b.cy };
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : b.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : b.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: b.cx + dx * s, y: b.cy + dy * s };
}

const straight = (boxes: readonly Box[], from: number, to: number): readonly Point[] => {
  const a = boxes[from] as Box;
  const b = boxes[to] as Box;
  return [border(a, b.cx, b.cy), border(b, a.cx, a.cy)];
};

/** A cycle-closing edge: out of the top of `from`, over, and into the top of `to`. */
const arc = (boxes: readonly Box[], from: number, to: number): readonly Point[] => {
  const a = boxes[from] as Box;
  const b = boxes[to] as Box;
  const lift = 34;
  if (from === to) {
    const x = a.cx;
    const y = a.cy - a.h / 2;
    return [
      { x: x - 8, y },
      { x: x - 30, y: y - lift },
      { x: x + 30, y: y - lift },
      { x: x + 8, y },
    ];
  }
  const p = { x: a.cx, y: a.cy - a.h / 2 };
  const q = { x: b.cx, y: b.cy - b.h / 2 };
  const top = Math.min(p.y, q.y) - lift;
  return [p, { x: p.x, y: top }, { x: q.x, y: top }, q];
};

function finish(
  boxes: readonly Box[],
  edges: { edge: number; back: boolean; pts: readonly Point[] }[],
  ticks: readonly PlacedTick[] = [],
  axisY?: number
): DiagramGeometry {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const grow = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  for (const b of boxes) {
    grow(b.cx - b.w / 2, b.cy - b.h / 2);
    grow(b.cx + b.w / 2, b.cy + b.h / 2);
  }
  // A curve's control points bound it loosely: close enough for a canvas size, and never too small.
  for (const e of edges) for (const p of e.pts) grow(p.x, p.y);
  for (const t of ticks) grow(t.x, axisY ?? 0);
  if (axisY !== undefined) grow(minX, axisY - 4);
  const dx = PAD - minX;
  const dy = PAD - minY;
  const r1 = (n: number): number => Math.round(n * 10) / 10;
  return {
    width: r1(maxX - minX + 2 * PAD),
    height: r1(maxY - minY + 2 * PAD),
    nodes: boxes.map((b, index) => ({
      index,
      x: r1(b.cx - b.w / 2 + dx),
      y: r1(b.cy - b.h / 2 + dy),
      w: b.w,
      h: b.h,
    })),
    edges: edges.map((e) => ({
      ...e,
      pts: e.pts.map((p) => ({ x: r1(p.x + dx), y: r1(p.y + dy) })),
    })),
    ticks: ticks.map((t) => ({ ...t, x: r1(t.x + dx) })),
    ...(axisY === undefined ? {} : { axisY: r1(axisY + dy) }),
  };
}

const boxesOf = (value: DiagramValue): Box[] =>
  value.nodes.map((n) => ({ cx: 0, cy: 0, w: nodeWidth(n.label), h: NODE_H }));

// ── tree ─────────────────────────────────────────────────────────────────────────────────────────

function layoutTree(value: DiagramValue): DiagramGeometry {
  const n = value.nodes.length;
  const boxes = boxesOf(value);
  const g = diagramGraph(value);
  const children: number[][] = Array.from({ length: n }, () => []);
  const hasParent = new Array<boolean>(n).fill(false);
  for (const e of g.edges) {
    (children[e.from] as number[]).push(e.to);
    hasParent[e.to] = true;
  }
  const slot = Math.max(...boxes.map((b) => b.w)) + GAP_X;
  const rowH = NODE_H + GAP_Y + 12;
  const x = new Array<number>(n).fill(0);
  const depth = new Array<number>(n).fill(0);
  const seen = new Array<boolean>(n).fill(false);
  const preorder: number[] = [];
  let nextSlot = 0;
  const walk = (root: number): void => {
    const stack = [root];
    while (stack.length > 0) {
      const u = stack.pop() as number;
      if (seen[u]) continue;
      seen[u] = true;
      preorder.push(u);
      const kids = (children[u] as number[]).filter((c) => !seen[c]);
      children[u] = kids;
      if (kids.length === 0) x[u] = nextSlot++;
      for (let k = kids.length - 1; k >= 0; k--) {
        depth[kids[k] as number] = (depth[u] as number) + 1;
        stack.push(kids[k] as number);
      }
    }
  };
  for (let i = 0; i < n; i++) if (!hasParent[i]) walk(i);
  for (let i = 0; i < n; i++) if (!seen[i]) walk(i); // only an unchecked value gets here
  // A parent centres over its first and last child: children are finished before their parent in
  // reverse preorder.
  for (let k = preorder.length - 1; k >= 0; k--) {
    const u = preorder[k] as number;
    const kids = children[u] as number[];
    if (kids.length > 0)
      x[u] =
        ((x[kids[0] as number] as number) + (x[kids[kids.length - 1] as number] as number)) / 2;
  }
  boxes.forEach((b, i) => {
    b.cx = (x[i] as number) * slot;
    b.cy = (depth[i] as number) * rowH;
  });
  return finish(
    boxes,
    g.edges.map((e) => ({ edge: e.edge, back: false, pts: straight(boxes, e.from, e.to) }))
  );
}

// ── flow ─────────────────────────────────────────────────────────────────────────────────────────

const SWEEPS = 4;

function layoutFlow(value: DiagramValue): DiagramGeometry {
  const n = value.nodes.length;
  const boxes = boxesOf(value);
  const g = diagramGraph(value);
  const layerOf = g.layers;
  const depth = layerOf.reduce((m, l) => Math.max(m, l), 0) + 1;
  const columns: number[][] = Array.from({ length: depth }, () => []);
  for (let i = 0; i < n; i++) (columns[layerOf[i] as number] as number[]).push(i);

  const up: number[][] = Array.from({ length: n }, () => []); // predecessors over forward edges
  const down: number[][] = Array.from({ length: n }, () => []);
  for (const e of g.edges) {
    if (e.back) continue;
    (up[e.to] as number[]).push(e.from);
    (down[e.from] as number[]).push(e.to);
  }

  // Barycenter ordering: each layer is re-sorted by the mean position of its neighbours in the
  // adjacent layers, down then up, a few times. A node with no neighbour keeps its place; ties keep
  // the current order, so the result depends only on the input.
  const pos = new Array<number>(n).fill(0);
  const place = (col: readonly number[]): void => {
    col.forEach((u, k) => {
      pos[u] = k - (col.length - 1) / 2;
    });
  };
  for (const col of columns) place(col);
  const sweep = (order: readonly number[], toward: readonly number[][]): void => {
    for (const l of order) {
      const col = columns[l] as number[];
      const key = new Map<number, number>();
      for (const u of col) {
        const nb = toward[u] as number[];
        key.set(
          u,
          nb.length === 0
            ? (pos[u] as number)
            : nb.reduce((s, v) => s + (pos[v] as number), 0) / nb.length
        );
      }
      const current = new Map(col.map((u, k) => [u, k]));
      col.sort(
        (a, b) =>
          (key.get(a) as number) - (key.get(b) as number) ||
          (current.get(a) as number) - (current.get(b) as number)
      );
      place(col);
    }
  };
  const forward = Array.from({ length: Math.max(0, depth - 1) }, (_, i) => i + 1);
  const backward = Array.from({ length: Math.max(0, depth - 1) }, (_, i) => depth - 2 - i);
  for (let s = 0; s < SWEEPS; s++) {
    sweep(forward, up);
    sweep(backward, down);
  }

  const colW = columns.map((col) => col.reduce((m, u) => Math.max(m, (boxes[u] as Box).w), 0));
  const tallest = columns.reduce((m, c) => Math.max(m, c.length), 1);
  const rowH = NODE_H + GAP_Y;
  let left = 0;
  columns.forEach((col, l) => {
    const w = colW[l] as number;
    col.forEach((u, k) => {
      const b = boxes[u] as Box;
      b.cx = left + w / 2;
      b.cy = (k + (tallest - col.length) / 2) * rowH;
    });
    left += w + GAP_X * 3;
  });
  return finish(
    boxes,
    g.edges.map((e) => ({
      edge: e.edge,
      back: e.back,
      pts: e.back ? arc(boxes, e.from, e.to) : straight(boxes, e.from, e.to),
    }))
  );
}

// ── timeline ─────────────────────────────────────────────────────────────────────────────────────

const TICKS = 5;

function layoutTimeline(value: DiagramValue): DiagramGeometry {
  const n = value.nodes.length;
  const boxes = boxesOf(value);
  const at = value.nodes.map((node) => {
    const t = Date.parse(node.at ?? "");
    return Number.isNaN(t) ? 0 : t;
  });
  const lo = Math.min(...at);
  const hi = Math.max(...at);
  const plotW = Math.max(360, Math.min(1600, n * 90));
  const xOf = (t: number): number => (hi === lo ? plotW / 2 : ((t - lo) / (hi - lo)) * plotW);
  const rowH = NODE_H + 10;
  const axisY = 0;
  // Chronological, stable for ties; a node takes the first row where it clears the previous one.
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => (at[a] as number) - (at[b] as number) || a - b
  );
  const rowEnd: number[] = [];
  for (const u of order) {
    const b = boxes[u] as Box;
    b.cx = xOf(at[u] as number);
    const left = b.cx - b.w / 2;
    let row = rowEnd.findIndex((end) => end + 8 <= left);
    if (row < 0) row = rowEnd.length;
    rowEnd[row] = b.cx + b.w / 2;
    b.cy = axisY + 22 + NODE_H / 2 + row * rowH;
  }
  const g = diagramGraph(value);
  const count = hi === lo ? 1 : TICKS;
  const ticks = Array.from({ length: count }, (_, k) => {
    const t = count === 1 ? lo : lo + ((hi - lo) * k) / (count - 1);
    return { x: xOf(t), iso: new Date(t).toISOString() };
  });
  return finish(
    boxes,
    g.edges.map((e) => ({ edge: e.edge, back: false, pts: straight(boxes, e.from, e.to) })),
    ticks,
    axisY
  );
}

// ── network ──────────────────────────────────────────────────────────────────────────────────────

function layoutNetwork(value: DiagramValue): DiagramGeometry {
  const n = value.nodes.length;
  const boxes = boxesOf(value);
  const g = diagramGraph(value);
  if (n === 1) return finish(boxes, selfLoops(boxes, g.edges));
  // Adjacent nodes on the circle must clear each other (their diagonals plus a gap): the radius is
  // the smallest that spaces them by that chord at equal angles.
  const diag = (b: Box): number => Math.hypot(b.w, b.h);
  let need = 0;
  for (let i = 0; i < n; i++) {
    const a = boxes[i] as Box;
    const b = boxes[(i + 1) % n] as Box;
    need = Math.max(need, (diag(a) + diag(b)) / 2 + GAP_X);
  }
  const radius = Math.max(70, need / (2 * Math.sin(Math.PI / n)));
  boxes.forEach((b, i) => {
    const a = (2 * Math.PI * i) / n - Math.PI / 2; // the first node at the top, then clockwise
    b.cx = radius * Math.cos(a);
    b.cy = radius * Math.sin(a);
  });
  return finish(boxes, selfLoops(boxes, g.edges));
}

function selfLoops(
  boxes: readonly Box[],
  edges: readonly { edge: number; from: number; to: number; back: boolean }[]
): { edge: number; back: boolean; pts: readonly Point[] }[] {
  return edges.map((e) => ({
    edge: e.edge,
    back: false,
    pts: e.from === e.to ? arc(boxes, e.from, e.to) : straight(boxes, e.from, e.to),
  }));
}

/** Place a (checked) diagram. The layout is the value's `layout`. */
export function layoutDiagram(value: DiagramValue): DiagramGeometry {
  switch (value.layout) {
    case "tree":
      return layoutTree(value);
    case "flow":
      return layoutFlow(value);
    case "timeline":
      return layoutTimeline(value);
    case "network":
      return layoutNetwork(value);
  }
}

/** An edge as SVG path data. */
export function edgePath(e: PlacedEdge): string {
  const p = e.pts;
  const f = (q: Point): string => `${q.x},${q.y}`;
  return p.length === 4
    ? `M${f(p[0] as Point)}C${f(p[1] as Point)} ${f(p[2] as Point)} ${f(p[3] as Point)}`
    : `M${f(p[0] as Point)}L${f(p[1] as Point)}`;
}

/** The middle of an edge, where its label sits. */
export function edgeMidpoint(e: PlacedEdge): Point {
  const p = e.pts;
  if (p.length === 4) {
    const [a, b, c, d] = p as [Point, Point, Point, Point];
    return { x: (a.x + 3 * b.x + 3 * c.x + d.x) / 8, y: (a.y + 3 * b.y + 3 * c.y + d.y) / 8 };
  }
  const [a, b] = p as [Point, Point];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
