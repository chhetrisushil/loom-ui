import { isLayoutRole } from "@loom/blueprint-runtime";
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
/**
 * A `row` / `rowSpan` past this draws a `grid-line-extreme` WARN from `validateExperience`. The IR
 * stays unbounded (ADR 0098 D1: a grid grows implicit rows), so nothing is rejected; the threshold
 * only flags a runaway planner output. Exactly this value is fine; one more warns.
 */
export const GRID_LINE_WARN_ABOVE = 1000;
/** A start column, 1-based, inside the grid: the node occupies `column..column+span-1`. */
export const GridColumn = z.number().int().min(1).max(GRID_COLUMNS);
/**
 * A binding's confidentiality class, `@loom/classify`'s vocabulary. DECLARED here and carried onto
 * the compiled `DataBinding.sensitivity` (loom ADR 0097 D4). It IS enforced, at the two places
 * viewer-visible output is produced: `compile` redacts a node the `Viewer` may not see
 * (`CompileOptions.viewer`), and hydration refuses to fetch or serve its handle
 * (`ControllerOptions.viewer`, `ServeOptions.viewer`). No viewer is the most restrictive viewer.
 * See `viewer.ts`.
 */
export const Sensitivity = z.enum(["secret", "sensitive", "internal"]);

/**
 * A container's role (Blueprint IR 2.2.0, loom ADR 0099): the open, app-defined key a container
 * renderer is registered under — what `Widget.kind` is for a widget. Checked with loom's own
 * `isLayoutRole` (`/^[a-z][a-z0-9-]{0,63}$/`), the one spelling of the rule, so this schema and a
 * renderer's lookup cannot drift apart. Never an ARIA role and never display text.
 */
export const LayoutRole = z.custom<string>(isLayoutRole, {
  message:
    "a layout role is a lowercase letter, then lowercase letters, digits or hyphens, at most 64 characters",
});

/**
 * A semantic node's binding to ANY loom projection other than the hydration projection (an agent
 * status, an approval queue, a transcript...). It is the node-side half of one IR `DataBinding`:
 * `id` is the `projectionId`, `path` the value path inside that projection's state, `statusPath`
 * the optional status channel in the SAME state, and `version` the declared version of the
 * projection the author composed against (loom ADR 0095 — it lands in
 * `Blueprint.projectionVersions` and is checked against the host's projection catalogue at
 * compile). `sensitivity` is the author's class for the data; the host's catalogue may only
 * raise it. A node carries `binding` (a hydrated handle) or `projection`, never both.
 */
/** Caps on a projection binding's strings: they reach the Blueprint, findings and the content address. */
export const MAX_PROJECTION_ID = 128;
export const MAX_PROJECTION_PATH = 512;

export const ProjectionBinding = z.object({
  // `__proto__` is refused: a sticky class held for it would be dropped from the plain-object
  // class residue the content address hashes (assignment to `__proto__` is a no-op there).
  id: z
    .string()
    .min(1)
    .max(MAX_PROJECTION_ID)
    .refine((id) => id !== "__proto__", { message: "reserved projection id" }),
  path: z.string().min(1).max(MAX_PROJECTION_PATH),
  statusPath: z.string().min(1).max(MAX_PROJECTION_PATH).optional(),
  version: z.string().min(1).max(MAX_PROJECTION_ID),
  sensitivity: Sensitivity.optional(),
});
export type ProjectionBinding = z.infer<typeof ProjectionBinding>;

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
  /**
   * What this container is to a renderer that knows it (`LayoutRole`, loom ADR 0099) — a stepped
   * section, a tab set. Absent, or unknown to the renderer in use ⇒ the plain container.
   */
  role?: string;
  /**
   * Who may revise this container's membership (U15). `"planner"` marks a container a planner
   * authored: a later revise may retitle, re-role, move into, move out of and remove it. Absent ⇒
   * application-owned: a planner treats it as LOCKED (never edits, moves into, or removes it).
   * It is an edit boundary, not an access control, and it never reaches the compiled Blueprint;
   * an absent owner hashes exactly as before.
   */
  owner?: ContainerOwner;
  gap?: number;
  children: ExperienceNode[];
}

/** Who a container's membership belongs to. Absent ⇒ the application. */
export type ContainerOwner = "planner";
export const ContainerOwner = z.literal("planner");

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
  /** A binding to a non-hydration projection. Mutually exclusive with `binding` (`binding-conflict`). */
  projection?: ProjectionBinding;
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
      role: LayoutRole.optional(),
      owner: ContainerOwner.optional(),
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
      projection: ProjectionBinding.optional(),
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
 * Why `n`'s role is not a well-formed layout role — undefined when it is absent or well-formed.
 * The same predicate (`isLayoutRole`) and the same bounded echo as loom's `validateBlueprint`
 * `role-invalid` (ADR 0099 D4): the value is untrusted and can be any size. Tolerates unparsed input.
 */
export function roleProblem(n: ExperienceNode): string | undefined {
  const role = (n as { role?: unknown }).role;
  if (role === undefined || isLayoutRole(role)) return undefined;
  const shown =
    typeof role === "string"
      ? `${JSON.stringify(role.slice(0, 64))}${role.length > 64 ? "…" : ""} (length ${role.length})`
      : `of type ${role === null ? "null" : typeof role}`;
  return `role ${shown} is not a well-formed role (a lowercase letter, then lowercase letters, digits or hyphens, at most 64 characters)`;
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

type Sibling = { order: string; id: string };

/**
 * LEGACY sibling order: by `order` key ONLY. Used with a STABLE sort, so tied keys keep their
 * insertion order. This is the order every HASHED or FOLDED path uses (`experienceArtifact`,
 * `apply`/`replay`): changing how ties resolve there would move the content address of every
 * stored experience that has tied sibling keys.
 */
export function compareByOrder(x: Sibling, y: Sibling): number {
  return x.order < y.order ? -1 : x.order > y.order ? 1 : 0;
}

/**
 * TOTAL sibling order: by `order` key, then by node id on a tie. Equal keys (legacy data, or a
 * salt collision) therefore never leave sibling order to insertion order. Use it ONLY where order
 * must be total and nothing is hashed — the render / compile boundary.
 */
export function compareSiblings(x: Sibling, y: Sibling): number {
  const byKey = compareByOrder(x, y);
  if (byKey !== 0) return byKey;
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

/**
 * Structural copy (children re-sorted; `props` shallow-copied; `label`/`binding` shared) with
 * children sorted at every level — by `order` only (stable, legacy; the hash path) unless a
 * `compare` is given (the render boundary passes {@link compareSiblings}). Never mutates its input.
 */
export function normalize(
  node: ExperienceNode,
  compare: (x: Sibling, y: Sibling) => number = compareByOrder
): ExperienceNode {
  if (!isContainer(node)) return { ...node, props: { ...node.props } };
  const children = node.children.map((c) => normalize(c, compare)).sort(compare);
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
