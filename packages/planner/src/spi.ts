import type {
  ContainerRoleSpec,
  Experience,
  Finding,
  Intent,
  Operation,
  SemanticCatalog,
  Surface,
} from "@loom-ui/core";
import { type DataClass, type TaintedValue, isTainted } from "@loom/classify";
import type { RolloutStamp } from "@loom/learning";

/**
 * A tool the planner MAY bind a node to. The framework fetches nothing (spec §7.1: context is an
 * input, never a lookup): the caller resolves tools, pins their schema hash, and — if it wants the
 * planner to be able to bind — supplies a raw output sample the planner reshapes to pin
 * `outputShapeHash`. Loom has no `CapabilityRef` type; this is loom-ui's (plan ruling).
 */
export interface CapabilityRef {
  /** The name the model cites; short, `[a-z][a-z0-9_-]*`. Distinct per capability. */
  readonly handle: string;
  /**
   * The data-provider kind that runs this capability (U3): absent = MCP, the original — then
   * `toolName` is an MCP tool. Any other kind is an id the host registered a hydration
   * `DataProvider` for, and `toolName` is the target's id WITHIN that kind (a loom effect id, say);
   * `toolSchemaHash` is that kind's pin of the target's contract. The planner treats the kind as
   * opaque: it copies it onto the step it emits and keys identity by it, nothing more.
   */
  readonly kind?: string;
  readonly toolName: string;
  readonly toolVersion: string;
  /** Pinned into every step (of any kind) that uses this capability — makes input drift detectable. */
  readonly toolSchemaHash: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  /**
   * The JSON Schema of what the tool returns (U9b). Optional. Mark a field `"x-content-ref": true` (the
   * root too, for a tool whose whole output is a reference) to declare that the output at that path is
   * a content reference: ONLY a step reference to such an output may be bound to a content-reference
   * argument of another tool. Absent or unreadable = the tool proves nothing.
   */
  readonly outputSchema?: Record<string, unknown>;
  /** A raw tool output the planner reshapes to pin `outputShapeHash`. Absent ⇒ unbindable. */
  readonly sampleOutput?: unknown;
  /**
   * The data class of what this capability returns (and so of its `sampleOutput`, which reaches
   * the model). Folded into `PlanResult.summaryClass` for EVERY offered capability, bound or not.
   * A capability with a `sampleOutput` and no `sensitivity` is of unknown class: unless the caller
   * declares `contextClass`, the planner withholds the summary (finding `summary-withheld`).
   */
  readonly sensitivity?: DataClass;
}

/** Structural subset of loom's `ExecutionContext.decide` (workflow-runtime). Any loom `ctx` satisfies it. */
export interface DecideOptionsLike {
  readonly rationale?: unknown;
  readonly source?: string;
  readonly context?: Record<string, unknown>;
  /** The action set a policy chose FROM (U11): recorded so a counterfactual has something to range over. */
  readonly alternatives?: unknown;
  readonly policy?: { readonly id: string; readonly version: string; readonly propensity?: number };
}
/**
 * Structural subset of loom's `DecideScope` (workflow-runtime, L30): what `ctx.decide` hands its
 * decider. A call through `invokeTransient` runs AS the deciding execution — its workflowId /
 * executionId, full principal (delegation included), composed cancellation and budget snapshot —
 * and is still transient (nothing is journalled; the decision is the one record). A decider that
 * makes its model / tool / sandbox calls through the scope is authorised and metered as the flow
 * that asked, not as an anonymous runtime-level caller. Loom's own `DecideScope` satisfies this.
 */
export interface DecideScope {
  invokeTransient<TIn = unknown, TOut = unknown>(
    toolId: string,
    input: TIn,
    opts?: { readonly signal?: AbortSignal; readonly onDelta?: PlannerDeltaSink }
  ): Promise<TOut>;
}
export interface DecideContext {
  decide<T>(
    decisionId: string,
    // A decider that ignores its scope (`() => …`) is assignable: fewer parameters is always allowed.
    decider: (scope: DecideScope) => T | Promise<T>,
    opts?: DecideOptionsLike
  ): Promise<T>;
}

/** Where a media part's bytes are — structurally `@loom/llm`'s `LlmBinarySource`. */
export type PlannerBinarySource =
  | { readonly kind: "ref"; readonly ref: { readonly address: string; readonly size?: number } }
  | { readonly kind: "data"; readonly data: string };
