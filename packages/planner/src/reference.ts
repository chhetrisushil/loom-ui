import {
  type Experience,
  type Finding,
  type Intent,
  type Operation,
  genesis,
  loomCatalogFor,
  replay,
  validateExperience,
} from "@loom-ui/core";
import { parseModelJson, planSchema } from "./contract";
import { isControlPlaneError } from "./controlPlane";
import { planDecisionId } from "./decision";
import { materialize } from "./materialize";
import { type PreviousError, composeMessages, reviseMessages } from "./prompt";
import { type PlannerReach, declarePlannerReach } from "./reach";
import type {
  AttemptTrace,
  ComposeInput,
  DecideContext,
  DecideScope,
  PlanReport,
  PlanResult,
  Planner,
  PlannerModel,
  PlannerUsage,
  ReviseInput,
} from "./spi";
import { addUsage, readReportedUsage, totalUsage } from "./usage";

export const REFERENCE_POLICY = { id: "loom-ui.reference-planner", version: "1.0.0" } as const;
export const REFERENCE_SOURCE = "loom-ui.planner.reference";

export interface ReferencePlannerOptions {
  /**
   * The model, or a factory called with the decider's {@link DecideScope} once per decision — so a
   * model whose calls go through `scope.invokeTransient` (e.g. via `scopeInvoker`) runs as the
   * deciding execution. A plain model ignores the scope.
   */
  readonly model: PlannerModel | ((scope: DecideScope) => PlannerModel);
  /** Recorded in every report so the caller can stamp `Provenance.modelId`. */
  readonly modelId: string;
  /** Model calls per plan, parse and validation retries included. Default 2. */
  readonly maxAttempts?: number;
  /**
   * What this planner's deciders reach, declared for `@loom/verify` (loom L32): the toolIds the
   * `model` factory calls through `scope.invokeTransient` (e.g. `{ transient: ["llm.complete"] }`).
   * Only the caller knows them — the model is user-supplied. Omitted means NO declaration, so
   * verify reports the hand-off as unresolved rather than trusting a partial claim.
   */
  readonly reach?: PlannerReach;
}

/** Ops are id-based and every genesis has the same root, so validation can run against a scratch lineage. */
export function scratchGenesis(intent: Intent): Experience {
  return genesis({
    experienceId: "scratch",
    intent,
    meta: { author: "planner", createdAt: "1970-01-01T00:00:00Z", sourceKind: "scratch" },
  });
}

const err = (code: string, message: string): Finding => ({ code, severity: "error", message });
const warn = (code: string, message: string): Finding => ({ code, severity: "warn", message });
const errorsOf = (fs: readonly Finding[]) => fs.filter((f) => f.severity === "error");

