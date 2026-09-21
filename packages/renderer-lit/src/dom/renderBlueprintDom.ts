import { handleFromPath } from "@loom-ui/core";
import {
  HYDRATION_PROJECTION_ID,
  type HandleStatus,
  type HydrationState,
} from "@loom-ui/hydration";
import {
  type Blueprint,
  type Layout,
  type Widget,
  type WidgetAction,
  resolvePath,
  traverseBlueprint,
} from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { type DomRegistry, type DomWidgetHandle, placeholderFor } from "./registry";

export interface DomRenderOptions {
  readonly projectionRuntime: ProjectionRuntime;
  readonly executionId: string;
  readonly registry: DomRegistry;
  readonly onAction?: (action: WidgetAction) => void;
  /** Projection whose `status.<handle>` accompanies a widget's value. Default: the hydration projection. */
  readonly statusProjectionId?: string;
}
export interface DomRenderHandle {
  readonly element: HTMLElement;
  dispose(): void;
}

interface Slice {
  value: unknown;
  status: HandleStatus | undefined;
}

export function renderBlueprintDom(
  host: HTMLElement,
  blueprint: Blueprint,
  opts: DomRenderOptions
): DomRenderHandle {
  const statusProjectionId = opts.statusProjectionId ?? HYDRATION_PROJECTION_ID;
  const disposers: Array<() => void> = [];
  const stateMap = new Map<string, unknown>();
  for (const id of blueprint.projections)
    stateMap.set(id, opts.projectionRuntime.getState(id, opts.executionId));

  const selectSlice = (widget: Widget, state: unknown): Slice => {
    const path = widget.binding?.path ?? "";
    const value = widget.binding ? resolvePath(state, path) : undefined;
    if (widget.binding?.projectionId !== statusProjectionId) return { value, status: undefined };
    const handle = handleFromPath(path);
    const status =
      handle === undefined ? undefined : (state as HydrationState | undefined)?.status?.[handle];
    return { value, status };
  };

  const root = traverseBlueprint<HTMLElement>(blueprint.layout, stateMap, {
    renderWidget: ({ widget, value, onAction }) => {
      const widgetHost = document.createElement("div");
      widgetHost.dataset.widgetId = widget.id;
      widgetHost.dataset.widgetKind = widget.kind;
      const span = widget.props.span;
      if (typeof span === "number" && Number.isInteger(span) && span >= 1 && span <= 12)
        widgetHost.style.gridColumn = `span ${span}`;
      const renderer = opts.registry.get(widget.kind);
      if (!renderer) {
        widgetHost.appendChild(placeholderFor(widget.kind, "missing"));
        return widgetHost;
      }
      const initial = widget.binding
        ? selectSlice(widget, stateMap.get(widget.binding.projectionId))
        : { value, status: undefined };
      let handle: DomWidgetHandle;
      try {
        handle = renderer(widgetHost, {
          widget,
          value: initial.value,
          ...(initial.status && { status: initial.status }),
          ...(onAction && { onAction }),
        });
        if (!handle || typeof handle.update !== "function")
          throw new Error("renderer returned no handle");
      } catch (e) {
        widgetHost.replaceChildren(
          placeholderFor(widget.kind, "error", e instanceof Error ? e.message : String(e))
        );
        return widgetHost;
      }
      disposers.push(() => handle.dispose());
      if (widget.binding) {
        const off = opts.projectionRuntime.subscribeSelector<unknown, Slice>(
          widget.binding.projectionId,
          opts.executionId,
          (state) => selectSlice(widget, state),
          (slice) => {
            try {
              handle.update(slice.value, slice.status);
            } catch (e) {
              widgetHost.replaceChildren(
                placeholderFor(widget.kind, "error", e instanceof Error ? e.message : String(e))
              );
            }
          },
          (a, b) => a.value === b.value && a.status?.seq === b.status?.seq
        );
        disposers.push(off);
      }
      return widgetHost;
    },
    renderContainer: ({ layout, children }) => renderContainer(layout, children),
    ...(opts.onAction && { onAction: opts.onAction }),
  });

  const element = document.createElement("div");
  element.dataset.blueprintId = blueprint.id;
  const title = document.createElement("h1");
  title.textContent = blueprint.title;
  element.append(title, root);
  host.appendChild(element);
  return {
    element,
    dispose: () => {
      for (const d of disposers.splice(0)) d();
      element.remove();
    },
  };
}

function renderContainer(layout: Layout, children: HTMLElement[]): HTMLElement {
  const el = document.createElement("div");
  el.dataset.layout = layout.type;
  if (layout.type === "grid") {
    el.style.display = "grid";
    el.style.gridTemplateColumns = `repeat(${layout.columns}, 1fr)`;
  } else {
    el.style.display = "flex";
    el.style.flexDirection = layout.type === "flex" ? layout.direction : "column";
  }
  if (layout.gap !== undefined) el.style.gap = `${layout.gap}px`;
  el.append(...children);
  return el;
}
