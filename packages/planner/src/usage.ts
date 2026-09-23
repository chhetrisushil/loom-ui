import type { PlannerUsage } from "./spi";

const isCount = (n: unknown): boolean => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * Two non-negative safe integers. Anything else is refused rather than recorded: NaN and
 * ±Infinity do not survive the JSON a decision is persisted as, so a report carrying one would
 * replay as something other than what the live call returned.
 */
export function isPlannerUsage(u: unknown): u is PlannerUsage {
  if (typeof u !== "object" || u === null) return false;
  const { inputTokens, outputTokens } = u as { inputTokens?: unknown; outputTokens?: unknown };
  return isCount(inputTokens) && isCount(outputTokens);
}

/** The sum over the parts that report usage; `undefined` when none do ("unreported" ≠ "free"). */
export function totalUsage(
  parts: readonly { readonly usage?: PlannerUsage }[]
): PlannerUsage | undefined {
  let seen = false;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const p of parts) {
    if (p.usage === undefined) continue;
    seen = true;
    inputTokens += p.usage.inputTokens;
    outputTokens += p.usage.outputTokens;
  }
  return seen ? { inputTokens, outputTokens } : undefined;
}
