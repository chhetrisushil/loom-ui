import type { ProvenanceLedger } from "@loom-ui/core";

// ── Decision linkage (U11) ────────────────────────────────────────────────────
// A reward is attributed to a loom DECISION of a loom EXECUTION. The surface a viewer saw is a
// VERSION of an Experience; the host knows which decision(s) produced it (the planner turn's
// `PlanReport.variant.decisionId`, stamped on the ops as `Provenance.policyDecisionId`) and which
// execution ran that turn. `DecisionLink` is that knowledge, registered per (experience, version).

/** One learnable decision of one execution. */
export interface DecisionRef {
  readonly executionId: string;
  readonly decisionId: string;
}

export interface DecisionLink {
  /** Decisions that shaped this version as a whole. A version-level signal credits each. */
  readonly decisions: readonly DecisionRef[];
  /**
   * Node id → the decision that wrote it (`linkFromLedger`). When present, a signal naming a node it
   * does not list is refused (`unknown-node`), and a node signal credits that one decision. Absent =
   * every node signal credits `decisions`.
   */
  readonly nodes?: Readonly<Record<string, DecisionRef>>;
  /**
   * The tenant this surface belongs to. A viewer of another tenant gets `unknown-view` (the same
   * answer as for a version nobody registered, so it is not an oracle). Absent = single-tenant.
   */
  readonly tenant?: string;
}

/** Where the ingestor looks a view up. Return `undefined` for a view the host does not know. */
export interface DecisionLinkResolver {
  resolve(experienceId: string, versionHash: string): DecisionLink | undefined;
}

/**
 * A bounded in-memory registry (least-recently-registered out). An evicted view simply stops
 * attributing: its signals are refused as `unknown-view`, never guessed.
 */
export class DecisionLinks implements DecisionLinkResolver {
  private readonly map = new Map<string, DecisionLink>();
  constructor(private readonly max = 10_000) {}
  private static key(experienceId: string, versionHash: string): string {
    return `${experienceId}\u0000${versionHash}`;
  }
  register(experienceId: string, versionHash: string, link: DecisionLink): void {
    const k = DecisionLinks.key(experienceId, versionHash);
    this.map.delete(k);
    this.map.set(k, link);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  resolve(experienceId: string, versionHash: string): DecisionLink | undefined {
    return this.map.get(DecisionLinks.key(experienceId, versionHash));
  }
  get size(): number {
    return this.map.size;
  }
}

export interface LinkFromLedgerOptions {
  /** Which execution ran the planner turn that made `decisionId`. Return `undefined` if unknown. */
  readonly executionOf: (decisionId: string) => string | undefined;
  readonly tenant?: string;
  /** Node ids to keep (e.g. the nodes of the version). Default: every node the ledger knows. */
  readonly only?: ReadonlySet<string>;
}

/**
 * Build a {@link DecisionLink} from the provenance ledger of a version (U12): each node maps to the
 * decision of the op that last changed it (else created it) — `Provenance.policyDecisionId`, which
 * `plannerProvenance` stamps. A node with no stamped decision (a human edit, an application op) is
 * simply absent from `nodes` — it earns no planner reward. Linear in the ledger.
 */
export function linkFromLedger(
  ledger: ProvenanceLedger,
  opts: LinkFromLedgerOptions
): DecisionLink {
  const nodes: Record<string, DecisionRef> = Object.create(null);
  const all = new Map<string, DecisionRef>();
  for (const [id, nl] of ledger.nodes) {
    if (opts.only !== undefined && !opts.only.has(id)) continue;
    const decisionId = (nl.changed ?? nl.created)?.by.policyDecisionId;
    if (decisionId === undefined) continue;
    const executionId = opts.executionOf(decisionId);
    if (executionId === undefined) continue;
    const ref = { executionId, decisionId };
    nodes[id] = ref;
    all.set(`${executionId}\u0000${decisionId}`, ref);
  }
  return {
    decisions: [...all.values()],
    nodes,
    ...(opts.tenant !== undefined && { tenant: opts.tenant }),
  };
}
