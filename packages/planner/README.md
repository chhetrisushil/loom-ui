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
- **Drift re-authoring.** `reviseForDrift` turns a `DriftReport` from `@loom-ui/hydration` into a
  revision request any `Planner` can serve, composing the same helpers (`driftRequest`,
  `driftContext`, `observedSamples`, `driftCapabilities`, `unsampledDrift`) the reference planner
  itself calls.

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
- `DecideContext`, `DecideOptionsLike` — the structural subset of loom's `ExecutionContext.decide`
  a planner needs; any loom `ctx` satisfies it.
- `PlannerModel`, `PlannerMessage`, `PlannerUsage` — the structural subset of `@loom/llm`'s
  `LlmProvider.complete` a model must satisfy, and its token-usage shape.

### Reference planner

- `ReferencePlanner` — implements `Planner`. Constructor: `{ model: PlannerModel, modelId: string,
  maxAttempts?: number }` (default 2 attempts, parse/validation retries included).
- `REFERENCE_POLICY`, `REFERENCE_SOURCE` — the fixed `{ id, version }` policy stamp and decision
  source this planner records.
- `scratchGenesis(intent)` — a scratch-lineage `Experience` for validating a draft plan before it
  is applied to a real one (every genesis shares the same root, so ops are id-based and portable).

### Conformance

- `checkPlannerConformance(planner: Planner, fx: ConformanceFixture): Promise<Finding[]>` — runs a
  custom `Planner` through the contract a caller depends on: at least one attempt, a named model,
  `firstAttemptValid` agreeing with the attempts, replay-stable `usage`, and — with `fx.ctx` a
  recording context — that a second `compose` with the same inputs replays rather than re-calls
  the model.
- `ConformanceFixture` — the fixture shape: `intent`, `catalog`, `capabilities`, `meta`, a
  `revision` request, a `DecideContext`, and optional `modelCalls()`/`surface`.

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

- `readReportedUsage(reply)`, `addUsage(a, b)`, `totalUsage(attempts)`, `isPlannerUsage(u)` — read
  a model reply's `usage`, fold it into a running total (refusing rather than overflowing
  `Number.MAX_SAFE_INTEGER`), sum an attempt list, and validate a `PlannerUsage` shape. Exactly
  what `ReferencePlanner` itself calls — a custom planner need not re-derive any of it.

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

const repaired = await reviseForDrift(planner, {
  experience: current,
  request: { text: "repair drift" },
  catalog,
  capabilities,
  observed: observedSamplesFromReport,
}, ctx);
```

## Notable behaviours and guarantees

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
