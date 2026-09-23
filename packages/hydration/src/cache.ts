import type { ProviderSpec } from "@loom-ui/core";
import { canonicalJson, fnv1a64 } from "@loom/core";

// ── Result cache ──────────────────────────────────────────────────────────────
// `scope: "global"` shares one entry per handle; `scope: "principal"` keys on (principal, handle)
// and refuses to cache when no principal is known — a per-viewer result must never leak to the
// next viewer. TTL is against an injected clock so tests never sleep.
//
// The key also carries the SPEC's fingerprint: a handle whose provider was repaired (a remapped
// schema pin, a different tool, a new reshaping) is a different question, and must not be
// answered from the entry the old spec left behind. `invalidate(handle)` still drops every
// spec-generation of that handle, so the fingerprint never makes a stale entry unreachable.

// NUL: cannot appear in a handle, so `invalidate(handle)`'s suffix match can never mis-hit
// another handle whose name happens to contain the delimiter (e.g. a handle literally named "h").
const SEP = String.fromCharCode(0);

// Memoized per spec OBJECT: the controller fingerprints the same spec on every `schedule`, and
// `canonicalJson` walks the whole graph. A WeakMap keeps that O(1) without pinning specs alive.
const fingerprints = new WeakMap<ProviderSpec, string>();
let unhashable = 0;

/**
 * The content fingerprint of a provider spec — the identity both the cache key and the
 * controller's "have I already loaded THIS spec?" check are taken over, so the two can never
 * disagree about what "the same provider" means.
 *
 * Total: `canonicalJson` throws on a spec carrying a non-finite number, a bigint or a nest past
 * its depth cap. Such a spec gets a fingerprint unique to the OBJECT, which is conservative in
 * both directions — the same object is still recognised as itself (no reload storm), and two
 * structurally identical unhashable specs are treated as different (no cache hit).
 */
export function specFingerprint(spec: ProviderSpec): string {
  const memo = fingerprints.get(spec);
  if (memo !== undefined) return memo;
  let fp: string;
  try {
    fp = fnv1a64(canonicalJson(spec));
  } catch {
    unhashable += 1;
    fp = `unhashable-${unhashable}`;
  }
  fingerprints.set(spec, fp);
  return fp;
}

export class HydrationCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  constructor(private readonly clock: () => number = Date.now) {}

  /**
   * `outputCheck: "contract"` only: the sorted, deduplicated kinds a value was checked against
   * are part of the key. A value that passed for `[Kpi]` was never checked against `MetricCard`
   * — serving it for `[Kpi, MetricCard]` (a recompose that binds a second widget to the same
   * handle, or a second surface with different resolved kinds sharing this cache) would publish
   * a value no check ever cleared for the kind now reading it. Shape-mode keys are unaffected:
   * `kinds` is not even read unless the spec checks by contract.
   */
  private key(
    spec: ProviderSpec,
    principalId: string | undefined,
    kinds: readonly string[] | undefined
  ): string | undefined {
    const fp = specFingerprint(spec);
    const kindsPart =
      spec.outputCheck === "contract"
        ? `${SEP}k:${[...new Set(kinds ?? [])].sort().join(",")}`
        : "";
    if (spec.cachePolicy.scope === "global") return `g${SEP}${fp}${kindsPart}${SEP}${spec.handle}`;
    return principalId === undefined
      ? undefined
      : `p${SEP}${principalId}${SEP}${fp}${kindsPart}${SEP}${spec.handle}`;
  }

  get(
    spec: ProviderSpec,
    principalId: string | undefined,
    kinds?: readonly string[]
  ): { value: unknown } | undefined {
    const k = this.key(spec, principalId, kinds);
    if (k === undefined) return undefined;
    const e = this.entries.get(k);
    if (!e) return undefined;
    if (e.expiresAt <= this.clock()) {
      this.entries.delete(k);
      return undefined;
    }
    return { value: e.value };
  }

  set(
    spec: ProviderSpec,
    principalId: string | undefined,
    value: unknown,
    kinds?: readonly string[]
  ): void {
    const k = this.key(spec, principalId, kinds);
    if (k === undefined || spec.cachePolicy.ttlSeconds <= 0) return;
    this.entries.set(k, { value, expiresAt: this.clock() + spec.cachePolicy.ttlSeconds * 1000 });
  }

  invalidate(handle?: string): void {
    if (handle === undefined) {
      this.entries.clear();
      return;
    }
    for (const k of [...this.entries.keys()]) if (k.endsWith(SEP + handle)) this.entries.delete(k);
  }
}
