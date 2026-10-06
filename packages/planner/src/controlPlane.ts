/**
 * Errors that are the CONTROL PLANE speaking, not the model: the deciding execution is not
 * allowed to make this call (`CapabilityDeniedError`, effect-runtime authz), its budget refuses it
 * (`QuotaExceededError`, middleware metering), or it was cancelled (`AbortError`, or loom's
 * `ExecutionCancelledError` / `DecideScopeClosedError`), or another loom refusal that is pointless
 * to retry (see the name set below). None is a bad draft — retrying repeats the refusal, and
 * returning an empty failed plan from the decider would RECORD it as the decision, pinning the
 * refusal across a later grant. They are rethrown so `ctx.decide` records nothing and the flow
 * fails with the real error. A host's own custom cancel reason keeps its own name and is NOT
 * recognised (documented in the README).
 *
 * Matched structurally on `name` (not `instanceof`) so a second copy of loom's classes, or a
 * wrapper that re-creates the error across a package boundary, is still recognised.
 *
 * Classification rests on error NAMES alone (errors cross package copies, so `instanceof` is
 * unreliable). A turn's own cancellation is separate: the caller's `signal` is forwarded to
 * `complete(req, { signal, onDelta })` and an abort surfaces as `AbortError` (listed below).
 */
const CONTROL_PLANE_NAMES: ReadonlySet<string> = new Set([
  // effect-runtime authz / middleware metering / the platform's cancellation name
  "CapabilityDeniedError",
  "QuotaExceededError",
  "AbortError",
  // loom's cancellation (workflow-runtime): `cancel()` / a deadline breach, and the settled-decider
  // scope. A caller-supplied cancel reason keeps its own Error (and so its own name).
  "ExecutionCancelledError",
  "DecideScopeClosedError",
  // lifecycle authz, capability-invoke authz, the transient seam refusing a journaled effect (a
  // wiring bug a recorded failed plan would hide), isolate egress, safety middleware, and the
  // untrusted-content guard. None is a bad draft; a retry repeats the refusal.
  "ExecutionDeniedError",
  "CapabilityInvokeDeniedError",
  "EffectModeViolationError",
  "EgressDeniedError",
  "SafetyViolationError",
  "UntrustedContentError",
  // control-plane limits (loom R9): per-principal rate limit, an engaged kill switch (a
  // `SafetyViolationError` subclass, but its own `name`), and the spawn budget. A refusal, not a
  // draft: retrying repeats it, and recording a failed plan would pin it across a later reset.
  "RateLimitExceededError",
  "KillSwitchEngagedError",
  "SpawnLimitExceededError",
]);

export function isControlPlaneError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return typeof name === "string" && CONTROL_PLANE_NAMES.has(name);
}
