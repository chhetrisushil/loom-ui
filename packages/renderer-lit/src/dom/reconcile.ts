import {
  type Blueprint,
  type Layout,
  type Widget,
  blueprintNodeIds,
  isLayoutId,
  resolveWidgetStatus,
  resolveWidgetValue,
} from "@loom/blueprint-runtime";
import { deepEqual } from "./deepEqual";
import type { RecomposeFinding } from "./registry";
import {
  type ContainerEntry,
  type Entry,
  type MountContext,
  type WidgetEntry,
  applyPlacement,
  applyTitle,
  childSpecs,
  disposeEntry,
  elementOf,
  isWidgetNode,
  layoutNodeId,
  mountContainer,
  mountWidget,
  renderInto,
  roleKey,
  showError,
  styleContainer,
  subscribeEntry,
  updateChrome,
  widgetIdsOf,
} from "./tree";

// ── The keyed reconcile ───────────────────────────────────────────────────────
// Landing a revised Blueprint on the live entry tree. Widgets are keyed by id; containers by
// their layout id when they have one (IR 2.4.0, loom ADR 0101), else by ordinal among their
// id-less container siblings — and in both cases by type AND role (IR 2.2.0, loom ADR 0099 D3).
// Nothing is re-rendered for an unchanged node, and the ONE child whose subtree holds the focused
// element is never moved — its neighbours move around it, because detaching a focused
// `<textarea>` costs the user their caret and selection.

export interface Accumulator {
  /**
   * Every widget id this pass DISPOSED — dropped, swept out with a retyped container, or torn
   * down to be mounted again. Deliberately not "remounted": whether a disposal was a remount or
   * a removal is not knowable at the disposal site (a container reconciled early can destroy a
   * widget the new tree re-creates under a DIFFERENT parent later in the same pass), so the two
   * are separated at the end of `update` — an id present in `next` was remounted, an id absent
   * from it was dropped and is already loom's `identity.findings`. Per-branch bookkeeping got
   * this wrong in both directions.
   */
  readonly disposed: string[];
  readonly rebound: string[];
  readonly findings: RecomposeFinding[];
  /**
   * Every entry this pass MOUNTED (widgets and containers, nested ones included), recorded
   * before each renderer runs. Until `reconcileContainer` commits `entry.children` these live
   * only in locals, so a throw mid-pass would strand them — subscribed, in the DOM, and out of
   * reach of `dispose()`. `update`'s catch disposes and removes exactly these.
   */
  readonly mounted: Entry[];
}

/** The direct child (if any) whose subtree holds the focused element. It must never leave the DOM. */
export function pinnedChild(children: readonly HTMLElement[]): HTMLElement | undefined {
  const active = document.activeElement;
  if (!active) return undefined;
  return children.find((c) => c === active || c.contains(active));
}

/**
 * Put `parent`'s children in `target` order without ever moving `pinned`: nodes before it are
 * placed back-to-front against it, nodes after it front-to-back. One O(n) walk — NOT a minimal
 * move set (that is a longest-increasing-subsequence problem, not attempted): a node already in
 * its slot relative to its neighbour is not moved, so an unchanged sequence makes zero
 * mutations, but a single element moved far can shift every node between its two positions. Every node in
 * `target` must already be a child of `parent`; nodes not in `target` must already be removed.
 */
export function reorderChildren(
  parent: HTMLElement,
  target: readonly HTMLElement[],
  pinned: HTMLElement | undefined
): void {
  const i = pinned ? target.indexOf(pinned) : -1;
  if (i < 0) {
    let prev: Element | null = null;
    for (const el of target) {
      const expected: ChildNode | null = prev ? prev.nextSibling : parent.firstChild;
      if (expected !== el) parent.insertBefore(el, expected);
      prev = el;
    }
    return;
  }
  let anchor: Element = target[i] as HTMLElement;
  for (let k = i - 1; k >= 0; k--) {
    const el = target[k] as HTMLElement;
    if (el.nextSibling !== anchor) parent.insertBefore(el, anchor);
    anchor = el;
  }
  let prev: Element = target[i] as HTMLElement;
  for (let k = i + 1; k < target.length; k++) {
    const el = target[k] as HTMLElement;
    if (prev.nextSibling !== el) parent.insertBefore(el, prev.nextSibling);
    prev = el;
  }
}

