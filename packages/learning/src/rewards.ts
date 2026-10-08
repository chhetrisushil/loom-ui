import { attachOutcomes } from "@loom/analytics";
import type { VoteLedger, VoteSummary } from "./ledger";
import type { DecisionRef } from "./links";

// ── Rewards (U11) ─────────────────────────────────────────────────────────────
// A reward function turns what a decision's surface earned — one bounded vote per viewer, pooled —
// into ONE score in [0, 1]. The score is recorded on the decision through loom's
// `runtime.recordOutcome` (ADR 0116), LATE, once, at a host-declared close, under the key
// `ui:<rewardId>:<closeId>:<specHash>`.
//
// ONE SETTLEMENT PER DECISION. The kernel refuses a changed score for the same `(decisionId, key)`,
// and `trajectories` AVERAGES a decision's outcomes with equal weight — so recording many partial
// windows would let a 1-viewer window weigh the same as a 10 000-viewer one. Instead the ledger is
// frozen at the close (a CLAIM in its log; see ledger.ts) and the pooled score is recorded once. A
// different reward function, close id or ledger spec records under a new key and cannot reuse an old
// number — but a decision with SEVERAL such keys is averaged by `trajectories`, so give each decision
// one `rewardId`/`closeId` for its life (and `evaluateVariants` filters to one `rewardId`).
//
// `recordOutcome` is TERMINAL-ONLY (ADR 0116): a planner turn whose execution is still running
// cannot be rewarded. Run learning-relevant planner turns in SHORT executions (plan, record, finish)
// rather than inside a long-lived agent loop, or the settlement waits until it ends.

export type RewardFunction = (summary: VoteSummary) => number | undefined;

