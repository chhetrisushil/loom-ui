import type { Experience } from "./experience";
import { type Priority, walk } from "./node";

// ── The handle inventory ──────────────────────────────────────────────────────
// Hydration needs every handle an experience binds, ONCE, with the highest priority any node
// asked for and the nodes that want it (for cancel-on-recompose and per-node status). Core
// already walks the tree for validation and compilation; this is the walk hydration would
// otherwise re-implement. Deterministic order: priority, then handle.

export interface HandleUse {
  readonly handle: string;
  readonly priority: Priority;
  readonly nodeIds: readonly string[];
}

const RANK: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };

export function experienceHandles(exp: Experience): HandleUse[] {
  const byHandle = new Map<string, { priority: Priority; nodeIds: string[] }>();
  walk(exp.root, (n) => {
    if (n.kind !== "semantic" || n.binding === undefined) return;
    const cur = byHandle.get(n.binding.handle);
    if (cur === undefined) {
      byHandle.set(n.binding.handle, { priority: n.binding.priority, nodeIds: [n.id] });
      return;
    }
    cur.nodeIds.push(n.id);
    if (RANK[n.binding.priority] < RANK[cur.priority]) cur.priority = n.binding.priority;
  });
  return [...byHandle.entries()]
    .map(([handle, v]) => ({ handle, priority: v.priority, nodeIds: v.nodeIds }))
    .sort(
      (a, b) =>
        RANK[a.priority] - RANK[b.priority] ||
        (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0)
    );
}