export class ReferencePlanner implements Planner {
  private readonly maxAttempts: number;
  constructor(private readonly opts: ReferencePlannerOptions) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
    if (opts.reach !== undefined) declarePlannerReach(this, opts.reach);
  }

  private modelFor(scope: DecideScope): PlannerModel {
    const m = this.opts.model;
    return typeof m === "function" ? m(scope) : m;
  }

  private report(
    decisionId: string,
    attempts: readonly AttemptTrace[],
    firstAttemptValid: boolean
  ): PlanReport {
    const usage = totalUsage(attempts);
    return {
      decisionId,
      attempts,
      firstAttemptValid,
      modelId: this.opts.modelId,
      ...(usage !== undefined && { usage }),
    };
  }

  compose(input: ComposeInput, ctx: DecideContext): Promise<PlanResult> {
    const decisionId = planDecisionId("compose", input);
    return ctx.decide(
      decisionId,
      (scope) =>
        this.plan(
          () => this.modelFor(scope),
          decisionId,
          scratchGenesis(input.intent),
          input,
          (prev) => composeMessages(input, prev),
          undefined
        ),
      {
        source: REFERENCE_SOURCE,
        policy: REFERENCE_POLICY,
        context: {
          kind: "compose",
          catalogId: input.catalog.id,
          types: input.catalog.entries.length,
          capabilities: input.capabilities.length,
        },
      }
    );
  }

  revise(input: ReviseInput, ctx: DecideContext): Promise<PlanResult> {
    const decisionId = planDecisionId("revise", {
      versionHash: input.experience.versionHash,
      request: input.request,
      catalog: input.catalog,
      capabilities: input.capabilities,
      ...(input.context !== undefined && { context: input.context }),
      ...(input.surface !== undefined && { surface: input.surface }),
      ...(input.observed !== undefined && { observedHandles: Object.keys(input.observed) }),
    });
    if (input.experience.versionHash === "") {
      const report: PlanReport = {
        decisionId,
        attempts: [],
        firstAttemptValid: false,
        modelId: this.opts.modelId,
      };
      return Promise.resolve({
        ops: [],
        findings: [
          err(
            "unsealed-base",
            "revise needs a sealed experience (versionHash is empty); seal it first"
          ),
        ],
        report,
      });
    }
    return ctx.decide(
      decisionId,
      (scope) =>
        this.plan(
          () => this.modelFor(scope),
          decisionId,
          input.experience,
          input,
          (prev) => reviseMessages(input, prev),
          input.request
        ),
      {
        source: REFERENCE_SOURCE,
        policy: REFERENCE_POLICY,
        context: {
          kind: "revise",
          catalogId: input.catalog.id,
          base: input.experience.versionHash,
          scope: input.request.scopeNodeIds?.length ?? 0,
        },
      }
    );
  }

  /** The bounded loop. `request` present ⇒ revise: the primitives are wrapped in one `prompt` op. */
  private async plan(
    makeModel: () => PlannerModel,
    decisionId: string,
    base: Experience,
    input: {
      catalog: ComposeInput["catalog"];
      capabilities: ComposeInput["capabilities"];
      surface?: ComposeInput["surface"];
      /** Revise only: per-handle observed samples — each rebuilt provider pins from its own call's. */
      observed?: ReviseInput["observed"];
    },
    messagesFor: (prev?: PreviousError) => {
      system: string;
      messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
    },
    request: ReviseInput["request"] | undefined
  ): Promise<PlanResult> {
    const surface = input.surface ?? "web";
    // A catalogue whose entries cannot produce a loom widget catalogue for this surface is a
    // DEFECT IN THE INPUT, not a bad draft: no reply the model could write would satisfy the
    // contract, so calling it (and retrying it) only burns tokens to arrive at the same refusal.
    // Checked once, before the first call, and returned without a single attempt.
    const catalogFindings = loomCatalogFor(input.catalog, surface).findings.filter(
      (f) => f.severity === "error"
    );
    if (catalogFindings.length > 0)
      return {
        ops: [],
        findings: [
          ...catalogFindings,
          err(
            "catalog-invalid",
            `catalogue "${input.catalog.id}" does not resolve to a valid loom catalogue on "${surface}"; the model was not called`
          ),
        ],
        report: {
          decisionId,
          attempts: [],
          firstAttemptValid: false,
          modelId: this.opts.modelId,
        },
      };
    // The factory is part of "calling the model": its throw is a model-error finding, same as a
    // throwing `complete()`. Called once per decision (never on replay) and not retried — a
    // factory that throws will throw again, so a retry only repeats the failure.
    let model: PlannerModel;
    try {
      model = makeModel();
    } catch (e) {
      if (isControlPlaneError(e)) throw e; // see ./controlPlane: never recorded as the decision
      const f = err(
        "model-error",
        `model construction failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return {
        ops: [],
        findings: [f, err("plan-failed", "no valid plan: the model could not be constructed")],
        report: this.report(decisionId, [{ parsed: false, findings: [f] }], false),
      };
    }
    const schema = planSchema(input.catalog, input.capabilities);
    const attempts: AttemptTrace[] = [];
    let previous: PreviousError | undefined;
    let lastFindings: Finding[] = [];
    // Running total of the usage recorded so far; guards the plan total against overflow.
    let spent: PlannerUsage = { inputTokens: 0, outputTokens: 0 };
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      let content: string;
      let reply: object;
      try {
        const r = await model.complete(messagesFor(previous));
        content = r.content;
        reply = r;
      } catch (e) {
        if (isControlPlaneError(e)) throw e; // no retry, no recorded failed plan
        const f = err(
          "model-error",
          `model call failed: ${e instanceof Error ? e.message : String(e)}`
        );
        attempts.push({ parsed: false, findings: [f] });
        lastFindings = [f];
        previous = { error: f.message, raw: "" };
        continue;
      }
      // Never throws: an adapter's bad usage is a warning on this attempt, not a failed call.
      let usage: PlannerUsage | undefined;
      const usageFindings: Finding[] = [];
      const read = readReportedUsage(reply);
      if (read.problem !== undefined)
        usageFindings.push(
          warn(
            "usage-invalid",
            `the model reported usage that is not two non-negative integer token counts (${read.problem}); it is not recorded`
          )
        );
      else if (read.usage !== undefined) {
        // Refused rather than saturated: the plan total must stay the EXACT sum of the
        // recorded attempts, and itself a valid PlannerUsage.
        const added = addUsage(spent, read.usage);
        if (added.refused !== undefined)
          usageFindings.push(
            warn(
              "usage-invalid",
              `the model reported usage that ${added.refused}; it is not recorded`
            )
          );
        else {
          usage = read.usage;
          spent = added.total;
        }
      }
      const trace = (t: AttemptTrace): AttemptTrace => (usage === undefined ? t : { ...t, usage });
      const parsed = parseModelJson(schema, content);
      if (!parsed.ok) {
        const f = err("model-output-invalid", parsed.error);
        attempts.push(trace({ parsed: false, findings: [f, ...usageFindings] }));
        lastFindings = [f, ...usageFindings];
        previous = { error: parsed.error, raw: parsed.raw };
        continue;
      }
      const m = materialize(parsed.value, base, input.catalog, input.capabilities, input.observed);
      const findings: Finding[] = [...usageFindings, ...m.findings];
      const applied = replay(base, m.ops);
      if (!applied.ok) findings.push(applied.finding);
      else findings.push(...validateExperience(applied.value, input.catalog, surface).findings);
      attempts.push(trace({ parsed: true, findings }));
      lastFindings = findings;
      if (errorsOf(findings).length === 0) {
        const report = this.report(decisionId, attempts, attempts.length === 1);
        if (request === undefined) return { ops: m.ops, findings, report };
        const prompt: Operation = {
          type: "prompt",
          text: request.text,
          ...(request.scopeNodeIds && { scopeNodeIds: [...request.scopeNodeIds] }),
          materialized: m.ops,
        };
        return {
          ops: [prompt],
          findings:
            m.ops.length === 0
              ? [
                  ...findings,
                  {
                    code: "no-change",
                    severity: "warn",
                    message:
                      "the revision produced no operations; the prompt is recorded with an empty materialisation",
                  },
                ]
              : findings,
          report,
        };
      }
      previous = {
        error: errorsOf(findings)
          .map((f) => `${f.nodeId ? `${f.nodeId}: ` : ""}${f.code}: ${f.message}`)
          .join("\n"),
        raw: "",
      };
    }
    return {
      ops: [],
      findings: [
        ...lastFindings,
        err("plan-failed", `no valid plan after ${this.maxAttempts} attempt(s)`),
      ],
      report: this.report(decisionId, attempts, false),
    };
  }
}
