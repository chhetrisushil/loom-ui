import type { ContainerRoleSpec } from "@loom-ui/core";
import { canonicalJson, fnv1a64 } from "@loom/core";
import type {
  Policy,
  PolicyChoice,
  PolicyContext,
  PolicyResolver,
  RolloutSource,
} from "@loom/learning";

// ── Planner variants (U11) ────────────────────────────────────────────────────
// A variant is a named way of asking the SAME planner for the SAME surface: which container roles it
// may draw with, and an application-authored line of layout guidance. Choosing among variants is a
// loom DECISION made through `decideWithPolicy`, so it is recorded with its context, the alternatives
// and the policy's PROPENSITY — which is what lets `@loom/learning` evaluate a variant off-policy
// from the log (SNIPS) and what makes a late reward attributable to the choice that earned it.
//
// The choice is made BEFORE the model is called and is part of the plan decision's id (a plan made
// under one variant is not a plan for another). Everything a policy does here is PURE: the same
// context and action set give the same choice and the same propensity, with no clock and no RNG, so
// a replay (which serves the recorded choice anyway) and a re-run never disagree.

/** Longest guidance line; it is placed in the system prompt, so it is bounded and stripped. */
export const MAX_GUIDANCE = 400;
/** The unit key a variant policy assigns by: an OPAQUE id, never a name, email or other PII. */
export const UNIT_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

export interface PlanVariant {
  /** Replaces `ComposeInput.containers` for the turn when present (`[]` = plain containers only). */
  readonly containers?: readonly ContainerRoleSpec[];
  /**
   * APPLICATION-AUTHORED text (never model or user text) appended to the system prompt, e.g. "Prefer
   * one grouped tabs container over a long flat list." Bounded to {@link MAX_GUIDANCE}; control and
   * bidi characters are refused at construction of the planner.
   */
  readonly guidance?: string;
}

/**
 * Choose through a policy REGISTRY (loom R18, ADR 0124) instead of one fixed policy: the variant is
 * decided with `decideWithRollout`, so the decision records which VERSION acted, its shadow arm and
 * the rollout fields. These are `decideWithRollout`'s own arguments; `unit` (the turn's
 * `ComposeInput.unit`) is its `unitKey`.
 */
export interface PlanVariantRollout {
  /** Where the live/candidate versions come from. loom's `PolicyRegistry` satisfies it. */
  readonly source: RolloutSource;
  /** The registry id of the variant policy. */
  readonly policyId: string;
  /** Turns a registered (id, version) into code this process runs. */
  readonly resolve: PolicyResolver<string>;
  /** Server-held secret mixed into the traffic bucket (see `DecideWithRolloutOptions`). */
  readonly bucketSecret?: string;
}

interface PlanVariantSet {
  /** Variant id → variant. Ids are `[A-Za-z0-9_.:-]{1,48}`; at least one. */
  readonly variants: Readonly<Record<string, PlanVariant>>;
}

/**
 * Exactly one of `policy` (one fixed policy, `decideWithPolicy`) or `rollout` (a registry,
 * `decideWithRollout`).
 */
export type PlanVariants = PlanVariantSet &
  (
    | {
        /**
         * Chooses a variant id from the variant ids. Its context is `{ kind, unit, key, catalogId }`.
         * `stableBucketPolicy`, `epsilonGreedyPolicy` and `ucbPolicy` below are the shipped shapes; any
         * `@loom/learning` `Policy<string>` works (a learned one included).
         */
        readonly policy: Policy<string>;
        readonly rollout?: undefined;
      }
    | { readonly rollout: PlanVariantRollout; readonly policy?: undefined }
  );

// A code-point test (tab and newline allowed in guidance), not a regex: a formatter may rewrite
// escapes in a regex into the raw characters.
function unsafeText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      (c <= 0x1f && c !== 0x09 && c !== 0x0a) ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x200e ||
      c === 0x200f ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    )
      return true;
  }
  return false;
}
const VARIANT_ID = /^[A-Za-z0-9_.:-]{1,48}$/;

/** Throws on a variant set the planner could not run safely. Called once, at construction. */
export function assertVariants(v: PlanVariants): void {
  if ((v.policy === undefined) === (v.rollout === undefined))
    throw new Error("PlanVariants: set exactly one of `policy` and `rollout`");
  if (v.rollout !== undefined) {
    const r = v.rollout as Partial<PlanVariantRollout> | null;
    if (
      typeof r?.source?.resolve !== "function" ||
      typeof r.resolve !== "function" ||
      typeof r.policyId !== "string" ||
      r.policyId === ""
    )
      throw new Error(
        "PlanVariants: `rollout` needs a `source` with a resolve function, a `resolve` function and a non-empty `policyId`"
      );
  }
  const ids = Object.keys(v.variants);
  if (ids.length === 0) throw new Error("PlanVariants: at least one variant is required");
  for (const id of ids) {
    if (!VARIANT_ID.test(id)) throw new Error(`PlanVariants: variant id "${id}" is not a token`);
    const g = v.variants[id]?.guidance;
    if (g !== undefined && (g.length > MAX_GUIDANCE || unsafeText(g)))
      throw new Error(
        `PlanVariants: guidance of "${id}" is over ${MAX_GUIDANCE} chars or has control characters`
      );
  }
}

/** The key a plan decision mixes in for a variant: its id and its guidance (the text shapes the prompt). */
export const variantKey = (id: string, variant: PlanVariant): string =>
  `${id}:${fnv1a64(variant.guidance ?? "")}`;

