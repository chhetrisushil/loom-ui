import {
  type Experience,
  type Finding,
  Operation,
  experienceNodeIds,
  genesis,
  isContainer,
  preservesNodes,
  replay,
  validateExperience,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import type { CapabilityRef, ComposeInput, DecideContext, Planner, ReviseInput } from "./spi";

export interface ConformanceFixture {
  readonly intent: ComposeInput["intent"];
  readonly catalog: ComposeInput["catalog"];
  readonly capabilities: readonly CapabilityRef[];
  readonly meta: Experience["meta"];
  readonly revision: {
    readonly text: string;
    readonly scopeNodeIds?: readonly string[];
    readonly expectRemoval?: boolean;
  };
  /** A RECORDING context: the kit calls compose twice and expects the second to be served. */
  readonly ctx: DecideContext;
  /** Counts model calls; when given, the kit asserts the second compose adds none. */
  readonly modelCalls?: () => number;
  readonly surface?: ComposeInput["surface"];
}

const err = (code: string, message: string): Finding => ({ code, severity: "error", message });

/** True when calling into the planner itself threw instead of returning a `PlanResult`. */
async function safely<T>(
  label: string,
  run: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; finding: Finding }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      finding: err(
        "planner-threw",
        `${label} threw instead of returning: ${error instanceof Error ? error.message : String(error)}`
      ),
    };
  }
}

/**
 * What ANY planner must hold (spec §7.1): ops not experiences; ops that validate; a revise that is
 * one prompt op whose primitives reproduce the same artifact; a decision that replays without the
 * model. Returns findings — a test asserts the list is empty. Never throws: a planner that throws
 * is reported as a `planner-threw` finding, same as any other misbehaviour.
 */
export async function checkPlannerConformance(
  planner: Planner,
  fx: ConformanceFixture
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const surface = fx.surface ?? "web";
  const g = genesis({ experienceId: "conformance", intent: fx.intent, meta: fx.meta });
  const composeInput: ComposeInput = {
    intent: fx.intent,
    catalog: fx.catalog,
    capabilities: fx.capabilities,
    surface,
  };

  const firstAttempt = await safely("compose", () => planner.compose(composeInput, fx.ctx));
  if (!firstAttempt.ok) return [firstAttempt.finding];
  const first = firstAttempt.value;
  first.ops.forEach((op, i) => {
    if (!Operation.safeParse(op).success)
      findings.push(err("op-invalid", `compose op #${i} is not an Operation`));
  });
  if (findings.length > 0) return findings;
  const composed = replay(g, first.ops);
  if (!composed.ok) return [err("compose-replay-failed", composed.finding.message)];
  const v = validateExperience(composed.value, fx.catalog, surface);
  if (!v.ok)
    findings.push(
      ...v.findings
        .filter((f) => f.severity === "error")
        .map((f) => ({ ...f, code: `compose-invalid:${f.code}` }))
    );
  if (!isContainer(composed.value.root) || composed.value.root.children.length === 0)
    findings.push(err("compose-empty", "compose produced no nodes"));

  const before = fx.modelCalls?.() ?? 0;
  const secondAttempt = await safely("compose (second call)", () =>
    planner.compose(composeInput, fx.ctx)
  );
  if (!secondAttempt.ok) return [...findings, secondAttempt.finding];
  const second = secondAttempt.value;
  if (JSON.stringify(second.ops) !== JSON.stringify(first.ops))
    findings.push(
      err(
        "replay-diverged",
        "a second compose on the same recording context returned different ops"
      )
    );
  if (fx.modelCalls !== undefined && fx.modelCalls() !== before)
    findings.push(
      err(
        "replay-recalled-model",
        "a second compose on the same recording context called the model again"
      )
    );

  const base = seal(composed.value);
  const reviseAttempt = await safely("revise", () =>
    planner.revise(
      {
        experience: base,
        request: {
          text: fx.revision.text,
          ...(fx.revision.scopeNodeIds && { scopeNodeIds: [...fx.revision.scopeNodeIds] }),
        },
        catalog: fx.catalog,
        capabilities: fx.capabilities,
        surface,
      } satisfies ReviseInput,
      fx.ctx
    )
  );
  if (!reviseAttempt.ok) return [...findings, reviseAttempt.finding];
  const revised = reviseAttempt.value;
  if (revised.ops.length !== 1 || revised.ops[0]?.type !== "prompt") {
    findings.push(
      err(
        "revise-not-prompt",
        `revise returned ${revised.ops.length} op(s) of type(s) ${revised.ops.map((o) => o.type).join(",") || "none"}; expected exactly one prompt op`
      )
    );
    return findings;
  }
  const prompt = revised.ops[0];
  if (!Operation.safeParse(prompt).success)
    return [...findings, err("op-invalid", "revise's prompt op is not an Operation")];
  const viaPrompt = replay(base, [prompt]);
  const viaPrimitives = replay(base, prompt.materialized);
  if (!viaPrompt.ok) return [...findings, err("prompt-replay-failed", viaPrompt.finding.message)];
  if (!viaPrimitives.ok)
    return [...findings, err("prompt-replay-failed", viaPrimitives.finding.message)];
  if (seal(viaPrompt.value).versionHash !== seal(viaPrimitives.value).versionHash)
    findings.push(
      err(
        "prompt-replay-mismatch",
        "replaying the prompt op and replaying its materialized primitives yield different artifacts"
      )
    );
  const rv = validateExperience(viaPrompt.value, fx.catalog, surface);
  if (!rv.ok)
    findings.push(
      ...rv.findings
        .filter((f) => f.severity === "error")
        .map((f) => ({ ...f, code: `revise-invalid:${f.code}` }))
    );
  const identity = preservesNodes(experienceNodeIds(base), experienceNodeIds(viaPrompt.value));
  if (!identity.ok && fx.revision.expectRemoval !== true)
    findings.push(...identity.findings.map((f) => ({ ...f, code: "dropped-node" as const })));
  return findings;
}
