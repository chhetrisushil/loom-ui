import type { SeenLog, SeenRefusal } from "./seen";

// ── Reclaiming the value blobs of the record of what a viewer saw (U12) ──────────────────────
// MARK-AND-SWEEP, not a refcount. There is no transaction across the event log and the ContentStore,
// so a counter drifts, and a crash between "append the manifest" and "increment" would delete a live
// value. The roots are re-derived from the logs on every pass, so nothing here can drift:
//
//   MARK   every content address cited by (a) every line of the lineage (artifacts, op payloads,
//          anything stored as a ref in an event) and (b) every DECRYPTABLE ref of every viewer's
//          retention window; plus whatever the host's `extraRoots` names. Erased viewers and
//          rolled-off views are unreadable or out of window, so they mark nothing.
//   SWEEP  every blob the store lists that is not marked, deleted with the store's own conditional
//          `deleteIfUntouchedSince` so a blob that is touched (a put, including a dedup'd re-put)
//          after the cutoff is never deleted, in one atomic step.
//
// SAFETY WINDOW. `cutoff = store.touchClock() at mark start - graceMs`. A blob touched at or after the
// cutoff is kept: that covers a blob written during the pass AND one younger than `graceMs`, i.e. a
// value whose manifest is not appended yet. `graceMs` MUST exceed the longest a `record()` (or a
// lineage commit) can take between putting a blob and appending the event that cites it; a crash in
// that gap leaks the blob only until the first pass past its grace, and never loses a cited value.
// The pass is idempotent and safe to rerun (or to crash in the middle of).
//
// FAIL CLOSED. Anything the collector cannot establish aborts BEFORE any delete: a store that cannot
// enumerate its streams, a key-store failure, a ContentStore without the SPI 1.3.0 set
// (`listPage` + `deleteIfUntouchedSince` + `touchClock`), a root set over `maxMarked`.
//
// MEMORY. The marked set holds one address string per distinct live blob (O(live blobs); `maxMarked`
// refuses rather than grow past it). Streams are read one at a time; the sweep pages by `pageSize`.

export interface SeenGcOptions {
  /** Blobs touched within this many ms before the pass began are never swept. MUST exceed one `record()`'s duration. */
  readonly graceMs: number;
  /**
   * You assert EVERY blob in the log's ContentStore is either rooted by the lineage / the seen logs
   * or named by `extraRoots`. The collector deletes what it cannot find a root for: pointing it at a
   * store that also holds anything else would destroy that data. A literal `true`, so it is a decision.
   */
  readonly ownsContentStore: true;
  /** Addresses this collector cannot see but must keep (other users of the same ContentStore). */
  readonly extraRoots?: () => AsyncIterable<string> | Iterable<string>;
  /** Refuse (before deleting anything) if more than this many distinct addresses are live. Default 5,000,000. */
  readonly maxMarked?: number;
  /** Blobs per `listPage`. Default 500. */
  readonly pageSize?: number;
}

export interface SeenGcReport {
  /** Distinct live addresses found. */
  readonly marked: number;
  /** Blobs older than the cutoff that were examined. */
  readonly scanned: number;
  /** Blobs deleted. */
  readonly deleted: number;
  /** Unrooted blobs spared because they were touched at or after the cutoff (in grace). */
  readonly spared: number;
  readonly cutoffMs: number;
}

export type SeenGcResult =
  | { readonly ok: true; readonly report: SeenGcReport }
  | { readonly ok: false; readonly refusal: SeenRefusal };

const no = (code: string, message: string): SeenGcResult => ({
  ok: false,
  refusal: { code, message },
});

/** Run one collection pass over `log`'s content store. See the header for the contract. */
export async function collectSeenGarbage(log: SeenLog, opts: SeenGcOptions): Promise<SeenGcResult> {
  if (opts?.ownsContentStore !== true)
    return no(
      "gc-ownership-unasserted",
      "ownsContentStore: true is required: the sweep deletes unrooted blobs"
    );
  if (!Number.isFinite(opts.graceMs) || opts.graceMs < 0)
    return no("gc-grace-invalid", "graceMs must be a non-negative number of milliseconds");
  const maxMarked = opts.maxMarked ?? 5_000_000;
  const pageSize = opts.pageSize ?? 500;
  if (
    !Number.isSafeInteger(maxMarked) ||
    maxMarked < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1
  )
    return no("gc-options-invalid", "maxMarked and pageSize must be positive integers");
  const content = log.contentStore;
  if (
    content.listPage === undefined ||
    content.deleteIfUntouchedSince === undefined ||
    content.touchClock === undefined
  )
    return no(
      "gc-content-store-unsupported",
      "the ContentStore must implement listPage, deleteIfUntouchedSince and touchClock (SPI 1.3.0): without a touch time a young blob cannot be told from an orphan"
    );

  const marked = new Set<string>();
  const visit = (address: string) => {
    marked.add(address);
    if (marked.size > maxMarked) throw new Error("maxMarked exceeded");
  };
  let cutoffMs: number;
  try {
    // The clock is read BEFORE marking: anything touched after this instant is spared, so a blob
    // written while we mark (whose manifest we may have read too early to see) survives.
    cutoffMs = (await content.touchClock()) - opts.graceMs;
    await log.lineageOf.forEachContentRef(visit);
    await log.forEachLiveRef(visit);
    if (opts.extraRoots !== undefined) for await (const a of opts.extraRoots()) visit(a);
  } catch (err) {
    return no(
      "gc-roots-unavailable",
      `the root set could not be established (nothing was deleted): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let scanned = 0;
  let deleted = 0;
  let spared = 0;
  try {
    let cursor: string | undefined;
    for (;;) {
      const page = await content.listPage({
        ...(cursor !== undefined && { cursor }),
        limit: pageSize,
      });
      for (const entry of page.entries) {
        if (marked.has(entry.address)) continue;
        // 0 = unknown touch time (never orphan-eligible); at/after the cutoff = young or just touched
        if (entry.touchedAt === 0 || !(entry.touchedAt < cutoffMs)) {
          spared += 1;
          continue;
        }
        scanned += 1;
        if (await content.deleteIfUntouchedSince({ __loomContent: entry.address }, cutoffMs))
          deleted += 1;
        else spared += 1; // touched between the listing and the delete
      }
      if (page.nextCursor === undefined || page.nextCursor === cursor) break;
      cursor = page.nextCursor;
    }
  } catch (err) {
    return no(
      "gc-sweep-interrupted",
      `the sweep stopped after deleting ${deleted} blobs (safe to rerun): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return { ok: true, report: { marked: marked.size, scanned, deleted, spared, cutoffMs } };
}
