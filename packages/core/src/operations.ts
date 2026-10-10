import type { DataClass } from "@loom/classify";
import { z } from "zod";
import { inheritedClass, liveClasses, ownClass, toolsOf } from "./classes";
import { type Experience, type Finding, ProviderSpec } from "./experience";
import {
  type ContainerNode,
  ExperienceNode,
  LocalizedText,
  MAX_TREE_DEPTH,
  NodeId,
  OrderKey,
  Priority,
  ProjectionBinding,
  Sensitivity,
  findNode,
  isContainer,
  isPlaced,
  normalize,
  placementProblems,
  rebuild,
  treeDepth,
  walk,
} from "./node";
import { strictestClass } from "./viewer";

// ── Operations, not diffs ─────────────────────────────────────────────────────
// Every change to an experience is a semantic Operation. Ops are the replay unit: `apply` is pure
// and total (a refusal is a finding, never a throw), `replay` folds a sequence deterministically,
// and a `prompt` op carries BOTH the intent text and the primitives it materialised — so replay
// folds the primitives and never re-invokes a planner. There is deliberately NO operation over
// `intent`: a new intent is a new lineage.
// A provider is retired by `removeProvider`, refused while any node still binds its handle.

export const Provenance = z.object({
  source: z.enum(["user", "agent", "application", "system"]),
  agentId: z.string().optional(),
  modelId: z.string().optional(),
  ref: z.string().optional(),
  /**
   * The loom decision that produced the op (U12): a planner turn is ONE `ctx.decide`, and its id
   * (`PlanReport.decisionId`) is what a replay serves, so it links a node back to the recorded
   * model call without copying the model's text into the log. Optional (every log written before it
   * parses unchanged) and outside the content address, like the rest of provenance.
   */
  decisionId: z.string().min(1).max(256).optional(),
  /**
   * The LEARNABLE loom decision behind the op (U11): the `decideWithPolicy` choice among planner
   * variants that shaped this plan, recorded with its policy and propensity. `decisionId` names
   * the model call; this names the choice a reward should be attributed to, so a late reward
   * (`runtime.recordOutcome`) lands on the decision off-policy evaluation reads. Optional, outside
   * the content address, and absent unless the planner ran with variants.
   */
  policyDecisionId: z.string().min(1).max(256).optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export type Operation =
  | { type: "insertNode"; parentId: string; node: ExperienceNode }
  | { type: "removeNode"; nodeId: string }
  | { type: "moveNode"; nodeId: string; newParentId: string; newOrder: string }
  | { type: "setProps"; nodeId: string; patch: Record<string, unknown> }
  /** `label: null` clears the label (the key is removed, so the node hashes as if never labelled), as `setTitle`/`setRole` clear. */
  | { type: "setLabel"; nodeId: string; label: LocalizedText | null }
  | { type: "setTitle"; nodeId: string; title: LocalizedText | null }
  | { type: "setRole"; nodeId: string; role: string | null }
  | {
      type: "setPlacement";
      nodeId: string;
      span?: number;
      row?: number | null;
      rowSpan?: number | null;
      column?: number | null;
    }
  | {
      type: "bindProvider";
      nodeId: string;
      handle: string;
      priority?: Priority;
      sensitivity?: DataClass;
    }
  /**
   * Remove a semantic node's HANDLE binding, leaving the provider declared (retire it with
   * `removeProvider`, which is refused while a node still binds it). The class the node carried on
   * the handle stays on the handle (sticky, never lowered). A node with no handle binding (including
   * one bound to a projection) is refused `not-bound`: nothing is silently dropped.
   */
  | { type: "unbindProvider"; nodeId: string }
  /**
   * Bind a semantic node to a non-hydration projection (`SemanticNode.projection`), replacing any
   * handle binding. The class never drops: the node keeps the strictest of the class it carried
   * (on its old projection or handle) and the one given, and the handle it leaves keeps its
   * sticky class. Validity against the host's projections is `compile`'s check, not this op's.
   */
  | { type: "bindProjection"; nodeId: string; projection: ProjectionBinding }
  /**
   * The ONLY op that lowers a class: sets it to `to`, or clears it, on the handle and on every
   * node that binds it. With `tool: true` it lowers the handle's TOOLS the same way; a handle's
   * class is also held by its tool, so lowering a handle alone is undone by the next provider
   * change on that tool — lower both when both are set. Caller-only: `apply`/`replay` refuse it
   * unless the caller passes `{ allowDeclassify: true }` (`declassify-not-allowed`), the planner
   * never emits it, and a `prompt` op carrying one is refused (`declassify-in-prompt`).
   */
  | { type: "declassifyHandle"; handle: string; to?: DataClass; tool?: boolean }
  /** Lowers a PROJECTION's sticky class (and its live nodes' own): trusted callers only, like `declassifyHandle`. */
  | { type: "declassifyProjection"; projection: string; to?: DataClass }
  | { type: "remapProvider"; handle: string; spec: z.infer<typeof ProviderSpec> }
  | { type: "removeProvider"; handle: string }
  | { type: "prompt"; text: string; scopeNodeIds?: string[]; materialized: Operation[] };

export const Operation: z.ZodType<Operation> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("insertNode"), parentId: NodeId, node: ExperienceNode }),
    z.object({ type: z.literal("removeNode"), nodeId: NodeId }),
    z.object({
      type: z.literal("moveNode"),
      nodeId: NodeId,
      newParentId: NodeId,
      newOrder: OrderKey,
    }),
    z.object({ type: z.literal("setProps"), nodeId: NodeId, patch: z.record(z.unknown()) }),
    // `label` is REQUIRED and `null` clears, as for `setTitle`.
    z.object({ type: z.literal("setLabel"), nodeId: NodeId, label: LocalizedText.nullable() }),
    // `title` is REQUIRED — the op exists to change it; `null` clears (JSON keeps a null, it drops
    // an undefined, so "clear" must be spelled null to survive a recorded replay).
    z.object({ type: z.literal("setTitle"), nodeId: NodeId, title: LocalizedText.nullable() }),
    // `role` is REQUIRED and `null` clears, as for `setTitle`. Deliberately loose (any string): the
    // SHAPE check is the node schema's `LayoutRole` (see `apply`), so a malformed role is refused
    // with the node's id, exactly as an `insertNode` of that container would be.
    z.object({ type: z.literal("setRole"), nodeId: NodeId, role: z.string().nullable() }),
    // Deliberately loose: the RANGE check is the node schema's (see `apply`), so a bad value is
    // refused with the node's id, exactly as an `insertNode` of that node would be.
    z.object({
      type: z.literal("setPlacement"),
      nodeId: NodeId,
      span: z.number().optional(),
      row: z.number().nullable().optional(),
      rowSpan: z.number().nullable().optional(),
      column: z.number().nullable().optional(),
    }),
    z.object({
      type: z.literal("bindProvider"),
      nodeId: NodeId,
      handle: z.string().min(1),
      priority: Priority.optional(),
      sensitivity: Sensitivity.optional(),
    }),
    z.object({ type: z.literal("unbindProvider"), nodeId: NodeId }),
    z.object({
      type: z.literal("bindProjection"),
      nodeId: NodeId,
      projection: ProjectionBinding,
    }),
    z.object({
      type: z.literal("declassifyHandle"),
      handle: z.string().min(1),
      to: Sensitivity.optional(),
      tool: z.boolean().optional(),
    }),
    z.object({
      type: z.literal("declassifyProjection"),
      projection: z.string().min(1),
      to: Sensitivity.optional(),
    }),
    z.object({ type: z.literal("remapProvider"), handle: z.string().min(1), spec: ProviderSpec }),
    z.object({ type: z.literal("removeProvider"), handle: z.string().min(1) }),
    z.object({
      type: z.literal("prompt"),
      text: z.string(),
      scopeNodeIds: z.array(NodeId).optional(),
      materialized: z.array(Operation),
    }),
  ])
) as z.ZodType<Operation>;