// ── shipped policies ──────────────────────────────────────────────────────────

/** Uniform in [0,1) from a string: the top 53 bits of two FNV lanes — pure, no RNG. */
function unitInterval(...parts: readonly string[]): number {
  const h = fnv1a64(canonicalJson(parts));
  // fnv1a64 is a 16-hex-char string
  return Number.parseInt(h.slice(0, 13), 16) / 2 ** 52;
}

const unitOf = (ctx: PolicyContext): string => {
  const u = ctx.unit;
  if (typeof u !== "string" || !UNIT_KEY.test(u))
    throw new Error("variant policy: the context carries no valid `unit` key");
  return u;
};

/**
 * A/B by STABLE UNIT KEY: a unit always lands on the same variant (a hash of `salt` and the unit
 * against the cumulative `weights`), so the experience does not flip between turns. The recorded
 * propensity is the variant's weight share — a legitimate randomisation probability ACROSS units,
 * which is what off-policy evaluation needs. Weights are positive; actions the weights do not
 * name get weight 0 (never chosen). Change `salt` to re-randomise.
 */
export function stableBucketPolicy(opts: {
  readonly id: string;
  readonly version: string;
  readonly weights: Readonly<Record<string, number>>;
  readonly salt?: string;
}): Policy<string> {
  return {
    id: opts.id,
    version: opts.version,
    select(ctx, actions): PolicyChoice<string> {
      const unit = unitOf(ctx);
      const w = actions.map((a) => {
        const x = opts.weights[a];
        return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
      });
      const total = w.reduce((s, x) => s + x, 0);
      if (!(total > 0)) throw new Error("stableBucketPolicy: no action has a positive weight");
      const u = unitInterval("bucket", opts.salt ?? "", unit) * total;
      let acc = 0;
      for (let i = 0; i < actions.length; i++) {
        acc += w[i] as number;
        if (u < acc && (w[i] as number) > 0)
          return { action: actions[i] as string, propensity: (w[i] as number) / total };
      }
      // u === total only by rounding: the last positive-weight action
      for (let i = actions.length - 1; i >= 0; i--)
        if ((w[i] as number) > 0)
          return { action: actions[i] as string, propensity: (w[i] as number) / total };
      throw new Error("unreachable");
    },
  };
}

/**
 * Epsilon-greedy: with probability `epsilon` explore uniformly, otherwise take `greedy(ctx, actions)`.
 * The "coin" is a hash of `salt`, the unit and the plan key (the context's `key`), so it is
 * deterministic and VARIES across plans of one unit. Propensity of the chosen action is
 * `epsilon/k` plus `1-epsilon` if it is the greedy one — the exact probability, so SNIPS is unbiased.
 * `greedy` must be pure (read a snapshot, not a live counter).
 */
export function epsilonGreedyPolicy(opts: {
  readonly id: string;
  readonly version: string;
  readonly epsilon: number;
  readonly greedy: (ctx: PolicyContext, actions: readonly string[]) => string;
  readonly salt?: string;
}): Policy<string> {
  if (!(opts.epsilon > 0 && opts.epsilon <= 1))
    throw new Error("epsilonGreedyPolicy: epsilon must be in (0, 1]");
  return {
    id: opts.id,
    version: opts.version,
    select(ctx, actions): PolicyChoice<string> {
      const unit = unitOf(ctx);
      const k = actions.length;
      const best = opts.greedy(ctx, actions);
      if (!actions.includes(best))
        throw new Error("epsilonGreedyPolicy: greedy returned a non-action");
      const key = typeof ctx.key === "string" ? ctx.key : "";
      const coin = unitInterval("eps", opts.salt ?? "", unit, key);
      const pick = unitInterval("eps-arm", opts.salt ?? "", unit, key);
      const action = coin < opts.epsilon ? (actions[Math.floor(pick * k)] as string) : best;
      return { action, propensity: opts.epsilon / k + (action === best ? 1 - opts.epsilon : 0) };
    },
  };
}

/**
 * UCB1 over a SNAPSHOT of per-variant statistics (`stats()` is read at select time: hand it an
 * immutable snapshot, or a function over one). An untried variant goes first (ties: action order);
 * otherwise the highest `mean + c*sqrt(2 ln N / n)`. Deterministic, so it logs propensity 1 — off-policy
 * evaluation then reports `agreement-only` for it unless another policy's exploration is in the log.
 */
export function ucbPolicy(opts: {
  readonly id: string;
  readonly version: string;
  readonly stats: () => Readonly<Record<string, { readonly n: number; readonly mean: number }>>;
  readonly c?: number;
}): Policy<string> {
  const c = opts.c ?? 1;
  return {
    id: opts.id,
    version: opts.version,
    select(_ctx, actions): PolicyChoice<string> {
      const s = opts.stats();
      let total = 0;
      for (const a of actions) total += Math.max(0, s[a]?.n ?? 0);
      let best = actions[0] as string;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (const a of actions) {
        const n = Math.max(0, s[a]?.n ?? 0);
        const score =
          n === 0
            ? Number.POSITIVE_INFINITY
            : (s[a]?.mean ?? 0) + c * Math.sqrt((2 * Math.log(Math.max(total, 1))) / n);
        if (score > bestScore) {
          best = a;
          bestScore = score;
        }
      }
      return { action: best, propensity: 1 };
    },
  };
}
