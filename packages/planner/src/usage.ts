import type { PlannerUsage } from "./spi";

const isCount = (n: unknown): boolean => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * Two non-negative safe integers. Anything else is refused rather than recorded: NaN and
 * ±Infinity do not survive the JSON a decision is persisted as, so a report carrying one would
 * replay as something other than what the live call returned.
 */
export function isPlannerUsage(u: unknown): u is PlannerUsage {
  if (typeof u !== "object" || u === null) return false;
  try {
    const { inputTokens, outputTokens } = u as { inputTokens?: unknown; outputTokens?: unknown };
    return isCount(inputTokens) && isCount(outputTokens);
  } catch {
    // A throwing getter or a revoked proxy is simply not a usage — a type guard never throws.
    return false;
  }
}

/**
 * A fresh copy of `u`'s two counts when it is a valid `PlannerUsage`, read exactly ONCE each (a
 * getter cannot validate as one value and be summed as another); `undefined` otherwise. Never
 * throws, whatever `u` is.
 */
export function snapshotUsage(u: unknown): PlannerUsage | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  try {
    const { inputTokens, outputTokens } = u as { inputTokens?: unknown; outputTokens?: unknown };
    return isCount(inputTokens) && isCount(outputTokens)
      ? { inputTokens: inputTokens as number, outputTokens: outputTokens as number }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The sum over the parts that report usage; `undefined` when none do ("unreported" ≠ "free").
 *
 * PRECONDITION: every `usage` present is already a validated, plain `PlannerUsage` (e.g. from
 * `readReportedUsage` or `snapshotUsage`). This is plain arithmetic, not a guard — handed an
 * unvalidated adapter value it may throw or return NaN. Validate first, then sum.
 */
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

/**
 * A refused value's KIND — never its content, which an adapter controls (size, `toString`).
 * Total: it never throws, whatever the value (`typeof` cannot throw; `Array.isArray` can, on a
 * revoked proxy, so it is guarded).
 */
function kindOf(v: unknown): string {
  if (v === undefined) return "missing";
  if (v === null) return "null";
  const t = typeof v;
  if (t === "number") return "a number that is not a safe non-negative integer";
  if (t !== "object") return `a ${t}`;
  try {
    return Array.isArray(v) ? "an array" : "an object";
  } catch {
    return "an object";
  }
}

/**
 * What one model reply reported, read defensively: `reply.usage` and each count are read exactly
 * ONCE (a getter cannot validate as one value and be recorded as another), inside a guard (a
 * throwing getter or proxy trap is a refusal, not a failed model call). Only a fresh copy of the
 * two counts is returned, with -0 normalised to 0. `null`/absent ⇒ unreported (neither field set).
 * `problem` describes a refusal by kind only, so nothing adapter-controlled reaches the journal.
 *
 * Exported so a planner that is not `ReferencePlanner` can apply the exact same rule to its own
 * model replies instead of re-deriving it:
 * - absent (`undefined`) or `null` `usage` ⇒ `{}` — unreported, not free, and not a problem.
 * - `usage` present but not an object, or an object whose `inputTokens`/`outputTokens` are not
 *   both non-negative safe integers ⇒ `{ problem }`, a one-line description of the KIND of what
 *   was wrong (e.g. `"inputTokens is a string"`) — never the value itself, so an adapter cannot
 *   smuggle arbitrary content (a huge string, a hostile `toString`) into a journaled finding.
 * - two non-negative safe integers ⇒ `{ usage }`, a plain fresh `{ inputTokens, outputTokens }`
 *   with `-0` normalised to `0`.
 * - never throws, whatever `reply` is (a throwing getter, a revoked proxy, `reply.usage` itself
 *   throwing on read) — every read happens inside a guard, and a throw is reported as a problem.
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
  // From here on only the local copies are touched, through `typeof` / `Number.isSafeInteger` /
  // comparison on a verified number / `kindOf` — none of which can throw. The guard stays anyway,
  // so a future edit here cannot let an adapter value escape as a rejected plan.
  try {
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
  } catch {
    return { problem: "usage could not be inspected" };
  }
}

/**
 * Adds one attempt's usage to a running total, refusing rather than overflowing: a caller that
 * summed every attempt as it went, with no upper bound, would eventually hold a total that is no
 * longer a valid `PlannerUsage` (a JSON replay of `Number.MAX_SAFE_INTEGER + 1` is not the value
 * that produced it). When either field of `total + next` would exceed `Number.MAX_SAFE_INTEGER`,
 * `total` is returned UNCHANGED and `refused` names the reason (safe to fold straight into a
 * `usage-invalid`-style warning; it names no value, only the rule that fired). Otherwise `total`
 * is the field-wise sum and `refused` is absent.
 *
 * PRECONDITION, like `totalUsage`: both `total` and `next` are already validated `PlannerUsage`
 * values (e.g. from `readReportedUsage` or `snapshotUsage`). This is plain arithmetic, not a
 * guard — an unvalidated value may produce NaN or a nonsensical sum.
 */
export function addUsage(
  total: PlannerUsage,
  next: PlannerUsage
): { readonly total: PlannerUsage; readonly refused?: string } {
  if (
    total.inputTokens + next.inputTokens > Number.MAX_SAFE_INTEGER ||
    total.outputTokens + next.outputTokens > Number.MAX_SAFE_INTEGER
  )
    return {
      total,
      refused: "would overflow the plan total past Number.MAX_SAFE_INTEGER",
    };
  return {
    total: {
      inputTokens: total.inputTokens + next.inputTokens,
      outputTokens: total.outputTokens + next.outputTokens,
    },
  };
}
