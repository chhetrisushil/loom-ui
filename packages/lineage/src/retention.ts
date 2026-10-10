import type { LineageState, VersionRecord } from "./state";

// ── Version retention: which versions a line must keep (U17) ──────────────────────────────────
// Every version stores its WHOLE artifact (`putExperience`), so a line grows O(versions x nodes) and,
// because each version's event cites its artifact by a bare content ref, loom's `sweepUnpinnedContent`
// pins every one of them for ever while the lineage's streams are scanned. Retention is the policy
// that says which versions are still wanted; `Lineage.pins` turns it into the root set a collector
// marks, and everything NOT in it stops being pinned by the lineage.
//
// This module is the pure half: a policy over one line's folded state. It never reads a blob.

export interface RetentionPolicy {
  /**
   * Keep the newest N versions of each line, counted in append order and including the head.
   * Default {@link DEFAULT_KEEP_LAST}. The head is ALWAYS kept, whatever this says (`0` keeps only
   * what the other rules keep). `Infinity` keeps every version. Anything else that is not a
   * non-negative integer THROWS: this policy decides what gets deleted, so a typo is never read as
   * "keep nothing".
   */
  readonly keepLast?: number;
  /** Also keep every version authored at or after this instant (ISO-8601, compared as a date). An unparseable value THROWS. */
  readonly keepSince?: string;
  /**
   * Keep the line's first version (default `true`): the genesis anchors `verify`'s replay and is the
   * one version every other is derived from.
   */
  readonly keepGenesis?: boolean;
  /** Keep versions the host names (its own audit pins, a customer's "approved" marks). Unknown hashes are ignored. */
  readonly keep?: (version: VersionRecord) => boolean;
}

export const DEFAULT_KEEP_LAST = 20;

/**
 * Refuse a policy that does not mean what its author meant. A deletion policy must not coerce: NaN,
 * a negative or fractional `keepLast`, an unparseable `keepSince` or a non-boolean/-function rule
 * all throw. `Infinity` is the one non-integer allowed (keep everything).
 */
export function validateRetentionPolicy(policy: RetentionPolicy): void {
  const bad = (m: string): never => {
    throw new RangeError(`RetentionPolicy: ${m}`);
  };
  const { keepLast, keepSince, keepGenesis, keep } = policy;
  if (keepLast !== undefined) {
    if (typeof keepLast !== "number") bad(`keepLast must be a number, got ${typeof keepLast}`);
    else if (
      keepLast !== Number.POSITIVE_INFINITY &&
      !(Number.isSafeInteger(keepLast) && keepLast >= 0)
    )
      bad(
        `keepLast must be a non-negative integer or Infinity (keep all), got ${String(keepLast)}`
      );
  }
  if (keepSince !== undefined) {
    if (typeof keepSince !== "string" || Number.isNaN(Date.parse(keepSince)))
      bad(`keepSince must be a parseable ISO-8601 date string, got ${String(keepSince)}`);
  }
  if (keepGenesis !== undefined && typeof keepGenesis !== "boolean")
    bad("keepGenesis must be a boolean");
  if (keep !== undefined && typeof keep !== "function") bad("keep must be a function");
}

export interface Retained {
  /** Version hashes the policy keeps. */
  readonly keep: ReadonlySet<string>;
  /** Every other version of the line, oldest first: nothing the policy wants still needs its artifact. */
  readonly reclaimable: readonly string[];
}

/**
 * What to keep of one line. Always kept, regardless of the policy: the head, the promoted version (it
 * is what viewers are shown), and every version another line branched from (`branchSources`: a fork is
 * only as sound as its source, and `verify` rebuilds the source up to the fork point). Total: an empty
 * line keeps nothing. Throws on a malformed policy ({@link validateRetentionPolicy}).
 */
export function retainedVersions(
  state: LineageState,
  policy: RetentionPolicy = {},
  branchSources: ReadonlySet<string> = new Set()
): Retained {
  validateRetentionPolicy(policy);
  const keep = new Set<string>();
  const order = state.order;
  if (state.head !== null) keep.add(state.head);
  if (state.promoted !== null) keep.add(state.promoted);
  for (const h of branchSources) if (state.versions.has(h)) keep.add(h);

  const last = policy.keepLast ?? DEFAULT_KEEP_LAST;
  const n = last === Number.POSITIVE_INFINITY ? order.length : last;
  for (let i = Math.max(0, order.length - n); i < order.length; i++) keep.add(order[i] as string);

  if ((policy.keepGenesis ?? true) && order.length > 0) keep.add(order[0] as string);

  const since = policy.keepSince === undefined ? Number.NaN : Date.parse(policy.keepSince);
  for (const h of order) {
    const v = state.versions.get(h) as VersionRecord;
    if (!Number.isNaN(since)) {
      const at = Date.parse(v.at);
      if (!Number.isNaN(at) && at >= since) keep.add(h);
    }
    if (policy.keep?.(v) === true) keep.add(h);
  }
  return { keep, reclaimable: order.filter((h) => !keep.has(h)) };
}
