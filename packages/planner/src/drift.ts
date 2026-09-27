import { type Experience, type Finding, type MCPToolNode, experienceHandles } from "@loom-ui/core";
import { type DriftRecord, terminalSteps } from "@loom-ui/hydration";
import { type TaintedValue, unwrapTainted } from "@loom/classify";
import { canonicalJson } from "@loom/core";
import type { CapabilityRef, DecideContext, PlanResult, ReviseInput } from "./spi";

// `remapOperation` (hydration's repair.ts) repairs INPUT drift mechanically — a new schema pin,
// no model involved — and refuses OUTPUT drift with `repair-needs-planner`: an output reshape can
// only be re-authored with judgment about what the node should now show. This module is the
// planner half of that sentence: it turns a `DriftRecord[]` into a revise request the reference
// planner (or any `Planner`) can act on, feeding it the observed shapes as fenced CONTEXT and,
// when captured, each handle's observed raw sample on `ReviseInput.observed` — keyed by HANDLE,
// because an observation belongs to one call (tool AND arguments), not to a tool@version.

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
/**
 * Only the calls that were OBSERVED can be pinned this round (`ReviseInput.observed`): a node on a
 * drifted tool with a new argument set has no output of its own to pin against and is dropped
 * (`sample-not-observed`), so the model is told up front rather than invited into it.
 */
const NO_NEW_CALLS =
  " Keep this binding's arguments: on a drifted tool, a new argument set has no observed output, so it is not bindable this round.";

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
      return `Provider "${d.handle}" (nodes: ${nodes.join(", ") || "none"}) drifted: its reshaped output no longer satisfies the value contract of kind "${d.contractKind}" (observed shape ${d.observed}). Current path: "${spec?.reshaping.scriptRef ?? ""}". The CONTEXT DATA block lists this handle's observed shapes (the reshaped one that failed the contract, and the raw output shape a path is authored against). Re-author the binding's path so the node shows the same quantity from the new output as a valid ${d.contractKind} value; keep the node id, label, type and props.${NO_NEW_CALLS}`;
    return d.kind === "output"
      ? `Provider "${d.handle}" (nodes: ${nodes.join(", ") || "none"}) drifted: its reshaped output no longer matches the pinned shape ${d.expected} (observed ${d.observed}). Current path: "${spec?.reshaping.scriptRef ?? ""}". The CONTEXT DATA block lists this handle's observed shapes (the reshaped one that failed the pin, and the raw output shape a path is authored against). Re-author the binding's path so the node shows the same quantity from the new output; keep the node id, label, type and props.${NO_NEW_CALLS}`
      : `Provider "${d.handle}" (nodes: ${nodes.join(", ") || "none"}) has an input-schema drift on step ${d.stepId ?? "?"} (${d.toolName ?? "?"}): expected ${d.expected}, observed ${d.observed}. Re-bind it with the offered capability for that tool.`;
  });
  return { text: `Repair drifted providers.\n\n${lines.join("\n\n")}`, scopeNodeIds: [...scope] };
}

/** One drift record's shapes, for the fenced CONTEXT block. Samples are NEVER included here. */
export interface DriftContextEntry {
  readonly handle: string;
  /** The drifted (terminal) step, when the record names one — so a planner need not recompute it. */
  readonly stepId?: string;
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
      ...(d.stepId !== undefined && { stepId: d.stepId }),
      expected: d.expected,
      observed: d.observed,
      ...(d.observedShape !== undefined && { observedShape: d.observedShape }),
      ...(d.observedRawShape !== undefined && { observedRawShape: d.observedRawShape }),
    }));
}

/**
 * Each output drift's observed RAW sample, keyed by the handle that produced it — the value for
 * `ReviseInput.observed`. Still tainted: it is tool-authored, and a planner that ever showed it to
 * a model would have to fence it. A handle whose records carry DISAGREEING samples is left out
 * rather than resolved to an arbitrary one; a record without a sample contributes nothing.
 */
