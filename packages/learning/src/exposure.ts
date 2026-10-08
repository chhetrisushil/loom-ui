// ── Exposure (U11) ────────────────────────────────────────────────────────────
// A signal is client input; "the viewer saw it" is the fact a reward leans on, so it is checked, not
// believed. Two sources, usable together:
//   - the ingestor's own LEDGER of accepted `exposure` signals (client-CLAIMED: it stops an engagement
//     on a node the client never even claimed to show, not a determined forger of both);
//   - an AUTHORITATIVE check the host supplies — `seenLogExposure` over what the server recorded as
//     shown to this viewer (U12 `SeenLog`).

export interface ExposureQuery {
  readonly viewerId: string;
  readonly experienceId: string;
  readonly versionHash: string;
  /** Absent = "the surface as a whole" (feedback / outcome). */
  readonly node?: string;
  /** The node is a restricted placeholder: only the version-level fact is checkable. */
  readonly restricted?: boolean;
}

export interface ExposureCheck {
  saw(q: ExposureQuery): boolean | Promise<boolean>;
}

/** Structural slice of `@loom-ui/lineage`'s `SeenLog` this needs, so the packages stay unlinked. */
export interface SeenLogReader {
  read(input: {
    readonly experienceId: string;
    readonly viewerId: string;
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
  opts: { readonly versionIsEnough?: boolean; readonly limit?: number } = {}
): ExposureCheck {
  const enough = opts.versionIsEnough ?? true;
  return {
    async saw(q) {
      let r: Awaited<ReturnType<SeenLogReader["read"]>>;
      try {
        r = await log.read({
          experienceId: q.experienceId,
          viewerId: q.viewerId,
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
