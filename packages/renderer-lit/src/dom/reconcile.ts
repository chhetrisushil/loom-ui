import {
  type Layout,
  type Widget,
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
  applySpan,
  childSpecs,
  disposeEntry,
  elementOf,
  isWidgetNode,
  mountContainer,
  mountWidget,
  renderInto,
  showError,
  styleContainer,
  subscribeEntry,
  widgetIdsOf,
} from "./tree";

// ── The keyed reconcile ───────────────────────────────────────────────────────
// Landing a revised Blueprint on the live entry tree. Widgets are keyed by id, containers by
// ordinal-among-container-children AND type. Nothing is re-rendered for an unchanged node, and
// the ONE child whose subtree holds the focused element is never moved — its neighbours move
// around it, because detaching a focused `<textarea>` costs the user their caret and selection.

export interface Accumulator {
  readonly remounted: string[];
  readonly rebound: string[];
  readonly findings: RecomposeFinding[];
}

/** The direct child (if any) whose subtree holds the focused element. It must never leave the DOM. */
export function pinnedChild(children: readonly HTMLElement[]): HTMLElement | undefined {
  const active = document.activeElement;
  if (!active) return undefined;
  return children.find((c) => c === active || c.contains(active));
}

/**
 * Put `parent`'s children in `target` order with the fewest moves that never touch `pinned`:
 * nodes before it are placed back-to-front against it, nodes after it front-to-back. A node
 * already in place is not moved (an unchanged sequence makes zero mutations). Every node in
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

/** Dispose a kept widget's handle and run its renderer again into the same host. */
function remountWidget(
  entry: WidgetEntry,
  next: Widget,
  ctx: MountContext,
  acc: Accumulator
): void {
  const errors: unknown[] = [];
  disposeEntry(entry, errors);
  for (const e of errors)
    acc.findings.push({ code: "mount-failed", nodeId: entry.widget.id, message: messageOf(e) });
  entry.widget = next;
  // `renderInto` clears the host itself, so the old renderer's DOM leaves with it.
  renderInto(entry, ctx, fail(acc, "mount-failed"));
  acc.remounted.push(next.id);
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
 * Reconcile one container's children against `next`. Widgets match by id; containers match by
 * ordinal among the container children (the k-th container ↔ the k-th container) AND type.
 */
export function reconcileContainer(
  entry: ContainerEntry,
  next: Layout,
  ctx: MountContext,
  acc: Accumulator
): void {
  styleContainer(entry.el, next);
  const inGrid = next.type === "grid";
  const oldWidgets = new Map<string, WidgetEntry>();
  const oldContainers: ContainerEntry[] = [];
  for (const c of entry.children) {
    if (c.kind === "widget") oldWidgets.set(c.widget.id, c);
    else oldContainers.push(c);
  }
  const nextChildren: Entry[] = [];
  const used = new Set<Entry>();
  let containerOrdinal = 0;
  for (const { node, span } of childSpecs(next)) {
    let child: Entry;
    if (isWidgetNode(node)) {
      const kept = oldWidgets.get(node.id);
      if (kept && !used.has(kept)) {
        reconcileWidget(kept, node, ctx, acc);
        child = kept;
      } else {
        child = mountWidget(node, ctx, fail(acc, "mount-failed"));
        entry.el.appendChild(child.host); // position fixed by the reorder below
      }
    } else {
      const kept = oldContainers[containerOrdinal];
      containerOrdinal++;
      if (kept && kept.layout.type === node.type) {
        reconcileContainer(kept, node, ctx, acc);
        child = kept;
      } else {
        if (kept) {
          // Same ordinal, different type: the container is remounted whole. Disposing it HERE
          // (rather than leaving it to the dropped loop) is what puts its widget ids in
          // `remounted` — they are still present in the new tree, so a dropped-id would lie.
          const errors: unknown[] = [];
          disposeEntry(kept, errors);
          for (const e of errors)
            acc.findings.push({ code: "mount-failed", nodeId: "", message: messageOf(e) });
          acc.remounted.push(...widgetIdsOf(kept));
          kept.el.remove();
          used.add(kept);
        }
        child = mountContainer(node, ctx, fail(acc, "mount-failed"));
        entry.el.appendChild(child.el);
      }
    }
    used.add(child);
    applySpan(elementOf(child), span, inGrid);
    nextChildren.push(child);
  }
  // Dropped: anything old that the new layout did not claim.
  for (const c of entry.children) {
    if (used.has(c)) continue;
    const errors: unknown[] = [];
    disposeEntry(c, errors);
    for (const e of errors)
      acc.findings.push({
        code: "mount-failed",
        nodeId: c.kind === "widget" ? c.widget.id : "",
        message: messageOf(e),
      });
    elementOf(c).remove();
  }
  const targetEls = nextChildren.map(elementOf);
  reorderChildren(entry.el, targetEls, pinnedChild(targetEls));
  entry.layout = next;
  entry.children = nextChildren;
}
