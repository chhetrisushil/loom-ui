import type { ContractRegistry, ProviderSpec } from "@loom-ui/core";
import { canonicalJson, fnv1a64 } from "@loom/core";
import type { LoadParams } from "./params";

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

/**
 * What else, besides the spec, decides a cached answer.
 *
 * `params` are the load's params AS DECLARED — relative-time tokens (`$now-7d`) UNRESOLVED. That
 * is deliberate: resolving first would give every load a fresh instant and so a fresh key, and the
 * cache would never hit. `$now-7d` is therefore one key for the entry's TTL; freshness comes from
 * `cachePolicy.ttlSeconds`, and a provider whose answer must track the clock more closely than
 * that sets a shorter TTL (or 0, never cached).
 *
 * `kinds` are the kinds a `"contract"` value was checked against. They are keyed ONLY for a spec
 * whose `outputCheck` is `"contract"`, sorted and de-duplicated (`normaliseKinds`). A value that
 * passed for `[Kpi]` was never checked against `MetricCard` — serving it for `[Kpi, MetricCard]`
 * would publish a value no check ever cleared for the kind now reading it. A shape-mode key
 * ignores `kinds` entirely.
 */
export interface CacheVariant {
  readonly params?: LoadParams;
  readonly kinds?: readonly string[];
  /**
   * The host's value contracts. The `version` of each BOUND kind's contract (only those that
   * declare one) is folded into the key, so a changed contract is a different question. A contract
   * with no `version` adds nothing — such a host calls `invalidate()` after changing it.
   */
  readonly contracts?: ContractRegistry;
}

/** `{kind: version}` for the bound kinds whose contract declares a version; `undefined` if none. */
function contractVersions(
  kinds: readonly string[],
  contracts: ContractRegistry | undefined
): Record<string, string> | undefined {
  if (contracts === undefined) return undefined;
  let out: Record<string, string> | undefined;
  for (const k of kinds) {
    if (!Object.hasOwn(contracts, k)) continue;
    const v = contracts[k]?.version;
    if (typeof v !== "string") continue;
    // Null-prototype-safe: a kind named `__proto__` must not set a prototype.
    out ??= Object.create(null) as Record<string, string>;
    out[k] = v;
  }
  return out;
}

/**
 * The one normal form of a kinds list — sorted, de-duplicated. The cache key and the controller's
 * load fingerprint both use it, so they can never disagree about whether two kinds lists are the
 * same question.
 */
export function normaliseKinds(kinds: readonly string[]): string[] {
  return [...new Set(kinds)].sort();
}

/** `""` for the plain variant; `undefined` for one that cannot be keyed (never cached). */
function variantKey(
  params: LoadParams,
  kinds: readonly string[],
  versions: Record<string, string> | undefined
): string | undefined {
  if (Object.keys(params).length === 0 && kinds.length === 0) return "";
  try {
    // `versions` is added ONLY when present, so every key without one is what it always was.
    return fnv1a64(
      canonicalJson(versions === undefined ? { params, kinds } : { params, kinds, versions })
    );
  } catch {
    return undefined;
  }
}

export class HydrationCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  constructor(private readonly clock: () => number = Date.now) {}

  private key(
    spec: ProviderSpec,
    principalId: string | undefined,
    variant: CacheVariant
  ): string | undefined {
    const kinds = spec.outputCheck === "contract" ? normaliseKinds(variant.kinds ?? []) : [];
    const v = variantKey(variant.params ?? {}, kinds, contractVersions(kinds, variant.contracts));
    if (v === undefined) return undefined;
    const fp = specFingerprint(spec);
    // The handle stays LAST: `invalidate(handle)` suffix-matches it across every variant.
    if (spec.cachePolicy.scope === "global") return `g${SEP}${fp}${SEP}${v}${SEP}${spec.handle}`;
    return principalId === undefined
      ? undefined
      : `p${SEP}${principalId}${SEP}${fp}${SEP}${v}${SEP}${spec.handle}`;
  }

  get(
    spec: ProviderSpec,
    principalId: string | undefined,
    variant: CacheVariant = {}
  ): { value: unknown } | undefined {
    const k = this.key(spec, principalId, variant);
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
    variant: CacheVariant = {}
  ): void {
    const k = this.key(spec, principalId, variant);
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
