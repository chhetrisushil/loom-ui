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
import { planDecisionId } from "./decision";
import { materialize } from "./materialize";
import { type PreviousError, composeMessages, reviseMessages } from "./prompt";
import type {
  AttemptTrace,
  ComposeInput,
  DecideContext,
  PlanReport,
  PlanResult,
  Planner,
  PlannerModel,
  ReviseInput,
} from "./spi";

export const REFERENCE_POLICY = { id: "loom-ui.reference-planner", version: "1.0.0" } as const;
export const REFERENCE_SOURCE = "loom-ui.planner.reference";

export interface ReferencePlannerOptions {
  readonly model: PlannerModel;
  /** Recorded in every report so the caller can stamp `Provenance.modelId`. */
  readonly modelId: string;
  /** Model calls per plan, parse and validation retries included. Default 2. */
  readonly maxAttempts?: number;
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
const errorsOf = (fs: readonly Finding[]) => fs.filter((f) => f.severity === "error");

export class ReferencePlanner implements Planner {
  private readonly maxAttempts: number;
  constructor(private readonly opts: ReferencePlannerOptions) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  }

  compose(input: ComposeInput, ctx: DecideContext): Promise<PlanResult> {
    const decisionId = planDecisionId("compose", input);
    return ctx.decide(
      decisionId,
      () =>
        this.plan(
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
      () =>
        this.plan(
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
    decisionId: string,
    base: Experience,
    input: {
      catalog: ComposeInput["catalog"];
      capabilities: ComposeInput["capabilities"];
      surface?: ComposeInput["surface"];
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
    const schema = planSchema(input.catalog, input.capabilities);
    const attempts: AttemptTrace[] = [];
    let previous: PreviousError | undefined;
    let lastFindings: Finding[] = [];
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      let content: string;
      try {
        content = (await this.opts.model.complete(messagesFor(previous))).content;
      } catch (e) {
        const f = err(
          "model-error",
          `model call failed: ${e instanceof Error ? e.message : String(e)}`
        );
        attempts.push({ parsed: false, findings: [f] });
        lastFindings = [f];
        previous = { error: f.message, raw: "" };
        continue;
      }
      const parsed = parseModelJson(schema, content);
      if (!parsed.ok) {
        const f = err("model-output-invalid", parsed.error);
        attempts.push({ parsed: false, findings: [f] });
        lastFindings = [f];
        previous = { error: parsed.error, raw: parsed.raw };
        continue;
      }
      const m = materialize(parsed.value, base, input.catalog, input.capabilities);
      const findings: Finding[] = [...m.findings];
      const applied = replay(base, m.ops);
      if (!applied.ok) findings.push(applied.finding);
      else findings.push(...validateExperience(applied.value, input.catalog, surface).findings);
      attempts.push({ parsed: true, findings });
      lastFindings = findings;
      if (errorsOf(findings).length === 0) {
        const report: PlanReport = {
          decisionId,
          attempts,
          firstAttemptValid: attempts.length === 1,
          modelId: this.opts.modelId,
        };
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
    const report: PlanReport = {
      decisionId,
      attempts,
      firstAttemptValid: false,
      modelId: this.opts.modelId,
    };
    return {
      ops: [],
      findings: [
        ...lastFindings,
        err("plan-failed", `no valid plan after ${this.maxAttempts} attempt(s)`),
      ],
      report,
    };
  }
}