export interface RecordedOperation {
  readonly op: Operation;
  /**
   * The `versionHash` of the artifact the author composed this op against, when they declared
   * one. Informational in the log; enforced by {@link applyAt}. Absent = last-writer-wins.
   */
  readonly baseVersion?: string;
  readonly by: Provenance;
  readonly at: string;
}

export type OpResult<T> = { ok: true; value: T } | { ok: false; finding: Finding };

const refuse = (code: string, message: string, nodeId?: string): OpResult<never> => ({
  ok: false,
  finding: { code, severity: "error", message, ...(nodeId !== undefined && { nodeId }) },
});

/**
 * `classes` folded into `kept` by `strictest` — never lower. Returns `kept` itself when nothing
 * changed (so an unclassified experience never grows the field).
 */
function foldClasses(
  kept: Experience["handleClasses"],
  classes: ReadonlyArray<readonly [string, DataClass]>
): Experience["handleClasses"] {
  let out = kept;
  for (const [handle, c] of classes) {
    const had = out !== undefined && Object.hasOwn(out, handle) ? out[handle] : undefined;
    const merged = strictestClass(had, c);
    if (merged === had || merged === undefined) continue;
    out = { ...out, [handle]: merged };
  }
  return out;
}

/** Every (handle, class) a subtree's classified semantic bindings carry. */
function classesOf(node: ExperienceNode): Array<readonly [string, DataClass]> {
  const found: Array<readonly [string, DataClass]> = [];
  walk(node, (n) => {
    if (n.kind === "semantic" && n.binding?.sensitivity !== undefined)
      found.push([n.binding.handle, n.binding.sensitivity]);
  });
  return found;
}

/** `classes` folded into the sticky per-projection map, never lower. */
function foldProjectionClasses(
  kept: Experience["projectionClasses"],
  classes: ReadonlyArray<readonly [string, DataClass]>
): Experience["projectionClasses"] {
  let out = kept;
  for (const [id, c] of classes) {
    const had = out !== undefined && Object.hasOwn(out, id) ? out[id] : undefined;
    const merged = strictestClass(had, c);
    if (merged === had || merged === undefined) continue;
    out = { ...out, [id]: merged };
  }
  return out;
}

