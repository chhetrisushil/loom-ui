import type {
  BindingStatus,
  IdentityReport,
  Layout,
  RendererRegistry,
  Widget,
  WidgetAction,
} from "@loom/blueprint-runtime";

// ── The DOM renderer contract ─────────────────────────────────────────────────
// loom's `RendererRegistry<T>` is generic over the renderer type; this is the DOM shape its own
// comment anticipates. A renderer mounts into `host`, returns a handle the adapter drives with
// each new value/status, and disposes when the blueprint is torn down. `status` is present only
// when the widget's binding declares a status path (IR 2.0.0) that resolves to a `BindingStatus`.

export interface DomWidgetProps {
  readonly widget: Widget;
  readonly value: unknown;
  readonly status?: BindingStatus;
  readonly onAction?: (action: WidgetAction) => void;
}
export interface DomWidgetHandle {
  update(value: unknown, status?: BindingStatus): void;
  /**
   * The widget NODE changed (props, title, source, …) but kept its id and kind. Optional: a
   * renderer without it is remounted on any widget change (reported in `RecomposeReport.remounted`).
   * User-entered state inside the widget is DOM state — a renderer must not overwrite it here.
   */
  patch?(widget: Widget): void;
  dispose(): void;
}
export type DomWidgetRenderer = (host: HTMLElement, props: DomWidgetProps) => DomWidgetHandle;
export type DomRegistry = RendererRegistry<DomWidgetRenderer>;

// ── The container renderer contract (Blueprint IR 2.2.0 `Layout.role`, loom ADR 0099) ─────────
// A layout whose `role` names a renderer in `DomRenderOptions.containers` is drawn with that
// renderer's CHROME around the adapter's own container. The adapter keeps everything it owns for
// a plain container — the `body` element (`data-layout`, the layout style), the children's
// mount / keyed reconcile / reorder / placement / subscriptions, the focus pin, the section
// wrap. The app owns only what it mounts in `host` outside `body`, and which of the children it
// is handed are visible (`hidden`, `inert`, `aria-*`, `role`, `id`, `class` on those elements).
// It never adds, removes, reorders or restyles `body`'s children.

/** One child of a roled container, in document order. `node` is there for labels (a step's title). */
export interface DomContainerChild {
  /** The element the adapter put in `body`: a widget's host, or a child container's outermost element. */
  readonly element: HTMLElement;
  readonly node: Widget | Layout;
}
export interface DomContainerProps {
  /** The layout being drawn, `role` included. */
  readonly layout: Layout;
  /** The adapter's container element: the children's parent. Chrome goes beside it in `host`, never in it. */
  readonly body: HTMLElement;
  readonly children: readonly DomContainerChild[];
}
export interface DomContainerHandle {
  /**
   * The layout's own fields (type, columns, direction, gap, title, role), its child element list
   * or order, or a child's own fields changed. REQUIRED — chrome never owns a child, so there is
   * nothing a remount would buy. Not called for an identical Blueprint.
   */
  update(props: DomContainerProps): void;
  /**
   * The container is being swept out, remounted, fallen back after a failure, or the handle
   * disposed. Remove your chrome AND undo every attribute you set on the children you were
   * handed (`role="tabpanel"`, `aria-labelledby`, `id`, `class`, …) — they may stay mounted in a
   * plain container, where a reference to disposed chrome would dangle. The adapter guarantees
   * only that visibility (`hidden`, `inert`, `aria-hidden`) is restored when a renderer throws.
   */
  dispose(): void;
}
/**
 * Mounts chrome into `host` — a `<div data-container-role="R">` that already holds `props.body`
 * — and returns its handle. A renderer that throws (here or in `update`) is disposed and the
 * container falls back to plain, children intact: chrome can never lose a child.
 */
export type DomContainerRenderer = (
  host: HTMLElement,
  props: DomContainerProps
) => DomContainerHandle;
/** Container renderers keyed by ROLE (loom's registry: `.register`, `.merge`; there is no default). */
export type DomContainerRegistry = RendererRegistry<DomContainerRenderer>;

/**
 * One adapter-side failure during `update`; the widget is already on its error placeholder. A
 * container renderer's failure has the layout's id as `nodeId` when it has one (IR 2.4.0, loom
 * ADR 0101), else `""`, and names the role and the layout's path; that container is already drawn
 * plain.
 */
export interface RecomposeFinding {
  readonly code: "patch-failed" | "mount-failed";
  readonly nodeId: string;
  readonly message: string;
}

/** What `DomRenderHandle.update(next)` did. `identity` is loom's report, not a second vocabulary. */
export interface RecomposeReport {
  readonly identity: IdentityReport;
  /**
   * Present in both trees but disposed and mounted again: the kind changed, the renderer has no
   * `patch`, OR the widget did not stay put WITHIN ITS CONTAINER — it moved to another container,
   * or its container was not kept. A container with a layout id (IR 2.4.0, loom ADR 0101) is kept
   * by that id, type and role, so inserting or reordering id'd containers remounts nothing; one
   * without an id is keyed by its ordinal among its id-less container siblings + type + role, so
   * a shift in that ordinal re-creates its widgets. An id change, a type or role change, a move to
   * another parent, and an id'd ↔ id-less crossing each re-create the container's widgets.
   */
  readonly remounted: readonly string[];
  /** Binding changed: unsubscribed, re-subscribed, first slice pushed synchronously. */
  readonly rebound: readonly string[];
  readonly findings: readonly RecomposeFinding[];
}

export function placeholderFor(
  kind: string,
  reason: "missing" | "error",
  detail?: string
): HTMLElement {
  const el = document.createElement("div");
  el.dataset.placeholder = reason;
  el.textContent =
    reason === "missing"
      ? `[No renderer for ${kind}]`
      : `[Renderer error for ${kind}${detail ? `: ${detail}` : ""}]`;
  return el;
}

/** A blueprint declared a projection its runtime never registered — degrade visibly, don't throw. */
export function projectionPlaceholder(projectionId: string): HTMLElement {
  const el = document.createElement("div");
  el.dataset.placeholder = "projection";
  el.dataset.projectionId = projectionId;
  el.textContent = `[Projection "${projectionId}" is not registered]`;
  return el;
}