/** A text part — structurally `@loom/llm`'s `LlmTextPart`. */
export interface PlannerTextPart {
  readonly type: "text";
  readonly text: string;
}
/** An image / audio / file part — structurally `@loom/llm`'s media parts. */
export interface PlannerMediaPart {
  readonly type: "image" | "audio" | "file";
  readonly mediaType: string;
  readonly source: PlannerBinarySource;
  readonly name?: string;
  readonly untrusted?: { readonly origin: string };
}
/**
 * One content part — structurally `@loom/llm`'s `LlmContentPart` (text, media, `tool_use`,
 * `tool_result`; ADR 0120). `@loom-ui/planner` does not depend on `@loom/llm`, so the shape is
 * mirrored and a loom provider's request flows through with no adapter.
 */
export type PlannerContentPart =
  | PlannerTextPart
  | PlannerMediaPart
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly content: string | readonly (PlannerTextPart | PlannerMediaPart)[];
      readonly isError?: boolean;
    };
/** Structurally `@loom/llm`'s `LlmMessageContent`: text, or parts. */
export type PlannerMessageContent = string | readonly PlannerContentPart[];

/** Structural subset of `@loom/llm`'s `LlmProvider.complete` message (content is text OR parts). */
export interface PlannerMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: PlannerMessageContent;
}

/**
 * The text of a message's content — the local equivalent of `@loom/llm`'s `textOf`. A string is
 * itself; parts contribute their `text` parts and a `tool_result`'s text, in order, and media and
 * `tool_use` parts contribute nothing. Never `[object Object]`. A `tainted()` wrapper (untrusted
 * data, not message text) is refused with a throw rather than flattened: unwrap it on purpose.
 */
export function plannerMessageText(content: PlannerMessageContent): string {
  if (typeof content === "string") return content;
  if (isTainted(content))
    throw new Error(taintedMessage((content as TaintedValue<unknown>).__loomTainted.origin));
  let out = "";
  for (const p of content) {
    if (isTainted(p))
      throw new Error(taintedMessage((p as TaintedValue<unknown>).__loomTainted.origin));
    if (p.type === "text") out += plain(p.text);
    else if (p.type === "tool_result") {
      const c: unknown = p.content;
      if (isTainted(c))
        throw new Error(taintedMessage((c as TaintedValue<unknown>).__loomTainted.origin));
      if (typeof c === "string") out += c;
      else
        for (const r of c as readonly PlannerContentPart[])
          if (r.type === "text") out += plain(r.text);
    }
  }
  return out;
}
const taintedMessage = (origin: string): string =>
  `plannerMessageText() was given tainted content from "${origin}": untrusted data, not message text; unwrap it deliberately and treat it as DATA`;
const plain = (text: unknown): string => {
  if (isTainted(text))
    throw new Error(taintedMessage((text as TaintedValue<unknown>).__loomTainted.origin));
  return text as string;
};
/**
 * Token accounting for one model call — the same shape as `@loom/llm`'s `LlmResponse.usage`,
 * so a loom provider's usage flows through with no adapter.
 */
export interface PlannerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
/**
 * One live chunk of a model reply — structurally loom's `EffectDelta` (ADR 0119,
 * `@loom/effect-runtime`), so a scope's chunk flows through with no adapter. `delta` is a TAINTED
 * string (the model's text is untrusted): unwrap it explicitly to display it. A `reset` chunk
 * (empty `delta`) means the call is retrying and the text so far is void; the terminal `done`
 * chunk carries the provider's `usage`. Live-only: never recorded, and it may never arrive at all
 * (a refused sink, a non-streaming model) — the settled return value is authoritative.
 */
export interface PlannerDelta {
  readonly delta: TaintedValue<string>;
  readonly done?: true;
  readonly reset?: true;
  readonly attempt?: number;
  readonly usage?: PlannerUsage;
}
/** Synchronous and fire-and-forget; a throw is swallowed by the runtime. */
export type PlannerDeltaSink = (chunk: PlannerDelta) => void;

export interface PlannerModelRequest {
  readonly system?: string;
  readonly messages: readonly PlannerMessage[];
}
export interface PlannerModel {
  /**
   * The whole reply — the ONE model call, governed like any other (a scope-routed model sends it
   * through `scope.invokeTransient`, so authorization, middleware, taint and budget admission
   * apply whether or not anyone is watching). `opts.signal` aborts the call (the planner also
   * stops waiting for a model that ignores it). `opts.onDelta` is passed ONLY when the caller asked
   * for partials: a model that can stream forwards it (`scope.invokeTransient(id, req, { signal,
   * onDelta })`) and the planner shows partials as nodes complete; one that cannot, or whose
   * runtime refuses the sink, simply never calls it and the turn completes without partials.
   * What `complete` RETURNS — not the deltas — is what the plan (and so `ctx.decide`) is built
   * from, and its `usage` is the turn's usage.
   */
  complete(
    request: PlannerModelRequest,
    opts?: { readonly signal?: AbortSignal; readonly onDelta?: PlannerDeltaSink }
  ): Promise<{
    readonly content: string;
    /** Absent when the provider reports none — "unreported", not "free". */
    readonly usage?: PlannerUsage;
  }>;
}

