import type { DataClass } from "@loom/classify";
import { type SemanticCatalog, type Surface, resolveSurface } from "./catalog";
import { type DeclaredToolClasses, type UndeclaredToolPolicy, effectiveClasses } from "./classes";
import type { Experience } from "./experience";
import { isMediaKind } from "./mediaRef";
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
   * The strictest `sensitivity` of any node binding this handle or that ever bound it
   * (`Experience.handleClasses`); `undefined` = unclassified. A
   * handle carries ONE value for every node that binds it, so it is as classified as its most
   * classified node: hydration and `compile` both gate on this, never on a single node's class.
   */
  readonly sensitivity?: DataClass;
}

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };

export function experienceHandles(
  exp: Experience,
  declaredToolClasses?: DeclaredToolClasses,
  undeclared?: UndeclaredToolPolicy
): HandleUse[] {
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
  // Effective class, read at once: live nodes + the sticky per-handle class + the class of every
  // tool the handle's provider calls (tool-level, fail-closed — a sibling bound before its tool
  // was classified is gated as soon as the tool is).
  const effective = effectiveClasses(exp, declaredToolClasses, undeclared);
  return [...byHandle.entries()]
    .map(([handle, v]) => {
      const sensitivity = strictestClass(v.sensitivity, effective.get(handle));
      return {
        handle,
        priority: v.priority,
        nodeIds: v.nodeIds,
        ...(sensitivity !== undefined && { sensitivity }),
      };
    })
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

/**
 * U9: `handleKinds`, plus the media kinds implied by a node's TYPE NAME alone. A node whose `type` is
 * a framework media kind (`Image`, `Audio`, `Video`, `File`) marks its handle as media-bound even
 * when no catalogue was supplied (or the catalogue cannot resolve it), so a host that forgot
 * `outputKinds` still gets the `MediaRef` contract enforced at the data boundary, never a vacuous
 * pass. Same shape and ordering as `handleKinds`.
 */
export function handleKindsWithMedia(
  exp: Experience,
  catalog?: SemanticCatalog,
  surface?: Surface
): Map<string, string[]> {
  const kinds = new Map<string, Set<string>>();
  if (catalog !== undefined && surface !== undefined)
    for (const [h, ks] of handleKinds(exp, catalog, surface)) kinds.set(h, new Set(ks));
  walk(exp.root, (n) => {
    if (n.kind !== "semantic" || n.binding === undefined || !isMediaKind(n.type)) return;
    const set = kinds.get(n.binding.handle);
    if (set === undefined) kinds.set(n.binding.handle, new Set([n.type]));
    else set.add(n.type);
  });
  return new Map(
    [...kinds.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([handle, set]) => [handle, [...set].sort()])
  );
}

/** Does this experience have a node whose type names a framework media kind? */
export function hasMediaTypeNodes(exp: Experience): boolean {
  let found = false;
  walk(exp.root, (n) => {
    if (n.kind === "semantic" && isMediaKind(n.type)) found = true;
  });
  return found;
}
