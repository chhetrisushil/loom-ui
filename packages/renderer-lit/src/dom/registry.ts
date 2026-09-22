import type {
  BindingStatus,
  IdentityReport,
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

/** One adapter-side failure during `update`; the widget is already on its error placeholder. */
export interface RecomposeFinding {
  readonly code: "patch-failed" | "mount-failed";
  readonly nodeId: string;
  readonly message: string;
}

/** What `DomRenderHandle.update(next)` did. `identity` is loom's report, not a second vocabulary. */
export interface RecomposeReport {
  readonly identity: IdentityReport;
  /** Kept their id but changed kind, or their renderer has no `patch`: disposed and mounted again. */
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
