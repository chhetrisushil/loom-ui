import {
  type BindingStatus,
  type Layout,
  type Widget,
  type WidgetAction,
  asCell,
  resolveWidgetStatus,
  resolveWidgetValue,
} from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { type DomRegistry, type DomWidgetHandle, placeholderFor } from "./registry";

// ── The entry tree ────────────────────────────────────────────────────────────
// The adapter mounts a blueprint into a tree of ENTRIES that mirrors the DOM one-for-one: a
// `WidgetEntry` per widget host, a `ContainerEntry` per layout element. Mounting a blueprint and
// landing a revised one on the live tree are then the same shapes — the walk is here, once,
// instead of once inside a `traverseBlueprint` callback and again inside a reconciler.

export interface MountContext {
  readonly registry: DomRegistry;
  readonly projectionRuntime: ProjectionRuntime;
  readonly executionId: string;
  /** Every projection the blueprint declares → its state; rebuilt by the caller before each mount/update. */
  readonly stateMap: Map<string, unknown>;
  readonly onAction?: (action: WidgetAction) => void;
}
export interface WidgetEntry {
  readonly kind: "widget";
  /** `<div data-widget-id data-widget-kind>` — the grid item itself, no wrapper. */
  readonly host: HTMLElement;
  widget: Widget;
  /** Undefined while a placeholder is showing (no renderer for the kind, or the renderer threw). */
  handle: DomWidgetHandle | undefined;
  unsubscribe: (() => void) | undefined;
}
export interface ContainerEntry {
  readonly kind: "container";
  /** `<div data-layout>`. */
  readonly el: HTMLElement;
  layout: Layout;
  /** Document order — the i-th entry is the i-th child element of `el`. */
  children: Entry[];
}
export type Entry = WidgetEntry | ContainerEntry;
export interface ChildSpec {
  readonly node: Widget | Layout;
  readonly span: number;
}
export interface Slice {
  value: unknown;
  status: BindingStatus | undefined;
}

export const isWidgetNode = (n: Widget | Layout): n is Widget => "_tag" in n;

/** A layout's children with the span each one occupies: cells under a grid, 1 elsewhere. */
export function childSpecs(layout: Layout): ChildSpec[] {
  if (layout.type === "grid")
    return layout.children.map((c) => {
      const cell = asCell(c);
      return { node: cell.node, span: cell.span ?? 1 };
    });
  return layout.children.map((node) => ({ node, span: 1 }));
}

/** IR 2.0.0: the span is the CELL's, and it lands on the child's own host — no wrapper element. */
export function applySpan(host: HTMLElement, span: number, inGrid: boolean): void {
  host.style.gridColumn = inGrid && span > 1 ? `span ${span}` : "";
}

/** The container element's own styling, derived only from the layout node. Idempotent. */
export function styleContainer(el: HTMLElement, layout: Layout): void {
  el.dataset.layout = layout.type;
  if (layout.type === "grid") {
    el.style.display = "grid";
    el.style.gridTemplateColumns = `repeat(${layout.columns}, 1fr)`;
    el.style.flexDirection = "";
  } else {
    el.style.display = "flex";
    el.style.gridTemplateColumns = "";
    el.style.flexDirection = layout.type === "flex" ? layout.direction : "column";
  }
  el.style.gap = layout.gap !== undefined ? `${layout.gap}px` : "";
}

// A bound widget's slice, resolved the way loom resolves it: value AND status both come from
// the binding's own paths in the SAME projection state (IR 2.0.0), so this adapter knows
// nothing about handles or a hydration-shaped state. `resolveWidgetStatus` returns undefined
// for a binding with no `status.path` (the channel is opt-in) and for anything that is not a
// `BindingStatus` — including the `Object.prototype` a `status.__proto__` path resolves to.
//
// `subscribeSelector` calls the selector on every event, so the one-entry state map each
// widget hands loom is allocated ONCE per widget and rewritten in place, not per call.
const sliceSelector = (widget: Widget, projectionId: string): ((state: unknown) => Slice) => {
  const map = new Map<string, unknown>();
  return (state) => {
    map.set(projectionId, state);
    return { value: resolveWidgetValue(widget, map), status: resolveWidgetStatus(widget, map) };
  };
};

/**
 * Two slices are the same UPDATE when the value is unchanged and the status has not moved.
 *
 * `seq` is the cheap answer, but it is OPTIONAL on loom's `BindingStatus` (IR 2.0.0) — only the
 * hydration store happens to stamp one. Comparing `a.status?.seq === b.status?.seq` alone would
 * call every seq-less status pair equal, silently dropping exactly the transition the status
 * matrix exists for: "the provider failed, keep the last value" is `ready` → `error` over an
 * UNCHANGED value, and `undefined` → `{ state: "error" }` compares equal too (both `undefined`).
 * So `seq` decides only when it is actually present; otherwise the statuses must be the same
 * object. A producer that rebuilds an equal status object each event re-renders needlessly —
 * the safe direction to be wrong in.
 */
export function sliceIsEqual(a: Slice, b: Slice): boolean {
  if (a.value !== b.value) return false;
  if (a.status === b.status) return true;
  return a.status?.seq !== undefined && a.status.seq === b.status?.seq;
}

