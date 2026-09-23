import type {
  Experience,
  Finding,
  Intent,
  Operation,
  SemanticCatalog,
  Surface,
} from "@loom-ui/core";

/**
 * A tool the planner MAY bind a node to. The framework fetches nothing (spec §7.1: context is an
 * input, never a lookup): the caller resolves tools, pins their schema hash, and — if it wants the
 * planner to be able to bind — supplies a raw output sample the planner reshapes to pin
 * `outputShapeHash`. Loom has no `CapabilityRef` type; this is loom-ui's (plan ruling).
 */
export interface CapabilityRef {
  /** The name the model cites; short, `[a-z][a-z0-9_-]*`. Distinct per capability. */
  readonly handle: string;
  readonly toolName: string;
  readonly toolVersion: string;
  /** Pinned into every MCPToolNode that uses this capability — makes input drift detectable. */
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
export interface DecideContext {
  decide<T>(
    decisionId: string,
    decider: () => T | Promise<T>,
    opts?: DecideOptionsLike
  ): Promise<T>;
}

/** Structural subset of `@loom/llm`'s `LlmProvider.complete`. */
export interface PlannerMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}
export interface PlannerModel {
  complete(request: {
    readonly system?: string;
    readonly messages: readonly PlannerMessage[];
  }): Promise<{
    readonly content: string;
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
}

export interface AttemptTrace {
  /** The raw reply survived JSON.parse + the contract schema. */
  readonly parsed: boolean;
  readonly findings: readonly Finding[];
}
export interface PlanReport {
  readonly decisionId: string;
  readonly attempts: readonly AttemptTrace[];
  /** Clean on the FIRST attempt — the rate a prompt regression moves (a clean vs a retried attempt). */
  readonly firstAttemptValid: boolean;
  readonly modelId: string;
}
export interface PlanResult {
  readonly ops: readonly Operation[];
  readonly findings: readonly Finding[];
  readonly report: PlanReport;
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