/** Every (projection id, class) a subtree's classified projection-bound nodes carry. */
function projectionClassesOf(node: ExperienceNode): Array<readonly [string, DataClass]> {
  const found: Array<readonly [string, DataClass]> = [];
  walk(node, (n) => {
    if (n.kind === "semantic" && n.projection?.sensitivity !== undefined)
      found.push([n.projection.id, n.projection.sensitivity]);
  });
  return found;
}

/** True when `ops` (looking through nested `prompt` ops) holds a `declassifyHandle`. */
function carriesDeclassify(ops: readonly Operation[]): boolean {
  const stack = [...ops];
  for (let op = stack.pop(); op !== undefined; op = stack.pop()) {
    if (op.type === "declassifyHandle" || op.type === "declassifyProjection") return true;
    if (op.type === "prompt") stack.push(...op.materialized);
  }
  return false;
}

/**
 * A new unpersisted artifact. Its parent is the base when the base is a sealed artifact; an
 * unsealed intermediate (mid-fold) carries its own parents forward, so a replay's result cites
 * the last SEALED ancestor, never nothing.
 */
function next(
  base: Experience,
  patch: Partial<
    Pick<Experience, "root" | "providers" | "handleClasses" | "toolClasses" | "projectionClasses">
  >
): Experience {
  return {
    ...base,
    ...patch,
    versionHash: "",
    parents: base.versionHash ? [base.versionHash] : base.parents,
  };
}

/**
 * Depth at which `id` sits in `root` (root itself is 1), or undefined. ITERATIVE, like
 * {@link treeDepth}: it runs on the refusal path, before anything recursive is allowed to.
 */
function depthOfNode(root: ExperienceNode, id: string): number | undefined {
  const stack: Array<{ node: ExperienceNode; depth: number }> = [{ node: root, depth: 1 }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    if (top.node.id === id) return top.depth;
    if (top.node.kind === "container")
      for (const child of top.node.children) stack.push({ node: child, depth: top.depth + 1 });
  }
  return undefined;
}

/** Ids of every semantic node (at any depth) whose binding names `handle`, in tree order. */
function bindersOf(root: ExperienceNode, handle: string): string[] {
  const ids: string[] = [];
  walk(root, (n) => {
    if (n.kind === "semantic" && n.binding?.handle === handle) ids.push(n.id);
  });
  return ids;
}

/**
 * The node `id` in `root` and the container that directly holds it (undefined for root itself),
 * or undefined when absent. ONE iterative walk, so an op that needs both pays for one.
 */
function locate(
  root: ExperienceNode,
  id: string
): { node: ExperienceNode; parent: ContainerNode | undefined } | undefined {
  if (root.id === id) return { node: root, parent: undefined };
  const stack: ExperienceNode[] = [root];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    if (top.kind !== "container") continue;
    for (const child of top.children) {
      if (child.id === id) return { node: child, parent: top };
      stack.push(child);
    }
  }
  return undefined;
}

const outsideGrid = (nodeId: string, parent: ContainerNode, fix: string): OpResult<never> =>
  refuse(
    "placement-outside-grid",
    `"${nodeId}" carries grid placement but its parent "${parent.id}" is a ${parent.direction} container, which does not lay it out; ${fix}`,
    nodeId
  );

/**
 * Why `n`, sitting under `parent`, has a placement that cannot be laid out — the op-level twin of
 * `validateExperience`'s `checkPlacement`, with the same codes and the same predicate
 * (`placementProblems`): outside a grid a placement is `placement-outside-grid`; inside one it
 * must fit (`placement-out-of-range`). Undefined when `n` is unplaced or fits. `fix` is the
 * calling op's remedy, appended to either refusal.
 */
function placementRefusal(
  n: ExperienceNode,
  parent: ContainerNode,
  fix: string
): OpResult<never> | undefined {
  if (!isPlaced(n)) return undefined;
  if (parent.direction !== "grid") return outsideGrid(n.id, parent, fix);
  const problems = placementProblems(n);
  return problems.length > 0
    ? refuse(
        "placement-out-of-range",
        `"${n.id}": placement cannot be laid out — ${problems.join("; ")}; ${fix}`,
        n.id
      )
    : undefined;
}

/**
 * {@link placementRefusal} for the first offending node in `node`'s subtree (itself included,
 * sitting under `parent`), in tree order. One ITERATIVE walk.
 */
function subtreePlacementRefusal(
  parent: ContainerNode,
  node: ExperienceNode,
  fix: string
): OpResult<never> | undefined {
  const stack: Array<{ node: ExperienceNode; parent: ContainerNode }> = [{ node, parent }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const refusal = placementRefusal(top.node, top.parent, fix);
    if (refusal) return refusal;
    if (top.node.kind === "container")
      for (let i = top.node.children.length - 1; i >= 0; i--)
        stack.push({ node: top.node.children[i] as ExperienceNode, parent: top.node });
  }
  return undefined;
}

