import {
  type ContainerNode,
  type Experience,
  type Finding,
  type Operation,
  type ProviderSpec,
  type SemanticCatalog,
  type SemanticNode,
  isContainer,
  orderKeyAfterAll,
} from "@loom-ui/core";
import { jsonPathSelect, outputShapeHashOf } from "@loom-ui/hydration";
import { canonicalJson, fnv1a64 } from "@loom/core";
import { type DraftBinding, type DraftNode, type PlanDraft, entryFor } from "./contract";
import type { CapabilityRef } from "./spi";

export const DEFAULT_TTL_SECONDS = 60;

const err = (code: string, message: string, nodeId?: string): Finding => ({
  code,
  severity: "error",
  message,
  ...(nodeId !== undefined && { nodeId }),
});
const warn = (code: string, message: string, nodeId?: string): Finding => ({
  code,
  severity: "warn",
  message,
  ...(nodeId !== undefined && { nodeId }),
});

/** Identical (tool, version, arguments, path) → identical handle, so two nodes share one fetch. */
export function providerHandle(
  toolName: string,
  toolVersion: string,
  args: Record<string, unknown>,
  path: string
): string {
  return `p-${fnv1a64(canonicalJson({ toolName, toolVersion, args, path }))}`;
}

export function buildProviderSpec(
  cap: CapabilityRef,
  binding: DraftBinding,
  nodeId?: string
): { ok: true; spec: ProviderSpec } | { ok: false; finding: Finding } {
  if (cap.sampleOutput === undefined)
    return {
      ok: false,
      finding: err(
        "capability-unsampled",
        `capability "${cap.handle}" offers no output sample, so its output shape cannot be pinned; it is not bindable`,
        nodeId
      ),
    };
  const reshaped = jsonPathSelect(cap.sampleOutput, binding.path);
  if (!reshaped.ok)
    return {
      ok: false,
      finding: {
        ...reshaped.finding,
        code: "reshape-invalid",
        ...(nodeId !== undefined && { nodeId }),
      },
    };
  let outputShapeHash: string;
  try {
    outputShapeHash = outputShapeHashOf(reshaped.value);
  } catch (e) {
    return {
      ok: false,
      finding: err(
        "unhashable-sample",
        `capability "${cap.handle}" sample at "${binding.path}" cannot be shape-hashed: ${e instanceof Error ? e.message : String(e)}`,
        nodeId
      ),
    };
  }
  const handle = providerHandle(cap.toolName, cap.toolVersion, binding.arguments, binding.path);
  return {
    ok: true,
    spec: {
      handle,
      executionGraph: [
        {
          stepId: "s1",
          toolName: cap.toolName,
          toolVersion: cap.toolVersion,
          toolSchemaHash: cap.toolSchemaHash,
          arguments: binding.arguments,
          dependsOn: [],
          idempotent: true,
        },
      ],
      reshaping: { engine: "JSONPath", scriptRef: binding.path },
      outputShapeHash,
      cachePolicy: { ttlSeconds: DEFAULT_TTL_SECONDS, scope: "principal" },
    },
  };
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/**
 * Draft → operations by DIFFING against `base.root`'s direct children. Compose is the special
 * case where the base is an empty genesis. The reference planner authors a FLAT list under the
 * root (nested containers are the app's, untouched here); a draft id that names a container is
 * refused. Order: remapProvider before the bindProvider/insertNode that needs it; removals last.
 *
 * `setProps` (core's `apply`) MERGES the patch into the existing props, so there is no way to
 * DELETE a key through this op: a patch value of `undefined` round-trips through `Operation`'s
 * zod (`z.record(z.unknown())` accepts it) but the merge (`{...n.props, ...patch}`) still leaves
 * the key present with value `undefined`, and `canonicalJson` only drops undefined-valued keys
 * from its OWN output — it does not delete them from the live object `apply` returns, so the
 * live experience still carries the key. Rather than emit a patch that looks like a removal but
 * is not one, a props change that would need a key gone is reported as a `props-not-removed`
 * warn and the patch still carries every key the draft wants SET (additions/changes go through
 * normally; nothing here can make a key vanish).
 */
export function materialize(
  draft: PlanDraft,
  base: Experience,
  catalog: SemanticCatalog,
  capabilities: readonly CapabilityRef[]
): { ops: Operation[]; findings: Finding[] } {
  const ops: Operation[] = [];
  const findings: Finding[] = [];
  if (!isContainer(base.root))
    return {
      ops,
      findings: [
        err(
          "not-a-container",
          `experience root "${base.root.id}" is not a container`,
          base.root.id
        ),
      ],
    };
  const root = base.root;
  const caps = new Map(capabilities.map((c) => [c.handle, c] as const));
  const existing = new Map(root.children.map((c) => [c.id, c] as const));
  const declared = new Set<string>(Object.keys(base.providers));
  const siblings: Array<{ order: string }> = [...root.children];
  const seen = new Set<string>();

  const resolveBinding = (
    n: DraftNode
  ): { handle: string; priority: DraftBinding["priority"] } | undefined => {
    if (n.binding === undefined) return undefined;
    const cap = caps.get(n.binding.capability);
    if (cap === undefined) {
      findings.push(
        err(
          "unknown-capability",
          `node "${n.id}" binds capability "${n.binding.capability}", which was not offered`,
          n.id
        )
      );
      return undefined;
    }
    const built = buildProviderSpec(cap, n.binding, n.id);
    if (!built.ok) {
      findings.push(built.finding);
      return undefined;
    }
    if (!declared.has(built.spec.handle)) {
      ops.push({ type: "remapProvider", handle: built.spec.handle, spec: built.spec });
      declared.add(built.spec.handle);
    }
    return { handle: built.spec.handle, priority: n.binding.priority };
  };

  for (const n of draft.nodes) {
    seen.add(n.id);
    const entry = entryFor(catalog, n.type, n.version);
    if (entry === undefined) {
      findings.push(
        err(
          "unknown-type",
          `node "${n.id}" names "${n.type}", which is not in catalogue "${catalog.id}"`,
          n.id
        )
      );
      continue;
    }
    const existingNode = existing.get(n.id);
    const bound = resolveBinding(n);
    if (existingNode === undefined) {
      // A new node's binding travels INSIDE its insertNode: one op, no intermediate artifact
      // that would trip `missing-binding` for a moment that never actually existed. `bindProvider`
      // is reserved for an EXISTING node whose binding changed (the revise diff, below).
      const node: SemanticNode = {
        id: n.id,
        order: orderKeyAfterAll(siblings),
        kind: "semantic",
        type: entry.name,
        typeVersion: entry.version,
        span: n.span,
        label: { key: `${n.id}.label`, fallback: n.label },
        props: n.props,
        ...(bound !== undefined && { binding: bound }),
      };
      siblings.push(node);
      ops.push({ type: "insertNode", parentId: root.id, node });
      continue;
    }
    if (existingNode.kind !== "semantic") {
      findings.push(
        err(
          "not-semantic",
          `"${n.id}" is a container; the planner only authors semantic nodes`,
          n.id
        )
      );
      continue;
    }
    const current = existingNode;
    // Existing semantic node: emit only what changed.
    if (current.label?.fallback !== n.label)
      ops.push({
        type: "setLabel",
        nodeId: n.id,
        label: { key: current.label?.key ?? `${n.id}.label`, fallback: n.label },
      });
    if (!sameJson(current.props, n.props)) {
      const removedKeys = Object.keys(current.props).filter((k) => !(k in n.props));
      if (removedKeys.length > 0)
        findings.push(
          warn(
            "props-not-removed",
            `node "${n.id}": setProps merges, so ${removedKeys.map((k) => `"${k}"`).join(", ")} cannot be removed this way and will remain`,
            n.id
          )
        );
      ops.push({ type: "setProps", nodeId: n.id, patch: n.props });
    }
    if (current.span !== n.span)
      findings.push(
        warn(
          "span-unchanged",
          `node "${n.id}": span is structural, not a prop; the planner cannot change it (${current.span} → ${n.span} ignored)`,
          n.id
        )
      );
    if (
      bound !== undefined &&
      (current.binding?.handle !== bound.handle || current.binding?.priority !== bound.priority)
    )
      ops.push({
        type: "bindProvider",
        nodeId: n.id,
        handle: bound.handle,
        priority: bound.priority,
      });
    if (current.type !== entry.name || current.typeVersion !== entry.version)
      findings.push(
        warn(
          "type-unchanged",
          `node "${n.id}": changing type ${current.type}@${current.typeVersion} → ${entry.name}@${entry.version} needs remove + insert; ignored`,
          n.id
        )
      );
  }
  for (const c of root.children) {
    if (!seen.has(c.id) && c.kind === "semantic") ops.push({ type: "removeNode", nodeId: c.id });
  }
  return { ops, findings };
}

export type { ContainerNode };
