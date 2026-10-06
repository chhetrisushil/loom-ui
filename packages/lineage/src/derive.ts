import { type Experience, type Provenance, carryClasses } from "@loom-ui/core";

// ── Versions that are not "ops on a parent" ───────────────────────────────────
// A revert and a branch adopt an OLDER artifact's content, so they are not expressible as ops
// from the head. They are deterministic functions of two artifacts instead, which is what makes
// them verifiable: `Lineage.verify` recomputes them from the log and compares the content address.
//
// THE CLASS RULE (fail-closed): the artifact adopted is older than the line. Everything the line
// ever learned about how confidential a handle, tool or projection is lives in the sticky class
// maps of its LATEST version, and the adopted artifact predates some of it. Both functions
// therefore fold the classes of the artifact the line had reached (`head` for a revert, the source
// head at the fork for a branch) into the adopted one with `carryClasses` — `strictest`, never
// lower — INCLUDING classes only that artifact's live nodes carried (they would vanish with the
// nodes). A restored version can be stricter than it was when first written; it can never be laxer
// than what the line knew. The one op that lowers a class, a trusted `declassify*`, is a normal
// composed version: reverting past it re-raises the class (the old artifact still holds it), which
// is the safe direction; declassifying again is how an operator lowers it for good.

export interface Authored {
  readonly by: Provenance;
  readonly at: string;
}

/** The unsealed artifact a revert to `target` produces on top of `head`. Same line, same id. */
export function revertArtifact(head: Experience, target: Experience, a: Authored): Experience {
  const adopted: Experience = {
    ...target,
    experienceId: head.experienceId,
    versionHash: "",
    parents: [head.versionHash],
    meta: { author: authorOf(a.by), createdAt: a.at, sourceKind: "revert" },
  };
  return carryClasses(head, adopted);
}

/**
 * The unsealed first artifact of the line `experienceId`, forked from `source` with the classes of
 * `carriedFrom` (the source line's head at the fork) carried in. Its parent is `source` — a version
 * of ANOTHER line, which is how a branch is told from a genesis.
 */
export function branchArtifact(
  source: Experience,
  carriedFrom: Experience,
  experienceId: string,
  a: Authored
): Experience {
  const adopted: Experience = {
    ...source,
    experienceId,
    versionHash: "",
    parents: [source.versionHash],
    meta: { author: authorOf(a.by), createdAt: a.at, sourceKind: "branch" },
  };
  return carryClasses(carriedFrom, adopted);
}

export const authorOf = (by: Provenance): string => by.agentId ?? by.ref ?? by.source;
