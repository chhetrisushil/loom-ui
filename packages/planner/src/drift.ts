import { type Experience, experienceHandles } from "@loom-ui/core";
import type { DriftRecord } from "@loom-ui/hydration";
import { unwrapTainted } from "@loom/classify";
import { canonicalJson } from "@loom/core";
import type { CapabilityRef, DecideContext, PlanResult, Planner, ReviseInput } from "./spi";

// `remapOperation` (hydration's repair.ts) repairs INPUT drift mechanically — a new schema pin,
// no model involved — and refuses OUTPUT drift with `repair-needs-planner`: an output reshape can
// only be re-authored with judgment about what the node should now show. This module is the
// planner half of that sentence: it turns a `DriftRecord[]` into a revise request the reference
// planner (or any `Planner`) can act on, feeding it the observed shapes as fenced CONTEXT and,
// when captured, the observed raw sample as the drifted capability's `sampleOutput`.

/** Which nodes a drifted handle feeds — the revision's scope. */
function boundNodeIds(exp: Experience, handle: string): string[] {
  return (
    experienceHandles(exp)
      .find((u) => u.handle === handle)
      ?.nodeIds.slice() ?? []
  );
}

/**
 * The planner's brief for a repair, written from the record alone (no re-fetch).
 *
 * OPERATOR-AUTHORED WORDS ONLY. Everything interpolated here is a framework identifier the
 * framework itself constrains — a provider handle (`p-<hash>`, minted by `providerHandle`), a
 * node id (`DRAFT_ID`: `^[a-z][a-z0-9_]{0,31}$`), a step id, a tool name, a catalogue widget kind
 * and a shape HASH. No
 * tool-authored text and no observed SHAPES: a shape is a structure the tool server chose the
 * key names of, so it is data — `reviseForDrift` hands it over as `context`, which
 * `reviseMessages` renders inside a DATA fence.
 */
export function driftRequest(
  exp: Experience,
  drift: readonly DriftRecord[]
): ReviseInput["request"] {
  const scope = new Set<string>();
  const lines = drift.map((d) => {
    const nodes = boundNodeIds(exp, d.handle);
    for (const n of nodes) scope.add(n);
    const spec = exp.providers[d.handle];
    if (d.kind === "output" && d.contractKind !== undefined)
      return `Provider "${d.handle}" (nodes: ${nodes.join(", ") || "none"}) drifted: its reshaped output no longer satisfies the value contract of kind "${d.contractKind}" (observed shape ${d.observed}). Current path: "${spec?.reshaping.scriptRef ?? ""}". The CONTEXT DATA block lists this handle's observed shapes (the reshaped one that failed the contract, and the raw output shape a path is authored against). Re-author the binding's path so the node shows the same quantity from the new output as a valid ${d.contractKind} value; keep the node id, label, type and props.`;
    return d.kind === "output"
      ? `Provider "${d.handle}" (nodes: ${nodes.join(", ") || "none"}) drifted: its reshaped output no longer matches the pinned shape ${d.expected} (observed ${d.observed}). Current path: "${spec?.reshaping.scriptRef ?? ""}". The CONTEXT DATA block lists this handle's observed shapes (the reshaped one that failed the pin, and the raw output shape a path is authored against). Re-author the binding's path so the node shows the same quantity from the new output; keep the node id, label, type and props.`
      : `Provider "${d.handle}" (nodes: ${nodes.join(", ") || "none"}) has an input-schema drift on step ${d.stepId ?? "?"} (${d.toolName ?? "?"}): expected ${d.expected}, observed ${d.observed}. Re-bind it with the offered capability for that tool.`;
  });
  return { text: `Repair drifted providers.\n\n${lines.join("\n\n")}`, scopeNodeIds: [...scope] };
}

