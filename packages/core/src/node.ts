import type { DataClass } from "@loom/classify";
import { z } from "zod";

// ── The Experience node tree ──────────────────────────────────────────────────
// Two node kinds. Both carry a stable `id` (minted once, never reused) and a fractional `order`
// key (see order.ts) so concurrent inserts never collide. A SEMANTIC node names a catalogue type
// — `Trend`, `Metric` — never a visual kind; the catalogue resolves it per surface (catalog.ts).

export const NodeId = z.string().min(1);
// Base-62 only. An order key is compared with a plain string compare and minted by `order.ts`
// from that alphabet; anything else is either a hand-written key that will sort somewhere its
// author did not intend, or a value from outside that was never an order key at all.
export const OrderKey = z.string().regex(/^[0-9A-Za-z]+$/);
export const Priority = z.enum(["P0", "P1", "P2"]);
export type Priority = z.infer<typeof Priority>;
/**
 * The column count of every grid `compile` emits (`grid({ columns: GRID_COLUMNS })`) — the range a
 * node's `span` and `column` are checked against.
 */
export const GRID_COLUMNS = 12;
export const Span = z.number().int().min(1).max(GRID_COLUMNS);
/** A 1-based grid line or extent — a node's `row` or `rowSpan` (loom ADR 0098 D1). No upper bound: a grid grows implicit rows. */
export const GridLine = z.number().int().min(1);
/** A start column, 1-based, inside the grid: the node occupies `column..column+span-1`. */
export const GridColumn = z.number().int().min(1).max(GRID_COLUMNS);
/**
 * A binding's confidentiality class, `@loom/classify`'s vocabulary. DECLARED here and carried onto
 * the compiled `DataBinding.sensitivity` (loom ADR 0097 D4) so an audience check downstream reads
 * it off the artifact; nothing in this package enforces it.
 */
export const Sensitivity = z.enum(["secret", "sensitive", "internal"]);

export const LocalizedText = z.object({ key: z.string().min(1), fallback: z.string() });
export type LocalizedText = z.infer<typeof LocalizedText>;

export interface ContainerNode {
  id: string;
  order: string;
  kind: "container";
  direction: "row" | "column" | "grid";
  span: number;
  /** Start row in the PARENT grid, 1-based (loom ADR 0098 D1). Absent ⇒ flow placement. */
  row?: number;
  /** Rows occupied in the parent grid; default 1. */
  rowSpan?: number;
  /** Start column in the parent grid, 1-based; the node occupies `column..column+span-1`. */
  column?: number;
  /** A section heading, resolved at compile through `resolveLabel` like a node label. */
  title?: LocalizedText;
  gap?: number;
  children: ExperienceNode[];
}

export interface SemanticNode {
  id: string;
  order: string;
  kind: "semantic";
  type: string;
  typeVersion: string;
  span: number;
  /** Start row in the PARENT grid, 1-based (loom ADR 0098 D1). Absent ⇒ flow placement. */
  row?: number;
  /** Rows occupied in the parent grid; default 1. */
  rowSpan?: number;
  /** Start column in the parent grid, 1-based; the node occupies `column..column+span-1`. */
  column?: number;
  label?: LocalizedText;
  props: Record<string, unknown>;
  binding?: { handle: string; priority: Priority; sensitivity?: DataClass };
}

export type ExperienceNode = ContainerNode | SemanticNode;

export const ExperienceNode: z.ZodType<ExperienceNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      id: NodeId,
      order: OrderKey,
      kind: z.literal("container"),
      direction: z.enum(["row", "column", "grid"]),
      span: Span,
      row: GridLine.optional(),
      rowSpan: GridLine.optional(),
      column: GridColumn.optional(),
      title: LocalizedText.optional(),
      gap: z.number().optional(),
      children: z.array(ExperienceNode),
    }),
    z.object({
      id: NodeId,
      order: OrderKey,
      kind: z.literal("semantic"),
      type: z.string().min(1),
      typeVersion: z.string().min(1),
      span: Span,
      row: GridLine.optional(),
      rowSpan: GridLine.optional(),
      column: GridColumn.optional(),
      label: LocalizedText.optional(),
      props: z.record(z.unknown()),
      binding: z
        .object({
          handle: z.string().min(1),
          priority: Priority,
          sensitivity: Sensitivity.optional(),
        })
        .optional(),
    }),
  ])
) as z.ZodType<ExperienceNode>;

export function isContainer(n: ExperienceNode): n is ContainerNode {
  return n.kind === "container";
}

/** A node's explicit grid position (loom ADR 0098 D1): the keys it sets, and no others. */
export type Placement = Pick<SemanticNode, "row" | "rowSpan" | "column">;

/** The placement keys `n` sets — never a present-and-undefined key, so it spreads into `cell()` as-is. */
export function placementOf(n: ExperienceNode): Placement {
  return {
    ...(n.row !== undefined && { row: n.row }),
    ...(n.rowSpan !== undefined && { rowSpan: n.rowSpan }),
    ...(n.column !== undefined && { column: n.column }),
  };
}

