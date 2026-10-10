import { type ContractRegistry, checkKindValue } from "@loom-ui/core";
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
export const kindValueCheck: WidgetValueCheck = kindValueCheckFor();

/**
 * {@link kindValueCheck} that also checks the host's own kinds against `contracts` (a catalogue's
 * `valueContracts`). The framework's contract wins for a framework kind. Absent = framework only.
 */
export function kindValueCheckFor(contracts?: ContractRegistry): WidgetValueCheck {
  return (widget, value) => {
    const c = checkKindValue(widget.kind, value, contracts);
    return c.ok ? undefined : { code: c.finding.code, message: c.finding.message };
  };
}

export interface RenderExperienceOptions extends TerminalRegistryOptions {
  /** The catalogue's `valueContracts`: bound values of the host's own kinds are checked against them. */
  readonly contracts?: ContractRegistry;
  /**
   * Overrides the registry. Passing it together with `chrome` throws — `chrome` only configures the
   * default registry; build yours with `terminalRegistry({ chrome })` instead.
   * NOTE for `chrome: "host"`: the framework kinds' own renderings carry no title, but the rows
   * loom's traversal itself writes — `✗`/`○`/`~`/`⋯` status lines and loom's eight built-in kinds —
   * are loom's output and keep theirs. Drive a widget renderer directly for a fully title-free body.
   */
  readonly registry?: RendererRegistry<TerminalWidgetRenderer>;
  /**
   * The current state of any projection the blueprint declares OTHER than the store's own
   * hydration projection (a node bound through `SemanticNode.projection`): `(id) => state`,
   * `undefined` for one the host has no state for (its widgets render as loading). Typically
   * `(id) => runtime.getState(id, executionId)`. Never consulted for the hydration id — the store
   * is that projection's only source here.
   */
  readonly projectionState?: (projectionId: string) => unknown;
  /**
   * How `watch` hears that a non-hydration projection changed: called once, returns an
   * unsubscribe. Without it `watch` re-renders on hydration changes only.
   */
  readonly projectionSubscribe?: (onChange: () => void) => () => void;
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
  // blueprint declares is somebody else's, and has state here only if the host supplies it. A
  // throwing supplier is "no state yet" (a loading row), never a throw out of a render.
  for (const id of blueprint.projections) {
    if (id === HYDRATION_PROJECTION_ID) stateMap.set(id, state);
    else stateMap.set(id, readProjection(opts.projectionState, id));
  }
  return inert(
    renderBlueprintToString(blueprint, stateMap, {
      registry: opts.registry ?? terminalRegistry(opts),
      check: opts.contracts === undefined ? kindValueCheck : kindValueCheckFor(opts.contracts),
    })
  );
}

/**
 * Control characters other than newline (an ESC begins a terminal escape sequence: clear the screen,
 * retitle the window, move the cursor), C1 controls, and bidi overrides. A title, a label or a cell
 * can be model- or user-authored, so the frame as a whole is made inert, not only the kinds that
 * clean their own text. Idempotent; a printable character is never touched.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const inert = (frame: string): string => frame.replace(CONTROLS, "");

function readProjection(read: RenderExperienceOptions["projectionState"], id: string): unknown {
  if (read === undefined) return undefined;
  try {
    return read(id);
  } catch {
    return undefined;
  }
}
