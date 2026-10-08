import type { Provenance } from "@loom-ui/core";
import type { PlanResult } from "./spi";

/**
 * The `Provenance` a host stamps on the ops of a plan (U12): `source: "agent"`, the model that
 * wrote it and — the link the log was missing — the loom DECISION that recorded it
 * (`PlanReport.decisionId`). A planner turn is one `ctx.decide`, so this id is what a replay serves
 * and what an audit of "which model call put this widget here?" starts from; the model's text is
 * NOT copied into the log through it (that is `PlanResult.summary`, carried on the lineage event
 * under the summary-class rules). Pass the result to `RecordedOperation.by` / `Lineage.compose({ by })`.
 *
 * `agentId` is the host's own id for the planner (a replica, a session); it is not derived here.
 */
export function plannerProvenance(
  result: Pick<PlanResult, "report">,
  opts: { readonly agentId?: string; readonly ref?: string } = {}
): Provenance {
  const { decisionId, modelId } = result.report;
  const learnable = result.report.variant?.decisionId;
  // `Provenance.decisionId` is 1-256 characters. A decision id outside that is OMITTED, never
  // truncated (a cut id links to a different decision) and never stamped (an invalid provenance is
  // refused by the lineage's write path).
  const linkable = decisionId !== "" && decisionId.length <= 256;
  return {
    source: "agent",
    ...(opts.agentId !== undefined && { agentId: opts.agentId }),
    ...(modelId !== "" && { modelId }),
    ...(linkable && { decisionId }),
    // The decision a reward attaches to (U11): the variant choice, which carries the propensity.
    ...(learnable !== undefined &&
      learnable !== "" &&
      learnable.length <= 256 && { policyDecisionId: learnable }),
    ...(opts.ref !== undefined && { ref: opts.ref }),
  };
}
