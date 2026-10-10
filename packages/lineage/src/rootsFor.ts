import type { Lineage, PinsExtra } from "./lineage";
import { type RetentionPolicy, validateRetentionPolicy } from "./retention";
import type { SeenLog } from "./seen";
import { collectSeenRoots } from "./seenGc";

// ── The complete root set for a shared ContentStore (U17) ─────────────────────────────────────
// Loom's `sweepUnpinnedContent({ roots, completeScan: true })` erases every blob no root names, so
// `roots` must come from EVERY user of the store. Passing ONE lineage's `pins()` silently loses every
// other lineage's artifacts; this is the one place that composes them.

export interface RootsForOptions {
  /** EVERY lineage sharing the content store, each with the retention policy that decides what it keeps. */
  readonly lineages: ReadonlyArray<{
    readonly lineage: Lineage;
    readonly policy?: RetentionPolicy;
  }>;
  /**
   * EVERY seen log sharing the store. Each one's live sealed value blobs are rooted, and the versions
   * its views still read are kept by the lineage it was built over (`log.lineageOf`), which MUST be
   * one of `lineages` (THROWS otherwise: its versions would have no policy to be kept under).
   */
  readonly seenLogs?: readonly SeenLog[];
  /** Passed to each `collectSeenRoots`: sweep what an unreadable live window cites instead of refusing. Default: refuse. */
  readonly allowUnreadable?: boolean;
  /** Other users of the store (app tables, anything loom's own scan does not see). */
  readonly extra?: AsyncIterable<string> | Iterable<string>;
}

type VersionRef = { readonly experienceId: string; readonly versionHash: string };

/**
 * One async iterable of every address to keep: each lineage's `pins(policy)` (with the versions the
 * seen logs over THAT lineage still read), each seen log's sealed value blobs, and `extra`; deduplicated.
 *
 * FAIL CLOSED: policies and wiring are validated before anything is read, and the whole set is
 * established BEFORE the first address is yielded, so any source throwing makes the iterator throw
 * without yielding a partial set (loom consumes roots fully before it erases; this holds for any
 * consumer). Memory is one string per distinct live address.
 *
 *   roots: () => rootsFor({ lineages: [{ lineage: a, policy }, { lineage: b }], seenLogs: [log] })
 */
export async function* rootsFor(opts: RootsForOptions): AsyncGenerator<string, void, undefined> {
  const entries = [...opts.lineages];
  const seen = new Set<Lineage>();
  for (const e of entries) {
    validateRetentionPolicy(e.policy ?? {});
    if (seen.has(e.lineage))
      throw new Error("rootsFor: the same Lineage is listed twice (give it one policy)");
    seen.add(e.lineage);
  }
  for (const log of opts.seenLogs ?? [])
    if (!seen.has(log.lineageOf))
      throw new Error(
        "rootsFor: a seen log is built over a Lineage that is not in `lineages`; list it, or its versions have no policy to be kept under"
      );

  const addresses = new Set<string>();
  const versionsOf = new Map<Lineage, VersionRef[]>();
  for (const log of opts.seenLogs ?? []) {
    const r = await collectSeenRoots(log, {
      ...(opts.allowUnreadable !== undefined && { allowUnreadable: opts.allowUnreadable }),
    });
    for await (const a of r.keepAddresses) addresses.add(a);
    const list = versionsOf.get(log.lineageOf) ?? [];
    list.push(...r.keepVersions);
    versionsOf.set(log.lineageOf, list);
  }
  for (const { lineage, policy } of entries) {
    const extra: PinsExtra = { keepVersions: versionsOf.get(lineage) ?? [] };
    for await (const a of lineage.pins(policy ?? {}, extra)) addresses.add(a);
  }
  if (opts.extra !== undefined) for await (const a of opts.extra) addresses.add(a);

  for (const a of addresses) yield a;
}
