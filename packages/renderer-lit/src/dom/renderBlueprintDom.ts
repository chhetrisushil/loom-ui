import {
  type BindingStatus,
  type Blueprint,
  type Layout,
  type Widget,
  type WidgetAction,
  resolveWidgetStatus,
  resolveWidgetValue,
  traverseBlueprint,
} from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import {
  type DomRegistry,
  type DomWidgetHandle,
  placeholderFor,
  projectionPlaceholder,
} from "./registry";

export interface DomRenderOptions {
  readonly projectionRuntime: ProjectionRuntime;
  readonly executionId: string;
  readonly registry: DomRegistry;
  readonly onAction?: (action: WidgetAction) => void;
}
export interface DomRenderHandle {
  readonly element: HTMLElement;
  dispose(): void;
}

interface Slice {
  value: unknown;
  status: BindingStatus | undefined;
}

export function renderBlueprintDom(
  host: HTMLElement,
  blueprint: Blueprint,
  opts: DomRenderOptions
): DomRenderHandle {
  const disposers: Array<() => void> = [];
  const stateMap = new Map<string, unknown>();
  const unregisteredProjections: string[] = [];
  for (const id of blueprint.projections) {
    try {
      stateMap.set(id, opts.projectionRuntime.getState(id, opts.executionId));
    } catch {
      // A blueprint can declare a projection its runtime never registered — a finding, not a
      // thrown mount. Widgets bound to it render with `value: undefined` / no status below
      // (loom's `resolvePath(undefined, path)` is null-safe), and still subscribe:
      // `subscribeSelector` seeds via `peekState`, which does not throw for an unregistered
      // projection, so a later `register` + event lights the widget up without a remount.
      stateMap.set(id, undefined);
      unregisteredProjections.push(id);
    }
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

  const root = traverseBlueprint<HTMLElement>(blueprint.layout, stateMap, {
    renderWidget: ({ widget, value, status, onAction }) => {
      const widgetHost = document.createElement("div");
      widgetHost.dataset.widgetId = widget.id;
      widgetHost.dataset.widgetKind = widget.kind;
      const renderer = opts.registry.get(widget.kind);
      if (!renderer) {
        widgetHost.appendChild(placeholderFor(widget.kind, "missing"));
        return widgetHost;
      }
      let handle: DomWidgetHandle;
      try {
        handle = renderer(widgetHost, {
          widget,
          value,
          ...(status && { status }),
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
          sliceSelector(widget, widget.binding.projectionId),
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
    renderContainer: ({ layout, children, cells }) => {
      // IR 2.0.0: a grid child's span is a property of the CELL, not of the widget. It lands on
      // the child's own host element — a wrapper would put a non-grid-item between the grid and
      // its child and silently drop every other grid placement the child carries.
      if (cells)
        for (const { span, child } of cells) if (span > 1) child.style.gridColumn = `span ${span}`;
      return renderContainer(layout, children);
    },
    ...(opts.onAction && { onAction: opts.onAction }),
  });

  const element = document.createElement("div");
  element.dataset.blueprintId = blueprint.id;
  const title = document.createElement("h1");
  title.textContent = blueprint.title;
  element.append(title, ...unregisteredProjections.map(projectionPlaceholder));
  element.append(root);
  host.appendChild(element);
  return {
    element,
    dispose: () => {
      const errors: unknown[] = [];
      try {
        for (const d of disposers.splice(0)) {
          try {
            d();
          } catch (e) {
            errors.push(e);
          }
        }
      } finally {
        element.remove();
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "renderBlueprintDom: dispose failed for one or more widgets"
        );
      }
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