const fail =
  (acc: Accumulator, code: RecomposeFinding["code"]) => (f: { nodeId: string; message: string }) =>
    acc.findings.push({ code, ...f });

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A widget's dispose/unsubscribe threw: a `mount-failed` against that widget's own id. */
const disposeFailed =
  (acc: Accumulator) =>
  (widgetId: string, e: unknown): void => {
    acc.findings.push({ code: "mount-failed", nodeId: widgetId, message: messageOf(e) });
  };

const trackIn =
  (acc: Accumulator) =>
  (entry: Entry): void => {
    acc.mounted.push(entry);
  };

/** Dispose a kept widget's handle and run its renderer again into the same host. */
function remountWidget(
  entry: WidgetEntry,
  next: Widget,
  ctx: MountContext,
  acc: Accumulator
): void {
  disposeEntry(entry, disposeFailed(acc));
  acc.disposed.push(next.id);
  entry.widget = next;
  // `renderInto` clears the host itself, so the old renderer's DOM leaves with it.
  renderInto(entry, ctx, fail(acc, "mount-failed"));
}

function reconcileWidget(
  entry: WidgetEntry,
  next: Widget,
  ctx: MountContext,
  acc: Accumulator
): void {
  const prev = entry.widget;
  if (deepEqual(prev, next)) return;
  if (
    prev.kind !== next.kind ||
    entry.handle === undefined ||
    typeof entry.handle.patch !== "function"
  ) {
    remountWidget(entry, next, ctx, acc);
    return;
  }
  const bindingChanged = !deepEqual(prev.binding, next.binding);
  entry.widget = next;
  try {
    entry.handle.patch(next);
  } catch (e) {
    const message = messageOf(e);
    showError(entry, message);
    acc.findings.push({ code: "patch-failed", nodeId: next.id, message });
    return;
  }
  if (bindingChanged) {
    subscribeEntry(entry, ctx);
    // The first slice of the new binding, synchronously — a rebound widget must not sit on the
    // old handle's value until the next event (`subscribeSelector` only SEEDS, it does not push).
    const value = resolveWidgetValue(next, ctx.stateMap);
    const status = resolveWidgetStatus(next, ctx.stateMap);
    try {
      entry.handle.update(value, status);
    } catch (e) {
      const message = messageOf(e);
      showError(entry, message);
      acc.findings.push({ code: "patch-failed", nodeId: next.id, message });
      return;
    }
    acc.rebound.push(next.id);
  }
}

/**
 * Reconcile one container's children against `next`. Widgets match by id. A container WITH a
 * well-formed layout id (`isLayoutId`, IR 2.4.0) matches the old sibling with that id and nothing
 * else — never positionally on a miss, which would re-attach another container's widgets under a
 * new id. A container WITHOUT one matches by ordinal among the id-less container siblings (the
 * k-th id-less ↔ the k-th id-less), so an id'd sibling inserted or moved shifts no id-less
 * ordinal. An id'd container never matches an id-less one, either way round: the first recompose
 * across the upgrade remounts once, and `remounted` says so. A match is kept only if unused and of
 * the same type AND role — a role change sweeps the container out and mounts it again, like a type
 * change, because the chrome state its renderer holds (the current step) was built for that role.
 * A duplicate id in `next` is invalid data: the first occurrence claims the match, the second
 * mounts fresh. A kept container is MOVED by the reorder, never re-created. `path` names the
 * layout from the blueprint root, for a container renderer's failure message.
 */
