import { type Finding, type HandleUse, type Viewer, mayView } from "@loom-ui/core";

// ── Viewer enforcement at the data boundary ───────────────────────────────────
// Hydration is where data actually flows, so it is the second place a binding's `sensitivity`
// is enforced (the first is `compile`, which redacts the node). A handle whose strictest class the
// viewer may not see is never planned, never invoked, never cached, never served: its provider
// is not called at all. FAIL-CLOSED: no viewer is a viewer with no clearance; unclassified handles
// are unaffected either way. See `@loom-ui/core`'s `viewer.ts`.

/**
 * What the store (and so the viewer) is told about a refused handle. A fixed text: it names no
 * handle, class, tool or argument, so refusing leaks nothing beyond "this is restricted".
 */
export const restrictedFinding = (): Finding => ({
  code: "restricted",
  severity: "error",
  message: "this data is restricted for the current viewer",
});

/** The advisory for classified handles with no viewer supplied (they are all refused). */
export const viewerNotSuppliedFinding = (): Finding => ({
  code: "viewer-not-supplied",
  severity: "warn",
  message:
    "the experience binds classified handles and no viewer was supplied: they are refused (no viewer is the most restrictive viewer)",
});

/** Split an inventory into the handles a viewer may load and the ones it may not. */
export function partitionByViewer(
  uses: readonly HandleUse[],
  viewer: Viewer | undefined
): { allowed: HandleUse[]; restricted: HandleUse[]; advisory: Finding[] } {
  const allowed: HandleUse[] = [];
  const restricted: HandleUse[] = [];
  for (const use of uses) (mayView(viewer, use.sensitivity) ? allowed : restricted).push(use);
  const classified = uses.some((u) => u.sensitivity !== undefined);
  return {
    allowed,
    restricted,
    advisory: classified && viewer === undefined ? [viewerNotSuppliedFinding()] : [],
  };
}

/** A copy of the viewer holding only a clearance read once; a throwing getter reads as none. */
export function snapshotViewer(viewer: Viewer | undefined): Viewer | undefined {
  if (viewer === undefined) return undefined;
  try {
    const clearance = viewer.clearance;
    return clearance === undefined ? {} : { clearance };
  } catch {
    return {};
  }
}
