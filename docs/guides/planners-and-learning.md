# Planners, drift repair and learning

**Purpose.** Let a model (or any other author) compose and revise an experience safely: use the
reference planner, understand what a planner must and must not do, prove a custom planner conforms,
re-author providers after drift, and close the loop with learning.

**Prerequisites.** [Composing](composing.md) and [hydration](hydration.md). The planner and learning
packages are **server-side** (neither may enter a client graph). Snippets are mirrored from
[`planner.test.ts`](../snippets/src/planner.test.ts) and
[`learning.test.ts`](../snippets/src/learning.test.ts).

<!-- snippet: imports -->

```ts
import { defineSemanticCatalog, genesis, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { executeProvider } from "@loom-ui/hydration";
import type { DriftRecord, TransientInvoker } from "@loom-ui/hydration";
import {
  type CapabilityRef,
  type DecideContext,
  type PlannerModel,
  ReferencePlanner,
  checkPlannerConformance,
  declaredToolClassesFrom,
  plannerProvenance,
  reviseForDrift,
} from "@loom-ui/planner";
```

## The contract in five rules

1. **A planner returns operations, never an Experience.** `compose` and `revise` resolve to a
   `PlanResult { ops, findings, report, summary? }`; the caller folds `ops` onto its own line with
   `replay`. The planner imports no invoker, effect runtime, projection runtime or LLM provider:
   capabilities and context arrive resolved.
2. **Every model call is one `ctx.decide`.** The plan is recorded as a single decision keyed on every
   input that shapes the prompt, so replaying a flow serves the recorded operations with **no model
   call**. A capability's `sampleOutput` is deliberately not part of that key: a new sample is a new
   revision, never a silent re-plan.
3. **The catalogue is closed.** A planner may only name catalogue entries; a gap is a finding.
4. **Capabilities are an input.** A `CapabilityRef` is a tool the planner *may* bind a node to. It
   needs a pinned `toolSchemaHash` and a raw `sampleOutput` (no sample means not bindable), from
   which the planner pins `outputShapeHash`.
5. **Anything authored by a tool or a caller reaches the model only as fenced, untrusted DATA** in a
   user message, never `system`. `ReferencePlanner` fences its own prompts.

<!-- snippet: inputs -->

```ts
// The closed vocabulary a planner may name. A gap is a finding, never a guess.
const catalog = defineSemanticCatalog({
  id: "example.planning.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit"],
      binding: "required",
      surfaces: { web: { kind: "Kpi", props: ["unit"], binding: "required" } },
    },
  ],
});

// Capabilities are an INPUT: the app resolves tools and pins their schema. A capability with no
// `sampleOutput` is not bindable, because the planner pins the output shape from the sample.
const capabilities: CapabilityRef[] = [
  {
    handle: "orders",
    toolName: "orders.summary",
    toolVersion: "2.1.0",
    toolSchemaHash: "sha256:orders-summary-2-1",
    description: "Order totals for a window",
    sampleOutput: { window: "7d", totals: { count: 412 } },
  },
];
```

## Compose, replay, revise

<!-- snippet: compose -->

```ts
// Any `@loom/llm` provider is a PlannerModel; `ctx` is your loom flow's ExecutionContext.
const planner = new ReferencePlanner({ model, modelId: "my-model" });

const plan = await planner.compose({ intent, catalog, capabilities }, ctx);
// plan: { ops, findings, report, summary? }. Operations, never an Experience.

const composed = replay(genesis({ experienceId: "weekly-orders", intent, meta }), plan.ops);
if (!composed.ok) throw new Error(composed.finding.message);
const v1 = seal(composed.value); // the APP persists it (see the lineage guide)

// The same inputs on a recording context are served from the log: no second model call.
await planner.compose({ intent, catalog, capabilities }, ctx);
```

`report` carries the `decisionId`, per-attempt traces, `firstAttemptValid`, `modelId` and summed
`usage`; `maxAttempts` (default 2) bounds parse and validation retries. The model must return the
JSON draft contract described in the prompt; the planner parses, materialises it into operations,
validates against the catalogue and retries with the exact complaint.

