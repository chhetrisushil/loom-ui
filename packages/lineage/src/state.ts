import {
  type Finding,
  MAX_TREE_DEPTH,
  type Provenance,
  type RecordedOperation,
  boundSummary,
  treeDepth,
} from "@loom-ui/core";
import {
  type BranchedPayload,
  type ComposedPayload,
  EXPERIENCE_BRANCHED,
  EXPERIENCE_COMPOSED,
  EXPERIENCE_PROMOTED,
  EXPERIENCE_REVERTED,
  PAYLOAD_SCHEMAS,
  type RevertedPayload,
  isLineageEventType,
} from "./events";
import type { StoredLineageRecord } from "./store";

// ── Folding a lineage's events into its state ─────────────────────────────────
// The fold is pure and total (a malformed log is a finding, never a throw) and it is where the
// log's STRUCTURE is checked: dense sequences, every version's `parents` naming the head it was
// appended on, one version per content address. What a version's artifact IS, and whether its ops
// reproduce it, needs the content store and is `Lineage.verify`'s job.

export type VersionKind = "composed" | "reverted" | "branched";

export interface VersionRecord {
  readonly experienceId: string;
  readonly versionHash: string;
  readonly ref: { readonly __loomContent: string };
  readonly parents: readonly string[];
  readonly kind: VersionKind;
  /** Position in the line's event log. */
  readonly sequence: number;
  readonly at: string;
  readonly by: Provenance;
  /** The ops folded onto the parent (`composed` only; `[]` otherwise and for a genesis). */
  readonly ops: readonly RecordedOperation[];
  /** `composed`: what the author said about the change; untrusted text, already bounded. */
  readonly summary?: string;
  /** `reverted`: the version whose content this restores. */
  readonly revertedTo?: string;
  /** `branched`: the version of another line this forked, and the source head classes came from. */
  readonly from?: { readonly experienceId: string; readonly versionHash: string };
  readonly carriedFrom?: string;
}

export interface LineageState {
  readonly experienceId: string;
  /** The event log's tip (0 = empty): the compare-and-set token of the STORE. */
  readonly sequence: number;
  readonly versions: ReadonlyMap<string, VersionRecord>;
  /** Version hashes in append order. */
  readonly order: readonly string[];
  /** The latest version (the CAS token of `advance`); null = the line has no version yet. */
  readonly head: string | null;
  /** The version the app chose to show; null = none promoted. */
  readonly promoted: string | null;
}

/** Most ops one version may record. A longer array is a finding before the schema ever walks it. */
export const MAX_OPS_PER_VERSION = 10_000;
/** How deep `prompt` ops may nest their `materialized` ops while being checked. */
export const MAX_OP_NESTING = 16;

/**
 * Why a stored ops array must not reach the (recursive) zod `Operation` schema, or undefined when
 * it may. The schema recurses through `insertNode.node` and `prompt.materialized`, so a payload
 * nested past the caps would blow the stack inside `safeParse` instead of returning an issue;
 * a log is untrusted input (anyone with append access to the stream wrote it).
 */
function opsRefusal(ops: unknown): string | undefined {
  if (!Array.isArray(ops)) return undefined; // the schema reports the wrong shape
  if (ops.length > MAX_OPS_PER_VERSION)
    return `records ${ops.length} ops, over the ${MAX_OPS_PER_VERSION} limit`;
  const stack: Array<{ op: unknown; nest: number }> = [];
  for (const r of ops) stack.push({ op: (r as { op?: unknown } | null)?.op, nest: 1 });
  let seen = 0;
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { op, nest } = top;
    if (typeof op !== "object" || op === null) continue;
    if (++seen > MAX_OPS_PER_VERSION * 2) return "nests too many ops";
    const node = (op as { node?: unknown }).node;
    if (node !== undefined) {
      const depth = treeDepth(node as never);
      if (depth > MAX_TREE_DEPTH)
        return `an op's node nests ${depth} levels, over the ${MAX_TREE_DEPTH} limit`;
    }
    const inner = (op as { materialized?: unknown }).materialized;
    if (Array.isArray(inner)) {
      if (nest >= MAX_OP_NESTING) return `prompt ops nest over ${MAX_OP_NESTING} levels`;
      if (inner.length > MAX_OPS_PER_VERSION) return "a prompt op materializes too many ops";
      for (const i of inner) stack.push({ op: i, nest: nest + 1 });
    }
  }
  return undefined;
}

export type Fold = { ok: true; state: LineageState } | { ok: false; finding: Finding };

