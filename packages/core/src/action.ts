// ── Action provenance: what the user was LOOKING AT when they acted ───────────────────────────
//
// An action (an approval, a rejection, a button) is only meaningful against the view it was taken
// on. A renderer stamps every action it emits with `viewedVersion`; a host compares that stamp with
// the CURRENT head before acting, and refuses an action taken on a view that has since moved
// (recomposed, or whose bound data changed). No zod, no Experience schema: a browser renderer
// imports this from `@loom-ui/core/browser`.
//
// Threat model: the stamp is written by the RENDERER (trusted host code), never by a widget, an
// A2UI tree or a sandbox frame — those produce only `type`-less payloads that the renderer wraps.
// It is a staleness / oversight aid, not authentication: it does not prove WHO acted (that is the
// host's `ResumeAuthenticator` job), only WHICH version of the view they saw.

/** The binding state the user saw on a bound widget, when the widget has a binding status. */
export interface ViewedBinding {
  /** The binding's delivery state at the time of the action (`ready`, `stale`, ...). */
  readonly state: string;
  /** The binding's monotonic sequence — lets a host detect that the data moved since the view. */
  readonly seq?: number;
}

/** The version of the view an action was taken on. */
export interface ViewedVersion {
  /** The compiled Blueprint id the user saw: `<experienceId>@<versionHash>` (`@unsealed` if none). */
  readonly blueprintId: string;
  /** The Experience id, parsed from the Blueprint id. */
  readonly experienceId: string;
  /** The Experience `versionHash` the user saw; `""` when the Experience was unsealed. */
  readonly versionHash: string;
  /** For a widget with a binding status: what the user saw of the data. Absent otherwise. */
  readonly binding?: ViewedBinding;
}

/** Any action a loom-ui renderer emits: loom's `WidgetAction` plus the stamped provenance. */
export interface StampedAction {
  readonly type: string;
  readonly widgetId: string;
  readonly payload?: unknown;
  /** Additive: hosts that ignore it behave exactly as before. Absent only on a legacy emitter. */
  readonly viewedVersion?: ViewedVersion;
}

const UNSEALED = "unsealed";

/** Split a compiled Blueprint id (`<experienceId>@<versionHash|unsealed>`) into its two halves. */
export function parseBlueprintId(blueprintId: string): {
  experienceId: string;
  versionHash: string;
} {
  const at = blueprintId.lastIndexOf("@");
  if (at < 0) return { experienceId: blueprintId, versionHash: "" };
  const hash = blueprintId.slice(at + 1);
  return {
    experienceId: blueprintId.slice(0, at),
    versionHash: hash === UNSEALED ? "" : hash,
  };
}

/** Build the stamp for a Blueprint id (+ the widget's binding status, if it has one). */
export function viewedVersionOf(
  blueprintId: string,
  binding?: { state: string; seq?: number }
): ViewedVersion {
  const { experienceId, versionHash } = parseBlueprintId(blueprintId);
  return {
    blueprintId,
    experienceId,
    versionHash,
    ...(binding && {
      binding: { state: binding.state, ...(binding.seq !== undefined && { seq: binding.seq }) },
    }),
  };
}

/**
 * Why an action is or is not safe to act on.
 *  - `fresh`        — stamped with exactly the current head.
 *  - `stale`        — stamped with a different version (recomposed since).
 *  - `unstamped`    — no provenance (legacy emitter, or a forged action): cannot be verified.
 *  - `unverifiable` — the head or the stamp is unsealed (`versionHash` empty): no version to compare.
 */
export type ActionFreshness = "fresh" | "stale" | "unstamped" | "unverifiable";

/** The current head, as much of it as the check needs: an Experience or a bare version. */
export interface CurrentHead {
  readonly experienceId: string;
  readonly versionHash: string;
}

export function actionFreshness(
  action: { readonly viewedVersion?: ViewedVersion },
  current: CurrentHead
): ActionFreshness {
  const viewed = action.viewedVersion;
  if (!viewed || typeof viewed.versionHash !== "string") return "unstamped";
  if (viewed.versionHash === "" || current.versionHash === "") return "unverifiable";
  if (viewed.experienceId !== current.experienceId) return "stale";
  return viewed.versionHash === current.versionHash ? "fresh" : "stale";
}

/**
 * Fail-closed: `true` for EVERY verdict but `fresh`. A host that must not act on a view the user
 * never saw refuses when this is `true`; use `actionFreshness` to tell the reasons apart.
 */
export function isStaleAction(
  action: { readonly viewedVersion?: ViewedVersion },
  current: CurrentHead
): boolean {
  return actionFreshness(action, current) !== "fresh";
}