export function observedSamples(
  drift: readonly DriftRecord[]
): Readonly<Record<string, TaintedValue<unknown>>> {
  const byHandle = new Map<string, TaintedValue<unknown>>();
  const conflicted = new Set<string>();
  for (const d of drift) {
    if (d.kind !== "output" || d.observedSample === undefined || conflicted.has(d.handle)) continue;
    const prior = byHandle.get(d.handle);
    if (
      prior !== undefined &&
      canonicalJson(unwrapTainted(prior)) !== canonicalJson(unwrapTainted(d.observedSample))
    ) {
      byHandle.delete(d.handle);
      conflicted.add(d.handle);
      continue;
    }
    if (prior === undefined) byHandle.set(d.handle, d.observedSample);
  }
  // `fromEntries` defines OWN properties, so a handle named like an Object.prototype key is data.
  return Object.fromEntries(byHandle);
}

/** A drifted step's identity for sample matching: the tool AND the arguments it was called with. */
const stepKey = (toolName: string, toolVersion: string, args: unknown): string =>
  `${toolName}@${toolVersion}#${canonicalJson(args)}`;

/**
 * The step a drift record's sample was actually taken from — never `executionGraph[0]`. A
 * provider inlines its dependencies as earlier steps and samples the TERMINAL step's output
 * (`executeProvider`), so the first step is only right by accident for a single-step provider.
 * `d.stepId` names it directly when the record carries one (set whenever the graph has exactly
 * one terminal); with several terminals the record has none, and the raw sample is a
 * stepId-keyed record rather than one tool's output, so no step can be resolved here either.
 */
function driftedStep(graph: readonly MCPToolNode[], d: DriftRecord): MCPToolNode | undefined {
  if (d.stepId !== undefined) return graph.find((s) => s.stepId === d.stepId);
  const terminals = terminalSteps(graph);
  return terminals.length === 1 ? terminals[0] : undefined;
}

/**
 * The FALLBACK for a planner that does not read `ReviseInput.observed`: give a drifted tool's
 * capability the UNWRAPPED RAW sample as its `sampleOutput` (the prompt re-fences it as data),
 * because a capability's `sampleOutput` is RAW by contract — `buildProviderSpec` reshapes it with
 * the draft's `path` to pin `outputShapeHash`, so a reshaped sample would pin the wrong shape.
 *
 * A capability has ONE sample, but an observation belongs to a HANDLE (one call: tool AND
 * arguments). So the swap happens only when the tool's drift amounts to a single observation:
 * every drifted step of that tool carries a sample and they all agree. When the drifted steps
 * disagree, or when one of them drifted WITHOUT a sample, the capability keeps its OWN sample —
 * handing it another handle's output would pin that sample-less handle against a call it never
 * made. `ReferencePlanner` does not rely on this: it pins each handle from `observed`.
 */
export function driftCapabilities(
  capabilities: readonly CapabilityRef[],
  exp: Experience,
  drift: readonly DriftRecord[]
): CapabilityRef[] {
  // tool@version → the distinct samples the drifted steps for that tool produced, by step key.
  const byTool = new Map<string, Map<string, unknown>>();
  // tool@version with at least one drifted step that carries NO sample.
  const unsampled = new Set<string>();
  for (const d of drift) {
    if (d.kind !== "output") continue;
    const graph = exp.providers[d.handle]?.executionGraph;
    const step = graph && driftedStep(graph, d);
    if (!step) continue;
    const tool = `${step.toolName}@${step.toolVersion}`;
    if (d.observedSample === undefined) {
      unsampled.add(tool);
      continue;
    }
    const perStep = byTool.get(tool) ?? new Map<string, unknown>();
    perStep.set(
      stepKey(step.toolName, step.toolVersion, step.arguments),
      unwrapTainted(d.observedSample)
    );
    byTool.set(tool, perStep);
  }
  return capabilities.map((c) => {
    const tool = `${c.toolName}@${c.toolVersion}`;
    const perStep = byTool.get(tool);
    if (perStep === undefined || perStep.size === 0 || unsampled.has(tool)) return c;
    const samples = [...perStep.values()];
    const first = samples[0];
    // Several argument sets drifted for this tool: only take the sample when they agree.
    if (samples.some((s) => canonicalJson(s) !== canonicalJson(first))) return c;
    return { ...c, sampleOutput: first };
  });
}

