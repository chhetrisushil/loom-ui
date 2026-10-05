import type { DataClass } from "@loom/classify";
import { type SemanticCatalog, type Surface, resolveSurface } from "./catalog";
import type { Experience } from "./experience";
import { type Priority, walk } from "./node";
import { strictestClass } from "./viewer";

// ── The handle inventory ──────────────────────────────────────────────────────
// Hydration needs every handle an experience binds, ONCE, with the highest priority any node
// asked for and the nodes that want it (for cancel-on-recompose and per-node status). Core
// already walks the tree for validation and compilation; this is the walk hydration would
// otherwise re-implement. Deterministic order: priority, then handle.

export interface HandleUse {
  readonly handle: string;
  readonly priority: Priority;
  readonly nodeIds: readonly string[];
  /**
   * The strictest `sensitivity` of any node binding this handle (`undefined` = unclassified). A
   * handle carries ONE value for every node that binds it, so it is as classified as its most
   * classified node: hydration and `compile` both gate on this, never on a single node's class.
   */
  readonly sensitivity?: DataClass;
}

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };

export function experienceHandles(exp: Experience): HandleUse[] {
  const byHandle = new Map<
    string,
    { priority: Priority; nodeIds: string[]; sensitivity: DataClass | undefined }
  >();
  walk(exp.root, (n) => {
    if (n.kind !== "semantic" || n.binding === undefined) return;
    const cur = byHandle.get(n.binding.handle);
    if (cur === undefined) {
      byHandle.set(n.binding.handle, {
        priority: n.binding.priority,
        nodeIds: [n.id],
        sensitivity: n.binding.sensitivity,
      });
      return;
    }
    cur.nodeIds.push(n.id);
    cur.sensitivity = strictestClass(cur.sensitivity, n.binding.sensitivity);
    if (RANK[n.binding.priority] < RANK[cur.priority]) cur.priority = n.binding.priority;
  });
  return [...byHandle.entries()]
    .map(([handle, v]) => ({
      handle,
      priority: v.priority,
      nodeIds: v.nodeIds,
      ...(v.sensitivity !== undefined && { sensitivity: v.sensitivity }),
    }))
    .sort(
      (a, b) =>
        RANK[a.priority] - RANK[b.priority] ||
        (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0)
    );
}

/**
 * The widget kinds each bound handle feeds on ONE surface: every node binding the handle,
 * resolved through the catalogue (degrade chains followed), deduplicated and sorted. What a
 * `"contract"` provider's value is checked against (`ProviderSpec.outputCheck`): a handle bound
 * by a `Kpi` and a `Table` widget feeds both, and its value must satisfy both contracts — each
 * widget renders the same value. Per surface, never across surfaces: a degrade changes the kind.
 * A node whose type does not resolve contributes nothing (`validateExperience` reports it); a
 * handle with no resolvable node is absent. Entries are in handle order.
 */
export function handleKinds(
  exp: Experience,
  catalog: SemanticCatalog,
  surface: Surface
): Map<string, string[]> {
  const kinds = new Map<string, Set<string>>();
  walk(exp.root, (n) => {
    if (n.kind !== "semantic" || n.binding === undefined) return;
    const r = resolveSurface(catalog, n.type, n.typeVersion, surface, n.id);
    if (!r.ok) return;
    const set = kinds.get(n.binding.handle);
    if (set === undefined) kinds.set(n.binding.handle, new Set([r.kind]));
    else set.add(r.kind);
  });
  return new Map(
    [...kinds.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([handle, set]) => [handle, [...set].sort()])
  );
}
