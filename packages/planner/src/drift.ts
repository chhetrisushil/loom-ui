import { type Experience, experienceHandles } from "@loom-ui/core";
import type { DriftRecord } from "@loom-ui/hydration";
import { unwrapTainted } from "@loom/classify";
import type { CapabilityRef, DecideContext, PlanResult, Planner, ReviseInput } from "./spi";

// `remapOperation` (hydration's repair.ts) repairs INPUT drift mechanically — a new schema pin,
// no model involved — and refuses OUTPUT drift with `repair-needs-planner`: an output reshape can
// only be re-authored with judgment about what the node should now show. This module is the
// planner half of that sentence: it turns a `DriftRecord[]` into a revise request the reference
// planner (or any `Planner`) can act on, feeding it the observed shape and, when captured, the
// observed sample.

/** Which nodes a drifted handle feeds — the revision's scope. */
function boundNodeIds(exp: Experience, handle: string): string[] {
  return (
    experienceHandles(exp)
      .find((u) => u.handle === handle)
      ?.nodeIds.slice() ?? []
  );
}

/** The planner's brief for a repair, written from the record alone (no re-fetch). */
export function driftRequest(
  exp: Experience,
  drift: readonly DriftRecord[]
): ReviseInput["request"] {
  const scope = new Set<string>();
  const lines = drift.map((d) => {
    const nodes = boundNodeIds(exp, d.handle);
    for (const n of nodes) scope.add(n);
    const spec = exp.providers[d.handle];
    const shape =
      d.observedShape !== undefined
        ? `\nObserved output shape:\n${JSON.stringify(d.observedShape, null, 2)}`
        : "";
    return d.kind === "output"
      ? `Provider "${d.handle}" (nodes: ${nodes.join(", ") || "none"}) drifted: its reshaped output no longer matches the pinned shape ${d.expected} (observed ${d.observed}). Current path: "${spec?.reshaping.scriptRef ?? ""}".${shape}\nRe-author the binding's path so the node shows the same quantity from the new output; keep the node id, label, type and props.`
      : `Provider "${d.handle}" (nodes: ${nodes.join(", ") || "none"}) has an input-schema drift on step ${d.stepId ?? "?"} (${d.toolName ?? "?"}): expected ${d.expected}, observed ${d.observed}. Re-bind it with the offered capability for that tool.`;
  });
  return { text: `Repair drifted providers.\n\n${lines.join("\n\n")}`, scopeNodeIds: [...scope] };
}

/**
 * Give the planner the observed sample to pin against: a drifted provider's capability gets the
 * UNWRAPPED sample as its `sampleOutput` (the prompt re-fences it as data). Without a sample the
 * capability keeps its own — the shape text in the request is still enough to re-author a path.
 */
export function driftCapabilities(
  capabilities: readonly CapabilityRef[],
  exp: Experience,
  drift: readonly DriftRecord[]
): CapabilityRef[] {
  const sampleByTool = new Map<string, unknown>();
  for (const d of drift) {
    if (d.kind !== "output" || d.observedSample === undefined) continue;
    const step = exp.providers[d.handle]?.executionGraph[0];
    if (step)
      sampleByTool.set(`${step.toolName}@${step.toolVersion}`, unwrapTainted(d.observedSample));
  }
  return capabilities.map((c) => {
    const sample = sampleByTool.get(`${c.toolName}@${c.toolVersion}`);
    return sample === undefined ? c : { ...c, sampleOutput: sample };
  });
}

export async function reviseForDrift(
  planner: Planner,
  input: {
    experience: Experience;
    drift: readonly DriftRecord[];
    catalog: ReviseInput["catalog"];
    capabilities: readonly CapabilityRef[];
    context?: unknown;
    surface?: ReviseInput["surface"];
  },
  ctx: DecideContext
): Promise<PlanResult> {
  return planner.revise(
    {
      experience: input.experience,
      request: driftRequest(input.experience, input.drift),
      catalog: input.catalog,
      capabilities: driftCapabilities(input.capabilities, input.experience, input.drift),
      ...(input.context !== undefined && { context: input.context }),
      ...(input.surface !== undefined && { surface: input.surface }),
    },
    ctx
  );
}
