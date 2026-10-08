import { attachOutcomes } from "@loom/analytics";
import type { AccumulatedEntry, RewardAccumulator, WindowSummary } from "./ingest";
import type { DecisionRef } from "./links";

// ── Rewards (U11) ─────────────────────────────────────────────────────────────
// A reward function turns what a decision's surface earned in one CLOSED window into ONE bounded
// score in [0, 1]. The score is recorded on the decision through loom's `runtime.recordOutcome`
// (ADR 0116) — late, after the planner's execution finished — under the key
// `ui:<rewardId>:<window>`. `(decisionId, key)` is idempotent in the kernel, so re-running a
// settlement is safe; and a window is only settled once it is CLOSED (it can no longer change), because
// the kernel refuses a second, different score for the same pair.

/** `undefined` = "this window says nothing about the decision" (nothing is recorded). */
export type RewardFunction = (summary: WindowSummary) => number | undefined;

export interface RewardWeights {
  /** Share of the exposed (viewer, node) pairs that were engaged. Default 1. */
  readonly engagement?: number;
  /** Mean rating, 1..5 mapped to 0..1. Default 2. */
  readonly feedback?: number;
  /** Share of task outcomes that succeeded. Default 3. */
  readonly outcome?: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The declared default: a weighted mean of the components a window actually has — engagement rate,
 * mean rating, outcome success rate — over a window with at least one exposure. Components with no
 * data are left out (not counted as zero); weights are non-negative. Always within [0, 1], rounded to
 * 6 places so the recorded score is stable. A window with no exposure is `undefined`.
 */
export function defaultReward(weights: RewardWeights = {}): RewardFunction {
  const we = Math.max(0, weights.engagement ?? 1);
  const wf = Math.max(0, weights.feedback ?? 2);
  const wo = Math.max(0, weights.outcome ?? 3);
  return (s) => {
    if (s.exposed <= 0) return undefined;
    let num = 0;
    let den = 0;
    if (we > 0) {
      num += we * clamp01(s.engaged / s.exposed);
      den += we;
    }
    if (wf > 0 && s.feedbackCount > 0) {
      num += wf * clamp01((s.feedbackSum / s.feedbackCount - 1) / 4);
      den += wf;
    }
    if (wo > 0 && s.outcomes > 0) {
      num += wo * clamp01(s.outcomeSuccesses / s.outcomes);
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

export interface SettleOptions {
  readonly accumulator: RewardAccumulator;
  readonly runtime: OutcomeRuntime;
  readonly reward: RewardFunction;
  /**
   * Names the reward function in the outcome key (`ui:<rewardId>:<window>`), so changing the function
   * records under a NEW key instead of colliding with a score the old one already wrote. Token.
   */
  readonly rewardId: string;
  /** Settle windows strictly before this one (use `ingestor.windowOf(clock())`). */
  readonly before: number;
  /**
   * Who records the outcome: the execution's OWNER (ADR 0116 default rule `annotate: owner`), as
   * `{ principal }` — or `{ system }` for a host that opted into it. Judged per decision, because
   * executions have owners.
   */
  readonly authorize: (ref: DecisionRef) => { principal?: unknown; system?: unknown };
}

export interface SettleReport {
  readonly appended: number;
  /** Already recorded (idempotent re-run). */
  readonly duplicates: number;
  /** The window said nothing (`reward` returned undefined); dropped. */
  readonly empty: number;
  /** The execution is not finished yet: kept, retried by the next settlement. */
  readonly deferred: number;
  /** Refused by the kernel (unauthorized, unknown decision, conflicting score…): dropped. */
  readonly refused: ReadonlyArray<{ ref: DecisionRef; window: number; error: unknown }>;
}

const TOKEN = /^[A-Za-z0-9_.:-]{1,48}$/;

/**
 * Settle every CLOSED window: compute each decision's score, record it late, and forget what was
 * recorded. Idempotent and safe to run on a timer. A decision whose execution is still running
 * stays in the accumulator (`deferred`); a permanent refusal is dropped and reported, so a poisoned
 * entry cannot be retried forever.
 */
export async function settleRewards(opts: SettleOptions): Promise<SettleReport> {
  if (!TOKEN.test(opts.rewardId)) throw new Error("settleRewards: rewardId must be a token");
  let appended = 0;
  let duplicates = 0;
  let empty = 0;
  let deferred = 0;
  const refused: Array<{ ref: DecisionRef; window: number; error: unknown }> = [];
  for (const e of opts.accumulator.closed(opts.before)) {
    const raw = opts.reward(e.summary);
    if (raw === undefined || !Number.isFinite(raw)) {
      empty += 1;
      opts.accumulator.drop(e.ref, e.window);
      continue;
    }
    const score = Math.round(clamp01(raw) * 1e6) / 1e6;
    const r = await attachOutcomes(
      opts.runtime,
      [
        {
          executionId: e.ref.executionId,
          decisionId: e.ref.decisionId,
          key: `ui:${opts.rewardId}:${e.window}`,
          score,
        },
      ],
      { options: opts.authorize(e.ref) }
    );
    const failure = r.failed[0];
    if (failure === undefined) {
      if (r.appended > 0) appended += 1;
      else duplicates += 1;
      opts.accumulator.drop(e.ref, e.window);
    } else if ((failure.error as { name?: unknown } | null)?.name === "ExecutionNotTerminalError") {
      deferred += 1;
    } else {
      refused.push({ ref: e.ref, window: e.window, error: failure.error });
      opts.accumulator.drop(e.ref, e.window);
    }
  }
  return { appended, duplicates, empty, deferred, refused };
}

export type { AccumulatedEntry };
