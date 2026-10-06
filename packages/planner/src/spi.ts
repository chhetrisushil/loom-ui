import type {
  Experience,
  Finding,
  Intent,
  Operation,
  SemanticCatalog,
  Surface,
} from "@loom-ui/core";
import type { TaintedValue } from "@loom/classify";

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
  /** A raw tool output the planner reshapes to pin `outputShapeHash`. Absent ⇒ unbindable. */
  readonly sampleOutput?: unknown;
}

/** Structural subset of loom's `ExecutionContext.decide` (workflow-runtime). Any loom `ctx` satisfies it. */
export interface DecideOptionsLike {
  readonly rationale?: unknown;
  readonly source?: string;
  readonly context?: Record<string, unknown>;
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
    opts?: { readonly signal?: AbortSignal }
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

/** Structural subset of `@loom/llm`'s `LlmProvider.complete`. */
export interface PlannerMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}
/**
 * Token accounting for one model call — the same shape as `@loom/llm`'s `LlmResponse.usage`,
 * so a loom provider's usage flows through with no adapter.
 */
export interface PlannerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}
export interface PlannerModel {
  complete(request: {
    readonly system?: string;
    readonly messages: readonly PlannerMessage[];
  }): Promise<{
    readonly content: string;
    /** Absent when the provider reports none — "unreported", not "free". */
    readonly usage?: PlannerUsage;
  }>;
}

export interface ComposeInput {
  readonly intent: Intent;
  readonly catalog: SemanticCatalog;
  readonly capabilities: readonly CapabilityRef[];
  /** Resolved and recorded by the caller (ADR 0092). Rendered into the prompt verbatim as data. */
  readonly context?: unknown;
  /** Surface `validateExperience` checks against. Default "web". (Plan ruling; spec §7.1 omits it.) */
  readonly surface?: Surface;
}
export interface ReviseInput {
  readonly experience: Experience;
  readonly request: { readonly text: string; readonly scopeNodeIds?: readonly string[] };
  readonly catalog: SemanticCatalog;
  readonly capabilities: readonly CapabilityRef[];
  readonly context?: unknown;
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
}

export interface Planner {
  /**
   * One plan, recorded as ONE `ctx.decide` keyed on every input that shapes the prompt — intent,
   * catalogue content, surface, the offered capabilities' identity AND their tool-authored text,
   * and the caller's context. A capability's `sampleOutput` is deliberately NOT part of that key:
   * a new sample is a new REVISION (`reviseForDrift` asks for one), never a silent re-plan of a
   * decision a replay is already serving.
   */
  compose(input: ComposeInput, ctx: DecideContext): Promise<PlanResult>;
  revise(input: ReviseInput, ctx: DecideContext): Promise<PlanResult>;
}