/**
 * A drifted handle with NO sample of its own, on a tool other handles DID observe — under a
 * different call, so no observation is its own. It is reported, not guessed: pinning it against
 * another call's output would record a wrong repair as proven. (A sample-less drift on a tool
 * nobody observed is the ordinary case — the planner re-authors from the shapes in `context`.)
 */
export function unsampledDrift(exp: Experience, drift: readonly DriftRecord[]): Finding[] {
  const observedTools = new Set<string>();
  const observedCalls = new Set<string>();
  const steps = drift.map((d) => {
    const graph = exp.providers[d.handle]?.executionGraph;
    const step = d.kind === "output" && graph ? driftedStep(graph, d) : undefined;
    if (step && d.observedSample !== undefined) {
      observedTools.add(`${step.toolName}@${step.toolVersion}`);
      observedCalls.add(stepKey(step.toolName, step.toolVersion, step.arguments));
    }
    return step;
  });
  const findings: Finding[] = [];
  drift.forEach((d, i) => {
    const step = steps[i];
    if (step === undefined || d.observedSample !== undefined) return;
    const tool = `${step.toolName}@${step.toolVersion}`;
    if (!observedTools.has(tool)) return;
    if (observedCalls.has(stepKey(step.toolName, step.toolVersion, step.arguments))) return;
    findings.push({
      code: "drift-sample-missing",
      severity: "warn",
      message: `provider "${d.handle}" drifted without an observed sample of its own, while other providers on ${tool} observed a different call; it is not repaired from their output — re-run it with captureSample to repair it`,
    });
  });
  return findings;
}

/**
 * What `reviseForDrift` needs of a planner: its `revise`. Generic over the result that `revise`
 * returns, so a planner whose revision carries MORE than a `PlanResult` (say, artifacts the caller
 * must persist beside the ops) gets its own result type back — every `Planner` satisfies
 * `DriftReviser<PlanResult>`.
 */
export interface DriftReviser<R extends PlanResult = PlanResult> {
  revise(input: ReviseInput, ctx: DecideContext): Promise<R>;
}

/**
 * Repair a drifted experience: build the revise request (`driftRequest`), the fenced drift shapes
 * (`driftContext`, beside the caller's own `context` under `caller`), the per-handle samples
 * (`observedSamples`, on `ReviseInput.observed`) and the fallback capabilities
 * (`driftCapabilities`), call `planner.revise` once, and append `unsampledDrift`'s findings.
 * Resolves to the planner's OWN result (`R`) — every field it returned is kept; only `findings`
 * may grow. A custom planner that does not go through this function reproduces it from those
 * five exported helpers.
 */
export async function reviseForDrift<R extends PlanResult>(
  planner: DriftReviser<R>,
  input: {
    experience: Experience;
    drift: readonly DriftRecord[];
    catalog: ReviseInput["catalog"];
    capabilities: readonly CapabilityRef[];
    context?: unknown;
    surface?: ReviseInput["surface"];
  },
  ctx: DecideContext
): Promise<R> {
  // The caller's own context, when it has one, is nested under `caller` so the drift shapes can
  // never overwrite a key it owns (and so `context` stays one fenced DATA block, not two).
  const context = {
    drift: driftContext(input.drift),
    ...(input.context !== undefined && { caller: input.context }),
  };
  const observed = observedSamples(input.drift);
  const result = await planner.revise(
    {
      experience: input.experience,
      request: driftRequest(input.experience, input.drift),
      catalog: input.catalog,
      capabilities: driftCapabilities(input.capabilities, input.experience, input.drift),
      context,
      ...(Object.keys(observed).length > 0 && { observed }),
      ...(input.surface !== undefined && { surface: input.surface }),
    },
    ctx
  );
  const missing = unsampledDrift(input.experience, input.drift);
  return missing.length === 0 ? result : { ...result, findings: [...result.findings, ...missing] };
}