const bad = (code: string, message: string): Fold => ({
  ok: false,
  finding: { code, severity: "error", message },
});

export function foldLineage(experienceId: string, records: readonly StoredLineageRecord[]): Fold {
  try {
    return foldChecked(experienceId, records);
  } catch (err) {
    // Total by construction: whatever a hostile record does (a throwing getter, a shape the
    // checks above did not anticipate) is a finding, never an exception out of every read.
    return bad("lineage-event-invalid", `lineage "${experienceId}": ${errMessage(err)}`);
  }
}

const errMessage = (err: unknown): string => {
  try {
    return err instanceof Error ? err.message : String(err);
  } catch {
    return "unreadable record";
  }
};

function foldChecked(experienceId: string, records: readonly StoredLineageRecord[]): Fold {
  const versions = new Map<string, VersionRecord>();
  const order: string[] = [];
  let head: string | null = null;
  let promoted: string | null = null;
  let expectedSequence = 0;
  for (const rec of records) {
    expectedSequence += 1;
    if (typeof rec !== "object" || rec === null)
      return bad(
        "lineage-event-invalid",
        `lineage "${experienceId}" event #${expectedSequence}: the record is not an object`
      );
    const where = `lineage "${experienceId}" event #${rec.sequence} (${rec.type})`;
    if (rec.sequence !== expectedSequence)
      return bad(
        "lineage-sequence-gap",
        `${where}: expected sequence ${expectedSequence} — the log has a hole or a reorder`
      );
    if (!isLineageEventType(rec.type))
      return bad("lineage-event-unknown", `${where}: unknown type`);
    const tooBig = opsRefusal((rec.payload as { ops?: unknown } | null)?.ops);
    if (tooBig !== undefined) return bad("lineage-event-invalid", `${where}: ${tooBig}`);
    const parsed = PAYLOAD_SCHEMAS[rec.type].safeParse(rec.payload);
    if (!parsed.success)
      return bad(
        "lineage-event-invalid",
        `${where}: ${parsed.error.issues[0]?.message ?? "payload is malformed"}`
      );
    const p = parsed.data;
    if (p.experienceId !== experienceId)
      return bad("lineage-event-foreign", `${where}: names experience "${p.experienceId}"`);

    if (rec.type === EXPERIENCE_PROMOTED) {
      if (!versions.has(p.versionHash))
        return bad(
          "lineage-promote-unknown",
          `${where}: promotes unknown version ${p.versionHash}`
        );
      promoted = p.versionHash;
      continue;
    }

    const v = p as ComposedPayload | RevertedPayload | BranchedPayload;
    if (versions.has(v.versionHash))
      return bad("lineage-version-duplicate", `${where}: version ${v.versionHash} already exists`);
    if (rec.type === EXPERIENCE_BRANCHED) {
      if (head !== null)
        return bad("lineage-branch-midline", `${where}: only a line's first event`);
    } else if (head === null) {
      if (rec.type !== EXPERIENCE_COMPOSED || v.parents.length !== 0)
        return bad(
          "lineage-genesis-invalid",
          `${where}: a line starts with a parentless composition`
        );
    } else if (v.parents.length !== 1 || v.parents[0] !== head) {
      return bad(
        "lineage-parent-mismatch",
        `${where}: parents ${JSON.stringify(v.parents)} are not the head ${head} it was appended on`
      );
    }
    const base = {
      experienceId,
      versionHash: v.versionHash,
      ref: v.ref,
      parents: v.parents,
      sequence: rec.sequence,
      at: rec.at,
      by: v.by,
    };
    const record: VersionRecord =
      rec.type === EXPERIENCE_COMPOSED
        ? {
            ...base,
            kind: "composed",
            ops: (v as ComposedPayload).ops as RecordedOperation[],
            ...summaryOf((v as ComposedPayload).summary),
          }
        : rec.type === EXPERIENCE_REVERTED
          ? {
              ...base,
              kind: "reverted",
              ops: [],
              revertedTo: (v as RevertedPayload).revertedTo,
            }
          : {
              ...base,
              kind: "branched",
              ops: [],
              from: (v as BranchedPayload).from,
              carriedFrom: (v as BranchedPayload).carriedFrom,
            };
    versions.set(v.versionHash, record);
    order.push(v.versionHash);
    head = v.versionHash;
  }
  return {
    ok: true,
    state: { experienceId, sequence: expectedSequence, versions, order, head, promoted },
  };
}

const summaryOf = (raw: string | undefined): { summary?: string } => {
  const summary = boundSummary(raw);
  return summary === undefined ? {} : { summary };
};