type SetPlacement = Extract<Operation, { type: "setPlacement" }>;
const PLACEMENT_KEYS = ["row", "rowSpan", "column"] as const;

/**
 * The node with `op`'s placement applied. Absent = unchanged; `null` = cleared, and a cleared
 * key is REMOVED (not set to undefined) so the node hashes as if it was never placed. `null`
 * rather than `undefined` because ops are persisted as JSON, where an undefined-valued key
 * vanishes — a clear written that way would replay as "unchanged".
 */
function place(n: ExperienceNode, op: SetPlacement): ExperienceNode {
  const cleared = new Set<string>(PLACEMENT_KEYS.filter((k) => op[k] === null));
  const kept = Object.fromEntries(Object.entries(n).filter(([k]) => !cleared.has(k)));
  const set: Record<string, number> = {};
  if (op.span !== undefined) set.span = op.span;
  for (const k of PLACEMENT_KEYS) {
    const v = op[k];
    if (typeof v === "number") set[k] = v;
  }
  return { ...kept, ...set } as unknown as ExperienceNode;
}

/**
 * Who is applying an op. `allowDeclassify` is the trust boundary for lowering a class: it is an
 * argument of the CALL, never a field of the op, so a producer that only controls op data (a
 * planner's `PlanResult.ops`, a client) cannot mint it. The host passes it only for ops it
 * authored itself, or when replaying a log of its own already-authorised ops.
 */
export interface ApplyOptions {
  readonly allowDeclassify?: boolean;
  /**
   * Replaying RECORDED history: a `bindProvider` to an undeclared handle applies (the strict
   * `missing-provider` check is a write-path rule; older versions legally did this). Never set it
   * for a new write.
   */
  readonly legacyBind?: boolean;
}

/** Fold the classes the current handles carry into their tools, so a later retirement keeps them. */
function foldTools(exp: Experience): Experience {
  const live = liveClasses(exp.root);
  let tools = exp.toolClasses;
  for (const [handle, spec] of Object.entries(exp.providers)) {
    const c = ownClass(exp, live, handle);
    if (c === undefined) continue;
    for (const k of toolsOf(spec)) {
      const had = tools !== undefined && Object.hasOwn(tools, k) ? tools[k] : undefined;
      const merged = strictestClass(had, c);
      if (merged === had || merged === undefined) continue;
      tools = { ...tools, [k]: merged };
    }
  }
  return tools === exp.toolClasses
    ? exp
    : { ...exp, ...(tools !== undefined && { toolClasses: tools }) };
}

const BEFORE_FOLD = new Set<string>([
  "removeProvider",
  "remapProvider",
  "bindProvider",
  "unbindProvider",
]);
const AFTER_FOLD = new Set<string>(["insertNode", "remapProvider", "bindProvider"]);

export function apply(
  base: Experience,
  rawOp: Operation,
  opts: ApplyOptions = {}
): OpResult<Experience> {
  // Tool classes are folded from the handles that exist BEFORE an op that can retire or re-point a
  // provider, and from the ones that exist AFTER an op that can introduce a class or a provider.
  const type = (rawOp as { type?: unknown } | null)?.type;
  const pre = typeof type === "string" && BEFORE_FOLD.has(type) ? foldTools(base) : base;
  const r = applyOp(pre, rawOp, opts);
  return r.ok && typeof type === "string" && AFTER_FOLD.has(type)
    ? { ok: true, value: foldTools(r.value) }
    : r;
}

