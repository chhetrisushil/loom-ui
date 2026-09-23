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

/** A refused value's KIND — never its content, which an adapter controls (size, `toString`). */
function kindOf(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  if (typeof v === "number") return "a number that is not a safe non-negative integer";
  if (Array.isArray(v)) return "an array";
  const t = typeof v;
  return t === "object" ? "an object" : `a ${t}`;
}

/**
 * What one model reply reported, read defensively: `reply.usage` and each count are read exactly
 * ONCE (a getter cannot validate as one value and be recorded as another), inside a guard (a
 * throwing getter or proxy trap is a refusal, not a failed model call). Only a fresh copy of the
 * two counts is returned, with -0 normalised to 0. `null`/absent ⇒ unreported (neither field set).
 * `problem` describes a refusal by kind only, so nothing adapter-controlled reaches the journal.
 */
export function readReportedUsage(reply: object): {
  readonly usage?: PlannerUsage;
  readonly problem?: string;
} {
  let raw: unknown;
  let inputTokens: unknown;
  let outputTokens: unknown;
  try {
    raw = (reply as { usage?: unknown }).usage;
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object") return { problem: `usage is ${kindOf(raw)}, not an object` };
    ({ inputTokens, outputTokens } = raw as { inputTokens?: unknown; outputTokens?: unknown });
  } catch {
    return { problem: "reading usage threw" };
  }
  if (isCount(inputTokens) && isCount(outputTokens))
    return {
      usage: {
        // `+ 0` turns -0 into 0 so the live value and its JSON replay are the same number.
        inputTokens: (inputTokens as number) + 0,
        outputTokens: (outputTokens as number) + 0,
      },
    };
  const bad = [
    ...(isCount(inputTokens) ? [] : [`inputTokens is ${kindOf(inputTokens)}`]),
    ...(isCount(outputTokens) ? [] : [`outputTokens is ${kindOf(outputTokens)}`]),
  ];
  return { problem: bad.join(", ") };
}