/**
 * One incremental view of a plan being written (U1). NOT a decision and never recorded: it is the
 * ops the reply has made parseable SO FAR, each node already through the same contract,
 * materialisation, replay and `validateExperience` as the final plan, so a partial that would
 * not stand as a final plan is simply not emitted. `ops` is the WHOLE pending list (a later
 * partial supersedes the earlier — fold it with core's `OpStream`). For a revise it is the single
 * `prompt` op the final is. There is no `summary`: a summary is stamped with a class and handed
 * out only with the final result (`PlanResult.summary` / `summaryClass`, U7), never as live text.
 */
export interface PlanPartial {
  /** Which model attempt wrote it (0-based). A new attempt starts with an empty `ops` reset. */
  readonly attempt: number;
  readonly ops: readonly Operation[];
  /** Warnings only; a partial with an error is not emitted. */
  readonly findings: readonly Finding[];
  /** How many of the reply's nodes `ops` covers. */
  readonly nodes: number;
}
export interface PlanStreamOptions {
  /**
   * Called with each incremental view as a node completes. A LIVE side channel: it is not part of
   * the decision, is never called when a recorded decision is served (a replay makes no model call
   * and shows the final at once), and a throw from it is swallowed — a broken UI cannot fail a plan.
   */
  readonly onPartial?: (partial: PlanPartial) => void;
  /**
   * Cancels the turn. A cancelled turn REJECTS with an `AbortError` and records nothing (a
   * control-plane error, see `isControlPlaneError`), so the same input can be planned again.
   */
  readonly signal?: AbortSignal;
}

export interface ComposeInput {
  readonly intent: Intent;
  readonly catalog: SemanticCatalog;
  readonly capabilities: readonly CapabilityRef[];
  /** Resolved and recorded by the caller (ADR 0092). Rendered into the prompt verbatim as data. */
  readonly context?: unknown;
  /**
   * The strictest class of `context` and of the capabilities' samples, which the planner cannot
   * classify itself. It only rides to `PlanResult.summaryClass`; it is not part of the decision id.
   */
  readonly contextClass?: DataClass;
  /** Surface `validateExperience` checks against. Default "web". (Plan ruling; spec §7.1 omits it.) */
  readonly surface?: Surface;
  /**
   * Container roles the host's renderers draw (U15), on top of the plain `section` / `row` /
   * `grid` every host gets — `REFERENCE_CONTAINER_ROLES` for `renderer-lit`'s `tabs` and `stepper`.
   * A reply naming a role not listed here is refused. Part of a decision's id when present.
   */
  readonly containers?: readonly ContainerRoleSpec[];
  /**
   * The stable UNIT a planner with `variants` assigns a variant by (U11): an opaque id of a user,
   * tenant or cohort, `[A-Za-z0-9_.:-]{1,128}`. The HOST derives it server-side as a keyed HMAC alias
   * (`unitAlias(key, userId)` in `@loom-ui/learning`) — never client-supplied, never a name or an
   * email. It is a PSEUDONYM, recorded in the decision log for good: destroying the key severs it
   * from the person, but the log still ties one alias's decisions together. Not part of the plan
   * decision's id. Required when the planner has
   * variants (a missing or malformed unit is refused, no model call); ignored otherwise.
   */
  readonly unit?: string;
}
export interface ReviseInput {
  readonly experience: Experience;
  readonly request: { readonly text: string; readonly scopeNodeIds?: readonly string[] };
  readonly catalog: SemanticCatalog;
  readonly capabilities: readonly CapabilityRef[];
  readonly context?: unknown;
  /** As on {@link ComposeInput.contextClass}. */
  readonly contextClass?: DataClass;
  readonly surface?: Surface;
  /**
   * Observed RAW outputs, keyed by the PROVIDER HANDLE of `experience` that produced them
   * (`observedSamples(drift)` builds it from `DriftRecord.observedSample`). Per handle, not per
   * tool: one tool called with two argument sets returns two outputs, so a `CapabilityRef`'s one
   * `sampleOutput` cannot say which call a sample came from. A planner pins a rebuilt provider
   * against the sample of the call it rebuilds, never another handle's. A separate channel from
   * `context`: these are pinning DATA, never rendered into a prompt (the shapes a model authors
   * against travel in `context`), and — like `sampleOutput` — not part of a decision's id.
   */
  readonly observed?: Readonly<Record<string, TaintedValue<unknown>>>;
  /** As on {@link ComposeInput.containers}. */
  readonly containers?: readonly ContainerRoleSpec[];
  /** As on {@link ComposeInput.unit}. */
  readonly unit?: string;
}

