import { z } from "zod";
import { type Experience, type Finding, ProviderSpec } from "./experience";
import {
  ExperienceNode,
  LocalizedText,
  NodeId,
  OrderKey,
  Priority,
  findNode,
  normalize,
  rebuild,
} from "./node";

// ── Operations, not diffs ─────────────────────────────────────────────────────
// Every change to an experience is a semantic Operation. Ops are the replay unit: `apply` is pure
// and total (a refusal is a finding, never a throw), `replay` folds a sequence deterministically,
// and a `prompt` op carries BOTH the intent text and the primitives it materialised — so replay
// folds the primitives and never re-invokes a planner. There is deliberately NO operation over
// `intent`: a new intent is a new lineage.

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
  | { type: "bindProvider"; nodeId: string; handle: string; priority?: Priority }
  | { type: "remapProvider"; handle: string; spec: z.infer<typeof ProviderSpec> }
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
    }),
    z.object({ type: z.literal("remapProvider"), handle: z.string().min(1), spec: ProviderSpec }),
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

export function apply(base: Experience, rawOp: Operation): OpResult<Experience> {
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
        return {
          ...n,
          binding: { handle: op.handle, priority: op.priority ?? n.binding?.priority ?? "P1" },
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
    case "prompt":
      // Replay path: fold the materialised primitives. Re-invoking the planner is never core's job.
      return replay(base, op.materialized);
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
    cur = { ...r.value, experienceId: genesis.experienceId };
  }
  return { ok: true, value: cur };
}