/**
 * Degrade a live widget to its error placeholder: the host's content is the placeholder alone.
 *
 * This TEARS THE WIDGET DOWN, it does not merely hide it. Dropping `entry.handle` on its own
 * would leave the subscription closure — which closes over the destructured `handle`, not over
 * `entry` — pushing slices into a renderer that has already failed, and would leak whatever the
 * handle holds because nothing ever calls `dispose()` on it. So: unsubscribe first (that is what
 * stops further `update` calls), then dispose. Both in `try`/`catch`: a renderer that threw once
 * may well throw again, and the placeholder must go up regardless.
 */
export function showError(entry: WidgetEntry, message: string): void {
  try {
    entry.unsubscribe?.();
  } catch {
    // A failing unsubscribe must not stop the teardown.
  }
  try {
    entry.handle?.dispose();
  } catch {
    // Ditto — the handle is dropped either way, so it is never disposed twice.
  }
  entry.unsubscribe = undefined;
  entry.handle = undefined;
  entry.host.replaceChildren(placeholderFor(entry.widget.kind, "error", message));
}

/** (Re)subscribe a widget to its binding's projection. Drops any previous subscription first. */
export function subscribeEntry(entry: WidgetEntry, ctx: MountContext): void {
  entry.unsubscribe?.();
  entry.unsubscribe = undefined;
  const { widget, handle } = entry;
  if (!widget.binding || !handle) return;
  const off = ctx.projectionRuntime.subscribeSelector<unknown, Slice>(
    widget.binding.projectionId,
    ctx.executionId,
    sliceSelector(widget, widget.binding.projectionId),
    (slice) => {
      try {
        handle.update(slice.value, slice.status);
      } catch (e) {
        showError(entry, e instanceof Error ? e.message : String(e));
      }
    },
    sliceIsEqual
  );
  entry.unsubscribe = off;
}

/** Run the widget's renderer into an EMPTY host. Placeholders on a missing renderer or a throw. */
export function renderInto(
  entry: WidgetEntry,
  ctx: MountContext,
  onFail: (f: { nodeId: string; message: string }) => void
): void {
  const { widget, host } = entry;
  // The host is cleared unconditionally, so a REMOUNT in place needs no caller discipline: every
  // path below (placeholder, renderer output, error) starts from an empty host.
  host.replaceChildren();
  // Set BEFORE the lookup: a kind with no renderer still labels its host with the kind it wanted.
  host.dataset.widgetKind = widget.kind;
  const renderer = ctx.registry.get(widget.kind);
  if (!renderer) {
    host.replaceChildren(placeholderFor(widget.kind, "missing"));
    entry.handle = undefined;
    // A missing renderer is a REPORTED failure, not a silent one: a widget the new blueprint
    // added of a kind nobody registered lands in `RecomposeReport.findings` as `mount-failed`.
    // The initial mount passes a no-op `onFail`, so mount behaviour is unchanged.
    onFail({ nodeId: widget.id, message: `no renderer for "${widget.kind}"` });
    return;
  }
  const value = resolveWidgetValue(widget, ctx.stateMap);
  const status = resolveWidgetStatus(widget, ctx.stateMap);
  try {
    const handle = renderer(host, {
      widget,
      value,
      ...(status && { status }),
      ...(ctx.onAction && { onAction: ctx.onAction }),
    });
    if (!handle || typeof handle.update !== "function")
      throw new Error("renderer returned no handle");
    entry.handle = handle;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    showError(entry, message);
    onFail({ nodeId: widget.id, message });
    return;
  }
  subscribeEntry(entry, ctx);
}

export function mountWidget(
  widget: Widget,
  ctx: MountContext,
  onFail: (f: { nodeId: string; message: string }) => void
): WidgetEntry {
  const host = document.createElement("div");
  host.dataset.widgetId = widget.id;
  const entry: WidgetEntry = {
    kind: "widget",
    host,
    widget,
    handle: undefined,
    unsubscribe: undefined,
  };
  renderInto(entry, ctx, onFail);
  return entry;
}

export function mountContainer(
  layout: Layout,
  ctx: MountContext,
  onFail: (f: { nodeId: string; message: string }) => void
): ContainerEntry {
  const el = document.createElement("div");
  styleContainer(el, layout);
  const inGrid = layout.type === "grid";
  const children: Entry[] = [];
  for (const { node, span } of childSpecs(layout)) {
    const child = isWidgetNode(node)
      ? mountWidget(node, ctx, onFail)
      : mountContainer(node, ctx, onFail);
    const childEl = elementOf(child);
    applySpan(childEl, span, inGrid);
    el.appendChild(childEl);
    children.push(child);
  }
  return { kind: "container", el, layout, children };
}

/** Unsubscribe and dispose every widget under `entry`, collecting errors. Leaves the DOM in place. */
export function disposeEntry(entry: Entry, errors: unknown[]): void {
  if (entry.kind === "container") {
    for (const c of entry.children) disposeEntry(c, errors);
    return;
  }
  try {
    entry.unsubscribe?.();
  } catch (e) {
    errors.push(e);
  }
  entry.unsubscribe = undefined;
  try {
    entry.handle?.dispose();
  } catch (e) {
    errors.push(e);
  }
  entry.handle = undefined;
}

export function widgetIdsOf(entry: Entry): string[] {
  return entry.kind === "widget" ? [entry.widget.id] : entry.children.flatMap(widgetIdsOf);
}

export const elementOf = (entry: Entry): HTMLElement =>
  entry.kind === "widget" ? entry.host : entry.el;