/** True iff the node sets any of `row`, `rowSpan`, `column`. */
export function isPlaced(n: ExperienceNode): boolean {
  return n.row !== undefined || n.rowSpan !== undefined || n.column !== undefined;
}

const isPositiveInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
const show = (v: unknown): string => JSON.stringify(v) ?? String(v);

/**
 * Why `n`'s placement cannot be laid out in a `columns`-wide grid — empty when it can. The same
 * predicate, and the same wording, as loom's `validateBlueprint` `placement-out-of-range`
 * (ADR 0098 D5): a `row`/`rowSpan` that is not a positive integer, a `column` outside
 * `1..columns`, a `column + span - 1` past the last column. The overflow test runs only for a
 * valid span, so an invalid span is reported once (by loom, as `span-out-of-range`). Tolerates
 * unparsed input: every field is read as `unknown`.
 *
 * Width-parametric, like loom's predicate: `columns` defaults to `GRID_COLUMNS` (the width
 * `compile` targets), and a composer may pass any other grid width to check against.
 */
export function placementProblems(n: ExperienceNode, columns: number = GRID_COLUMNS): string[] {
  const { row, rowSpan, column, span } = n as {
    row?: unknown;
    rowSpan?: unknown;
    column?: unknown;
    span?: unknown;
  };
  const out: string[] = [];
  if (row !== undefined && !isPositiveInt(row))
    out.push(`row ${show(row)} is not a positive integer`);
  if (rowSpan !== undefined && !isPositiveInt(rowSpan))
    out.push(`rowSpan ${show(rowSpan)} is not a positive integer`);
  if (column !== undefined) {
    if (!isPositiveInt(column) || column > columns)
      out.push(`column ${show(column)} is outside 1..${columns}`);
    else if (isPositiveInt(span) && span <= columns && column + span - 1 > columns)
      out.push(`column ${column} + span ${span} overflows the ${columns}-column grid`);
  }
  return out;
}

/**
 * The deepest nesting an experience tree may carry. Everything downstream of the tree — zod's
 * recursive parse, `walk`, `rebuild`, `normalize`, `canonicalJson` — is recursive, so a tree deep
 * enough to exhaust the JS stack turns a total, finding-returning API into a `RangeError` thrown
 * from inside a library. The cap is checked at every entry point BEFORE any of that runs, so a
 * hostile or generated tree is refused with a finding instead.
 */
export const MAX_TREE_DEPTH = 256;

/**
 * Depth of the deepest path, counting the root as 1. ITERATIVE by construction (an explicit
 * stack): this is the guard that keeps the recursive code below from being reached, so it must
 * itself survive a tree no recursive walk could. Tolerates unparsed input — it runs before the
 * zod parse — and reports 0 for anything that is not a node object.
 */
export function treeDepth(root: ExperienceNode): number {
  if (typeof root !== "object" || root === null) return 0;
  let max = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { node, depth } = top;
    if (typeof node !== "object" || node === null) continue;
    if (depth > max) max = depth;
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push({ node: child, depth: depth + 1 });
    }
  }
  return max;
}

/** Depth-first walk, parent before children. */
export function walk(
  root: ExperienceNode,
  visit: (n: ExperienceNode, parent: ContainerNode | null) => void
): void {
  const rec = (n: ExperienceNode, parent: ContainerNode | null): void => {
    visit(n, parent);
    if (isContainer(n)) for (const c of n.children) rec(c, n);
  };
  rec(root, null);
}

export function findNode(root: ExperienceNode, id: string): ExperienceNode | undefined {
  let found: ExperienceNode | undefined;
  walk(root, (n) => {
    if (n.id === id) found = n;
  });
  return found;
}

export function nodeIds(root: ExperienceNode): string[] {
  const ids: string[] = [];
  walk(root, (n) => ids.push(n.id));
  return ids;
}

/**
 * Structural copy (children re-sorted; `props` shallow-copied; `label`/`binding` shared) with
 * children sorted by `order` at every level. Never mutates its input.
 */
export function normalize(node: ExperienceNode): ExperienceNode {
  if (!isContainer(node)) return { ...node, props: { ...node.props } };
  const children = [...node.children]
    .map(normalize)
    .sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : 0));
  return { ...node, children };
}

/** Replace / remove within an immutable tree. `edit` returning null removes the node. */
export function rebuild(
  root: ExperienceNode,
  edit: (n: ExperienceNode, parentId: string | null) => ExperienceNode | null
): ExperienceNode {
  const rec = (n: ExperienceNode, parentId: string | null): ExperienceNode | null => {
    const kept = edit(n, parentId);
    if (kept === null) return null;
    if (!isContainer(kept)) return kept;
    const children = kept.children
      .map((c) => rec(c, kept.id))
      .filter((c): c is ExperienceNode => c !== null);
    return { ...kept, children };
  };
  const out = rec(root, null);
  if (out === null) throw new Error("rebuild removed the root node");
  return out;
}