<!-- snippet: revise -->

```ts
// A revision is ONE `prompt` op; its materialized primitives replay to the same artifact.
const revision = await planner.revise(
  { experience: v1, request: { text: "make the orders tile wider" }, catalog, capabilities },
  ctx
);
const revised = replay(v1, revision.ops);
if (!revised.ok) throw new Error(revised.finding.message);

// Stamp the ops with the model call that produced them.
const by = plannerProvenance(revision, { agentId: "dashboard-planner" });
// by: { source: "agent", modelId: "my-model", ... } -> Lineage.compose({ ..., by })
```

A revision is **one `prompt` operation**. `apply` of the prompt op and replay of its `materialized`
primitives yield the same artifact, and the revision keeps the ids of nodes it did not change. It
describes (and edits) only the root's direct children and any container the planner owns
(`owner: "planner"`); an application-owned container is a locked placeholder. `prompt` ops cannot
contain `declassifyHandle` (`declassify-in-prompt`).

### Things a host must pass

- **`contextClass`.** The planner cannot classify context or tool samples. If yours read classified
  material, pass `contextClass`, or the summary's class floor is only as good as the capabilities'
  declared `sensitivity`. A capability with a `sampleOutput` and no `sensitivity` and no
  `contextClass` makes the summary withheld (`summary-withheld`); the ops are unaffected.
- **The summary is model text.** Stamp it on the event (`Lineage.compose({ summary, summaryClass })`)
  and display it as text, never as an instruction.
- A capability's `sensitivity` classes every node bound to it (the planner never lowers it). Build the
  matching read floor from the same refs:

<!-- snippet: classes -->

```ts
// The same capabilities the planner reads give the host's read-time floor, so the two agree.
const declaredToolClasses = declaredToolClassesFrom(capabilities);
// pass it as `readPolicy: { declaredToolClasses }` to Lineage, compile and serveHandles
```

## Containers and structure