export interface RewardWeights {
  /** Mean share of the surface's nodes a viewer engaged with. Default 1. */
  readonly engagement?: number;
  /** Mean rating, 1..5 mapped to 0..1. Default 2. */
  readonly feedback?: number;
  /** Mean success rate over the registered outcome names. Default 3. */
  readonly outcome?: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The declared default: a weighted mean of the components the pooled votes have — mean engagement,
 * mean rating, mean outcome rate — each a mean of per-VIEWER terms that are themselves in [0, 1]
 * (so no client-controlled count can scale it). Always within [0, 1], rounded to 6 places;
 * `undefined` with no exposed viewer.
 */
export function defaultReward(weights: RewardWeights = {}): RewardFunction {
  const we = Math.max(0, weights.engagement ?? 1);
  const wf = Math.max(0, weights.feedback ?? 2);
  const wo = Math.max(0, weights.outcome ?? 3);
  return (s) => {
    if (s.viewers <= 0) return undefined;
    let num = 0;
    let den = 0;
    if (we > 0) {
      num += we * clamp01(s.engagementSum / s.viewers);
      den += we;
    }
    if (wf > 0 && s.feedbackViewers > 0) {
      num += wf * clamp01(s.feedbackSum / s.feedbackViewers);
      den += wf;
    }
    if (wo > 0 && s.outcomeViewers > 0) {
      num += wo * clamp01(s.outcomeSum / s.outcomeViewers);
      den += wo;
    }
    if (den <= 0) return undefined;
    return Math.round(clamp01(num / den) * 1e6) / 1e6;
  };
}

/** The slice of `WorkflowRuntime` a settlement needs (`@loom/analytics` `OutcomeAttacher`). */
export interface OutcomeRuntime {
  recordOutcome(
    executionId: string,
    outcome: { decisionId: string; key: string; success?: boolean; score?: number },
    options?: { principal?: unknown; system?: unknown }
  ): Promise<{ appended: boolean }>;
}

/**
 * The kernel says "this execution is not finished" with a typed error; a decorated or second copy
 * of the class is not `instanceof` ours, so it is recognised by name. ISOLATED here: replace with a
 * typed check when loom exports one (TODO: loom `isExecutionNotTerminal`).
 */
export function isNotTerminal(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "ExecutionNotTerminalError";
}
/** Refusals that no retry can fix (typed). Anything else is treated as possibly transient. */
const PERMANENT = new Set(["ExecutionDeniedError", "OutcomeRefusedError"]);
export const isPermanentRefusal = (err: unknown): boolean =>
  PERMANENT.has(String((err as { name?: unknown } | null)?.name));

export interface SettleOptions {
  readonly ledger: VoteLedger;
  readonly runtime: OutcomeRuntime;
  /** The decisions to settle (the host knows them: it registered their links). */
  readonly decisions: Iterable<DecisionRef>;
  readonly reward: RewardFunction;
  /**
   * Names the reward function (token, <= 32). Part of the outcome key; give a decision ONE for life.
   */
  readonly rewardId: string;
  /** Names this close (experiment end, a TTL after the execution finished…). Token, <= 32. */
  readonly closeId: string;
  /**
   * Who records the outcome, per decision. Prefer a REWARD-PIPELINE principal granted `annotate`
   * for its tenant (`executionAccessPolicy({ rules: { annotate: "tenant" } })`, or a `system` grant)
   * over impersonating each owner; ADR 0116's default is `annotate: owner`. Host-supplied, never derived.
   */
  readonly authorize: (ref: DecisionRef) => { principal?: unknown; system?: unknown };
  /** Injected time (ms), to age a deferred settlement. */
  readonly clock: () => number;
  /** A settlement still failing this long after its close is abandoned and reported. Default 7 days. */
  readonly maxDeferralMs?: number;
  /** Transient failures retried per decision per process before abandoning. Default 5. */
  readonly maxAttempts?: number;
  /** Decisions with fewer pooled viewers than this are settled as empty. Default 1. */
  readonly minViewers?: number;
}

export interface SettleReport {
  readonly appended: number;
  /** Already recorded (idempotent re-run). */
  readonly duplicates: number;
  /** Nothing to say (no exposed viewer, or the function declined): settled empty. */
  readonly empty: number;
  /** Already settled by an earlier run (or another replica). */
  readonly alreadySettled: number;
  /** Not finished / transient failure: left open, retried by the next run. */
  readonly deferred: number;
  /** Gave up (age or attempts): marked settled, reported. */
  readonly abandoned: ReadonlyArray<{ ref: DecisionRef; reason: string; error?: unknown }>;
  /** Refused by the kernel for good (unauthorized, conflicting score…): marked settled, reported. */
  readonly refused: ReadonlyArray<{ ref: DecisionRef; error: unknown }>;
}

const TOKEN = /^[A-Za-z0-9_.:-]{1,32}$/;

export async function settleRewards(opts: SettleOptions): Promise<SettleReport> {
  if (!TOKEN.test(opts.rewardId))
    throw new Error("settleRewards: rewardId must be a token of <= 32 chars");
  if (!TOKEN.test(opts.closeId))
    throw new Error("settleRewards: closeId must be a token of <= 32 chars");
  const maxAge = opts.maxDeferralMs ?? 7 * 24 * 3_600_000;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const rep = { appended: 0, duplicates: 0, empty: 0, alreadySettled: 0, deferred: 0 };
  const abandoned: Array<{ ref: DecisionRef; reason: string; error?: unknown }> = [];
  const refused: Array<{ ref: DecisionRef; error: unknown }> = [];
  const key = `ui:${opts.rewardId}:${opts.closeId}:${opts.ledger.specHash}`;
  for (const ref of opts.decisions) {
    let f = await opts.ledger.fold(ref);
    if (f.settled) {
      rep.alreadySettled += 1;
      continue;
    }
    if (!f.claim) f = await opts.ledger.close(ref, opts.closeId);
    const claim = f.claim;
    const age = claim === undefined ? 0 : opts.clock() - Date.parse(claim.at);
    const raw = f.summary.viewers < (opts.minViewers ?? 1) ? undefined : opts.reward(f.summary);
    if (raw === undefined || !Number.isFinite(raw)) {
      await opts.ledger.markSettled(ref, "empty");
      rep.empty += 1;
      continue;
    }
    const score = Math.round(clamp01(raw) * 1e6) / 1e6;
    const r = await attachOutcomes(
      opts.runtime,
      [{ executionId: ref.executionId, decisionId: ref.decisionId, key, score }],
      { options: opts.authorize(ref) }
    );
    const failure = r.failed[0];
    if (failure === undefined) {
      await opts.ledger.markSettled(ref, "recorded");
      if (r.appended > 0) rep.appended += 1;
      else rep.duplicates += 1;
      continue;
    }
    const err = failure.error;
    if (isPermanentRefusal(err)) {
      await opts.ledger.markSettled(ref, "refused");
      refused.push({ ref, error: err });
      continue;
    }
    // not terminal yet, or a failure that may be transient: keep it open, within bounds
    const tries = (attempts.get(`${ref.executionId}${"\u0000"}${ref.decisionId}`) ?? 0) + 1;
    attempts.set(`${ref.executionId}${"\u0000"}${ref.decisionId}`, tries);
    if (attempts.size > 10_000) attempts.delete(attempts.keys().next().value as string);
    if (age > maxAge || (!isNotTerminal(err) && tries >= maxAttempts)) {
      await opts.ledger.markSettled(ref, "abandoned");
      abandoned.push({
        ref,
        reason: age > maxAge ? "deferred past maxDeferralMs" : "transient failure past maxAttempts",
        error: err,
      });
      continue;
    }
    rep.deferred += 1;
  }
  return { ...rep, abandoned, refused };
}

/** Process-local retry counts for transient failures (the ledger holds the durable age). */
const attempts = new Map<string, number>();
