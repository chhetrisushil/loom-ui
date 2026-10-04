# @loom-ui/planner

The Planner SPI — `compose`/`revise`: intent + semantic catalogue + capabilities → `Operation[]`
— plus a reference planner, a conformance kit any planner must pass, and the machinery to
re-author bindings when hydration reports drift. It is the layer that turns a request into edits
of the Experience Model `@loom-ui/core` defines: a planner never touches a `Blueprint` or a
projection directly, only `Operation`s that `apply`/`replay` fold onto an Experience — which
`@loom-ui/core` then compiles and `@loom-ui/hydration` hydrates.

## Install / import

```
pnpm add @loom-ui/planner
```

```ts
import { ReferencePlanner, interpretAction, checkPlannerConformance } from "@loom-ui/planner";
import type { Planner, ComposeInput, ReviseInput, PlanResult } from "@loom-ui/planner";
```

## Key concepts

- **A planner returns operations, never an Experience.** `Planner.compose`/`.revise` both resolve
  to a `PlanResult { ops, findings, report }`; the caller folds `ops` onto its own lineage with
  `replay`. `@loom-ui/planner` imports no invoker, effect runtime, projection runtime or LLM
  provider (enforced by `noLookups.test.ts`) — capabilities and context arrive resolved from the
  caller.
