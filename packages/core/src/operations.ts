import type { DataClass } from "@loom/classify";
import { z } from "zod";
import { type Experience, type Finding, ProviderSpec } from "./experience";
import {
  ExperienceNode,
  LocalizedText,
  MAX_TREE_DEPTH,
  NodeId,
  OrderKey,
  Priority,
  Sensitivity,
  findNode,
  normalize,
  rebuild,
  treeDepth,
  walk,
} from "./node";

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
});
export type Provenance = z.infer<typeof Provenance>;

export type Operation =
  | { type: "insertNode"; parentId: string; node: ExperienceNode }
  | { type: "removeNode"; nodeId: string }
  | { type: "moveNode"; nodeId: string; newParentId: string; newOrder: string }
  | { type: "setProps"; nodeId: string; patch: Record<string, unknown> }
  | { type: "setLabel"; nodeId: string; label: LocalizedText }
  | {
      type: "bindProvider";
      nodeId: string;
      handle: string;
      priority?: Priority;
      sensitivity?: DataClass;
    }
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
    z.object({ type: z.literal("setLabel"), nodeId: NodeId, label: LocalizedText }),
    z.object({
      type: z.literal("bindProvider"),
      nodeId: NodeId,
      handle: z.string().min(1),
      priority: Priority.optional(),
      sensitivity: Sensitivity.optional(),
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
  readonly by: Provenance;
  readonly at: string;
}

export type OpResult<T> = { ok: true; value: T } | { ok: false; finding: Finding };

const refuse = (code: string, message: string, nodeId?: string): OpResult<never> => ({
  ok: false,
  finding: { code, severity: "error", message, ...(nodeId !== undefined && { nodeId }) },
});

/**
 * A new unpersisted artifact. Its parent is the base when the base is a sealed artifact; an
 * unsealed intermediate (mid-fold) carries its own parents forward, so a replay's result cites
 * the last SEALED ancestor, never nothing.
 */
function next(
  base: Experience,
  patch: Partial<Pick<Experience, "root" | "providers">>
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

export function apply(base: Experience, rawOp: Operation): OpResult<Experience> {
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
      const root = rebuild(base.root, (n) =>
        n.id === op.parentId && n.kind === "container"
          ? { ...n, children: [...n.children, normalize(op.node)] }
          : n
      );
      return { ok: true, value: next(base, { root: normalize(root) }) };
    }
    case "removeNode": {
      if (op.nodeId === base.root.id)
        return refuse("root-immutable", "cannot remove the root node", op.nodeId);
      if (!findNode(base.root, op.nodeId))
        return refuse("missing-node", `node "${op.nodeId}" not found`, op.nodeId);
      return {
        ok: true,
        value: next(base, { root: rebuild(base.root, (n) => (n.id === op.nodeId ? null : n)) }),
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
      const detached: ExperienceNode = { ...normalize(moving), order: op.newOrder };
      let root = rebuild(base.root, (n) => (n.id === op.nodeId ? null : n));
      root = rebuild(root, (n) =>
        n.id === op.newParentId && n.kind === "container"
          ? { ...n, children: [...n.children, detached] }
          : n
      );
      return { ok: true, value: next(base, { root: normalize(root) }) };
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
      const root = rebuild(base.root, (n) => {
        if (n.id !== op.nodeId || n.kind !== "semantic") return n;
        if (op.type === "setProps") return { ...n, props: { ...n.props, ...op.patch } };
        if (op.type === "setLabel") return { ...n, label: op.label };
        // `sensitivity` merges the way `priority` does: an op that does not mention it keeps the
        // class the node already carries, so re-binding a handle cannot silently declassify it.
        const sens = op.sensitivity ?? n.binding?.sensitivity;
        return {
          ...n,
          binding: {
            handle: op.handle,
            priority: op.priority ?? n.binding?.priority ?? "P1",
            ...(sens !== undefined && { sensitivity: sens }),
          },
        };
      });
      return { ok: true, value: next(base, { root }) };
    }
    case "remapProvider": {
      if (op.spec.handle !== op.handle)
        return refuse("handle-mismatch", "remapProvider: spec.handle must equal handle");
      return {
        ok: true,
        value: next(base, { providers: { ...base.providers, [op.handle]: op.spec } }),
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
      // Replay path: fold the materialised primitives. Re-invoking the planner is never core's job.
      // A prompt that materialised NOTHING is still an event in the lineage — a planner that
      // declined, or produced only no-ops. `replay` over an empty list returns its argument
      // unchanged, which would hand back the SEALED base and make the op indistinguishable from
      // never having happened; `next` produces the unsealed child the other cases do.
      return op.materialized.length === 0
        ? { ok: true, value: next(base, {}) }
        : replay(base, op.materialized);
  }
}

/** Fold ops onto a genesis. Deterministic and zero model invocations, by construction. */
export function replay(genesis: Experience, ops: readonly Operation[]): OpResult<Experience> {
  let cur = genesis;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as Operation;
    const r = apply(cur, op);
    if (!r.ok)
      return {
        ok: false,
        finding: { ...r.finding, message: `op #${i} (${op.type}): ${r.finding.message}` },
      };
    cur = r.value;
  }
  return { ok: true, value: cur };
}
