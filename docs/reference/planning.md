# Planning reference

How the reference planner composes and revises an experience, and how drift repair works. The SPI
and conformance kit are in [`@loom-ui/planner`](../../packages/planner/README.md); the operations a
planner emits, and every refusal code, are in the [composition reference](composition.md).

## Compose and revise

A sketch, not a compiling snippet: `intent`, `catalog`, `capabilities`, `ctx`, `content` and the
model options are the app's.

```ts
import { genesis, replay } from "@loom-ui/core";
import { putExperience } from "@loom-ui/core/log";
import { ReferencePlanner, interpretAction } from "@loom-ui/planner";
import { AnthropicProvider } from "@loom/llm";

// Any `@loom/llm` provider (e.g. `AnthropicProvider`) is a PlannerModel.
const planner = new ReferencePlanner({
  model: new AnthropicProvider({ /* credentials */ }),
  modelId: "claude-…",
});

// Inside a loom flow: the model call is a decision — replay serves the recorded ops.
const { ops, findings, report } = await planner.compose({ intent, catalog, capabilities }, ctx);
// The fold mints the artifact; the APP persists it and emits EXPERIENCE_COMPOSED.
const experience = replay(genesis({ experienceId, intent, meta }), ops);
await putExperience(content, experience.value);

// A revision is ONE prompt op; its materialized primitives replay to the same artifact.
const revision = await planner.revise(
  { experience: current, request: { text }, catalog, capabilities },
  ctx
);
```

Capabilities are an INPUT: the app resolves tools, pins `toolSchemaHash`, and supplies a raw
`sampleOutput` for each one the planner may bind (no sample ⇒ not bindable). Everything the
framework and the operator did not author reaches the model only inside a fenced, untrusted DATA
block in the user message — samples, caller context, the current experience's node list, and a
capability's tool-server-authored `description`/`inputSchema` (the CAPABILITIES summary line carries
only handle, tool@version, schema pin and whether it is bindable).

`ReferencePlanner` fences its own prompts: it does NOT go through `@loom/llm`'s
`buildRequest`/`guardRequest`.

The caller hands it a provider whose `complete` it calls directly, so the untrusted-content
discipline above is the planner's own, applied at prompt assembly.

`sampleOutput` is deliberately NOT part of a plan's decision id.

A sample pins shapes, it is not prose the model reasons from — and a new sample is a new REVISION
(that is what `reviseForDrift` asks for), never a silent re-plan of a decision a replay is already
serving.

A revision describes, and materialises, only the root's DIRECT children. A nested container is shown
as a locked placeholder (`{ id, kind: "container", locked: true, descendants }`) and its subtree is
not described at all; a draft naming a node inside one is refused as `nested-node`.

## Usage accounting

`PlannerModel.complete` may return `usage: { inputTokens, outputTokens }` (the shape `@loom/llm`
providers already report).

The reference planner records it per attempt and sums it on `PlanReport.usage` — inside the plan's
`ctx.decide`, so a replay serves the same token totals with no model call. Absent means unreported,
not free; a value that is not two non-negative integers is dropped with a `usage-invalid` warn.

`checkPlannerConformance` fails a planner whose replayed report changes its usage
(`usage-not-replayed`).

A custom `Planner` need not re-derive any of this: `readReportedUsage` (a reply → `{ usage? }` or `{
problem? }`, defensive and side-effect-free) and `addUsage` (fold one usage into a running total,
refusing rather than overflowing `Number.MAX_SAFE_INTEGER`) are exported from `@loom-ui/planner` and
are exactly what the reference planner itself calls.

## Drift repair

Output drift (`DriftRecord{kind:"output"}`) carries `observedShape` (the RESHAPED value that failed
the pin), `observedRawShape` (the raw terminal output's shape, which is what a `reshaping.scriptRef`
is authored against) and, when the hydration caller sets `captureSample`, a tainted `observedSample`
of the RAW terminal output — raw because a capability's `sampleOutput` is raw by contract.

`reviseForDrift` turns a drift report into a repair revision: the handles and node ids go in the
request text, the shapes and each record's `stepId` go in `context` (fenced), and the raw samples go
on `ReviseInput.observed` — `Record<handle, TaintedValue>`, built by `observedSamples(drift)`, a
channel SEPARATE from `context` that is never rendered into a prompt.

### Per-handle samples

Samples are per HANDLE because an observation belongs to one CALL — a tool AND the arguments it was
called with — while a `CapabilityRef` has one `sampleOutput` per tool@version. Two nodes on the same
tool with different arguments drift to two different outputs; pinning both from one sample records a
wrong repair as proven, and the second handle drifts again on its next load.

