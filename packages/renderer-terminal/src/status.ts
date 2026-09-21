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
      const check = checkKindValue(w.kind, v);
      if (!check.ok) return `✗ ${title(w)}: ${check.finding.message}`;
      if (w.binding?.projectionId !== statusProjectionId) return inner(w, v);
      const handle = handleFromPath(w.binding.path);
      const status =
        handle === undefined
          ? undefined
          : Object.hasOwn(state.status, handle)
            ? state.status[handle]
            : undefined;
      if (status?.state === "pending") return `⋯ ${title(w)}`;
      if (status?.state === "error") return `✗ ${title(w)}: ${status.finding?.message ?? "error"}`;
      if (status?.state === "stale") return `~ ${inner(w, v)}`;
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
