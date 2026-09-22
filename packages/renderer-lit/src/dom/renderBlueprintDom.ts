import type { Blueprint, WidgetAction } from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { type DomRegistry, type RecomposeReport, projectionPlaceholder } from "./registry";
import { type ContainerEntry, type MountContext, disposeEntry, mountContainer } from "./tree";

export interface DomRenderOptions {
  readonly projectionRuntime: ProjectionRuntime;
  readonly executionId: string;
  readonly registry: DomRegistry;
  readonly onAction?: (action: WidgetAction) => void;
}
export interface DomRenderHandle {
  readonly element: HTMLElement;
  /** Land a revised Blueprint on the live tree (Task 3). Never throws. */
  update(next: Blueprint): RecomposeReport;
  dispose(): void;
}

/** Every projection the blueprint declares → its current state, or `undefined` if unregistered. */
export function buildStateMap(
  blueprint: Blueprint,
  runtime: ProjectionRuntime,
  executionId: string
): { stateMap: Map<string, unknown>; unregistered: string[] } {
  const stateMap = new Map<string, unknown>();
  const unregistered: string[] = [];
  for (const id of blueprint.projections) {
    try {
      stateMap.set(id, runtime.getState(id, executionId));
    } catch {
      // A blueprint can declare a projection its runtime never registered — a finding, not a
      // thrown mount. Widgets bound to it render with `value: undefined` / no status (loom's
      // `resolvePath(undefined, path)` is null-safe) and still subscribe: `subscribeSelector`
      // seeds via `peekState`, which does not throw, so a later `register` + event lights the
      // widget up without a remount.
      stateMap.set(id, undefined);
      unregistered.push(id);
    }
  }
  return { stateMap, unregistered };
}

export function renderBlueprintDom(
  host: HTMLElement,
  blueprint: Blueprint,
  opts: DomRenderOptions
): DomRenderHandle {
  const { stateMap, unregistered } = buildStateMap(
    blueprint,
    opts.projectionRuntime,
    opts.executionId
  );
  const ctx: MountContext = {
    registry: opts.registry,
    projectionRuntime: opts.projectionRuntime,
    executionId: opts.executionId,
    stateMap,
    ...(opts.onAction && { onAction: opts.onAction }),
  };
  const root: ContainerEntry = mountContainer(blueprint.layout, ctx, () => {});

  const element = document.createElement("div");
  element.dataset.blueprintId = blueprint.id;
  const title = document.createElement("h1");
  title.textContent = blueprint.title;
  element.append(title, ...unregistered.map(projectionPlaceholder));
  element.append(root.el);
  host.appendChild(element);

  const state = { current: blueprint, root, disposed: false };
  return {
    element,
    update: (next) => {
      // Task 3 replaces this body. Until then the adapter is mount-only.
      throw new Error(`update not implemented (next: ${next.id})`);
    },
    dispose: () => {
      state.disposed = true;
      const errors: unknown[] = [];
      try {
        disposeEntry(state.root, errors);
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
