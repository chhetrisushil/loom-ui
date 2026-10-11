import type { Audience } from "@loom-ui/core";

// ── Exposure (U11) ────────────────────────────────────────────────────────────
// A signal is client input; "the viewer saw it" is the fact a reward leans on, so it is checked, not
// believed. `SignalIngestor` REQUIRES a policy:
//   - an AUTHORITATIVE check the host supplies — `seenLogExposure` over what the server recorded as
//     shown to this viewer (U12 `SeenLog`). Prefer `{ versionIsEnough: false }` wherever nodes are
//     data-bound: with the default a recorded view of the VERSION vouches for every node in it;
//   - or the explicit `"client-claimed"` opt-out (demos, tests): the vote fold then credits an
//     engagement only after the same viewer's own claimed exposure of that node, which stops a
//     signal for a node the client never claimed to show and nothing more.

export interface ExposureQuery {
  readonly viewerId: string;
  /** The viewer's tenant: the same `viewerId` in two tenants is two viewers. */
  readonly tenant: string;
  readonly experienceId: string;
  readonly versionHash: string;
  /** Absent = "the surface as a whole" (feedback / outcome). */
  readonly node?: string;
  /** The node is a restricted placeholder: only the version-level fact is checkable. */
  readonly restricted?: boolean;
  /** The audience of the surface the signal came from: `"broadcast"` = judged on what a no-clearance viewer was shown. */
  readonly audience?: Audience;
}

export interface ExposureCheck {
  saw(q: ExposureQuery): boolean | Promise<boolean>;
}

/** Structural slice of `@loom-ui/lineage`'s `SeenLog` this needs, so the packages stay unlinked. */
export interface SeenLogReader {
  read(input: {
    readonly experienceId: string;
    readonly viewerId: string;
    /** Passed through; the real `SeenLog` is keyed by `viewerId` alone (see `seenLogExposure`). */
    readonly tenant?: string;
    /** Forwarded from the query: a broadcast read sees only what a no-clearance viewer was shown. */
    readonly audience?: Audience;
    readonly limit?: number;
  }): Promise<
    | {
        readonly ok: true;
        readonly value: {
          readonly views: readonly {
            readonly versionHash: string;
            readonly entries: readonly { readonly nodeIds: readonly string[] }[];
          }[];
          readonly erased: boolean;
        };
      }
    | { readonly ok: false; readonly refusal: { readonly code: string } }
  >;
}

/**
 * The authoritative check over a `SeenLog`: the viewer saw `versionHash` when the server recorded a
 * view of that exact version for them. A NODE query is satisfied when a recorded entry names the
 * node (a data-bound node), or — `versionIsEnough` (default true) — when the version was viewed at
 * all, since a static node leaves no entry of its own. An erased viewer, an unreadable log or a
 * refusal answers NO: fail-closed.
 */
export function seenLogExposure(
  log: SeenLogReader,
  opts: {
    readonly versionIsEnough?: boolean;
    readonly limit?: number;
    /**
     * The `SeenLog` viewer id for a (tenant, viewer). The `SeenLog` has no tenant of its own, so it
     * MUST be tenant-keyed: either one `SeenLog` per tenant, or record views under the id this
     * returns (default: the bare viewer id, fine only for globally unique ids).
     */
    readonly viewerIdOf?: (q: { readonly tenant: string; readonly viewerId: string }) => string;
  } = {}
): ExposureCheck {
  const enough = opts.versionIsEnough ?? true;
  return {
    async saw(q) {
      let r: Awaited<ReturnType<SeenLogReader["read"]>>;
      try {
        r = await log.read({
          experienceId: q.experienceId,
          viewerId: opts.viewerIdOf?.(q) ?? q.viewerId,
          tenant: q.tenant,
          ...(q.audience !== undefined && { audience: q.audience }),
          limit: opts.limit ?? 50,
        });
      } catch {
        return false;
      }
      if (!r.ok || r.value.erased) return false;
      const views = r.value.views.filter((v) => v.versionHash === q.versionHash);
      if (views.length === 0) return false;
      if (q.node === undefined || q.restricted === true || enough) return true;
      return views.some((v) => v.entries.some((e) => e.nodeIds.includes(q.node as string)));
    },
  };
}

/** Both must agree (a forged claim is not rescued by a lenient source). */
export const allOf = (...checks: readonly ExposureCheck[]): ExposureCheck => ({
  async saw(q) {
    for (const c of checks) if (!(await c.saw(q))) return false;
    return true;
  },
});
