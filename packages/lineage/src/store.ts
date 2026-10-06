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
  /**
   * OPTIONAL — the newest `limit` records of the line, in sequence order (`[]` for an unknown line).
   * Lets a long-lived per-viewer log answer "what is the tip?" without reading its whole history.
   * Implement it together with {@link readAfter}; absent, callers fall back to `read` (O(log length)).
   */
  readTail?(experienceId: string, limit: number): Promise<readonly StoredLineageRecord[]>;
  /**
   * OPTIONAL — the records with `sequence > afterSequence`, in sequence order, at most `limit` of
   * them (default: all). The retention window of a per-viewer log is read this way, so a read costs
   * the size of the window, not the age of the log.
   */
  readAfter?(
    experienceId: string,
    afterSequence: number,
    limit?: number
  ): Promise<readonly StoredLineageRecord[]>;
  /**
   * OPTIONAL — enumerate the ids of every line this store holds, in bounded pages. A collector
   * (`SeenLog.collectGarbage`) needs it to find every root; a store that omits it cannot be
   * garbage-collected (the collector refuses rather than guess a root set). Ids are exactly what
   * `read` takes. Concurrent creation during a scan may be missed (a maintenance pass, not a snapshot).
   */
  listStreams?(): AsyncIterable<string>;
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

type EventEnvelope = Awaited<ReturnType<EventStore["read"]>>[number];

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

  async readTail(experienceId: string, limit: number): Promise<readonly StoredLineageRecord[]> {
    const line = this.lines.get(experienceId) ?? [];
    return clone(limit >= line.length ? line : line.slice(line.length - Math.max(0, limit)));
  }

  async readAfter(
    experienceId: string,
    afterSequence: number,
    limit = Number.POSITIVE_INFINITY
  ): Promise<readonly StoredLineageRecord[]> {
    // dense 1..n: the records after `a` start at index `a`
    const line = this.lines.get(experienceId) ?? [];
    const from = Math.max(0, afterSequence);
    return clone(line.slice(from, Number.isFinite(limit) ? from + Math.max(0, limit) : undefined));
  }

  async *listStreams(): AsyncGenerator<string, void, void> {
    for (const id of [...this.lines.keys()]) yield id;
  }
}

/** The reserved-stream namespace a lineage's events live under in an `EventStore`. */
export const LINEAGE_STREAM_PREFIX = "__loom_ui_lineage__:";
const WORKFLOW_ID = "loom-ui.lineage";

/** Every stream prefix this package may write under; the kernel's own reserved prefixes are not ours. */
export const LOOM_UI_STREAM_NAMESPACE = "__loom_ui_";
const WORKFLOW_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

/** A `LineageStore` that knows which stream prefix it writes under (see {@link eventStoreLineageStore}). */
export interface PrefixedLineageStore extends LineageStore {
  readonly streamPrefix: string;
}

/**
 * A `LineageStore` over loom's `EventStore`. One stream per experience
 * (`__loom_ui_lineage__:<experienceId>`, a RESERVED stream so enumerators of real executions skip
 * it; see the README for what a reserved stream costs); the lineage sequence IS the envelope sequence, so the CAS is the log's own
 * `(executionId, sequence)` uniqueness. The adapter checks the tip first (a store enforces a
 * taken slot, not a skipped one) and treats a `DuplicateSequenceError` from a racing writer as a
 * lost CAS. Fencing, tenancy and sharding decorators wrap `store` as usual.
 *
 * `streamPrefix` must start with `__loom_ui_` (and say more): it is the namespace this package owns
 * inside loom's reserved `__loom_` space, so a configuration can never write into the kernel's own
 * control streams (`__loom_lifecycle__`, `__loom_erasure__`) or an execution's id space. `workflowId`
 * is a short identifier. A bad value THROWS at construction (a misconfiguration, found at startup).
 */
export function eventStoreLineageStore(
  store: EventStore,
  opts: { readonly streamPrefix?: string; readonly workflowId?: string } = {}
): PrefixedLineageStore {
  const prefix = opts.streamPrefix ?? LINEAGE_STREAM_PREFIX;
  const workflowId = opts.workflowId ?? WORKFLOW_ID;
  if (
    typeof prefix !== "string" ||
    !prefix.startsWith(LOOM_UI_STREAM_NAMESPACE) ||
    prefix.length <= LOOM_UI_STREAM_NAMESPACE.length ||
    prefix.length > 128
  )
    throw new Error(
      `streamPrefix must start with "${LOOM_UI_STREAM_NAMESPACE}" and name its stream (got ${JSON.stringify(String(prefix).slice(0, 40))})`
    );
  if (typeof workflowId !== "string" || !WORKFLOW_ID_SHAPE.test(workflowId))
    throw new Error("workflowId must be 1-128 characters of [A-Za-z0-9._:-]");
  const streamOf = (experienceId: string) => `${prefix}${experienceId}`;
  return {
    streamPrefix: prefix,
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
      return toRecords(await store.read(streamOf(experienceId)));
    },
    async readTail(experienceId, limit) {
      const id = streamOf(experienceId);
      const tip = (await headOf(store, id)) ?? 0;
      if (tip === 0 || limit <= 0) return [];
      return toRecords(await readWindow(store, id, Math.max(1, tip - limit + 1), tip));
    },
    async readAfter(experienceId, afterSequence, limit = Number.POSITIVE_INFINITY) {
      const id = streamOf(experienceId);
      const tip = (await headOf(store, id)) ?? 0;
      const from = Math.max(1, afterSequence + 1);
      const to = Number.isFinite(limit) ? Math.min(tip, from + Math.max(0, limit) - 1) : tip;
      if (to < from) return [];
      return toRecords(await readWindow(store, id, from, to));
    },
    ...(store.listExecutionsPage !== undefined || store.listExecutions !== undefined
      ? {
          async *listStreams(): AsyncGenerator<string, void, void> {
            // Reserved streams ARE surfaced by the SPI's enumeration (`__loom_*`), so ours are found
            // by prefix. Pages are keyset-ordered by code point, so with pages the scan starts just
            // before our prefix and stops once past it; the unpaged fallback filters the full list.
            if (store.listExecutionsPage === undefined) {
              for (const id of (await store.listExecutions?.()) ?? [])
                if (id.startsWith(prefix)) yield id.slice(prefix.length);
              return;
            }
            let cursor: string | undefined = prefix.slice(0, -1);
            for (;;) {
              const page: { executionIds: string[]; nextCursor?: string } =
                await store.listExecutionsPage({
                  ...(cursor !== undefined && { cursor }),
                  limit: 500,
                });
              for (const id of page.executionIds) {
                if (id.startsWith(prefix)) yield id.slice(prefix.length);
                else if (id > prefix) return;
              }
              if (page.nextCursor === undefined || page.nextCursor === cursor) return;
              cursor = page.nextCursor;
            }
          },
        }
      : {}),
  };
}

function toRecords(events: readonly EventEnvelope[]): StoredLineageRecord[] {
  return events
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((e) => ({
      sequence: e.sequence,
      type: e.eventType,
      payload: clone(e.payload),
      at: typeof e.metadata?.at === "string" ? e.metadata.at : new Date(e.timestamp).toISOString(),
    }));
}

/** Sequences `from..to` (inclusive) of a stream: the store's `readRange`, else `readFrom`/`read` filtered. */
async function readWindow(
  store: EventStore,
  id: string,
  from: number,
  to: number
): Promise<EventEnvelope[]> {
  if (store.readRange !== undefined) return store.readRange(id, from, to);
  return (await store.read(id)).filter((e) => e.sequence >= from && e.sequence <= to);
}
