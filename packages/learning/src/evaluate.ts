import type { EventEnvelope } from "@loom/core";
import {
  type EvalReport,
  type EvaluateOptions,
  type Policy,
  type PromotionThresholds,
  type PromotionVerdict,
  type Trajectory,
  evaluatePolicy,
  promotionGate,
  trajectories,
} from "@loom/learning";

// ── UI evaluation (U11) ───────────────────────────────────────────────────────
// Which planner variant is better, from the log alone? Each variant is a CANDIDATE policy that
// "always chooses this variant"; `@loom/learning`'s `evaluatePolicy` estimates its value from the
// logged variant decisions (their recorded propensity, the late rewards `settleRewards` attached)
// with SNIPS. loom-ui adds NO estimator: it selects the variant decisions and the reward outcomes,
// names the candidates and reads the verdict from loom's `promotionGate`.
//
// A decision's `OUTCOME_RECORDED` entries are averaged by `trajectories`, and ANY emitter could add
// one (a CSAT score, a flow's own `recordOutcome`). So only outcomes this pipeline recorded count:
// key `ui:<rewardId>:` AND kernel-stamped (a userspace `ctx.emit` cannot carry that metadata).
//
// For an execution whose log was compacted, pass `evidenceEvents(state, events)` from `@loom/learning`,
// not the raw tail, or the compacted decisions are missing.

/** The id prefix of a variant-choice decision (`ReferencePlanner`). */
export const VARIANT_DECISION_PREFIX = "plan-variant:";

export interface VariantRow {
  readonly variant: string;
  readonly report: EvalReport;
  readonly verdict: PromotionVerdict;
}

export interface VariantEvaluation {
  /** Best estimate first; a variant with no estimate last. */
  readonly rows: readonly VariantRow[];
  /** The best variant that PASSED the gate; `undefined` when none did (never a guess). */
  readonly winner: string | undefined;
  /** Why there is no winner, or the caveats that survived for the winner. */
  readonly reasons: readonly string[];
  /** The variant-choice steps that fed the evaluation (before per-variant filtering). */
  readonly steps: number;
  /**
   * Every logged variant choice had propensity 1 (or none): the logging policy never explored, so
   * an "estimate" is just the observed mean of what it happened to pick. No winner is named then.
   */
  readonly deterministicLogging: boolean;
}

export interface EvaluateVariantsOptions {
  /** The reward pipeline whose outcomes count (`ui:<rewardId>:`). Required. */
  readonly rewardId: string;
  /** Variants to evaluate. Default: every action recorded in the variant decisions. */
  readonly variants?: readonly string[];
  /** Gate thresholds. loom's defaults demand 1000 steps, so a small trial passes its own. */
  readonly thresholds?: PromotionThresholds;
  readonly evaluate?: EvaluateOptions;
  /** Name a winner even when logging was deterministic (propensity 1). Off by default. */
  readonly allowDeterministicLogging?: boolean;
}

export function evaluateVariants(
  events: readonly EventEnvelope[],
  opts: EvaluateVariantsOptions
): VariantEvaluation {
  const prefix = `ui:${opts.rewardId}:`;
  const counted = events.filter((e) => {
    if (e.eventType !== "OUTCOME_RECORDED") return true;
    const key = (e.payload as { key?: unknown } | null)?.key;
    return e.metadata?.kernel === true && typeof key === "string" && key.startsWith(prefix);
  });
  const all = trajectories<string>(counted, { terminalReward: () => undefined });
  const ts: Trajectory<string>[] = [];
  let steps = 0;
  let explored = false;
  const seen = new Set<string>();
  for (const t of all) {
    const own = t.steps.filter((s) => s.decisionId.startsWith(VARIANT_DECISION_PREFIX));
    if (own.length === 0) continue;
    steps += own.length;
    for (const s of own) {
      seen.add(s.action);
      for (const a of s.actions) seen.add(a);
      if (s.policy?.propensity !== undefined && s.policy.propensity < 1) explored = true;
    }
    const unit = (own[0]?.context as { unit?: unknown } | undefined)?.unit;
    ts.push({ ...t, steps: own, ...(typeof unit === "string" && { unit }) });
  }
  const variants = [...(opts.variants ?? seen)].sort();
  const rows: VariantRow[] = variants.map((variant) => {
    const candidate: Policy<string> = {
      id: `variant:${variant}`,
      version: "1",
      select: () => ({ action: variant }),
    };
    const report = evaluatePolicy(ts, candidate, opts.evaluate);
    return { variant, report, verdict: promotionGate(report, opts.thresholds) };
  });
  rows.sort(
    (a, b) =>
      (b.report.estimatedValue ?? Number.NEGATIVE_INFINITY) -
        (a.report.estimatedValue ?? Number.NEGATIVE_INFINITY) || (a.variant < b.variant ? -1 : 1)
  );
  const deterministicLogging = steps > 0 && !explored;
  const blocked = deterministicLogging && opts.allowDeterministicLogging !== true;
  const winner = blocked ? undefined : rows.find((r) => r.verdict.ok);
  return {
    rows,
    winner: winner?.variant,
    deterministicLogging,
    reasons: blocked
      ? [
          "every logged variant choice was deterministic (propensity 1): no off-policy estimate exists",
        ]
      : winner !== undefined
        ? winner.verdict.reasons
        : rows.length === 0
          ? ["no variant decisions in the log"]
          : rows.map((r) => `${r.variant}: ${r.verdict.reasons.join("; ")}`),
    steps,
  };
}