export interface AttemptTrace {
  /** The raw reply survived JSON.parse + the contract schema. */
  readonly parsed: boolean;
  readonly findings: readonly Finding[];
  /** What the model reported for THIS attempt's call. Absent when it reported none, or threw. */
  readonly usage?: PlannerUsage;
}
export interface PlanReport {
  readonly decisionId: string;
  readonly attempts: readonly AttemptTrace[];
  /** Clean on the FIRST attempt — the rate a prompt regression moves (a clean vs a retried attempt). */
  readonly firstAttemptValid: boolean;
  readonly modelId: string;
  /**
   * The sum of `usage` over the attempts that reported (and had recorded) usage; absent when
   * none did. Always a valid PlannerUsage: an attempt whose usage would push it past
   * Number.MAX_SAFE_INTEGER is refused with a `usage-invalid` warning instead. The report is part
   * of the DECIDED value, so a replay serves these same numbers without a model call — a
   * per-plan token total that survives replay.
   */
  readonly usage?: PlannerUsage;
  /**
   * The variant this plan was made under (U11); present only on a planner with `variants`. Set on
   * the result OUTSIDE the plan decision (the variant has its own, earlier, decision), so it is the
   * same on a replay. `decisionId` is the LEARNABLE decision a reward is attributed to.
   */
  readonly variant?: PlanVariantReport;
}
export interface PlanVariantReport {
  /** The `decideWithPolicy` decision that chose the variant: stamp it with `plannerProvenance`. */
  readonly decisionId: string;
  /** The chosen variant id. */
  readonly id: string;
  /**
   * The policy that chose. `version` is always present for a fixed `policy`. Under a `rollout` it is
   * the version that ACTED and is present only when this run made the choice; on a replay it is
   * OMITTED (the registry's current version is not the one that chose), and the loom log's
   * DECISION_RECORDED stamp for `decisionId` is the truth that `linkFromLedger` / `settleRewards`
   * join on.
   */
  readonly policy: { readonly id: string; readonly version?: string };
  /**
   * Under a `rollout` (R18): the version that ACTED is `policy.version`, and this is the rollout
   * stamp recorded with the decision (mode, bucket, `acted`, the `shadow` arm, `fellBack`). Present
   * only when this run made the choice; a replay serves the recorded one, whose stamp stays on the
   * decision in the log.
   */
  readonly rollout?: RolloutStamp;
  /**
   * The probability the policy gave the choice, when this run's policy produced the recorded
   * choice. Absent when a replay served a choice the CURRENT policy would not make (the recorded
   * stamp on the decision remains the truth).
   */
  readonly propensity?: number;
}
export interface PlanResult {
  readonly ops: readonly Operation[];
  readonly findings: readonly Finding[];
  readonly report: PlanReport;
  /**
   * What the model said about its plan, kept (U7) so a host can carry it to the people the change
   * reaches. MODEL TEXT: untrusted, never an instruction, never trusted as a statement of what the
   * ops do (the ops are the truth). Bounded and stripped of control/bidi characters by
   * `boundSummary`. Absent when no plan was produced or the planner has none. Optional, so a
   * planner written before this field, and a recorded decision, are unchanged.
   */
  readonly summary?: string;
  /**
   * The strictest class of what the summary was written from (U7): the experience the model saw
   * and the caller's `contextClass`. Hand it to `Lineage.compose({ summaryClass })` so a viewer is
   * shown the summary only when cleared for it. Present only with `summary`. What the planner
   * cannot see the class of (tool samples, context) is the host's to declare via `contextClass`.
   */
  readonly summaryClass?: DataClass;
}

export interface Planner {
  /**
   * One plan, recorded as ONE `ctx.decide` keyed on every input that shapes the prompt — intent,
   * catalogue content, surface, the offered capabilities' identity AND their tool-authored text,
   * and the caller's context. A capability's `sampleOutput` is deliberately NOT part of that key:
   * a new sample is a new REVISION (`reviseForDrift` asks for one), never a silent re-plan of a
   * decision a replay is already serving.
   */
  compose(input: ComposeInput, ctx: DecideContext, opts?: PlanStreamOptions): Promise<PlanResult>;
  revise(input: ReviseInput, ctx: DecideContext, opts?: PlanStreamOptions): Promise<PlanResult>;
}
