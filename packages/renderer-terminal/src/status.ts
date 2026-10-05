import { checkKindValue } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, type HydrationStore } from "@loom-ui/hydration/client";
import type { Blueprint, RendererRegistry } from "@loom/blueprint-runtime";
import {
  type TerminalWidgetRenderer,
  type WidgetValueCheck,
  renderBlueprintToString,
} from "@loom/plugin-renderer-terminal";
import { type TerminalRegistryOptions, terminalRegistry } from "./registry";

// ── The status matrix is loom's ───────────────────────────────────────────────
// Since Blueprint IR 2.0.0 (ADR 0097 D2) the eight-row decision table lives in loom's own
// traversal: each binding DECLARES its status channel (`status.<handle>`, beside the value's
// `values.<handle>` in the same projection state), and `renderBlueprintToString` applies the
// matrix. The framework contributes exactly one thing to it — what a bound VALUE must look
// like, which is catalogue vocabulary loom deliberately knows nothing about — through the
// `check` seam loom leaves open between `error` and `stale`.

/** The framework's per-kind value contract, in loom's `check` seam (between `error` and `stale`). */
export const kindValueCheck: WidgetValueCheck = (widget, value) => {
  const c = checkKindValue(widget.kind, value);
  return c.ok ? undefined : { code: c.finding.code, message: c.finding.message };
};

export interface RenderExperienceOptions extends TerminalRegistryOptions {
  /**
   * Overrides the registry. Passing it together with `chrome` throws — `chrome` only configures the
   * default registry; build yours with `terminalRegistry({ chrome })` instead.
   * NOTE for `chrome: "host"`: the framework kinds' own renderings carry no title, but the rows
   * loom's traversal itself writes — `✗`/`○`/`~`/`⋯` status lines and loom's eight built-in kinds —
   * are loom's output and keep theirs. Drive a widget renderer directly for a fully title-free body.
   */
  readonly registry?: RendererRegistry<TerminalWidgetRenderer>;
}

/**
 * Render the store's projection through loom's terminal renderer: loom's matrix, the framework's
 * contract check.
 *
 * The state map is keyed by `HYDRATION_PROJECTION_ID` — the one id a `HydrationStore` publishes
 * under. A blueprint compiled with any OTHER `hydrationProjectionId` therefore matches no state
 * here: every binding resolves to an undefined value and an undefined status, so the surface
 * renders as loading rows. That is the honest rendering of "this store holds nothing for that
 * projection", not an error — pass the store's own id to `compile` and the rows fill.
 */
export function renderExperience(
  blueprint: Blueprint,
  store: HydrationStore,
  opts: RenderExperienceOptions = {}
): string {
  if (opts.registry !== undefined && opts.chrome !== undefined)
    throw new Error(
      "renderExperience: `chrome` configures the default registry and would be ignored next to `registry` — pass one, or build your registry with terminalRegistry({ chrome })"
    );
  const state = store.state();
  const stateMap = new Map<string, unknown>();
  // `HydrationStore` publishes under one well-known projection id; every other projection the
  // blueprint declares is somebody else's and has no state here.
  for (const id of blueprint.projections)
    stateMap.set(id, id === HYDRATION_PROJECTION_ID ? state : undefined);
  return renderBlueprintToString(blueprint, stateMap, {
    registry: opts.registry ?? terminalRegistry(opts),
    check: kindValueCheck,
  });
}