/** One drift record's shapes, for the fenced CONTEXT block. Samples are NEVER included here. */
export interface DriftContextEntry {
  readonly handle: string;
  readonly expected: string;
  readonly observed: string;
  readonly observedShape?: unknown;
  readonly observedRawShape?: unknown;
}

/**
 * The shapes a repair needs, as DATA. `observedRawShape` is the one a `path` is authored against
 * (`reshaping.scriptRef` indexes the RAW output); `observedShape` is what actually failed the pin.
 * Both travel when both were captured — a record that carries only one still says something.
 */
export function driftContext(drift: readonly DriftRecord[]): DriftContextEntry[] {
  return drift
    .filter((d) => d.kind === "output")
    .map((d) => ({
      handle: d.handle,
      expected: d.expected,
      observed: d.observed,
      ...(d.observedShape !== undefined && { observedShape: d.observedShape }),
      ...(d.observedRawShape !== undefined && { observedRawShape: d.observedRawShape }),
    }));
}

/** A drifted step's identity for sample matching: the tool AND the arguments it was called with. */
const stepKey = (toolName: string, toolVersion: string, args: unknown): string =>
  `${toolName}@${toolVersion}#${canonicalJson(args)}`;

/**
 * Give the planner the observed sample to pin against: a drifted provider's capability gets the
 * UNWRAPPED RAW sample as its `sampleOutput` (the prompt re-fences it as data), because a
 * capability's `sampleOutput` is RAW by contract — `buildProviderSpec` reshapes it with the
 * draft's `path` to pin `outputShapeHash`, so a reshaped sample would pin the wrong shape.
 *
 * The match is keyed on the drifted step's `(toolName, toolVersion, arguments)`, not on
 * `tool@version` alone: one tool called with two different argument sets returns two different
 * outputs, so two such drifts carry two different samples and `tool@version` cannot say which one
 * belongs to a capability (a `CapabilityRef` declares no arguments — the draft's binding does).
 * When the drifted steps for one tool disagree, the capability keeps its OWN sample rather than
 * being handed an arbitrary one; the shapes in the CONTEXT block are still there to re-author from.
 */
export function driftCapabilities(
  capabilities: readonly CapabilityRef[],
  exp: Experience,
  drift: readonly DriftRecord[]
): CapabilityRef[] {
  // tool@version → the distinct samples the drifted steps for that tool produced, by step key.
  const byTool = new Map<string, Map<string, unknown>>();
  for (const d of drift) {
    if (d.kind !== "output" || d.observedSample === undefined) continue;
    const step = exp.providers[d.handle]?.executionGraph[0];
    if (!step) continue;
    const tool = `${step.toolName}@${step.toolVersion}`;
    const perStep = byTool.get(tool) ?? new Map<string, unknown>();
    perStep.set(
      stepKey(step.toolName, step.toolVersion, step.arguments),
      unwrapTainted(d.observedSample)
    );
    byTool.set(tool, perStep);
  }
  return capabilities.map((c) => {
    const perStep = byTool.get(`${c.toolName}@${c.toolVersion}`);
    if (perStep === undefined || perStep.size === 0) return c;
    const samples = [...perStep.values()];
    const first = samples[0];
    // Several argument sets drifted for this tool: only take the sample when they agree.
    if (samples.some((s) => canonicalJson(s) !== canonicalJson(first))) return c;
    return { ...c, sampleOutput: first };
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
  // The caller's own context, when it has one, is nested under `caller` so the drift shapes can
  // never overwrite a key it owns (and so `context` stays one fenced DATA block, not two).
  const context = {
    drift: driftContext(input.drift),
    ...(input.context !== undefined && { caller: input.context }),
  };
  return planner.revise(
    {
      experience: input.experience,
      request: driftRequest(input.experience, input.drift),
      catalog: input.catalog,
      capabilities: driftCapabilities(input.capabilities, input.experience, input.drift),
      context,
      ...(input.surface !== undefined && { surface: input.surface }),
    },
    ctx
  );
}
