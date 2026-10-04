// Declared reach (loom L32). Code a flow hands its `ctx` to — a planner's `compose`/`revise` —
// runs tools the verifier's static analysis cannot see. The code DECLARES them structurally under
// `Symbol.for("loom.verify.reach")`; the app maps the callee to the object via
// `defineConfig({ checks: { verify: { reach: { planner } } } })` and @loom/verify reads it.
// No dependency on @loom/verify: the key and shape are the whole contract.

/** The well-known key. Equal to `@loom/verify`'s `REACH_DECLARATION`. */
export const REACH_DECLARATION: unique symbol = Symbol.for("loom.verify.reach") as never;

/** What code run with a flow's `ctx` reaches. A CLAIM about the code, checked by conformance. */
export interface PlannerReach {
  /** toolIds run through `ctx.run` / `ctx.execute` (journaled steps). */
  readonly run?: readonly string[];
  /** toolIds called through the decide scope's `invokeTransient` (the model tool, hydration, ...). */
  readonly transient?: readonly string[];
}

const isList = (v: unknown): v is readonly string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Attach a declaration to `target` (non-enumerable: it never leaks into serialization). */
export function declarePlannerReach<T extends object>(target: T, reach: PlannerReach): T {
  const copy: PlannerReach = {
    ...(reach.run !== undefined && { run: [...reach.run] }),
    ...(reach.transient !== undefined && { transient: [...reach.transient] }),
  };
  Object.defineProperty(target, REACH_DECLARATION, {
    value: copy,
    enumerable: false,
    configurable: true,
  });
  return target;
}

/** The declaration attached to `value`, or undefined when it has none, a malformed one, or `{}`. */
export function readPlannerReach(value: unknown): PlannerReach | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return undefined;
  const d = (value as { [REACH_DECLARATION]?: unknown })[REACH_DECLARATION];
  if (d === null || typeof d !== "object") return undefined;
  const { run, transient } = d as { run?: unknown; transient?: unknown };
  if ((run !== undefined && !isList(run)) || (transient !== undefined && !isList(transient)))
    return undefined;
  // `{}` is UNDECLARED, exactly as @loom/verify reads it; `{ run: [], transient: [] }` is the
  // explicit "reaches nothing".
  if (run === undefined && transient === undefined) return undefined;
  return d as PlannerReach;
}