export function reconcileContainer(
  entry: ContainerEntry,
  next: Layout,
  ctx: MountContext,
  acc: Accumulator,
  path = "layout"
): void {
  const prevLayout = entry.layout;
  styleContainer(entry.el, next);
  applyTitle(entry, next);
  const inGrid = next.type === "grid";
  const oldWidgets = new Map<string, WidgetEntry>();
  // A `Map`, never an object: an id is any non-empty string, `__proto__` included (ADR 0101 D1).
  const oldById = new Map<string, ContainerEntry>();
  const oldUnkeyed: ContainerEntry[] = [];
  for (const c of entry.children) {
    if (c.kind === "widget") oldWidgets.set(c.widget.id, c);
    else if (!isLayoutId(c.layout.id)) oldUnkeyed.push(c);
    // A duplicate id in the OLD tree: the first keeps the key, the rest go unclaimed (dropped).
    else if (!oldById.has(c.layout.id)) oldById.set(c.layout.id, c);
  }
  const nextChildren: Entry[] = [];
  const used = new Set<Entry>();
  let unkeyedOrdinal = 0;
  const specs = childSpecs(next);
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i] as (typeof specs)[number];
    const { node } = spec;
    const childPath = `${path}.children[${i}]`;
    let child: Entry;
    if (isWidgetNode(node)) {
      const kept = oldWidgets.get(node.id);
      if (kept && !used.has(kept)) {
        reconcileWidget(kept, node, ctx, acc);
        child = kept;
      } else {
        child = mountWidget(node, ctx, fail(acc, "mount-failed"), trackIn(acc));
        entry.el.appendChild(child.host); // position fixed by the reorder below
      }
    } else {
      const candidate = isLayoutId(node.id) ? oldById.get(node.id) : oldUnkeyed[unkeyedOrdinal++];
      const kept = candidate !== undefined && !used.has(candidate) ? candidate : undefined;
      if (kept && kept.layout.type === node.type && kept.role === roleKey(node)) {
        reconcileContainer(kept, node, ctx, acc, childPath);
        child = kept;
      } else {
        if (kept) {
          // Same key, different type or role: the container is swept out whole and mounted again.
          // Its widget ids are DISPOSED, not necessarily remounted — the new tree decides.
          disposeEntry(kept, disposeFailed(acc));
          acc.disposed.push(...widgetIdsOf(kept));
          elementOf(kept).remove();
          used.add(kept);
        }
        child = mountContainer(node, ctx, fail(acc, "mount-failed"), trackIn(acc), childPath);
        entry.el.appendChild(elementOf(child));
      }
    }
    used.add(child);
    applyPlacement(elementOf(child), spec, inGrid);
    nextChildren.push(child);
  }
  // Dropped: anything old that the new layout did not claim.
  for (const c of entry.children) {
    if (used.has(c)) continue;
    acc.disposed.push(...widgetIdsOf(c));
    disposeEntry(c, disposeFailed(acc));
    elementOf(c).remove();
  }
  const targetEls = nextChildren.map(elementOf);
  reorderChildren(entry.el, targetEls, pinnedChild(targetEls));
  entry.layout = next;
  entry.children = nextChildren;
  // Last, over the final child order: a container renderer hears about the pass only if its
  // layout's own fields or its child list changed. A throw leaves the container plain.
  const failed = updateChrome(entry, prevLayout, path);
  if (failed !== undefined)
    acc.findings.push({ code: "patch-failed", nodeId: layoutNodeId(next), message: failed });
}

/**
 * Land `next` on the ROOT entry and return the root to keep. The root has no parent container to
 * key it, so it is keyed here by role alone: the same role reconciles in place (a root type
 * change restyles in place, as before IR 2.2.0), a different role mounts a fresh root, swaps it
 * in, and disposes the old one — its widgets are reported remounted. The fresh root is mounted
 * BEFORE the old one is touched, so a throw mid-mount leaves the old root live.
 */
export function reconcileRoot(
  root: ContainerEntry,
  next: Layout,
  ctx: MountContext,
  acc: Accumulator
): ContainerEntry {
  if (root.role === roleKey(next)) {
    reconcileContainer(root, next, ctx, acc);
    return root;
  }
  const fresh = mountContainer(next, ctx, fail(acc, "mount-failed"), trackIn(acc));
  disposeEntry(root, disposeFailed(acc));
  acc.disposed.push(...widgetIdsOf(root));
  elementOf(root).replaceWith(elementOf(fresh));
  return fresh;
}

/**
 * The ids a pass actually REMOUNTED: disposed during the pass, and still present in `next`.
 *
 * Anything disposed and absent from `next` was DROPPED — loom's `identity.findings` already says
 * so, and repeating it as a remount would be a lie. Deriving the list here, from what happened
 * plus the new tree, is what keeps the two honest no matter which branch did the disposing: a
 * retyped container whose widgets the new tree does not keep, and a widget moved between
 * containers (destroyed by one container's dropped loop, re-created by another's mount) both
 * land where they belong without either branch knowing the other ran.
 *
 * Order is `next`'s DOCUMENT order (`blueprintNodeIds` is pre-order), so the list reads the way
 * the tree does rather than in reconcile-visit order.
 */
export function remountedOf(next: Blueprint, disposed: readonly string[]): string[] {
  // Also what keeps this total on a malformed `next`: a blueprint `blueprintNodeIds` cannot walk
  // never reached the reconcile, so nothing was disposed and the walk is never attempted.
  if (disposed.length === 0) return [];
  const gone = new Set(disposed);
  return blueprintNodeIds(next).filter((id) => gone.has(id));
}
