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
// with SNIPS. loom-ui adds NO estimator: it selects the variant decisions, names the candidates and
// reads the verdict from loom's `promotionGate`.

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
}

export interface EvaluateVariantsOptions {
  /** Variants to evaluate. Default: every action recorded in the variant decisions. */
  readonly variants?: readonly string[];
  /** Gate thresholds. loom's defaults demand 1000 steps, so a small trial passes its own. */
  readonly thresholds?: PromotionThresholds;
  readonly evaluate?: EvaluateOptions;
}

/**
 * Compare planner variants from exported events (any `EventStore.read` result, any number of
 * executions). Only the variant decisions are considered, and only the rewards recorded against
 * them: the execution's own completion is NOT credited to a variant (it says nothing about layout).
 * The unit of each execution is the `unit` its first variant decision recorded, so `evaluatePolicy`
 * reports unit-level statistics and `thresholds.minUnits` applies.
 */
export function evaluateVariants(
  events: readonly EventEnvelope[],
  opts: EvaluateVariantsOptions = {}
): VariantEvaluation {
  const all = trajectories<string>(events, {
    terminalReward: () => undefined,
    unitOf: (_exec, first) => (typeof first?.unit === "string" ? first.unit : undefined),
  });
  const ts: Trajectory<string>[] = [];
  let steps = 0;
  const seen = new Set<string>();
  for (const t of all) {
    const own = t.steps.filter((s) => s.decisionId.startsWith(VARIANT_DECISION_PREFIX));
    if (own.length === 0) continue;
    steps += own.length;
    for (const s of own) {
      seen.add(s.action);
      for (const a of s.actions) seen.add(a);
    }
    ts.push({ ...t, steps: own });
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
  const winner = rows.find((r) => r.verdict.ok);
  return {
    rows,
    winner: winner?.variant,
    reasons:
      winner !== undefined
        ? winner.verdict.reasons
        : rows.length === 0
          ? ["no variant decisions in the log"]
          : rows.map((r) => `${r.variant}: ${r.verdict.reasons.join("; ")}`),
    steps,
  };
}
