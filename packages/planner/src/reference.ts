import {
  type Experience,
  type Finding,
  type Intent,
  type Operation,
  boundSummary,
  experienceClassFloor,
  genesis,
  loomCatalogFor,
  replay,
  strictestClass,
  validateExperience,
} from "@loom-ui/core";
import { unwrapTainted } from "@loom/classify";
import { declaredToolClassesFrom } from "./capabilityClass";
import { type DraftNode, draftNodeSchema, parseModelJson, planSchema } from "./contract";
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
  PlanPartial,
  PlanReport,
  PlanResult,
  PlanStreamOptions,
  Planner,
  PlannerDeltaSink,
  PlannerModel,
  PlannerUsage,
  ReviseInput,
} from "./spi";
import { NodeScanner } from "./streamScan";
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
  /**
   * An AUTHOR id (a replica / agent / session id) mixed into the order keys of the nodes this
   * planner inserts. Planners that write concurrently into one experience should each pass a
   * DISTINCT value, so their appends into the same gap get distinct keys instead of tying.
   * It identifies an author, not an insert: one planner inserting twice into one gap mints the
   * same key twice (a tie, resolved at render by node id). Omitted = unsalted legacy keys,
   * and the planner's output is byte-identical to before this option existed.
   */
  readonly orderSalt?: string;
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

