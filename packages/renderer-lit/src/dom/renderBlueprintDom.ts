import {
  type Blueprint,
  type IdentityReport,
  type WidgetAction,
  preservesBlueprintNodes,
} from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { type Accumulator, reconcileContainer, remountedOf } from "./reconcile";
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
  /**
   * Land a revised Blueprint on the live tree: widgets keyed by id, containers by ordinal and
   * type, the focused subtree never moved. Never throws — renderer failures come back in
   * `RecomposeReport.findings` with the failing widget already on its error placeholder.
   */
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
      const acc: Accumulator = { disposed: [], rebound: [], findings: [] };
      // `compared: 0` is loom's own tell that nothing was compared, which is the truth when
      // `next` is so malformed that walking it threw before the reconcile began.
      let identity: IdentityReport = { ok: true, findings: [], added: [], compared: 0 };
      try {
        identity = preservesBlueprintNodes(state.current, next);
        if (state.disposed)
          return {
            identity,
            remounted: [],
            rebound: [],
            findings: [{ code: "patch-failed", nodeId: "", message: "disposed" }],
          };
        // The state map is the SAME Map instance the mount context holds — every widget's
        // resolution reads through it, so it is rewritten in place, never reassigned.
        const rebuilt = buildStateMap(next, opts.projectionRuntime, opts.executionId);
        ctx.stateMap.clear();
        for (const [k, v] of rebuilt.stateMap) ctx.stateMap.set(k, v);
        reconcileContainer(state.root, next.layout, ctx, acc);
        // Root chrome: title, id, projection placeholders (rebuilt from the new projection list).
        // Written only when they differ, like the container styles — an identical Blueprint must
        // not so much as replace the title's text node.
        if (element.dataset.blueprintId !== next.id) element.dataset.blueprintId = next.id;
        if (title.textContent !== next.title) title.textContent = next.title;
        const currentPlaceholders = [...element.children].filter(
          (p) => (p as HTMLElement).dataset.placeholder === "projection"
        ) as HTMLElement[];
        const currentIds = currentPlaceholders.map((p) => p.dataset.projectionId);
        const sameIds =
          currentIds.length === rebuilt.unregistered.length &&
          currentIds.every((id, i) => id === rebuilt.unregistered[i]);
        if (!sameIds) {
          for (const p of currentPlaceholders) p.remove();
          for (const id of rebuilt.unregistered)
            element.insertBefore(projectionPlaceholder(id), state.root.el);
        }
        state.current = next;
        return {
          identity,
          remounted: remountedOf(next, acc.disposed),
          rebound: acc.rebound,
          findings: acc.findings,
        };
      } catch (e) {
        // "Never throws" is absolute, not "absolute for renderers that misbehave the way the
        // matrix expects": a `ProjectionRuntime` or a Blueprint the adapter has never seen
        // comes back as a finding beside whatever the pass had already accomplished.
        // `state.current` is deliberately NOT advanced — a partial pass is not the new tree.
        return {
          identity,
          remounted: remountedOf(next, acc.disposed),
          rebound: acc.rebound,
          findings: [
            ...acc.findings,
            {
              code: "patch-failed" as const,
              nodeId: "",
              message: e instanceof Error ? e.message : String(e),
            },
          ],
        };
      }
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
