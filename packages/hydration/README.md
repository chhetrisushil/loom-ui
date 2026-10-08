# @loom-ui/hydration

Resolves an Experience's provider handles through loom's transient effects and publishes them as
one loom projection, so a renderer can bind to `values.<handle>` / `status.<handle>` and redraw as
they arrive. It is the provider plane of the pipeline: `@loom-ui/core` compiles an Experience to a
`Blueprint`; this package answers what the Blueprint's bindings need, in-process or split across a
trust boundary; `@loom-ui/renderer-lit` and `@loom-ui/renderer-terminal` read the resulting
projection state. Hydration is **read-only and log-free** — it never emits a durable event; drift
repair is the app's own loom execution.

## Install / import

```
pnpm add @loom-ui/hydration
```

```ts
// Node / server: executes providers — imports loom's sandbox (QuickJS WASM) and MCP plugin.
import { HydrationController, handleInventory, serveHandles } from "@loom-ui/hydration";

// Browser: split hydration only. Never import the root entry from a browser bundle.
import { SplitHydrationController, HydrationStore } from "@loom-ui/hydration/client";
```

## Key concepts

- **Two entries, one trust boundary.** The root entry (`@loom-ui/hydration`) is server-side: it
  executes providers, so its module graph reaches loom's sandbox and MCP plugin. The client entry
  (`@loom-ui/hydration/client`, `src/client.ts`) carries only what split hydration needs in a
  browser: the split controller, the loader contract, the store, and param checks — nothing that
  imports the sandbox, MCP, `@loom/effect-runtime` or a Node builtin. `clientEntry.test.ts` walks
  the *built* client bundle to enforce this, and keeps it under a 64 KB size budget (about 34 KB
  minified today).
  The client entry also carries the pure helpers other client-side packages need (`terminalSteps`,
  `stepReferences`, `topoWaves`, `jsonPathSelect`, `outputShapeHashOf`, a client-safe mirror of the
  sandbox's shape hash, parity-tested). `@loom-ui/planner`, `renderer-terminal`, `renderer-lit` and
  `core` import ONLY `@loom-ui/hydration/client`; `clientConsumers.test.ts` fails if any of them
  reaches the root entry, QuickJS or the MCP plugin, by source import or built module graph.
- **The hydration projection.** Every handle publishes to one loom projection
  (`HYDRATION_PROJECTION_ID = "loom-ui.hydration"`, version `HYDRATION_PROJECTION_VERSION`) that a
  `HydrationStore` wraps; a compiled Blueprint's bindings read `values.<handle>` /
  `status.<handle>` from it. A handle's `HandleState` is `"pending" | "ready" | "stale" | "error" |
  "empty"`.
- **In-process vs. split.** `HydrationController` executes providers directly through an injected
  `TransientInvoker` (any loom `EffectRuntime` satisfies it structurally). `SplitHydrationController`
  (client) talks to a `HandleLoader` — the app's transport — which calls `serveHandle`/`serveHandles`
  (server) over that boundary; the server answers with the exact same `HandleLoadResult` shape the
  in-process controller publishes, so the two paths cannot disagree.
- **`scopeInvoker` and `principal`.** When the invoker is a planner `scopeInvoker` (a `ctx.decide` scope), do not configure `principal`: the scope already carries the execution's principal and the call is refused otherwise.
- **Scheduling.** Both controllers schedule by priority: P0 loads immediately, P1 batches within a
  short window, P2 waits for `markVisible`. An identical step (same tool, same arguments) runs once
  per pass no matter how many handles share it.
- **Params, time tokens, drift.** A step declares which argument names a load may override
  (`MCPToolNode.overridable`); `$now`/`$now±<n><s|m|h|d|w>` tokens resolve once per pass against an
  injected clock; drift (an input schema pin that moved, or an output that no longer reshapes or
  fits its contract) is reported through `onDrift`, never repaired here.

## API

### The projection and its store

- `HYDRATION_PROJECTION_ID`, `HYDRATION_PROJECTION_VERSION`, `HYDRATION_SET_EVENT` — the fixed
  projection id/version and the internal set event it folds.
- `hydrationProjection()`, `HydrationState`, `HandleSlice`, `HandleState`, `HandleStatus`,
  `HydrationScope` — the loom `Projection` itself and its state shape.
- `HydrationStore` — wraps a `projectionRuntime` and exposes `.state()` and
  `.runtimeSubscribe(fn)` for a renderer or `watch` to read/observe.
- `isReservedHandle(handle)` — true for a handle name the projection itself reserves.

### Running providers (server / Node only)

- `HydrationController` — in-process controller. Constructor takes `ControllerOptions`
  (`invoker`, `store`, `clock?`, `setTimer?`, `batchWindowMs?`, `concurrency?`,
  `maxConcurrentCalls?`, `principal?`, `cache?`, `onDrift?`, `outputKinds?`, `defaultParams?`,
  `inputDrift?`, `argumentHook?`, `contentRefArgs` (required), `acceptContentRefParam?`, `reshapers?`, `providers?`,
  `captureSample?`). Methods: `load(exp)`,
  `recompose(next)`, `markVisible(handle)`, `setParams(params, scope?)`, `invalidate(handle?)`,
  `inFlight()`, `dispose()` — each returns `{ findings: Finding[] }` where relevant.
- **Content-reference arguments (U9b).** `contentRefArgs` is REQUIRED on `ControllerOptions` and `ServeOptions`: the table
  `contentRefArgsFrom(capabilities)` builds (persist it with the capability set; `parseContentRefTable` re-reads it), or the
  explicit opt-out `"none"` (an experience with media nodes then reports `media-content-refs-unguarded`). Before ANY call a
  step's marked argument must be absent / null, a `{{steps.…}}` reference to an output its tool declares to be a content
  reference, or a param the host accepted; otherwise the step is refused (`media-arg-literal` / `media-arg-unproven-ref`) and
  the call is NOT made. The same check runs BEFORE every cache lookup (in-process and split), asking the gate again: a cached
  value is never served to a principal whose gate refuses, nor after a revocation, and a result a param filled is cached per
  principal only, never globally. A param that fills a marked argument (in-process `setParams`, or a split client's params,
  which are client input) is refused unless `acceptContentRefParam({ handle, stepId, toolName, kind?, param, value,
  principalId?, principal? }) => boolean` returns `true`. The gate MUST check that the value was ISSUED TO `principalId`
  (e.g. keep the `MediaRef`s `acceptMediaAttach` accepted for each principal and return `issued.get(principalId)?.has(value.address)`)
  and is still current (a revoked share answers `false`). `null` at a marked path is stripped before the call. The
  `argumentHook` runs after the check and is the host's own word. A tool whose schema mentions the marker but was unreadable
  (`"unknown"`) has every replaced param gated and every literal string refused.
- `executeProvider` — runs one `ProviderSpec`'s execution graph and reshaping; what both
  controllers and `serveHandle`/`serveHandles` call underneath.
- `ExecuteOptions`, `ProviderOutcome`, `DriftRecord`, `InputDriftMode` — the execution options and
  outcome/drift shapes `executeProvider` and `onDrift` use.
- `DriftReport` — what `ControllerOptions.onDrift` actually receives: `{ experienceId,
  versionHash, handle, spec, drift: readonly DriftRecord[], findings, proceeded }` — one or more
  drift records for the handle, plus the provider spec that drifted and whether the load
  retried and published (`inputDrift: "report-and-proceed"`).
- `HandleLoadResult` — what every load resolves to and what both controllers publish:
  `{ state: "ready", value, finding? } | { state: "stale" | "error", finding } | { state:
  "empty", finding }`.
- `HydrationCache`, `CacheVariant` (`params`, `kinds`, `contracts` — the bound kinds' `ValueContract.version`s are folded into the key; unversioned contracts leave keys unchanged, so call `invalidate()` after changing one) — the per-principal, per-params cache `HydrationController` uses
  by default (inject your own, or a fresh one per controller).
- `limitInvoker`, `memoInvoker`, `signalInvoker` — `TransientInvoker` wrappers: cap concurrency,
  de-duplicate identical calls within one pass, and bind an `AbortSignal`. `memoInvoker` keys on
  the principal AND every other call option except `signal` (e.g. a stamped execution identity
  `as`, or the `label` that names the transient execution when `as` is absent — an authorizer
  may grant by either), so calls made as different executions never share a result.
- `defineReshapers(entries)`, `jsonPathSelect(value, path)`, `outputShapeHashOf(value)` — build a
  `ReshaperRegistry` for `reshaping.engine: "Named"`, run a JSONPath reshape, and hash a value's
  structural shape for pinning `ProviderSpec.outputShapeHash`.
- `stepReferences`, `terminalSteps`, `topoWaves` — inspect an execution graph's `{{steps.…}}`
  references, find its terminal step(s), and compute its topological waves.
- `DEFAULT_TIME_RANGE`, `checkParams` — the default `{ from: "$now-24h", to: "$now" }` params, and
  a params validity check.

### The data plane: data-provider kinds (server / Node only)

A provider step used to be an MCP tool call and nothing else. A step now names a **kind**
(`step.kind`; absent = `mcp`, the original) and hydration runs it through the `DataProvider`
registered for that kind. A loom app whose data lives in a loom effect (a `tool$`, a read-model
query, an A2A call) binds it directly, without wrapping it as an MCP server.

- `DataProvider` — `{ kind, invoke(call, invoker, opts) }`. `call` is `{ stepId, target, args,
  expectedPin }`: `target` is the step's `toolName` (its id WITHIN the kind), `args` the prepared
  arguments (params, time tokens, templates, hook already applied), `expectedPin` the step's
  `toolSchemaHash`. `invoke` runs the target THROUGH the transient `invoker` it is handed with
  `opts` (signal, principal, label) — so the invoker's authoriser, budget and per-principal
  identity stay in force, the read path stays log-free, and a kind never sees the runtime.
- **The pin is the contract.** `invoke` MUST compare `expectedPin` with the target's current pin and
  throw `TypedFailure("schemaDrift", { observedHash })` BEFORE running the target. That is what makes
  drift a `DriftRecord` (`kind: "input"`, `providerKind` set for a non-MCP kind), what
  `remapOperation` repairs, and what `inputDrift: "report-and-proceed"` retries on. A kind that cannot
  say what its target's contract is must not be registered: there is no unpinned kind.
  `checkDataProviderConformance(provider, { target, pin, invoker })` returns the violations
  (empty = conformant), including a violation if a stale pin reached a direct call to `target`; it is
  a TEST HELPER — `defineDataProviders` cannot enforce the rule, so run it in a kind's own tests.
- `defineDataProviders(providers)` → `DataProviderRegistry` (`has`/`get`/`kinds`) — composition-time
  only, no discovery, no later registration; a malformed or duplicate kind id throws. Pass it as
  `providers` to `HydrationController`, `serveHandle(s)` or `executeProvider`. Default
  (`DEFAULT_DATA_PROVIDERS`): MCP only, byte-identical to before kinds.
- `mcpProvider` — the first registered kind: `mcp.invoke` with `expectedPin` as
  `expectedSchemaHash` (the plugin verifies it per call).
- `loomEffectProvider({ runtime, effects })` — the second kind, `loom-effect` (`LOOM_EFFECT_KIND`): a
  step whose `toolName` is a registered loom effect id, invoked via `invokeTransient`. Hydration is
  a read path (per viewer load, unmemoised, retried), so at CONSTRUCTION every listed effect is
  checked against `runtime` (`has` / `modeOf` / `kindOf`): it must be registered, explicitly
  `mode: "ambient"` (ADR 0073 — an UNDECLARED mode is refused, since loom itself only refuses an
  explicit `journaled` one), and not a `human` / `llm` kind. `effects` is an ALLOWLIST: a stored or
  planner-authored step can name any string. Each entry is `{ inputSchema }` (the pin is computed
  with `effectPin(schema)` = `jsonSchemaHash` of its JSON-Schema form, so editing the effect's zod
  schema drifts every stored step with no edit to the map) or `{ pin }` (HOST-ASSERTED: nothing
  checks it against the effect). Use `effectPin` also when building a planner
  `CapabilityRef.toolSchemaHash`, so both come from one source. An unlisted target fails
  `tool-targetUnregistered` and nothing runs; `mcp.invoke` and the sandbox effect cannot be listed.
  A target that itself throws `schemaDrift` surfaces as `tool-targetFailed` (`TARGET_FAILED`), never
  as pin drift — only the provider's own pin check emits `schemaDrift`, or a repair would flip the
  pin forever. An effect call is not memoised within a pass (`memoInvoker` coalesces `mcp.invoke`
  only); memoising `ambient` effects is a possible follow-up. A persisted experience must cross
  version boundaries only through the log: an older in-memory `executeProvider` / `seal` that
  predates kinds would run a kinded step as an MCP call.
- `ArgumentHookContext.kind` — the step's provider kind (absent for MCP): a hook keyed on
  `toolName` must also read it, since MCP tool `x` and loom effect `x` are different targets.
- An unregistered kind fails the WHOLE provider as `provider-kind-unregistered` before any step runs
  (never a throw, no partial calls); served publicly as a fixed text naming neither kind nor target.

A step's class identity is `toolKey(step)` (core): the bare `toolName` for MCP — every class recorded
before kinds still applies — and `<kind>:<toolName>` otherwise, so `toolClasses` stickiness and
`effectiveClasses` cover every kind and a loom effect never shares a class with a same-named MCP tool.

### Split hydration — server half

- `handleInventory(exp, opts: InventoryOptions): { inventory, findings }` — the client-safe
  inventory: per bound handle, its priority, the overridable param names, and an opaque, keyed
  revision.
- `InventoryOptions` — `{ revisionOf: RevisionFn, viewer?, declaredToolClasses?, undeclared? }`.
- `createServeSurface(policy?: ReadPolicy): ServeSurface` — `handleInventory` / `serveHandle` /
  `serveHandles` with the read policy bound once (prefer it to the free functions).
- `RevisionFn` — `(handle: string, fingerprint: string) => string`. MUST be a keyed hash (e.g. an
  HMAC over a server secret) — never the provider's own content fingerprint, which a client could
  confirm a guessed provider against offline; `handleInventory` throws if it returns a non-string,
  an empty string, or the fingerprint itself.
- `serveHandle(exp, request, opts: ServeOptions)`, `serveHandles(exp, requests, opts: ServeOptions)`
  — answer one or many `HandleLoadRequest`s; every request is treated as untrusted and re-checked
  server-side. `ServeOptions` extends `ExecuteOptions` (minus `params`/`kinds`) with `maxBatch?`
  (default `DEFAULT_MAX_BATCH`, 256) and `maxConcurrentCalls?` (default
  `DEFAULT_MAX_CONCURRENT_CALLS`, 32).
- `publicFinding(handle, finding)` — the public form of a finding a client may see (fixed code,
  handle name only — never a tool, argument, script or exception text).

### Split hydration — client half (also on `@loom-ui/hydration/client`)

- `SplitHydrationController` — same scheduling as `HydrationController`, over a `HandleInventory`,
  loading through an injected `HandleLoader`. Methods: `load(inventory)`, `recompose(next)`,
  `markVisible(handle)`, `setParams(params, scope?)`, `invalidate(handle?)`, `inFlight()`,
  `dispose()`.
- `HandleLoader` — the app's transport: `load(request, signal)` and `loadMany(requests, signal)`
  (both required — loads the scheduler starts together go out as one `loadMany` round trip).
- `HandleInventory`, `HandleRef`, `HandleLoadRequest`, `SplitControllerOptions` — the wire shapes.
- `handleOfPath(path): string | undefined`, `HYDRATION_VALUES_PREFIX` — client entry only. Maps a
  widget's binding path (`values.<handle>`) back to its hydration handle: the exact inverse of
  `@loom-ui/core`'s `hydrationPath`. `undefined` unless the path is `values.` plus a non-empty
  handle (the bare prefix, `status.<handle>` and near-misses like `valuesh` all give `undefined`);
  everything after the first `values.` is the handle, spelled exactly as `hydrationPath` spelled
  it (a handle containing `.` round-trips here but will not resolve at render time, because
  binding paths are resolved by splitting on `.` — keep handles dot-free). The browser takes these
  from here so the client entry never pulls core's runtime graph into a bundle. The prefix is
  defined in both packages (core cannot import hydration); a type-level `satisfies` and a test pin
  them equal.

### Repair (app-side, durable)

- `SCHEMA_REPAIRED`, `SchemaRepairedPayload` — the userspace event name and payload an app emits
  after applying a repair, from inside a loom execution.
- `remapOperation(spec, drift)` — turns an INPUT drift record into the `Operation` that repairs it
  (refuses output/reshape drift with `repair-needs-planner` — that needs `@loom-ui/planner`'s
  `reviseForDrift`).

## Examples

In-process hydration (illustrative — not a compiling snippet):

```ts
import { HydrationController, HydrationStore, SCHEMA_REPAIRED, remapOperation } from "@loom-ui/hydration";

const store = new HydrationStore(projectionRuntime, {
  experienceId: experience.experienceId,
  principalId: viewer.id,
});
const controller = new HydrationController({
  invoker: effectRuntime, // any EffectRuntime satisfies TransientInvoker
  store,
  principal: { id: viewer.id, chain: viewer.principalChain },
  onDrift: (report) => durableRepair(report), // the app's own loom execution
});
controller.load(experience); // P0 now, P1 in ~50ms, P2 on markVisible
```

Split hydration, client side (illustrative):

```ts
import { HydrationStore, SplitHydrationController } from "@loom-ui/hydration/client";

const split = new SplitHydrationController({
  store,
  loader: {
    load: (request, signal) => postJson("/hydrate", request, signal),
    loadMany: (requests, signal) => postJson("/hydrate/batch", requests, signal),
  },
});
split.load(inventory); // fetched from the server's handleInventory(exp, { revisionOf })
```

## Notable behaviours and guarantees

- **A handle that feeds a media widget is always contract-checked (U9).** When the controller is given
  `outputKinds` and a handle's bound nodes resolve to `Image`/`Audio`/`Video`/`File`, the load runs as
  `outputCheck: "contract"` whatever the provider declared: a shape pin passes any value of the pinned
  shape (inline bytes or a locator included), and what is published reaches the store, a seen log and a
  split-hydration payload. A value that is not a `MediaRef` is drift (`output-contract-drift`), never
  published. A restricted media handle is never invoked, as for any restricted handle. Kinds are
  resolved through the catalogue when `outputKinds` is given AND by node type alone: a node whose `type` is a
  framework media kind marks its handle as media even with NO `outputKinds`, so forgetting it fails closed (a
  `media-output-kinds-missing` warning says to pass it). The split server (`serveHandle`/`serveHandles`) applies
  the same rule, including its cache variant. Resolving a ref to a URL is NOT hydration's job: it is the host's `MediaResolver`, called by
  the renderer (see `@loom-ui/core` "Media").

- **A host-declared tool class floors it too.** `declaredToolClasses` (on `HydrationController`,
  `handleInventory` and `serveHandle(s)`; `@loom-ui/core`'s `DeclaredToolClasses`) makes a handle
  whose provider calls a declared tool at least that class, even when no stored node carries one.
  **Bind it once with `createServeSurface(policy)`**: it returns `handleInventory`, `serveHandle` and
  `serveHandles` with a core `ReadPolicy` (`{ declaredToolClasses, undeclared }`) applied to every
  call, so the inventory and the loader cannot disagree because one call forgot the table. A per-call
  `declaredToolClasses` / `undeclared` only ADDS (`{}` or `undefined` cannot lower it). The free
  `handleInventory` / `serveHandle(s)` take the table per call and are the low-level API.
  `undeclared: "deny"` refuses every handle whose provider calls a tool the table does not list (no
  table = an empty one: all tool-bound handles), for every viewer, until the tool is declared; a
  per-call table cannot list a new tool once deny is bound. `HydrationController` takes the SAME
  `readPolicy` (`new HydrationController({ readPolicy })`; the separate `declaredToolClasses` /
  `undeclared` options join it raise-only), so a host passes ONE policy to the controller and to
  `createServeSurface`.
- **A classified handle is never fetched for a viewer who may not see it (fail-closed).** Pass
  `viewer: { clearance }` (`@loom-ui/core`'s `Viewer`) to `HydrationController`, `handleInventory`
  and `serveHandle`/`serveHandles`. A handle bound by any node whose `sensitivity` is above the
  clearance is not planned, not cached and its provider is never invoked, and the controller writes
  NOTHING to the store for it: no value and no status, so a store projected to a client does not
  even name the handle (a stale entry is removed). The viewer is snapshotted at construction;
  `setViewer` re-plans (drops now-restricted values, aborts their in-flight loads, loads newly
  allowed ones). Token streams obey the same gate: `ctl.append(handle, chunk)` (and `store.append` once a
  controller fronts the store) refuses a handle that is restricted for the viewer (`restricted`), not
  bound (`stream-unbound`), or — with `outputKinds` — not a `StreamingText` widget
  (`stream-kind-mismatch`); nothing is written. `handleInventory`
  omits it (the client learns neither name nor revision); the server answers a client that names it
  anyway exactly as for a handle the experience does not bind (`unknown-handle`, no existence
  oracle) and logs the full `restricted` finding to `onFinding`. No viewer = no clearance, with one
  `viewer-not-supplied` warn when anything is classified; unclassified handles are unaffected. Use
  the same viewer you pass to `compile`, and one store per viewer.

- **`empty` is an answer, not an error.** A step whose `{{steps.<id>.output.<path>}}` indexes past
  the end of a real (but short) upstream array publishes `empty` — a warn (`upstream-empty`), no
  value, never cached, never drift, never repaired. Every other miss (a bad key, `null` mid-path, a
  step with no output) stays `unresolved-step-reference` → `error`.
- **Relative time is read once per pass.** `$now`/`$now±<n><unit>` resolve against one clock read,
  so two steps in the same load asking for "the last day" agree; anything else starting `$now` is
  refused (`invalid-time-token`) before it reaches a tool.
- **Calls are capped and de-duplicated.** `maxConcurrentCalls` bounds the whole controller (or one
  server batch); beneath it, one step memo per pass runs an identical step once no matter how many
  handles share it, ref-counted so one caller's abort never cancels another caller's still-pending
  wait on the same call.
- **A provider never reaches a browser.** Split hydration ships only the inventory
  (`handleInventory`) and answers requests (`serveHandle`); a client only ever sees a finding's
  PUBLIC form (fixed code + handle name) — the full finding (tool, step, script, exception text)
  reaches only the server's own `onFinding` hook.
- **Drift is reported, never repaired here.** `onDrift` fires with a `DriftReport`
  (`{ experienceId, versionHash, handle, spec, drift: readonly DriftRecord[], findings, proceeded
  }`) — one or more typed `DriftRecord`s for the handle, not a single record. Applying a fix
  (`remapOperation` for input drift, `@loom-ui/planner`'s `reviseForDrift` for output drift) and
  emitting `SCHEMA_REPAIRED` is the app's job, inside its own durable execution. Nothing in this
  package dedupes or bounds repairs — an app must dedupe on `(versionHash, handle)` and cap
  attempts itself.
- **A `scriptError` payload is untrusted, unlogged text.** A reshaping script's own exception can
  echo the raw output; loom-ui classifies drift by the failure's typed channel alone and never
  copies that text into a finding message, handle status or drift record.
- **Recompose keeps shared handles.** `controller.load(nextExperience)` (or
  `SplitHydrationController.recompose`) aborts and drops handles the new artifact no longer binds
  and keeps the ones still bound — no full re-hydrate on every revision.

## See also

- [../core/README.md](../core/README.md) — the Experience Model and `compile` this package
  hydrates.
- [../planner/README.md](../planner/README.md) — `reviseForDrift` repairs the output drift this
  package reports.
- [../renderer-lit/README.md](../renderer-lit/README.md) and
  [../renderer-terminal/README.md](../renderer-terminal/README.md) — read the projection this
  package publishes.
- [../../README.md](../../README.md) — root overview, including the full hydration options
  reference and split-hydration wiring.