So `ReferencePlanner` pins each rebuilt provider against the sample of the call it makes (the node's
own handle's, or one every handle making that call agrees on).

A call that runs behind upstream steps — the terminal step of a multi-step provider, whose arguments
may name an earlier step's output (`{{steps.<id>.output…}}`) — is rebuilt behind the same steps
while the draft keeps its tool: its dependency closure is kept in order with its step ids, the
terminal keeps its `idempotent` / `overridable` flags, and all of it is part of the provider handle
and of the observed call (the same terminal behind different upstream steps is a different call). A
binding whose arguments reference a step that does not run before it — outside the graph, or in the
same or a later wave — or a graph with a cycle is refused (`dangling-step-reference`, error);
`materialize` never emits a provider that replays but cannot run.

A binding on an observed tool whose call nobody observed is never pinned from another call's output:
a handle the base already declares keeps its spec, an existing node the draft re-binds keeps its
binding (`sample-not-observed`, warn), a new one is dropped (`sample-not-observed`, warn — a warn,
so the plan's other repairs survive; the drift request tells the model a new argument set on a
drifted tool is not bindable this round), and `reviseForDrift` reports a drifted handle with no
sample of its own beside observed siblings (`drift-sample-missing`, warn) — re-run it with
`captureSample` to repair it.

Which handles were observed is part of the revise decision id; the sample values are not.

`driftCapabilities` remains the fallback for a planner that ignores `observed`: it swaps a
capability's `sampleOutput` only when that tool's drift is a single observation (every drifted step
of the tool carries a sample, and they agree).

That is a behaviour change for such a planner: when one handle on a tool drifted with a sample and
another drifted without one, it no longer gets the swapped sample it used to, so it cannot repair
even the sampled handle from it. That is safer than pinning the sample-less handle against another
call's output, but a planner that wants the repair must read `observed`.

A contract drift (`outputCheck: "contract"`) carries `contractKind`, and the repair request names
that kind instead of a shape pin.

A reshaping that FAILS because of the tool's output is output drift too, but only when the output
demonstrably caused it. That is typed from the failure's channel and payload, never from its
message, as `reshapeFailureKind`: `script-error` (loom's sandbox completed on its `scriptError`
channel, `SANDBOX_ERRORS.scriptError`: the script's own exception, a SyntaxError, or a
ReferenceError for a global the VM lacks), `selects-nothing` (a JSONPath), `uncloneable-output` (the
output holds a value `structuredClone` cannot copy, so a Named reshaper is never handed it; recorded
WITHOUT a sample, since such a value is not a data observation), or a deterministic limit the script
hit on this input (`limit-cpu`, `limit-memory`, `limit-output`). `limit-cpu` is measured against the
host's instruction-count `interruptBudget`, not time, so it is deterministic for a given budget and
LOWERING the budget surfaces as output drift.

The record carries `reshapeFailure` (the failure's code; `expected` is `reshape`, `observed` that
code), `reshapeFailureKind`, `observedRawShape` and, under `captureSample`, the tainted raw
`observedSample` (never for `uncloneable-output`), but no `observedShape` (there is no reshaped
value). So `observedSamples` and `driftContext` include it, `remapOperation` refuses it
(`repair-needs-planner`), and `reviseForDrift` asks for a re-authored binding. The request says the
reshaping failed, names a script's ref or a Named reshaper as what it is (only a JSONPath's is a
"path"), and never quotes the failure.

A failed script or Named reshaping is repaired into whatever the planner authors: `ReferencePlanner`
authors a JSONPath, and an aggregating script may not be expressible as one, so that repair can
fail.

A path that selects nothing from the sample it is pinned against is refused (`reshape-invalid`, then
`plan-failed` once the planner's own bounded attempts run out), and the result carries no ops.

An `uncloneable-output` record has no sample, so the planner can only pin against the capability's
OLD `sampleOutput`, and a path authored for the new output typically fails that way (tested).

`reviseForDrift` calls `revise` once and never retries, so a failed repair ends in those error
findings; it does not loop.

Infrastructure, transient and host-code failures record NO drift and keep today's behaviour (an
error): a `wallClock` limit (host-load dependent — on a loaded host a script can trip `wallClock`
before `cpu`, and then no drift is reported that time), a Named reshaper's own throw (host code: a
host bug or its own I/O is not proven output-caused, and must never get the host's reshaper replaced
by a model-authored binding), an untyped throw (a transport error, an unavailable worker pool, an
integrity failure), an authorization or quota denial, a missing script (`reshape-scriptMissing`), an
unregistered Named reshaper (`reshape-unregistered`), an abort.

The `scriptError` payload (`name`, `message`) is script-authored, UNTRUSTED text that loom does not
taint-wrap: it can echo the raw output, so loom-ui classifies by the channel alone and never copies
that text anywhere: the finding's message is fixed text naming the script and the kind (`reshape
script <ref> failed on the output (script-error)`) — in-process handle `error` status, `onFinding`,
the split public finding, `onDrift` and the drift record alike — and the raw output travels only as
the tainted `observedSample`.

Other channels' payloads (loom-authored) are still quoted in the full finding.

A failed-reshaping record keeps the handle `error` with the served public finding unchanged
(`onDrift` fires in-process and split alike).

`HydrationController` takes `captureSample` like `serveHandle`, so both report the same records.

## Repairs are unbounded here

Nothing in loom-ui dedupes or limits drift repairs: every load that drifts fires `onDrift` again. An
app must dedupe on `(versionHash, handle)` and cap its repair attempts, or a repair that does not
fix the output re-plans on every load.

## A sample stays on the server

`observedSample` is raw tool output. A server's `onDrift` must never forward it (or a `DriftReport`
carrying it) to a client. The split response never includes it, but the hook's report does.

## Generic drift revision

`reviseForDrift` is generic over the planner's own result: `reviseForDrift<R extends
PlanResult>(planner: DriftReviser<R>, input, ctx): Promise<R>`, where `DriftReviser<R>` is just `{
revise(input: ReviseInput, ctx: DecideContext): Promise<R> }` — every `Planner` satisfies it with `R
= PlanResult`.

A planner whose `revise` returns more (say, artifacts the caller must persist beside the ops) gets
that result back with every extra field intact; only `findings` may grow (`unsampledDrift`'s
`drift-sample-missing` warns are appended).

A planner that must reproduce the function by hand composes the same exported helpers:
`driftRequest`, `driftContext`, `observedSamples`, `driftCapabilities` and `unsampledDrift`.

`findings` may grow, and the result is re-spread when it does, so return plain JSON data: a class
instance's prototype members (methods, getters) are dropped.