The reply is a flat list; a group is an entry with a `container` (`section`, `row`, `grid`, or a role
the host offered) and members name it with `parent`. Offer roles through `ComposeInput.containers`,
for example `REFERENCE_CONTAINER_ROLES` for the `tabs` and `stepper` that
`@loom-ui/renderer-lit/containers` draws ([rendering](rendering.md#containers-roles-and-placement)).
A reply naming a role you did not offer is refused. Bounds are counts the contract checks (depth 4, 24
entries per container, 64 in all).

## Widget actions: `interpretAction`

`interpretAction(exp, action)` is the one seam between a click and the experience. An
`experience.op` action is admitted only if it parses as an `Operation`, is not `prompt`, `setRole` or
a provider operation, and does not touch the root; everything else passes through to your ordinary
business-action path. `setRole` is never interactive.

## Prove a custom planner conforms

Anything with `compose` and `revise` is a planner. `checkPlannerConformance` runs it through the
contract a caller depends on and returns findings (never throws):

<!-- snippet: conformance -->

```ts
const findings = await checkPlannerConformance(planner, {
  intent,
  catalog,
  capabilities,
  meta,
  revision: { text: "make the orders tile wider" },
  ctx: recording(), // a FRESH recording context: the kit composes twice and expects a replay
  modelCalls: () => model.calls, // lets the kit assert the second compose made no model call
});
// findings === [] for a conforming planner
```

It checks that operations parse and apply, that a revise is one `prompt` op whose materialisation
reproduces the artifact (`prompt-replay-mismatch`), that `firstAttemptValid` agrees with the attempts,
that `usage` is replay-stable, and (with `modelCalls`) that a second `compose` replays. Opt in to more
by supplying probes: `scopeProbe` (decides through the scope as the deciding execution, makes no call
on replay), `denialProbe` (a denial propagates and records nothing), `streamProbe`, `readPolicy`,
`containers`, and `checkReach` (the planner declares what it reaches for `@loom/verify`). **Omitting a
probe means that contract is not checked.** `fx.ctx` must be fresh.

## Re-author after drift

Hydration reports output drift but cannot repair it; only a planner can, because the binding path
and the shape pin must be re-authored against what the tool returns now.

<!-- snippet: drift -->

```ts
// The tool now nests the count it used to return flat.
const invoker: TransientInvoker = {
  async invokeTransient<TIn, TOut>(): Promise<TOut> {
    return { window: "7d", totals: { count: { value: 412 } } } as TOut;
  },
};
const handle = Object.keys(experience.providers)[0] as string;
const outcome = await executeProvider(experience.providers[handle]!, {
  invoker,
  captureSample: true, // keep the raw output so the planner can re-pin against it
});
const drift: DriftRecord[] = outcome.ok ? [] : [...outcome.drift];

// Output drift is repaired only by a planner: it re-paths the binding and re-pins the shape.
const fixer = new ReferencePlanner({
  model: scripted([draft("totals.count.value")]),
  modelId: "my-model",
});
const repair = await reviseForDrift(fixer, { experience, drift, catalog, capabilities }, ctx);
// repair.ops: one `prompt` op (remapProvider + bindProvider + removeProvider), node ids kept
```

Rules that matter here:

- **Samples belong to a handle**, not to a tool. Two nodes calling one tool with different arguments
  drift to different outputs; a rebuilt provider is pinned only against its own call's sample, else it
  is kept, dropped with a warning, or reported (`sample-not-observed`, `drift-sample-missing`).
- **A sample never leaves the server.** `observedSample` is raw tool output: do not forward it, or a
  `DriftReport` that holds it, to a client.
- **Repairs are unbounded.** Dedupe on `(versionHash, handle)` and cap attempts, or a repair that does
  not fix the output re-plans on every load.
- `reviseForDrift` calls `revise` once and returns the planner's own result type; a failed repair is
  error findings, not a retry loop.
- An **input** drift (a moved schema pin) needs no model: `remapOperation` in
  [hydration](hydration.md#drift).

## Streaming a turn

Pass `{ onPartial, signal }` as the third argument of `compose` or `revise` and a model that can stream
forwards deltas; partials are a live side channel and the decision is the final. Fold partials with
core's `OpStream` into an unsealed working copy, never a lineage commit. `signal` aborts the turn and
records nothing. See the [planner README](../../packages/planner/README.md#streaming-a-turn-u1).

## Learning: choose, observe, reward, compare

loom-ui adds no learner. A planner **chooses** a variant as a loom decision, viewers **react**, the
reactions become one bounded reward on the decision that produced what they saw, and loom's own
evaluation says which choice was better.

1. **Variants.** `new ReferencePlanner({ model, modelId, variants: { policy, variants } })` makes the
   variant choice its own recorded decision (`plan-variant:*`) with the policy's propensity, before
   the plan. A variant is `{ containers?, guidance? }`. Shipped policies: `stableBucketPolicy`,
   `epsilonGreedyPolicy`, `ucbPolicy`; or `variants: { rollout, variants }` through loom's rollout
   registry (shadow, canary, promote). The turn requires `unit`, an opaque id the host derives
   **server-side** with `unitAlias(key, userId)`, never from a client.
2. **Signals.** An opt-in collector in the renderer sends four content-free facts (exposure,
   engagement, feedback, outcome) in batches. They are **untrusted input**.
3. **Ingest.** The host's `SignalIngestor` charges a rate budget, validates shape and view, checks the
   node is listed and visible to this viewer, checks the viewer actually saw it, and accepts only
   outcome names the host registered. Each accepted signal is appended to a per-decision, append-only
   `VoteLog`; the fold reduces every viewer to **one bounded vote**.

<!-- snippet: imports in learning.test.ts -->

```ts
import { SIGNAL_VERSION } from "@loom-ui/core/signals";
import {
  DecisionLinks,
  InMemoryVoteLog,
  SignalIngestor,
  VoteLedger,
  defaultReward,
} from "@loom-ui/learning";
```

<!-- snippet: ingest in learning.test.ts -->

```ts
// What the host knows about one compiled version: which decision wrote which node.
const decision = { executionId: "exec-1", decisionId: "plan-variant:abc" };
const links = new DecisionLinks();
links.register("weekly-orders", "v1", {
  tenant: "acme", // REQUIRED: a link is looked up by tenant
  decisions: [decision],
  nodes: { orders: decision },
});

const ledger = new VoteLedger({
  log: new InMemoryVoteLog(), // production: a durable VoteLog (eventStoreLineageStore)
  pseudonymKey: "0123456789abcdef0123456789abcdef", // >= 16 bytes, from your secret store
  clock: Date.now,
  outcomes: ["approved"], // the only outcome names a client may report
});
const ingestor = new SignalIngestor({
  links,
  ledger,
  clock: Date.now,
  exposure: "client-claimed", // tests and demos; production: seenLogExposure(seenLog, ...)
});

// The viewer is the host's authenticated session, never a field of the payload.
const result = await ingestor.ingest({
  viewer: { id: "ana", tenant: "acme" },
  raw: {
    v: SIGNAL_VERSION,
    batchId: "b1",
    view: { experienceId: "weekly-orders", versionHash: "v1" },
    signals: [
      { kind: "exposure", node: "orders" },
      { kind: "engagement", action: "click", count: 1, node: "orders" },
      { kind: "feedback", rating: 5 },
    ],
  },
});
// Answer the client with a bare 204 whatever `result` says; keep it in your server logs.

const { summary } = await ledger.fold(decision);
const reward = defaultReward()(summary); // a pooled score in [0, 1]
```

4. **Settle.** `settleRewards` closes each decision at a moment you choose with a CLAIM and records
   **one** pooled reward through loom's `recordOutcome` as a reward-pipeline principal. `rewardId`
   must name the reward weights; give a decision one `rewardId` and `closeId` for life.
   `recordOutcome` refuses a running execution, so run learning-relevant planner turns in short
   executions.
5. **Compare.** `evaluateVariants(events, { rewardId, thresholds })` evaluates "always variant V"
   off-policy (SNIPS) behind `promotionGate`. It names a winner only if one passes the gate *and*
   the logging policy explored: a deterministic policy (propensity 1) names none unless you pass
   `allowDeterministicLogging: true`.

Rules of the road: answer every well-formed signal POST with the same bare `204` and keep
`IngestResult` server-side (its reasons would let a client probe what exists); use
`seenLogExposure(seenLog, { versionIsEnough: false })` wherever nodes are data-bound; destroy the
pseudonym key to sever votes and units from a person. Step 4 and 5 need a running loom runtime and
execution log, so they are not compiled here; the full flow is the `planner-learning` example.

## Gotchas

- Replaying a flow must not call the model. If `deciderCalls` rises on replay, your inputs are not
  stable (a clock, a random id, an unsorted collection in the decision key).
- Never give `ReferencePlanner` a model that bypasses the scope when you need identity and budget
  attribution: pass a factory, `model: (scope) => ...`, and forward `signal` and `onDelta`.
- When the invoker is a `scopeInvoker`, do not configure `principal` on hydration: the scope already
  carries it, and the call is refused otherwise.
- Declare reach (`reach: { transient: ["llm.complete"] }`) if the flow is checked by `@loom/verify`.

## See also

- Packages: [`@loom-ui/planner`](../../packages/planner/README.md),
  [`@loom-ui/learning`](../../packages/learning/README.md).
- Reference: [planning](../reference/planning.md).
- Examples (in `loom-examples`): `experience-tabs-planner` (nested tabs composed by the reference
  planner, minimal-diff revise), `planner-decide-scope` (the model call authorised as the deciding
  execution), `planner-learning` (variants, votes, rewards, shadow, canary, rollback),
  `experience-recompose`.
