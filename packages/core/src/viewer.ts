import type { DataClass } from "@loom/classify";

// ── Who may see what ──────────────────────────────────────────────────────────
// A VIEWER is whoever the produced output is for. Its `clearance` is the strictest data class it
// may see, in `@loom/classify`'s ordering (secret > sensitive > internal): a viewer cleared to
// "sensitive" sees "sensitive" and "internal" bindings and not "secret" ones; one with no
// clearance sees only UNCLASSIFIED bindings (a binding with no `sensitivity`). Clearance is a
// plain fact the host derives from its own authorization (loom's `ExecutionAuthorizer`, a role
// claim); this package decides nothing about who has it, it only refuses to cross it.
//
// FAIL-CLOSED: no viewer at all is the same as a viewer with no clearance. An unclassified
// binding is never affected either way.

export interface Viewer {
  /** The strictest class this viewer may see. Absent = unclassified content only. */
  readonly clearance?: DataClass;
}

/**
 * WHO a surface is drawn for (loom-ui roadmap slice 7). `"viewer"` (the default) = the requesting
 * viewer: their `clearance` decides what they see. `"broadcast"` = a surface many, or unknown,
 * viewers see at once (a wallboard, a shared screen, a recording): the least-privileged ceiling
 * applies whoever asked. See {@link effectiveViewer}.
 */
export type Audience = "viewer" | "broadcast";

/** Is this a broadcast audience? FAIL-CLOSED: anything but `undefined` / `"viewer"` is broadcast. */
export function isBroadcast(audience: unknown): boolean {
  return audience !== undefined && audience !== "viewer";
}

/**
 * The viewer whose clearance actually decides what a surface for `audience` may show: the STRICTER
 * of the requesting viewer's clearance and the audience's ceiling. `"viewer"` has no ceiling, so
 * it is the requesting viewer as given. `"broadcast"`'s ceiling is the lowest class, UNCLASSIFIED
 * content only (this package's class order is secret > sensitive > internal, with no class below
 * "internal" but none at all), and nothing is stricter than the lowest, so the result is a viewer
 * with no clearance, whoever asked. A class this package does not recognise is withheld under
 * broadcast like any other classified content (`mayView` refuses it).
 */
export function effectiveViewer(
  viewer: Viewer | undefined,
  audience: Audience | undefined
): Viewer | undefined {
  return isBroadcast(audience) ? {} : viewer;
}

const RANK: Record<DataClass, number> = { secret: 3, sensitive: 2, internal: 1 };

/** Rank of a clearance: 0 for none, otherwise the class's rank. An unknown value ranks 0 (fail-closed). */
function clearanceRank(c: unknown): number {
  return typeof c === "string" && Object.hasOwn(RANK, c) ? (RANK[c as DataClass] as number) : 0;
}

/**
 * May `viewer` see content of `sensitivity`? Unclassified (`undefined`) content: always. Classified
 * content: only a viewer whose clearance ranks at least as high. Total — a malformed viewer or an
 * unknown class refuses, never throws.
 */
export function mayView(viewer: Viewer | undefined, sensitivity: DataClass | undefined): boolean {
  if (sensitivity === undefined) return true;
  const need = clearanceRank(sensitivity);
  // An unknown class string would rank 0 and read as "unclassified"; classified-but-unrecognised
  // content is not something to wave through.
  if (need === 0) return false;
  let have = 0;
  try {
    have = clearanceRank(viewer?.clearance);
  } catch {
    return false;
  }
  return have >= need;
}

/**
 * The strictest of two classes (`undefined` is weakest) — the class a handle shared by several
 * nodes carries. FAIL-CLOSED and monotone: a class this package does not recognise outranks every
 * known one (it cannot be waved through as weaker), so `strictest` never lowers what it was given.
 */
export function strictestClass(
  a: DataClass | undefined,
  b: DataClass | undefined
): DataClass | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const rank = (c: DataClass): number =>
    Object.hasOwn(RANK, c) ? (RANK[c] as number) : Number.POSITIVE_INFINITY;
  return rank(a) >= rank(b) ? a : b;
}

/**
 * The weakest of two classes (`undefined`, unclassified, is weakest) — the class a container whose
 * visibility is its most visible child carries. FAIL-CLOSED: an unrecognised class outranks every
 * known one, so it is never the weaker side against a known class.
 */
export function weakestClass(
  a: DataClass | undefined,
  b: DataClass | undefined
): DataClass | undefined {
  if (a === undefined || b === undefined) return undefined;
  const rank = (c: DataClass): number =>
    Object.hasOwn(RANK, c) ? (RANK[c] as number) : Number.POSITIVE_INFINITY;
  return rank(a) <= rank(b) ? a : b;
}
