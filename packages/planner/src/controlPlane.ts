/**
 * Errors that are the CONTROL PLANE speaking, not the model: the deciding execution is not
 * allowed to make this call (`CapabilityDeniedError`, effect-runtime authz), its budget refuses it
 * (`QuotaExceededError`, middleware metering), or it was cancelled (`AbortError`, from the
 * composed signal). None is a bad draft — retrying repeats the refusal, and returning an empty
 * failed plan from the decider would RECORD it as the decision, pinning the refusal across a later
 * grant. They are rethrown so `ctx.decide` records nothing and the flow fails with the real error.
 *
 * Matched structurally on `name` (not `instanceof`) so a second copy of loom's classes, or a
 * wrapper that re-creates the error across a package boundary, is still recognised.
 */
const CONTROL_PLANE_NAMES: ReadonlySet<string> = new Set([
  "CapabilityDeniedError",
  "QuotaExceededError",
  "AbortError",
]);

export function isControlPlaneError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return typeof name === "string" && CONTROL_PLANE_NAMES.has(name);
}