function applyOp(base: Experience, rawOp: Operation, opts: ApplyOptions): OpResult<Experience> {
  // Depth first, and before `Operation.safeParse`: zod's parse of `insertNode.node` is itself
  // recursive, so an over-deep subtree must be refused before the schema ever sees it.
  const baseDepth = treeDepth(base.root);
  if (baseDepth > MAX_TREE_DEPTH)
    return refuse(
      "tree-too-deep",
      `the experience tree nests ${baseDepth} levels, over the ${MAX_TREE_DEPTH} limit`,
      base.root.id
    );
  if (
    typeof rawOp === "object" &&
    rawOp !== null &&
    (rawOp as { type?: unknown }).type === "insertNode"
  ) {
    const raw = rawOp as { parentId?: unknown; node?: unknown };
    const added = treeDepth(raw.node as ExperienceNode);
    const parentDepth =
      typeof raw.parentId === "string" ? depthOfNode(base.root, raw.parentId) : undefined;
    if (parentDepth !== undefined && parentDepth + added > MAX_TREE_DEPTH)
      return refuse(
        "tree-too-deep",
        `inserting a ${added}-level subtree under "${raw.parentId}" (depth ${parentDepth}) would nest ${parentDepth + added} levels, over the ${MAX_TREE_DEPTH} limit`,
        typeof raw.parentId === "string" ? raw.parentId : undefined
      );
  }
  const parsed = Operation.safeParse(rawOp);
  if (!parsed.success)
    return refuse("invalid-operation", parsed.error.issues.map((i) => i.message).join("; "));
  const op = parsed.data;
  switch (op.type) {
    case "insertNode": {
      if (findNode(base.root, op.node.id))
        return refuse("duplicate-node-id", `node id "${op.node.id}" already exists`, op.node.id);
      const parent = findNode(base.root, op.parentId);
      if (!parent)
        return refuse("missing-parent", `insert parent "${op.parentId}" not found`, op.parentId);
      if (parent.kind !== "container")
        return refuse("not-a-container", `parent "${op.parentId}" is not a container`, op.parentId);
      const stray = subtreePlacementRefusal(
        parent,
        op.node,
        "insert it without row/rowSpan/column"
      );
      if (stray) return stray;
      const root = rebuild(base.root, (n) =>
        n.id === op.parentId && n.kind === "container"
          ? { ...n, children: [...n.children, normalize(op.node)] }
          : n
      );
      const handleClasses = foldClasses(base.handleClasses, classesOf(op.node));
      const projectionClasses = foldProjectionClasses(
        base.projectionClasses,
        projectionClassesOf(op.node)
      );
      return {
        ok: true,
        value: next(base, {
          root: normalize(root),
          ...(handleClasses !== undefined && { handleClasses }),
          ...(projectionClasses !== undefined && { projectionClasses }),
        }),
      };
    }
    case "removeNode": {
      if (op.nodeId === base.root.id)
        return refuse("root-immutable", "cannot remove the root node", op.nodeId);
      const doomed = findNode(base.root, op.nodeId);
      if (!doomed) return refuse("missing-node", `node "${op.nodeId}" not found`, op.nodeId);
      // What the removed subtree carried stays with its handles: removal is not declassification.
      const handleClasses = foldClasses(base.handleClasses, classesOf(doomed));
      const projectionClasses = foldProjectionClasses(
        base.projectionClasses,
        projectionClassesOf(doomed)
      );
      return {
        ok: true,
        value: next(base, {
          root: rebuild(base.root, (n) => (n.id === op.nodeId ? null : n)),
          ...(handleClasses !== undefined && { handleClasses }),
          ...(projectionClasses !== undefined && { projectionClasses }),
        }),
      };
    }
    case "moveNode": {
      if (op.nodeId === base.root.id)
        return refuse("root-immutable", "cannot move the root node", op.nodeId);
      const moving = findNode(base.root, op.nodeId);
      if (!moving) return refuse("missing-node", `node "${op.nodeId}" not found`, op.nodeId);
      const dest = findNode(base.root, op.newParentId);
      if (!dest || dest.kind !== "container")
        return refuse(
          "not-a-container",
          `move target "${op.newParentId}" is not a container`,
          op.newParentId
        );
      if (findNode(moving, op.newParentId))
        return refuse("cyclic-move", "cannot move a node into its own subtree", op.nodeId);
      // Only a grid lays out `row`/`rowSpan`/`column` (see `compile`), and only a placement that
      // fits it. Carrying one into a flow or stack container, or one that overflows the grid,
      // would leave a placement nothing honours — refused rather than silently dropped, so the
      // caller fixes it first with `setPlacement` and the loss is explicit. Descendants keep
      // their own parents, so only the moved node is checked.
      const misplaced = placementRefusal(
        moving,
        dest,
        "clear it first with setPlacement (row, column and rowSpan null)"
      );
      if (misplaced) return misplaced;
      const detached: ExperienceNode = { ...normalize(moving), order: op.newOrder };
      let root = rebuild(base.root, (n) => (n.id === op.nodeId ? null : n));
      root = rebuild(root, (n) =>
        n.id === op.newParentId && n.kind === "container"
          ? { ...n, children: [...n.children, detached] }
          : n
      );
      return { ok: true, value: next(base, { root: normalize(root) }) };
    }
    case "setPlacement": {
      if (op.nodeId === base.root.id)
        return refuse(
          "root-immutable",
          "the root is not a grid cell; it has no placement",
          op.nodeId
        );
      const found = locate(base.root, op.nodeId);
      if (!found) return refuse("missing-node", `node "${op.nodeId}" not found`, op.nodeId);
      const { node: target, parent } = found;
      if (op.span === undefined && PLACEMENT_KEYS.every((k) => op[k] === undefined))
        return refuse(
          "empty-placement",
          `setPlacement on "${op.nodeId}" names no field; an absent field means unchanged, so it would change nothing`,
          op.nodeId
        );
      // Setting (not clearing) a placement key under a non-grid parent would create a placement
      // nothing lays out; span-only changes and clears are always allowed.
      if (
        parent !== undefined &&
        parent.direction !== "grid" &&
        PLACEMENT_KEYS.some((k) => typeof op[k] === "number")
      )
        return outsideGrid(op.nodeId, parent, "move it into a grid first, or set only span");
      const placed = place(target, op);
      // Validated exactly as `insertNode` validates a node — through the node schema, so every
      // bound the schema declares applies here with no second copy. A container is checked
      // without its children: they are untouched and were valid before.
      const checked = ExperienceNode.safeParse(
        isContainer(placed) ? { ...placed, children: [] } : placed
      );
      if (!checked.success)
        return refuse(
          "invalid-operation",
          `setPlacement on "${op.nodeId}": ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          op.nodeId
        );
      // Under a grid the result must fit it — including after a span-only change to an
      // already-placed node. An unplaced node has nothing to overflow.
      if (parent?.direction === "grid") {
        const overflow = placementRefusal(
          placed,
          parent,
          "choose a column and span that fit the grid"
        );
        if (overflow) return overflow;
      }
      return {
        ok: true,
        value: next(base, { root: rebuild(base.root, (n) => (n.id === op.nodeId ? placed : n)) }),
      };
    }
    case "setTitle": {
      const target = findNode(base.root, op.nodeId);
      if (!target) return refuse("missing-node", `node "${op.nodeId}" not found`, op.nodeId);
      if (target.kind !== "container")
        return refuse(
          "not-container",
          `"${op.nodeId}" is a semantic node; setTitle applies to containers (a semantic node's heading is its label — setLabel)`,
          op.nodeId
        );
      const title = op.title;
      const root = rebuild(base.root, (n) => {
        if (n.id !== op.nodeId || n.kind !== "container") return n;
        // Cleared = key REMOVED (rebuilt, not deleted), so the container hashes as if never titled.
        if (title === null)
          return Object.fromEntries(
            Object.entries(n).filter(([k]) => k !== "title")
          ) as unknown as ExperienceNode;
        return { ...n, title };
      });
      return { ok: true, value: next(base, { root }) };
    }
    case "setRole": {
      const target = findNode(base.root, op.nodeId);
      if (!target) return refuse("missing-node", `node "${op.nodeId}" not found`, op.nodeId);
      if (target.kind !== "container")
        return refuse(
          "not-container",
          `"${op.nodeId}" is a semantic node; setRole applies to containers (a semantic node's renderer is chosen by the kind its type resolves to)`,
          op.nodeId
        );
      const role = op.role;
      // Cleared = key REMOVED (rebuilt, not deleted), so the container hashes as if never roled.
      const { role: _prior, ...rest } = target;
      const roled = role === null ? rest : { ...rest, role };
      // Validated through the node schema (children elided: untouched and valid before), so the
      // one role rule — loom's `isLayoutRole`, via `LayoutRole` — applies with no second copy.
      if (role !== null) {
        const checked = ExperienceNode.safeParse({ ...roled, children: [] });
        if (!checked.success)
          return refuse(
            "invalid-operation",
            `setRole on "${op.nodeId}": ${checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
            op.nodeId
          );
      }
      const root = rebuild(base.root, (n) => (n.id === op.nodeId ? roled : n));
      return { ok: true, value: next(base, { root }) };
    }
    case "setProps":
    case "setLabel":
    case "bindProvider": {
      const target = findNode(base.root, op.nodeId);
      if (!target) return refuse("missing-node", `node "${op.nodeId}" not found`, op.nodeId);
      if (target.kind !== "semantic")
        return refuse(
          "not-semantic",
          `"${op.nodeId}" is a container; ${op.type} applies to semantic nodes`,
          op.nodeId
        );
      // A handle must be declared (`remapProvider`, earlier in the same op list is fine) before a
      // node binds it: an undeclared one renders a permanently empty widget (`unknown-handle`).
      if (
        op.type === "bindProvider" &&
        opts.legacyBind !== true &&
        target.binding?.handle !== op.handle && // a re-pin of the CURRENT handle is not a new bind
        !Object.prototype.hasOwnProperty.call(base.providers, op.handle)
      )
        return refuse(
          "missing-provider",
          `bindProvider: provider "${op.handle}" is not declared; remapProvider it first`,
          op.nodeId
        );
      // A rebind keeps whatever class the node carried on the handle it LEAVES, and the class it
      // ends up with joins the handle it lands on.
      const carried = op.type === "bindProvider" ? classesOf(target) : [];
      const root = rebuild(base.root, (n) => {
        if (n.id !== op.nodeId || n.kind !== "semantic") return n;
        if (op.type === "setProps") return { ...n, props: { ...n.props, ...op.patch } };
        if (op.type === "setLabel") {
          // Cleared = key REMOVED (rebuilt, not deleted), so the node hashes as if never labelled.
          if (op.label === null)
            return Object.fromEntries(
              Object.entries(n).filter(([k]) => k !== "label")
            ) as unknown as ExperienceNode;
          return { ...n, label: op.label };
        }
        // `sensitivity` merges the way `priority` does: an op that does not mention it keeps the
        // class the node already carries, so re-binding a handle cannot silently declassify it.
        // A node leaving a classified PROJECTION for a handle carries that class with it.
        const sens = strictestClass(
          op.sensitivity ?? n.binding?.sensitivity,
          n.projection?.sensitivity
        );
        const { projection: _left, ...rest } = n;
        return {
          ...rest,
          binding: {
            handle: op.handle,
            priority: op.priority ?? n.binding?.priority ?? "P1",
            ...(sens !== undefined && { sensitivity: sens }),
          },
        };
      });
      if (op.type !== "bindProvider") return { ok: true, value: next(base, { root }) };
      const landed = findNode(root, op.nodeId);
      const handleClasses = foldClasses(base.handleClasses, [
        ...carried,
        ...(landed ? classesOf(landed) : []),
      ]);
      // The projection the node LEFT keeps what the node carried on it.
      const projectionClasses = foldProjectionClasses(
        base.projectionClasses,
        projectionClassesOf(target)
      );
      return {
        ok: true,
        value: next(base, {
          root,
          ...(handleClasses !== undefined && { handleClasses }),
          ...(projectionClasses !== undefined && { projectionClasses }),
        }),
      };
    }
    case "unbindProvider": {
      const target = findNode(base.root, op.nodeId);
      if (!target) return refuse("missing-node", `node "${op.nodeId}" not found`, op.nodeId);
      if (target.kind !== "semantic")
        return refuse(
          "not-semantic",
          `"${op.nodeId}" is a container; unbindProvider applies to semantic nodes`,
          op.nodeId
        );
      if (target.binding === undefined)
        return refuse("not-bound", `"${op.nodeId}" has no provider binding to remove`, op.nodeId);
      // The handle keeps what the node carried on it (sticky): unbinding never declassifies.
      const handleClasses = foldClasses(base.handleClasses, classesOf(target));
      const root = rebuild(base.root, (n) => {
        if (n.id !== op.nodeId || n.kind !== "semantic") return n;
        const { binding: _left, ...rest } = n;
        return rest;
      });
      return {
        ok: true,
        value: next(base, { root, ...(handleClasses !== undefined && { handleClasses }) }),
      };
    }
    case "bindProjection": {
      const target = findNode(base.root, op.nodeId);
      if (!target) return refuse("missing-node", `node "${op.nodeId}" not found`, op.nodeId);
      if (target.kind !== "semantic")
        return refuse(
          "not-semantic",
          `"${op.nodeId}" is a container; bindProjection applies to semantic nodes`,
          op.nodeId
        );
      const carried = classesOf(target);
      const sens = strictestClass(
        strictestClass(op.projection.sensitivity, target.projection?.sensitivity),
        target.binding?.sensitivity
      );
      const root = rebuild(base.root, (n) => {
        if (n.id !== op.nodeId || n.kind !== "semantic") return n;
        const { binding: _left, ...rest } = n;
        const { sensitivity: _s, ...bare } = op.projection;
        return {
          ...rest,
          projection: { ...bare, ...(sens !== undefined && { sensitivity: sens }) },
        };
      });
      const handleClasses = foldClasses(base.handleClasses, carried);
      // The projection the node LEFT keeps its class; the one it lands on gets the merged class.
      const landed = findNode(root, op.nodeId);
      const projectionClasses = foldProjectionClasses(base.projectionClasses, [
        ...projectionClassesOf(target),
        ...(landed ? projectionClassesOf(landed) : []),
      ]);
      return {
        ok: true,
        value: next(base, {
          root,
          ...(handleClasses !== undefined && { handleClasses }),
          ...(projectionClasses !== undefined && { projectionClasses }),
        }),
      };
    }
    case "declassifyHandle": {
      if (opts.allowDeclassify !== true)
        return refuse(
          "declassify-not-allowed",
          "declassifyHandle lowers a class and only a trusted caller may apply it (pass { allowDeclassify: true } for ops the host authored itself)"
        );
      const root = rebuild(base.root, (n) => {
        if (n.kind !== "semantic" || n.binding?.handle !== op.handle) return n;
        const { sensitivity: _drop, ...rest } = n.binding;
        return { ...n, binding: { ...rest, ...(op.to !== undefined && { sensitivity: op.to }) } };
      });
      const { [op.handle]: _gone, ...others } = base.handleClasses ?? {};
      const kept = { ...others, ...(op.to !== undefined && { [op.handle]: op.to }) };
      const { handleClasses: _old, ...withoutMap } = base;
      let nextBase: Experience =
        Object.keys(kept).length > 0 ? { ...withoutMap, handleClasses: kept } : withoutMap;
      const spec = Object.hasOwn(base.providers, op.handle) ? base.providers[op.handle] : undefined;
      if (op.tool === true && spec !== undefined) {
        const lowered = Object.fromEntries(
          Object.entries(base.toolClasses ?? {}).filter(([k]) => !toolsOf(spec).includes(k))
        );
        for (const k of toolsOf(spec)) if (op.to !== undefined) lowered[k] = op.to;
        const { toolClasses: _t, ...rest } = nextBase;
        nextBase = Object.keys(lowered).length > 0 ? { ...rest, toolClasses: lowered } : rest;
      }
      return { ok: true, value: next(nextBase, { root }) };
    }
    case "declassifyProjection": {
      if (opts.allowDeclassify !== true)
        return refuse(
          "declassify-not-allowed",
          "declassifyProjection lowers a class and only a trusted caller may apply it (pass { allowDeclassify: true } for ops the host authored itself)"
        );
      const root = rebuild(base.root, (n) => {
        if (n.kind !== "semantic" || n.projection?.id !== op.projection) return n;
        const { sensitivity: _drop, ...rest } = n.projection;
        return {
          ...n,
          projection: { ...rest, ...(op.to !== undefined && { sensitivity: op.to }) },
        };
      });
      const { [op.projection]: _gone, ...others } = base.projectionClasses ?? {};
      const kept = { ...others, ...(op.to !== undefined && { [op.projection]: op.to }) };
      const { projectionClasses: _old, ...withoutMap } = base;
      const nextBase: Experience =
        Object.keys(kept).length > 0 ? { ...withoutMap, projectionClasses: kept } : withoutMap;
      return { ok: true, value: next(nextBase, { root }) };
    }
    case "remapProvider": {
      if (op.spec.handle !== op.handle)
        return refuse("handle-mismatch", "remapProvider: spec.handle must equal handle");
      // A handle on a tool that ever carried a class carries it too, however it got here: a
      // changed argument or path is a different handle id, and must not shed the class.
      const inherited = inheritedClass(base, op.spec);
      const handleClasses = foldClasses(
        base.handleClasses,
        inherited === undefined ? [] : [[op.handle, inherited]]
      );
      return {
        ok: true,
        value: next(base, {
          providers: { ...base.providers, [op.handle]: op.spec },
          ...(handleClasses !== undefined && { handleClasses }),
        }),
      };
    }
    case "removeProvider": {
      // `hasOwnProperty`, not `in`: `providers` is a plain record, so `toString` or
      // `__proto__` would otherwise "exist" and be removed as a no-op.
      if (!Object.prototype.hasOwnProperty.call(base.providers, op.handle))
        return refuse("missing-provider", `provider "${op.handle}" not found`);
      // A binder with no provider renders a permanently empty widget (`unknown-handle`), so
      // the order is fixed: unbind or remove every binder first, then retire the provider.
      const binders = bindersOf(base.root, op.handle);
      if (binders.length > 0)
        return refuse(
          "provider-still-bound",
          `provider "${op.handle}" is still bound by ${binders.map((id) => `"${id}"`).join(", ")}; remove or rebind them first`,
          binders[0]
        );
      // Rebuilt, not `delete`d: the base is never mutated, and `fromEntries` keeps even a
      // `__proto__` handle an own key.
      const providers = Object.fromEntries(
        Object.entries(base.providers).filter(([h]) => h !== op.handle)
      );
      return { ok: true, value: next(base, { providers }) };
    }
    case "prompt":
      // A prompt's primitives are the planner's (the least trusted author in the pipeline), and
      // lowering a class is the one thing it may never do: refuse before folding any of them.
      if (carriesDeclassify(op.materialized))
        return refuse(
          "declassify-in-prompt",
          "a prompt op may not carry declassifyHandle: only the caller lowers a class"
        );
      // Replay path: fold the materialised primitives. Re-invoking the planner is never core's job.
      // A prompt that materialised NOTHING is still an event in the lineage — a planner that
      // declined, or produced only no-ops. `replay` over an empty list returns its argument
      // unchanged, which would hand back the SEALED base and make the op indistinguishable from
      // never having happened; `next` produces the unsealed child the other cases do.
      return op.materialized.length === 0
        ? { ok: true, value: next(base, {}) }
        : replay(base, op.materialized, opts.legacyBind === true ? { legacyBind: true } : {}); // no authority forwarded: a declassify was refused above
  }
}

/**
 * {@link apply} with an optimistic-concurrency precondition: the op was authored against the
 * artifact whose `versionHash` is `baseVersion`, and applies only if `base` is that artifact.
 * Otherwise a `stale-base-version` finding is returned and nothing is applied — the caller
 * re-reads and re-authors (rebase/merge is not built; see AGENTS.md). Never throws.
 *
 * `baseVersion` undefined = no precondition = exactly `apply` (last-writer-wins). A declared
 * base against an UNSEALED `base` (versionHash "") cannot be verified and is refused too.
 * Kept separate from `apply` so pure replay (`apply`/`replay`, which fold intermediate,
 * unsealed artifacts) is untouched.
 */
export function applyAt(
  base: Experience,
  rawOp: Operation,
  opts: { readonly baseVersion?: string } & ApplyOptions = {}
): OpResult<Experience> {
  const declared = opts.baseVersion;
  if (declared !== undefined && declared !== base.versionHash)
    return refuse(
      "stale-base-version",
      base.versionHash === ""
        ? `the op declares base version ${declared} but the artifact is unsealed, so it cannot be verified`
        : `the op was authored against ${declared} but the artifact is now ${base.versionHash}; re-read and re-author it`
    );
  return apply(base, rawOp, opts);
}

/** Fold ops onto a genesis. Deterministic and zero model invocations, by construction. */
export function replay(
  genesis: Experience,
  ops: readonly Operation[],
  opts: ApplyOptions = {}
): OpResult<Experience> {
  let cur = genesis;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Operation;
    const r = apply(cur, op, opts);
    if (!r.ok)
      return {
        ok: false,
        finding: { ...r.finding, message: `op #${i} (${op.type}): ${r.finding.message}` },
      };
    cur = r.value;
  }
  return { ok: true, value: cur };
}
