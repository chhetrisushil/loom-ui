import type { ProviderSpec } from "@loom-ui/core";

// ── Result cache ──────────────────────────────────────────────────────────────
// `scope: "global"` shares one entry per handle; `scope: "principal"` keys on (principal, handle)
// and refuses to cache when no principal is known — a per-viewer result must never leak to the
// next viewer. TTL is against an injected clock so tests never sleep.

// NUL: cannot appear in a handle, so `invalidate(handle)`'s suffix match can never mis-hit
// another handle whose name happens to contain the delimiter (e.g. a handle literally named "h").
const SEP = String.fromCharCode(0);

export class HydrationCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  constructor(private readonly clock: () => number = Date.now) {}

  private key(spec: ProviderSpec, principalId: string | undefined): string | undefined {
    if (spec.cachePolicy.scope === "global") return `g${SEP}${spec.handle}`;
    return principalId === undefined ? undefined : `p${SEP}${principalId}${SEP}${spec.handle}`;
  }

  get(spec: ProviderSpec, principalId: string | undefined): { value: unknown } | undefined {
    const k = this.key(spec, principalId);
    if (k === undefined) return undefined;
    const e = this.entries.get(k);
    if (!e) return undefined;
    if (e.expiresAt <= this.clock()) {
      this.entries.delete(k);
      return undefined;
    }
    return { value: e.value };
  }

  set(spec: ProviderSpec, principalId: string | undefined, value: unknown): void {
    const k = this.key(spec, principalId);
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
