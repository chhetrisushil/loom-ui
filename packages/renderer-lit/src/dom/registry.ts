import type { HandleStatus } from "@loom-ui/hydration";
import type { RendererRegistry, Widget, WidgetAction } from "@loom/blueprint-runtime";

// ── The DOM renderer contract ─────────────────────────────────────────────────
// loom's `RendererRegistry<T>` is generic over the renderer type; this is the DOM shape its own
// comment anticipates. A renderer mounts into `host`, returns a handle the adapter drives with
// each new value/status, and disposes when the blueprint is torn down. `status` is present only
// when the widget's binding targets the hydration projection.

export interface DomWidgetProps {
  readonly widget: Widget;
  readonly value: unknown;
  readonly status?: HandleStatus;
  readonly onAction?: (action: WidgetAction) => void;
}
export interface DomWidgetHandle {
  update(value: unknown, status?: HandleStatus): void;
  dispose(): void;
}
export type DomWidgetRenderer = (host: HTMLElement, props: DomWidgetProps) => DomWidgetHandle;
export type DomRegistry = RendererRegistry<DomWidgetRenderer>;

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
  el.textContent = `[Projection "${projectionId}" is not registered]`;
  return el;
}
