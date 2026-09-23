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
import type {
  CapabilityRef,
  ComposeInput,
  DecideContext,
  PlanReport,
  Planner,
  PlannerUsage,
  ReviseInput,
} from "./spi";
import { snapshotUsage, totalUsage } from "./usage";

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

/**
 * A `PlanReport` is what a caller stamps provenance from and what a prompt regression is measured
 * on, so it is part of the contract, not decoration. Three claims must hold or the numbers lie:
 * at least one attempt was made (a plan nobody attempted is not a plan), the model is NAMED, and
 * `firstAttemptValid` agrees with the attempts it summarises — it means "clean on the first call",
 * which is exactly "there was one attempt and every attempt parsed". When `usage` is present it
 * must be two non-negative integers and, if any attempt reports usage, their sum.
 */
/** One read of a `usage` field: absent, a validated fresh copy, or invalid (by kind, never content). */
type UsageRead =
  | { readonly state: "none" }
  | { readonly state: "valid"; readonly usage: PlannerUsage }
  | { readonly state: "invalid" };

/**
 * Reads `holder.usage` exactly ONCE, inside a guard, and snapshots it: a throwing or changing
 * getter cannot escape the kit or validate as one value and be compared as another. Callers use
 * only the returned snapshot afterwards. Never throws.
 */
function readUsage(holder: { readonly usage?: PlannerUsage }): UsageRead {
  let raw: unknown;
  try {
    raw = holder.usage;
  } catch {
    return { state: "invalid" };
  }
  if (raw === undefined) return { state: "none" };
  const usage = snapshotUsage(raw);
  return usage === undefined ? { state: "invalid" } : { state: "valid", usage };
}

/** `usage` is `report.usage` as already read once by {@link readUsage}; the report's own field is never re-read. */
function reportFindings(label: string, report: PlanReport, usage: UsageRead): Finding[] {
  const findings: Finding[] = [];
  if (report.attempts.length < 1)
    findings.push(err("report-invalid", `${label}: report.attempts is empty`));
  if (report.modelId === "")
    findings.push(err("report-invalid", `${label}: report.modelId is empty`));
  const clean = report.attempts.length === 1 && report.attempts.every((a) => a.parsed);
  if (report.firstAttemptValid !== clean)
    findings.push(
      err(
        "report-invalid",
        `${label}: firstAttemptValid is ${report.firstAttemptValid} but ${report.attempts.length} attempt(s) ${report.attempts.every((a) => a.parsed) ? "all parsed" : "did not all parse"}`
      )
    );
  // Each attempt's usage is read ONCE, inside a guard, and only a validated copy is summed: an
  // adapter controls these values, and the kit's contract is that it never throws. A refusal
  // names the attempt, never the value's content.
  const attemptUsages: { usage?: PlannerUsage }[] = [];
  let attemptsValid = true;
  report.attempts.forEach((a, i) => {
    const read = readUsage(a);
    if (read.state === "invalid") {
      attemptsValid = false;
      findings.push(
        err(
          "report-invalid",
          `${label}: attempt #${i} usage is not two non-negative integer token counts`
        )
      );
      return;
    }
    attemptUsages.push(read.state === "valid" ? { usage: read.usage } : {});
  });
  if (usage.state === "invalid")
    findings.push(
      err("report-invalid", `${label}: report.usage is not two non-negative integer token counts`)
    );
  else if (usage.state === "valid" && attemptsValid) {
    const total = usage.usage;
    const sum = totalUsage(attemptUsages);
    if (
      sum !== undefined &&
      (sum.inputTokens !== total.inputTokens || sum.outputTokens !== total.outputTokens)
    )
      findings.push(
        err(
          "report-invalid",
          `${label}: report.usage (${total.inputTokens}/${total.outputTokens}) is not the sum of its attempts' usage (${sum.inputTokens}/${sum.outputTokens})`
        )
      );
  }
  return findings;
}

/** A comparable key for one {@link readUsage} snapshot. Pure: it reads nothing from the planner. */
const usageKey = (u: UsageRead): string =>
  u.state === "valid" ? `${u.usage.inputTokens}/${u.usage.outputTokens}` : u.state;

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
  const firstUsage = readUsage(first.report);
  findings.push(...reportFindings("compose", first.report, firstUsage));
  first.ops.forEach((op, i) => {
    if (!Operation.safeParse(op).success)
      findings.push(err("op-invalid", `compose op #${i} is not an Operation`));
  });
  // Only an INVALID OP stops the kit here: nothing below can replay ops that are not operations.
  // A `report-invalid` finding is collected and the rest of the contract is still checked.
  if (findings.some((f) => f.code === "op-invalid")) return findings;
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
  // Usage is part of the DECIDED value: a replay that serves the ops but re-derives (or drops)
  // the report would give a caller two different token totals for one plan.
  const secondKey = usageKey(readUsage(second.report));
  const firstKey = usageKey(firstUsage);
  if (secondKey !== firstKey)
    findings.push(
      err(
        "usage-not-replayed",
        `a second compose on the same recording context reported usage ${secondKey}, the first ${firstKey}; record usage inside the decision`
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
  findings.push(...reportFindings("revise", revised.report, readUsage(revised.report)));
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
