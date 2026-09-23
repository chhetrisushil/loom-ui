import {
  type Blueprint,
  type IdentityReport,
  type WidgetAction,
  preservesBlueprintNodes,
} from "@loom/blueprint-runtime";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { type Accumulator, reconcileContainer, remountedOf } from "./reconcile";
import { type DomRegistry, type RecomposeReport, projectionPlaceholder } from "./registry";
import {
  type ContainerEntry,
  type MountContext,
  disposeEntry,
  elementOf,
  malformedNodes,
  mountContainer,
} from "./tree";

export interface DomRenderOptions {
  readonly projectionRuntime: ProjectionRuntime;
  readonly executionId: string;
  readonly registry: DomRegistry;
  readonly onAction?: (action: WidgetAction) => void;
  /**
   * Whether the Blueprint's own title renders as the root `<h1>`. Default `"heading"` — today's
   * behaviour, unchanged. `"none"` mounts no `<h1>` at all: an app with its own page header, or
   * whose compiled title is not display text, gets a bare root. Under `"none"` a `blueprint.title`
   * change is not a DOM mutation — `update` never creates, removes, or touches a title element.
   * Not supported mid-handle: the mode is fixed for the handle's lifetime, read once at
   * `renderBlueprintDom` and never re-read from `update`'s `next`.
   */
  readonly title?: "heading" | "none";
}
export interface DomRenderHandle {
  readonly element: HTMLElement;
  /**
   * Land a revised Blueprint on the live tree: widgets keyed by id, containers by ordinal and
   * type, the focused subtree never moved. Never throws — renderer failures come back in
   * `RecomposeReport.findings` with the failing widget already on its error placeholder.
   * Not re-entrant: an `update` called from inside a renderer's `patch`/`update` during a pass
   * is refused (a `re-entrant update` finding) and changes nothing.
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

  const titleMode = opts.title ?? "heading";
  const element = document.createElement("div");
  element.dataset.blueprintId = blueprint.id;
  const title = titleMode === "heading" ? document.createElement("h1") : undefined;
  if (title) title.textContent = blueprint.title;
  element.append(...(title ? [title] : []), ...unregistered.map(projectionPlaceholder));
  element.append(elementOf(root));
  host.appendChild(element);

  const state = { current: blueprint, root, disposed: false, updating: false };
  return {
    element,
    update: (next) => {
      // `compared: 0` is loom's own tell that nothing was compared: the truth for a refused call
      // and for a `next` so malformed that walking it threw before the reconcile began.
      const notCompared: IdentityReport = { ok: true, findings: [], added: [], compared: 0 };
      const refused = (message: string): RecomposeReport => ({
        identity: notCompared,
        remounted: [],
        rebound: [],
        findings: [{ code: "patch-failed", nodeId: "", message }],
      });
      // Both checks come BEFORE anything reads `next`: a disposed handle says "disposed" however
      // malformed the Blueprint it is handed, and a nested call must not walk a tree the outer
      // pass is half-way through landing.
      if (state.disposed) return refused("disposed");
      if (state.updating) return refused("re-entrant update");
      state.updating = true;
      const acc: Accumulator = { disposed: [], rebound: [], findings: [], mounted: [] };
      let identity = notCompared;
      try {
        identity = preservesBlueprintNodes(state.current, next);
        // Validate the WHOLE revised tree before touching the live one. loom's identity walk
        // skips malformed nodes without reporting them, so it cannot be relied on to have rejected it.
        const bad = malformedNodes(next.layout);
        // A rejected tree returns the not-compared identity because an identity computed over a
        // tree the adapter refuses to apply describes nothing that happened.
        if (bad.length > 0)
          return {
            identity: notCompared,
            remounted: [],
            rebound: [],
            findings: bad.map((path) => ({
              code: "patch-failed" as const,
              nodeId: "",
              message: `malformed node at ${path}`,
            })),
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
        if (title && title.textContent !== next.title) title.textContent = next.title;
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
            element.insertBefore(projectionPlaceholder(id), elementOf(state.root));
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
        //
        // Everything this pass MOUNTED is undone: until a container commits its `children`, a
        // new entry lives only in the reconcile's locals, so leaving it would strand a
        // subscribed widget in the DOM where `dispose()` can never reach it. Disposal is
        // idempotent, so an entry that also made it into the tree is harmless to dispose here.
        // What the pass did to KEPT entries (patched, remounted in place, dropped) stands.
        const findings = [...acc.findings];
        const cleanupFailed = (widgetId: string, err: unknown) =>
          findings.push({
            code: "mount-failed",
            nodeId: widgetId,
            message: err instanceof Error ? err.message : String(err),
          });
        const undone = new Set(acc.mounted);
        for (const m of acc.mounted) disposeEntry(m, cleanupFailed);
        for (const m of acc.mounted) elementOf(m).remove();
        // A container that committed a mounted child must forget it, or `dispose()` walks it.
        const forget = (c: ContainerEntry): void => {
          c.children = c.children.filter((k) => !undone.has(k));
          for (const k of c.children) if (k.kind === "container") forget(k);
        };
        forget(state.root);
        findings.push({
          code: "patch-failed",
          nodeId: "",
          message: e instanceof Error ? e.message : String(e),
        });
        return {
          identity,
          remounted: remountedOf(next, acc.disposed),
          rebound: acc.rebound,
          findings,
        };
      } finally {
        state.updating = false;
      }
    },
    dispose: () => {
      state.disposed = true;
      const errors: unknown[] = [];
      try {
        disposeEntry(state.root, (_id, e) => errors.push(e));
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