/** Settles with `p`, or rejects as soon as `signal` aborts (the call keeps running unobserved). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    if (signal.aborted) {
      p.catch(() => {}); // the call is abandoned: its late failure is nobody's
      return onAbort();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

const abortError = (signal: AbortSignal | undefined): Error => {
  const reason = (signal as { reason?: unknown } | undefined)?.reason;
  const e = new Error(reason instanceof Error ? reason.message : "the planner turn was aborted");
  e.name = "AbortError"; // a control-plane name: rethrown, never recorded as the decision
  return e;
};
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

  compose(
    input: ComposeInput,
    ctx: DecideContext,
    stream: PlanStreamOptions = {}
  ): Promise<PlanResult> {
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
          undefined,
          stream
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

  revise(
    input: ReviseInput,
    ctx: DecideContext,
    stream: PlanStreamOptions = {}
  ): Promise<PlanResult> {
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
          input.request,
          stream
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
      contextClass?: ComposeInput["contextClass"];
      /** Revise only: per-handle observed samples — each rebuilt provider pins from its own call's. */
      observed?: ReviseInput["observed"];
    },
    messagesFor: (prev?: PreviousError) => {
      system: string;
      messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
    },
    request: ReviseInput["request"] | undefined,
    stream: PlanStreamOptions
  ): Promise<PlanResult> {
    const { signal, onPartial } = stream;
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
    const salt = this.opts.orderSalt === undefined ? {} : { orderSalt: this.opts.orderSalt };
    // Ops as the plan hands them out: a revise wraps its primitives in ONE `prompt` op.
    const wrap = (ops: Operation[]): Operation[] =>
      request === undefined
        ? ops
        : [
            {
              type: "prompt",
              text: request.text,
              ...(request.scopeNodeIds && { scopeNodeIds: [...request.scopeNodeIds] }),
              materialized: ops,
            },
          ];
    // Partials only when someone listens; the model call is ONE governed call either way.
    const nodeSchema =
      onPartial === undefined ? undefined : draftNodeSchema(input.catalog, input.capabilities);
    const emit = (p: PlanPartial) => {
      try {
        onPartial?.(p);
      } catch {
        // a broken consumer must not fail (or record) a plan
      }
    };
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      let content: string;
      let reply: object;
      // A cancelled turn is the control plane speaking: reject, record nothing, call nothing.
      if (signal?.aborted) throw abortError(signal);
      try {
        let onDelta: PlannerDeltaSink | undefined;
        let malformed: string | undefined;
        if (nodeSchema !== undefined) {
          if (attempt > 0) emit({ attempt, ops: [], findings: [], nodes: 0 });
          const scanner = new NodeScanner();
          let accepted: DraftNode[] = [];
          let seen = new Set<string>();
          onDelta = (d) => {
            if (signal?.aborted || malformed !== undefined) return;
            if (typeof d !== "object" || d === null) {
              malformed = "a delta chunk that is not an object";
              return;
            }
            if (d.reset === true) {
              // The call is retrying: what it showed so far is void.
              scanner.reset();
              accepted = [];
              seen = new Set();
              emit({ attempt, ops: [], findings: [], nodes: 0 });
              return;
            }
            let text: unknown;
            try {
              text = unwrapTainted(d.delta);
            } catch {
              text = undefined;
            }
            if (d.done === true && (text === "" || text === undefined)) return;
            if (typeof text !== "string") {
              malformed = "a delta whose text is not a string";
              return;
            }
            if (text === "") return;
            let grew = false;
            for (const raw of scanner.feed(text)) {
              const n = nodeSchema.safeParse(raw);
              // An invalid or repeated node is not shown; the FINAL parse of the whole reply
              // reports it (and drives the retry), exactly as without partials.
              if (!n.success || seen.has(n.data.id)) continue;
              seen.add(n.data.id);
              accepted.push(n.data);
              grew = true;
            }
            if (!grew) return;
            const m = materialize(
              { summary: "(streaming)", nodes: accepted },
              base,
              input.catalog,
              input.capabilities,
              input.observed,
              salt
            );
            const ops = wrap(m.ops);
            const applied = replay(base, ops);
            const found = [
              ...m.findings,
              ...(applied.ok
                ? validateExperience(applied.value, input.catalog, surface).findings
                : [applied.finding]),
            ];
            // The same bar as a final plan: a partial with any error is not shown.
            if (errorsOf(found).length > 0 || m.ops.length === 0) return;
            emit({ attempt, ops, findings: found, nodes: accepted.length });
          };
        }
        const opts =
          signal === undefined && onDelta === undefined
            ? undefined
            : {
                ...(signal !== undefined && { signal }),
                ...(onDelta !== undefined && { onDelta }),
              };
        // Race the call against the abort: a model that ignores the signal must not hold the turn.
        const r = await raceAbort(model.complete(messagesFor(previous), opts), signal);
        if (malformed !== undefined) throw new Error(`the model streamed ${malformed}`);
        content = r.content;
        reply = r;
        if (signal?.aborted) throw abortError(signal); // an abort that landed during the call
      } catch (e) {
        if (signal?.aborted) throw abortError(signal);
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
      const m = materialize(
        parsed.value,
        base,
        input.catalog,
        input.capabilities,
        input.observed,
        salt
      );
      const findings: Finding[] = [...usageFindings, ...m.findings];
      const applied = replay(base, m.ops);
      if (!applied.ok) findings.push(applied.finding);
      else findings.push(...validateExperience(applied.value, input.catalog, surface).findings);
      attempts.push(trace({ parsed: true, findings }));
      lastFindings = findings;
      if (errorsOf(findings).length === 0) {
        const report = this.report(decisionId, attempts, attempts.length === 1);
        // The summary was written from the whole of `base`, the capabilities offered (their
        // samples reach the prompt whether or not the plan binds them) and the caller's context;
        // the plan it describes is `applied`. Stamp the strictest class of all of them.
        // The floors include the capabilities' declared tool classes, so a node stored unclassified
        // on a declared-secret tool still raises the summary's stamp.
        const declaredFloor = declaredToolClassesFrom(input.capabilities);
        let summaryClass = strictestClass(
          strictestClass(experienceClassFloor(base, undefined, declaredFloor), input.contextClass),
          applied.ok ? experienceClassFloor(applied.value, undefined, declaredFloor) : undefined
        );
        for (const c of input.capabilities)
          summaryClass = strictestClass(summaryClass, c.sensitivity);
        // FAIL CLOSED: a sample with no declared class and no host `contextClass` is content of
        // unknown class in the prompt; a guess would be a stamp, so the summary is withheld.
        const unclassified =
          input.contextClass === undefined &&
          input.capabilities.some(
            (c) => c.sampleOutput !== undefined && c.sensitivity === undefined
          );
        const summary = unclassified ? undefined : boundSummary(parsed.value.summary);
        if (unclassified && parsed.value.summary !== undefined)
          findings.push(
            warn(
              "summary-withheld",
              "the summary was withheld: an offered capability carries a sampleOutput with no `sensitivity` and no `contextClass` was declared"
            )
          );
        const said =
          summary === undefined
            ? {}
            : { summary, ...(summaryClass !== undefined && { summaryClass }) };
        if (request === undefined) return { ops: m.ops, findings, report, ...said };
        return {
          ops: wrap(m.ops),
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
          ...said,
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
