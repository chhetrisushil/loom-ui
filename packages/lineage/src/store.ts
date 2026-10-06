import {
  DuplicateEnvelopeIdError,
  DuplicateSequenceError,
  type EventStore,
  headOf,
} from "@loom/event-runtime";

// ── The store seam ────────────────────────────────────────────────────────────
// What a lineage needs from storage is exactly one thing loom's event log already is: an
// append-only, per-stream, SEQUENCED log whose append refuses a taken slot. The compare-and-set
// is the sequence: "append as event n+1 iff the tip is n". `LineageStore` is that, narrowed to
// what a lineage uses, so a backend that is not an `EventStore` (a table, a KV with a conditional
// put) can serve it, and `eventStoreLineageStore` adapts the loom SPI that is.

export interface LineageRecord {
  readonly type: string;
  readonly payload: unknown;
  /** ISO-8601 time the event was recorded. */
  readonly at: string;
}

export interface StoredLineageRecord extends LineageRecord {
  /** 1-based position in this line. Dense: 1..n with no gaps. */
  readonly sequence: number;
}

export type AppendOutcome =
  | { readonly ok: true; readonly sequence: number }
  /** The tip was not `expectedSequence`; `tip` is what it is now. Nothing was written. */
  | { readonly ok: false; readonly tip: number };

export interface LineageStore {
  /**
   * Append `record` as sequence `expectedSequence + 1` iff the line's tip is EXACTLY
   * `expectedSequence` (0 = the line is empty). Atomic: of N concurrent appends at the same
   * `expectedSequence` exactly one wins and the rest get `{ ok: false }`. NEVER overwrites,
   * never skips a sequence, and a refusal is a returned outcome, not a throw (a throw is an
   * infrastructure failure and leaves the line untouched).
   */
  append(
    experienceId: string,
    expectedSequence: number,
    record: LineageRecord
  ): Promise<AppendOutcome>;
  /** Every record of the line in sequence order; `[]` for an unknown line. The caller owns the result. */
  read(experienceId: string): Promise<readonly StoredLineageRecord[]>;
}

/**
 * A lost slot, by class OR name (a store decorator or a second copy of the package throws an error
 * that is not `instanceof` ours); mirrors the kernel's `isWriteConflict`.
 */
function isWriteConflict(err: unknown): boolean {
  if (err instanceof DuplicateSequenceError || err instanceof DuplicateEnvelopeIdError) return true;
  const name = (err as { name?: unknown } | null)?.name;
  return name === "DuplicateSequenceError" || name === "DuplicateEnvelopeIdError";
}

const clone = <T>(v: T): T => structuredClone(v);

/** Reference in-memory store. Copies on the way in and out, so no caller can mutate the log. */
export class InMemoryLineageStore implements LineageStore {
  private readonly lines = new Map<string, StoredLineageRecord[]>();

  async append(
    experienceId: string,
    expectedSequence: number,
    record: LineageRecord
  ): Promise<AppendOutcome> {
    const line = this.lines.get(experienceId) ?? [];
    if (line.length !== expectedSequence) return { ok: false, tip: line.length };
    const sequence = line.length + 1;
    line.push(clone({ ...record, sequence }));
    this.lines.set(experienceId, line);
    return { ok: true, sequence };
  }

  async read(experienceId: string): Promise<readonly StoredLineageRecord[]> {
    return clone(this.lines.get(experienceId) ?? []);
  }
}

/** The reserved-stream namespace a lineage's events live under in an `EventStore`. */
export const LINEAGE_STREAM_PREFIX = "__loom_ui_lineage__:";
const WORKFLOW_ID = "loom-ui.lineage";

/**
 * A `LineageStore` over loom's `EventStore`. One stream per experience
 * (`__loom_ui_lineage__:<experienceId>`, a RESERVED stream so enumerators of real executions skip
 * it; see the README for what a reserved stream costs); the lineage sequence IS the envelope sequence, so the CAS is the log's own
 * `(executionId, sequence)` uniqueness. The adapter checks the tip first (a store enforces a
 * taken slot, not a skipped one) and treats a `DuplicateSequenceError` from a racing writer as a
 * lost CAS. Fencing, tenancy and sharding decorators wrap `store` as usual.
 */
export function eventStoreLineageStore(
  store: EventStore,
  opts: { readonly streamPrefix?: string; readonly workflowId?: string } = {}
): LineageStore {
  const prefix = opts.streamPrefix ?? LINEAGE_STREAM_PREFIX;
  const workflowId = opts.workflowId ?? WORKFLOW_ID;
  const streamOf = (experienceId: string) => `${prefix}${experienceId}`;
  return {
    async append(experienceId, expectedSequence, record) {
      const executionId = streamOf(experienceId);
      const tip = (await headOf(store, executionId)) ?? 0;
      if (tip !== expectedSequence) return { ok: false, tip };
      const sequence = expectedSequence + 1;
      try {
        await store.append({
          id: `${executionId}#${sequence}`,
          workflowId,
          executionId,
          eventType: record.type,
          sequence,
          timestamp: Date.parse(record.at) || 0,
          payload: clone(record.payload),
          metadata: { at: record.at },
        });
      } catch (err) {
        if (isWriteConflict(err))
          return { ok: false, tip: (await headOf(store, executionId)) ?? sequence };
        throw err;
      }
      return { ok: true, sequence };
    },
    async read(experienceId) {
      const events = await store.read(streamOf(experienceId));
      return events
        .slice()
        .sort((a, b) => a.sequence - b.sequence)
        .map((e) => ({
          sequence: e.sequence,
          type: e.eventType,
          payload: clone(e.payload),
          at:
            typeof e.metadata?.at === "string"
              ? e.metadata.at
              : new Date(e.timestamp).toISOString(),
        }));
    },
  };
}
