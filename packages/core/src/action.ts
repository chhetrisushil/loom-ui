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
  /**
   * The binding's sequence the widget was last DELIVERED (what the user saw, not what the store
   * holds now). It is this binding's own status seq, drawn from a store-wide monotonic counter: a
   * write to ANOTHER handle does not change it. Compare it for EQUALITY with the current one to
   * detect "the data moved".
   */
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
  /**
   * Fingerprint of the viewer-dependent compile inputs (clearance, restricted handles, locale)
   * the host declared when it mounted the renderer (`compileFingerprint`). The artifact id alone
   * does not name the VIEW: an approver shown "Restricted" must not be treated as having seen the
   * real content. Absent when the host declared none.
   */
  readonly compile?: string;
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
  binding?: { state: string; seq?: number },
  compile?: string
): ViewedVersion {
  const { experienceId, versionHash } = parseBlueprintId(blueprintId);
  return {
    blueprintId,
    experienceId,
    versionHash,
    ...(binding && {
      binding: { state: binding.state, ...(binding.seq !== undefined && { seq: binding.seq }) },
    }),
    ...(compile !== undefined && { compile }),
  };
}

/** The viewer-dependent inputs a Blueprint's compile depends on besides the Experience itself. */
export interface CompileFingerprintInput {
  /** The viewer's clearance (`Viewer.clearance`). */
  readonly clearance?: string;
  /**
   * The handles redacted for this viewer (order-insensitive). The fingerprint is NOT secret and the
   * viewer carries it on every action, so pass `CompileResult.fingerprint.restrictedHandles` (opaque
   * aliases), never the real names: a plain hash of a handle list lets the viewer confirm a guess.
   */
  readonly restrictedHandles?: readonly string[];
  /** The locale `resolveLabel` renders in. */
  readonly locale?: string;
  /**
   * Any other compile input the host varies per viewer and wants covered (e.g. `surface`, the
   * catalogue version, `restrictedLabel`, a title override, the hydration projection version).
   * Order-insensitive; omitted = the fingerprint is exactly what it was without this field.
   */
  readonly extra?: Readonly<Record<string, string>>;
  /** `CompileResult.fingerprint.restrictedProjectionNodes` (the aliased form; order-insensitive); empty/absent adds nothing. */
  readonly restrictedProjectionNodes?: readonly string[];
  /** The projection id → version the host's catalogue offers; empty/absent adds nothing. */
  readonly projectionVersions?: Readonly<Record<string, string>>;
}

/**
 * A deterministic fingerprint of the compile inputs that change what the user SEES without
 * changing the Experience. Change detection only (two 32-bit FNV-1a lanes), not a security hash.
 * Total: never throws.
 */
export function compileFingerprint(input: CompileFingerprintInput): string {
  let canon: string;
  try {
    const handles = [...(input.restrictedHandles ?? [])].map(String).sort();
    const parts: unknown[] = [input.clearance ?? null, handles, input.locale ?? null];
    if (input.extra !== undefined)
      parts.push(
        Object.entries(input.extra)
          .map(([k, v]): [string, string] => [String(k), String(v)])
          .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
      );
    // Tagged and appended only when present, so a fingerprint without them is unchanged.
    const rp = [...(input.restrictedProjectionNodes ?? [])].map(String).sort();
    if (rp.length > 0) parts.push(["rp", rp]);
    const pv = Object.entries(input.projectionVersions ?? {})
      .map(([k, v]): [string, string] => [String(k), String(v)])
      .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    if (pv.length > 0) parts.push(["pv", pv]);
    canon = JSON.stringify(parts);
  } catch {
    canon = "?";
  }
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < canon.length; i++) {
    const c = canon.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return `cf1:${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
}

/**
 * Why an action is or is not safe to act on.
 *  - `fresh`        — stamped with exactly the current head.
 *  - `stale`        — stamped with a different version (recomposed since).
 *  - `unstamped`    — no provenance (legacy emitter, or a forged action): cannot be verified.
 *  - `data-moved`   — same composition, but the bound data's seq differs from the head's.
 *  - `unverifiable` — the head or the stamp is unsealed (`versionHash` empty), or the head asks a
 *                     question (data seq, compile fingerprint) the stamp cannot answer.
 */
export type ActionFreshness = "fresh" | "stale" | "data-moved" | "unstamped" | "unverifiable";

/** The current head, as much of it as the check needs: an Experience or a bare version. */
export interface CurrentHead {
  readonly experienceId: string;
  readonly versionHash: string;
  /**
   * The CURRENT sequence of the data bound to `widgetId` (e.g. `handle.head().bindingSeq`, or the
   * store's status for that widget's binding). When provided, a stamp WITH a binding must carry a
   * seq equal to it: a different one is `data-moved`, a missing one `unverifiable`. Return
   * `undefined` when unknown — that too is `unverifiable` for a bound widget (fail-closed).
   */
  readonly bindingSeq?: (widgetId: string) => number | undefined;
  /** The compile fingerprint the host currently serves this viewer; compared when provided. */
  readonly compile?: string;
}

export function actionFreshness(
  action: { readonly widgetId?: string; readonly viewedVersion?: ViewedVersion },
  current: CurrentHead
): ActionFreshness {
  const viewed = action.viewedVersion;
  if (!viewed || typeof viewed.versionHash !== "string") return "unstamped";
  if (viewed.versionHash === "" || current.versionHash === "") return "unverifiable";
  if (viewed.experienceId !== current.experienceId) return "stale";
  if (viewed.versionHash !== current.versionHash) return "stale";
  if (current.compile !== undefined) {
    if (typeof viewed.compile !== "string") return "unverifiable";
    if (viewed.compile !== current.compile) return "stale";
  }
  if (current.bindingSeq && viewed.binding) {
    const seen = viewed.binding.seq;
    let now: number | undefined;
    try {
      now = current.bindingSeq(typeof action.widgetId === "string" ? action.widgetId : "");
    } catch {
      now = undefined;
    }
    if (typeof seen !== "number" || typeof now !== "number") return "unverifiable";
    if (seen !== now) return "data-moved";
  }
  return "fresh";
}

/**
 * Fail-closed: `true` for EVERY verdict but `fresh`. A host that must not act on a view the user
 * never saw refuses when this is `true`; use `actionFreshness` to tell the reasons apart.
 */
export function isStaleAction(
  action: { readonly widgetId?: string; readonly viewedVersion?: ViewedVersion },
  current: CurrentHead
): boolean {
  return actionFreshness(action, current) !== "fresh";
}