- **Every model call is one `ctx.decide`.** A plan is recorded as a single decision keyed on every
  input that shapes the prompt (intent, catalogue content, surface, the offered capabilities'
  identity and tool-authored text, and the caller's context) — so a replay serves the recorded
  `ops` with no model call. `CapabilityRef.sampleOutput` is deliberately NOT part of that key: a
  new sample is a new REVISION, never a silent re-plan.
- **Capabilities are an input, not a lookup.** A `CapabilityRef` is a tool the planner MAY bind a
  node to: `handle`, `toolName`, `toolVersion`, a pinned `toolSchemaHash`, and an optional
  `sampleOutput` the planner reshapes to pin `outputShapeHash` — no sample means not bindable.
- **Untrusted content stays fenced.** Anything tool- or caller-authored that reaches a model
  (samples, the current experience's node list, a capability's description/schema) is wrapped as
  DATA in the user message, never `system`; `ReferencePlanner` fences its own prompts rather than
  going through `@loom/llm`'s `buildRequest`/`guardRequest`.
- **Two authorisation domains.** `interpretAction` is the one seam between a widget's click and the
  Experience: an `experience.op` action is admitted only if it parses as an `Operation`, is not
  `prompt`/`setRole`/a provider op, and does not touch the root; everything else passes through to
  loom's ordinary business-action path untouched.
- **Drift re-authoring.** `reviseForDrift` takes the `DriftRecord`s collected from one or more
  `@loom-ui/hydration` `DriftReport`s (their `.drift` arrays) and turns them into a revision
  request any `Planner` can serve, composing the same helpers (`driftRequest`, `driftContext`,
  `observedSamples`, `driftCapabilities`, `unsampledDrift`) the reference planner itself calls.

## API

### The SPI

- `Planner` — `{ compose(input: ComposeInput, ctx): Promise<PlanResult>; revise(input: ReviseInput,
  ctx): Promise<PlanResult> }`.
- `ComposeInput`, `ReviseInput` — `{ intent, catalog, capabilities, context?, surface? }` and, for a
  revision, `{ experience, request: { text, scopeNodeIds? }, ..., observed? }`.
- `PlanResult`, `PlanReport`, `AttemptTrace` — `{ ops, findings, report }`; the report's
  `decisionId`, `attempts`, `firstAttemptValid`, `modelId` and summed `usage` are what a caller
  stamps provenance from.
- `CapabilityRef` — one bindable tool: `handle`, `toolName`, `toolVersion`, `toolSchemaHash`,
  optional `description`/`inputSchema`/`sampleOutput`.
- `DecideContext`, `DecideOptionsLike`, `DecideScope` — the structural subset of loom's
  `ExecutionContext.decide` a planner needs; any loom `ctx` satisfies it. The decider is
  `(scope: DecideScope) => T | Promise<T>`: `scope.invokeTransient(toolId, input, { signal? })`
  runs the call AS the deciding execution (its workflowId/executionId, full principal including
  delegation, composed cancellation, budget snapshot), still transient. A zero-arg decider remains
  valid. A planner that makes its model / MCP / sandbox calls through the scope is authorised and
  metered as the flow that asked, not as an anonymous runtime-level caller.
- `scopeInvoker(scope): TransientInvoker` — adapts a `DecideScope` to the `TransientInvoker`
  interface `@loom-ui/hydration` is written against, so its wrappers compose on top:
  `memoInvoker(limitInvoker(scopeInvoker(scope), 4))`. Only `signal` is forwarded; `principal`,
  `as` and `resources` throw (the scope IS the identity; a silent drop would run a call as
  someone it did not ask to be), `label` is ignored. `memoInvoker` keys on every option except
  `signal`, and the scope fixes the identity, so a memo built inside one decider is safe — never
  share one memo across scopes (executions). A refused option is a REJECTED promise, never a
  synchronous throw. Do not configure `principal` on hydration / reshape when their invoker is a
  `scopeInvoker` — the scope already carries the execution's principal, and the call is refused
  otherwise (refusing beats running as someone else).
- `PlannerModel`, `PlannerMessage`, `PlannerUsage` — the structural subset of `@loom/llm`'s
  `LlmProvider.complete` a model must satisfy, and its token-usage shape.
- `planDecisionId(kind, input): string` — the `ctx.decide` key `compose`/`revise` use: every input
  that shapes the prompt (intent/request, catalogue CONTENT, the offered capabilities including
  their tool-authored text, caller `context`, and `surface`), deliberately excluding a
  capability's `sampleOutput` (a new sample is a new revision, never a silent re-plan). Overloaded
  per `kind`: `"compose"` takes `{ intent, catalog, capabilities, context?, surface? }`;
  `"revise"` takes `{ versionHash, request, catalog?, capabilities?, context?, surface?,
  observedHandles? }`. `ReferencePlanner` calls it to key its own `ctx.decide`; a custom planner
  can reuse it for the same replay-stability.

### Reference planner

- `ReferencePlanner` — implements `Planner`. Constructor: `{ model: PlannerModel | ((scope: DecideScope) => PlannerModel),
  modelId: string, maxAttempts?: number }` (default 2 attempts, parse/validation retries included).
  Pass a factory to make the model calls AS the deciding execution, e.g.
  `model: (scope) => { const inv = scopeInvoker(scope); return { complete: (req) =>
  inv.invokeTransient("llm.complete", req) }; }`; a plain model ignores the scope.
- `REFERENCE_POLICY`, `REFERENCE_SOURCE` — the fixed `{ id, version }` policy stamp and decision
  source this planner records.
- `scratchGenesis(intent)` — a scratch-lineage `Experience` for validating a draft plan before it
  is applied to a real one (every genesis shares the same root, so ops are id-based and portable).

### Conformance

- `checkPlannerConformance(planner: Planner, fx: ConformanceFixture): Promise<Finding[]>` — runs a
  custom `Planner` through the contract a caller depends on: at least one attempt, a named model,
  `firstAttemptValid` agreeing with the attempts, replay-stable `usage`, and — with `fx.ctx` a
  recording context — that a second `compose` with the same inputs replays rather than re-calls
  the model. With `fx.scopeProbe` (`{ identity, calls() }`, observing the scope behind `fx.ctx`) it
  also requires compose to decide through `ctx.decide` and its decider to call through the scope
  (`scope-unused` either way), every call to be stamped as
  the deciding execution (`scope-identity-mismatch`), and a replay to make none
  (`replay-recalled-scope`); calls made during `revise` must be stamped as the deciding execution
  too, reported separately from a compose mismatch (whether `revise` must call the scope at all
  is not checked). **Omitting `scopeProbe` means
  the scope contract is NOT checked.** `fx.ctx` must be fresh: a ctx that already holds the
  compose decision serves it without running the decider, reported as `fixture-ctx-not-fresh`
  (not `scope-unused`). `calls()` may return a live array.
  With `fx.denialProbe` (`{ ctx, error, decisions() }`: a second fresh recording context whose scope
  throws `error`) it also requires `compose` to REJECT with that error and record nothing
  (`denial-swallowed` / `denial-replaced` / `denial-recorded`). Omitting it means the
  control-plane contract is NOT checked.
- `ConformanceFixture` — the fixture shape: `intent`, `catalog`, `capabilities`, `meta`, a
  `revision` request, a `DecideContext`, and optional `modelCalls()`/`surface`/`scopeProbe`/`denialProbe`.

### Interaction (widget actions vs. experience ops)

- `interpretAction(exp, action: WidgetAction): Interpretation` — `{ kind: "experience", op }` |
  `{ kind: "business", action }` | `{ kind: "refused", finding }`.
- `EXPERIENCE_OP_ACTION` — the one `WidgetAction.type` this function interprets as an operation.
- `EXPERIENCE_PROMOTED`, `ExperiencePromotedPayload` — the event name/payload for promoting a
  scratch or draft Experience to the lineage a viewer sees.

### Materialising a draft into operations

- `materialize(draft, ...)` — turns a parsed model draft (`PlanDraft`) into `Operation[]` against a
  base Experience, building every rebuilt `ProviderSpec` along the way.
- `buildProviderSpec(cap, binding, nodeId?, graph?)` — one capability + a draft binding →
  `{ ok: true, spec: ProviderSpec }` or a typed refusal (`capability-unsampled`,
  `reshape-invalid`, `unhashable-sample`, `dangling-step-reference`).
- `providerHandle`, `callGraphOf`, `CallGraph`, `danglingStepReference`, `orphanedProviders`,
  `DEFAULT_TTL_SECONDS` — supporting helpers: derive a provider's handle, read a multi-step call's
  dependency graph, check a graph schedules without a cycle or forward reference, and find
  providers a plan's own removals/rebinds orphaned.
- `DRAFT_ID`, `MAX_DRAFT_NODES`, `entryFor`, `parseModelJson`, `planSchema`, `DraftBinding`,
  `DraftNode`, `Parsed`, `PlanDraft` — the model-facing draft contract: its zod schema, node-count
  cap, and the parser that turns a raw model reply into a `PlanDraft`.

### Prompts

- `composeMessages`, `reviseMessages`, `describeCatalog`, `describeCapabilities`,
  `describeExperience`, `capabilityDetailBlocks`, `fenceData`, `COMPOSE_SYSTEM`, `REVISE_SYSTEM`,
  `MAX_FENCE_BODY`, `PreviousError` — the prompt-assembly building blocks `ReferencePlanner` uses;
  exported so a custom planner can reuse the same fencing discipline rather than re-deriving it.

### Drift repair

- `reviseForDrift<R extends PlanResult>(planner: DriftReviser<R>, input, ctx): Promise<R>` —
  resolves to the planner's OWN `revise` result (extra fields preserved; only `findings` may grow).
- `driftRequest`, `driftContext`, `observedSamples`, `driftCapabilities`, `unsampledDrift` — the
  exported helpers `reviseForDrift` composes, for a planner that must reproduce the flow by hand.
- `DriftReviser<R>`, `DriftContextEntry` — the minimal `{ revise(...) }` shape `reviseForDrift`
  needs, and one fenced drift-context entry.

### Usage accounting

- `readReportedUsage(reply)`, `addUsage(a, b)`, `totalUsage(attempts)` — read a model reply's
  `usage`, fold it into a running total (refusing rather than overflowing
  `Number.MAX_SAFE_INTEGER`), and sum an attempt list. Exactly what `ReferencePlanner` itself
  calls — a custom planner need not re-derive any of it.
- `isPlannerUsage(u)` — validate that a value has the `PlannerUsage` shape; exported for a
  caller's own checks, not called by `ReferencePlanner` itself.

## Examples

Composing and revising with the reference planner (illustrative — not a compiling snippet):

```ts
import { ReferencePlanner, interpretAction } from "@loom-ui/planner";
import { AnthropicProvider } from "@loom/llm";
import { genesis, replay } from "@loom-ui/core";

const planner = new ReferencePlanner({ model: new AnthropicProvider({ /* ... */ }), modelId: "claude-…" });

// Inside a loom flow: the model call is a decision — replay serves the recorded ops.
const { ops, findings, report } = await planner.compose({ intent, catalog, capabilities }, ctx);
const experience = replay(genesis({ experienceId, intent, meta }), ops);

// A revision is one prompt op; its materialized primitives replay to the same artifact.
const revision = await planner.revise({ experience: current, request: { text }, catalog, capabilities }, ctx);
```

Repairing drift a hydration `onDrift` reported (illustrative):

```ts
import { reviseForDrift } from "@loom-ui/planner";
import type { DriftReport } from "@loom-ui/hydration";

// Collected from one or more DriftReports' `.drift` (e.g. every report for this experience
// since the last repair).
const drift = reports.flatMap((report: DriftReport) => report.drift);

const repaired = await reviseForDrift(planner, {
  experience: current,
  drift,
  catalog,
  capabilities,
}, ctx);
```

## Notable behaviours and guarantees

- **Error semantics: refusals propagate, model failures become findings.** A plain model failure
  (provider error, unparseable or invalid output, `TypedFailure`) becomes a `model-error` /
  `model-output-invalid` finding, is retried up to `maxAttempts`, and ends as a recorded failed
  plan. A CONTROL-PLANE refusal is different: `CapabilityDeniedError` (the deciding execution has
  no grant for the effect), `QuotaExceededError` (its budget refuses the call) and `AbortError`
  (cancellation) are rethrown out of the decider at once — from the model call or the model
  factory — with no retry. A throwing decider records nothing, so the flow fails with the real
  error and, once the grant is fixed, a re-run decides afresh instead of replaying a failed plan.
  They are matched by error `name`, so a second copy of loom's classes is still recognised.
  The set also names loom's `ExecutionCancelledError` / `DecideScopeClosedError` (its cancellation
  errors) and the refusals `ExecutionDeniedError`, `CapabilityInvokeDeniedError`,
  `EffectModeViolationError`, `EgressDeniedError`, `SafetyViolationError` and `UntrustedContentError`.
  An `AbortError` thrown by the provider itself (say its own request timeout) is therefore ALSO
  propagated and fails the flow: an `AbortError` is the platform's name for a cancelled call and
  cannot be told from the execution's cancellation by name, retrying a cancelled call is the
  caller's policy (not a draft to re-ask), and previously it was masked as a recorded failed plan.
  `plan()` receives no cancellation signal, so classification rests on names alone — which means
  a host that cancels with its OWN `Error` (loom keeps a caller-supplied reason as-is, e.g.
  `new Error("user left")`) is not recognised and is retried and recorded like a model failure.
  Cancel with the default reason (loom's `ExecutionCancelledError`) or an error named `AbortError`.

- **Replay serves the recorded plan.** Because every model call is one `ctx.decide`, a replayed
  execution never calls the model again — `checkPlannerConformance`'s recording-context assertion
  is exactly this property, tested.
- **A revision only describes the root's direct children.** A nested container comes back as a
  locked placeholder (`{ id, kind: "container", locked: true, descendants }`); a draft naming a
  node inside one is refused (`nested-node`).
- **`setRole` is never interactive.** `interpretAction` refuses `setRole` from a widget action
  (`role-op-not-interactive`) — a role picks which container renderer draws a section, and
  changing it discards that renderer's chrome state; only a planner or the app sets one.
- **Op refusals are typed and total.** Every operation `materialize` or a caller applies can fail
  with one of a fixed set of codes (`invalid-operation`, `tree-too-deep`, `placement-outside-grid`,
  `placement-out-of-range`, `dangling-step-reference`, …) — see the root README's "Op refusal
  codes" for the complete per-op list.
- **A sample pins a call, never a tool.** Samples are keyed by HANDLE (one call: tool + arguments),
  not by tool@version — two nodes calling the same tool with different arguments drift to two
  different outputs, and pinning both from one sample would record a wrong repair as proven.
- **A sample never leaves the server.** `observedSample` is raw tool output; an app's `onDrift`
  hook must never forward it (or a `DriftReport` carrying it) to a client.
- **`reviseForDrift` does not loop.** It calls `revise` once; a failed repair ends in error
  findings rather than retrying.

## See also

- [../core/README.md](../core/README.md) — the Experience Model, operations and catalogue a
  planner composes against.
- [../hydration/README.md](../hydration/README.md) — the `DriftReport` `reviseForDrift` repairs.
- [../../README.md](../../README.md) — root overview, including the full op refusal code list and
  drift re-authoring details.
