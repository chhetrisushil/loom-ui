import { checkKindValue, handleFromPath } from "@loom-ui/core";
import {
  HYDRATION_PROJECTION_ID,
  type HydrationState,
  type HydrationStore,
} from "@loom-ui/hydration";
import { type Blueprint, RendererRegistry, type Widget } from "@loom/blueprint-runtime";
import {
  type TerminalWidgetRenderer,
  renderBlueprintToString,
} from "@loom/plugin-renderer-terminal";
import { terminalRegistry } from "./registry";

const title = (w: Widget): string => w.title ?? w.kind;

/** Wrap every renderer so a widget bound to the status projection shows its handle's state. */
export function withStatus(
  registry: RendererRegistry<TerminalWidgetRenderer>,
  state: HydrationState,
  statusProjectionId: string = HYDRATION_PROJECTION_ID
): RendererRegistry<TerminalWidgetRenderer> {
  const out = new RendererRegistry<TerminalWidgetRenderer>();
  for (const kind of registry.kinds()) {
    const inner = registry.get(kind) as TerminalWidgetRenderer;
    out.register(kind, (w, v) => {
      // Not bound to the status projection: no status to consult, just the contract then the
      // renderer.
      if (w.binding?.projectionId !== statusProjectionId) {
        const check = checkKindValue(w.kind, v);
        if (!check.ok) return `✗ ${title(w)}: ${check.finding.message}`;
        return inner(w, v);
      }
      const handle = handleFromPath(w.binding.path);
      const status =
        handle === undefined
          ? undefined
          : Object.hasOwn(state.status, handle)
            ? state.status[handle]
            : undefined;
      // ── The status matrix ───────────────────────────────────────────────────
      // ONE decision table, and the Lit surface implements the SAME one in
      // `@loom-ui/renderer-lit`'s `widgets/base.ts` (`LuWidget.state()`). Both are pinned by an
      // identical eight-row table-driven test (`statusMatrix.test.ts` in each package) so the
      // two surfaces cannot drift into disagreeing about what a handle's state means.
      //
      // 1. A live status error outranks the value's own contract violation — the finding on the
      //    STATUS is the more specific diagnosis (e.g. "provider timed out") than the generic
      //    "does not match its contract" the last-known value would otherwise produce.
      if (status?.state === "error") return `✗ ${title(w)}: ${status.finding?.message ?? "error"}`;
      // 2. The contract.
      const check = checkKindValue(w.kind, v);
      if (!check.ok) return `✗ ${title(w)}: ${check.finding.message}`;
      // 3. Stale: the marker plus what we have — or, with nothing to show, the marker plus the
      //    reason. "Stale AND empty" is a third fact, not a spinner.
      if (status?.state === "stale")
        return v === undefined
          ? `~ ${title(w)}: — (${status.finding?.message ?? "stale"})`
          : `~ ${inner(w, v)}`;
      // 4. Pending over a value we already have: the marker plus the old rendering; pending over
      //    nothing: the marker and the title alone.
      if (status?.state === "pending")
        return v === undefined ? `⋯ ${title(w)}` : `⋯ ${inner(w, v)}`;
      // 5/6. No value (loom's renderers already print `title: —`), or ready.
      return inner(w, v);
    });
  }
  return out;
}

export interface RenderExperienceOptions {
  readonly registry?: RendererRegistry<TerminalWidgetRenderer>;
  readonly statusProjectionId?: string;
}

export function renderExperience(
  blueprint: Blueprint,
  store: HydrationStore,
  opts: RenderExperienceOptions = {}
): string {
  const state = store.state();
  const stateMap = new Map<string, unknown>();
  for (const id of blueprint.projections)
    stateMap.set(
      id,
      id === (opts.statusProjectionId ?? HYDRATION_PROJECTION_ID) ? state : undefined
    );
  return renderBlueprintToString(blueprint, stateMap, {
    registry: withStatus(opts.registry ?? terminalRegistry(), state, opts.statusProjectionId),
  });
}
