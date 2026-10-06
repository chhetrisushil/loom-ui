import { Operation, Provenance, Sensitivity } from "@loom-ui/core";
import { z } from "zod";

// ── The lineage event protocol ────────────────────────────────────────────────
// A lineage is the append-only log of ONE experience's versions. Every entry is an event whose
// type names what happened and whose payload carries the content address (`ref`) of the stored
// artifact plus enough to VERIFY it without trusting the blob:
//
//   EXPERIENCE_COMPOSED  a version produced by ops folded onto its parent (or the genesis, ops [])
//   EXPERIENCE_REVERTED  a version that restores an older artifact's content as a NEW version
//   EXPERIENCE_BRANCHED  the first version of a NEW lineage forked from a version of another
//   EXPERIENCE_PROMOTED  the app chose to SHOW a version (head is "latest", promoted is "shown")
//
// `EXPERIENCE_COMPOSED` is the same name and `{ ref, parents, ops }` core's `log.ts` declared as a
// userspace convention; here it gains a producer, a consumer and a validator. The extra fields
// (`experienceId`, `versionHash`, `by`) are additive. `EXPERIENCE_PROMOTED` is redeclared (not
// imported) because importing it from `@loom-ui/planner` would put the planner's whole graph —
// hydration, the sandbox — into a server-side store package; `lineage.test.ts` asserts the two
// spellings never drift.

export const EXPERIENCE_COMPOSED = "EXPERIENCE_COMPOSED";
export const EXPERIENCE_REVERTED = "EXPERIENCE_REVERTED";
export const EXPERIENCE_BRANCHED = "EXPERIENCE_BRANCHED";
export const EXPERIENCE_PROMOTED = "EXPERIENCE_PROMOTED";

export type LineageEventType =
  | typeof EXPERIENCE_COMPOSED
  | typeof EXPERIENCE_REVERTED
  | typeof EXPERIENCE_BRANCHED
  | typeof EXPERIENCE_PROMOTED;

const ContentRefSchema = z.object({ __loomContent: z.string().min(1) });
const Hash = z.string().min(1);

const RecordedOperationSchema = z.object({
  op: Operation,
  baseVersion: z.string().optional(),
  by: Provenance,
  at: z.string(),
});

const Common = {
  experienceId: z.string().min(1),
  versionHash: Hash,
  ref: ContentRefSchema,
  parents: z.array(Hash),
  by: Provenance,
};

export const ComposedPayload = z.object({
  ...Common,
  ops: z.array(RecordedOperationSchema),
  /**
   * What the author said about the change (U7): UNTRUSTED text (a planner's model text), bounded
   * and stripped by `boundSummary` on the way in AND on the way out of the fold, since the log is
   * untrusted input. Optional, so every version written before it replays unchanged; it is not in
   * the content address (nothing here is).
   */
  summary: z.string().optional(),
  /**
   * The strictest class of everything the author READ to write `summary` (the experience, tool
   * samples, caller context), stamped by the host at compose. A summary is judged against it (and
   * against the version's own class floor) before a viewer is shown it. Recorded on the event, not
   * in the content address. Absent = unknown, and the floor alone gates the summary.
   */
  summaryClass: Sensitivity.optional(),
});
export const RevertedPayload = z.object({ ...Common, revertedTo: Hash });
export const BranchedPayload = z.object({
  ...Common,
  from: z.object({ experienceId: z.string().min(1), versionHash: Hash }),
  /** The version of the SOURCE line whose sticky classes were carried in (its head at the fork). */
  carriedFrom: Hash,
});
export const PromotedPayload = z.object({
  ref: ContentRefSchema,
  experienceId: z.string().min(1),
  versionHash: Hash,
  by: Provenance,
});

export type ComposedPayload = z.infer<typeof ComposedPayload>;
export type SummaryClass = NonNullable<ComposedPayload["summaryClass"]>;
export type RevertedPayload = z.infer<typeof RevertedPayload>;
export type BranchedPayload = z.infer<typeof BranchedPayload>;
export type PromotedPayload = z.infer<typeof PromotedPayload>;

export const PAYLOAD_SCHEMAS = {
  [EXPERIENCE_COMPOSED]: ComposedPayload,
  [EXPERIENCE_REVERTED]: RevertedPayload,
  [EXPERIENCE_BRANCHED]: BranchedPayload,
  [EXPERIENCE_PROMOTED]: PromotedPayload,
} as const;

export const isLineageEventType = (t: string): t is LineageEventType =>
  Object.hasOwn(PAYLOAD_SCHEMAS, t);
