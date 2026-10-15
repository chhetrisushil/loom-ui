# Hydration reference

Hydration resolves an experience's provider handles through loom's transient effects and publishes
the results as one loom projection. This page covers the options, the split (server / browser)
arrangement and the per-feature rules. The package overview is in
[`@loom-ui/hydration`](../../packages/hydration/README.md).

## Hydrate and repair

A sketch of the in-process loop and the durable repair that closes it. It is not a compiling
snippet: `projectionRuntime`, `effectRuntime`, `viewer`, `durableRepair` and `ctx` come from the
app.

```ts
import { apply } from "@loom-ui/core";
import {
  HydrationController,
  HydrationStore,
  SCHEMA_REPAIRED,
  remapOperation,
} from "@loom-ui/hydration";

const store = new HydrationStore(projectionRuntime, {
  experienceId: experience.experienceId,
  principalId: viewer.id,
});
const controller = new HydrationController({
  invoker: effectRuntime, // EffectRuntime satisfies TransientInvoker
  store,
  principal: { id: viewer.id, chain: viewer.principalChain },
  contentRefArgs: "none", // REQUIRED: a table from contentRefArgsFrom(capabilities), or "none"
  onDrift: (report) => durableRepair(report), // the app's loom execution, not this package
});
controller.load(experience); // P0 now, P1 in 50 ms, P2 on markVisible
// ...compile(experience, { hydrationProjectionId: HYDRATION_PROJECTION_ID,
//      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION, ... })

// Inside durableRepair (a loom execution):
const r = remapOperation(report.spec, report.drift);
if (r.ok) {
  const next = apply(sealedExperience, r.op); // then seal + put
  ctx.emit(SCHEMA_REPAIRED, { ...report, op: r.op });
}
```

## Options and split hydration

```ts
// Server (Node): the root entry: execution, the split server half, invokers, reshapers.
import {
  DEFAULT_TIME_RANGE,
  HydrationController,
  defineReshapers,
  handleInventory,
  serveHandles,
} from "@loom-ui/hydration";
// Browser: the client entry, never the root entry (see "Which entry" below).
import { HydrationStore, SplitHydrationController } from "@loom-ui/hydration/client";

// A provider may be checked by what its widgets can render instead of an exact output shape:
const provider: ProviderSpec = { ...spec, outputCheck: "contract" }; // an empty list or a null cell is healthy

const controller = new HydrationController({
  invoker: effectRuntime,
  store,
  contentRefArgs: "none", // REQUIRED, as on ServeOptions
  outputKinds: { catalog, surface: "web" }, // a handle's kinds = its bound nodes on this surface
  clock: Date.now, // `$now`, `$now-7d`, `$now+1h` resolve against it, once per pass
  defaultParams: DEFAULT_TIME_RANGE, // { from: "$now-24h", to: "$now" }
  maxConcurrentCalls: 4, // controller-wide; an identical step runs once per pass, per principal
  inputDrift: "report-and-proceed", // a read-only viewer: record the drift, retry once, publish
  argumentHook: (args, { params, now }) => args, // the host's last word before each call
  reshapers: defineReshapers({ "rows-to-table": (raw) => toTable(raw) }), // engine "Named"
});
controller.setParams({ from: "$now-7d" }); // a time-range picker
controller.setParams({ region: "north" }, { handle: "fleet" }); // one widget's filter
```

Split hydration keeps providers on the server. `revisionOf` is REQUIRED and must be a KEYED hash (an
HMAC over a server secret), never the spec's own content fingerprint, which a client could confirm a
guessed provider against offline.

```ts
// Server
const revisionOf = (handle, fingerprint) =>
  createHmac("sha256", serverSecret).update(`${handle}\0${fingerprint}`).digest("hex");
// GET  -> { blueprint: compile(exp, opts).blueprint,
//           inventory: handleInventory(exp, { revisionOf }).inventory }
// POST -> serveHandles(exp, requests, {
//           invoker: effectRuntime, now: Date.now(), contentRefArgs: "none",
//           outputKinds, reshapers, cache, onFinding,
//         })
//         (serveHandle answers one request; serveHandles is the batch pass it is built from)

// Browser
const split = new SplitHydrationController({
  store,
  loader: {
    load: (request, signal) => postJson("/hydrate", request, signal),
    // required: there is no fallback to N single loads
    loadMany: (requests, signal) => postJson("/hydrate/batch", requests, signal),
  },
});
split.load(inventory);
```

### Contract check

`outputCheck: "contract"` validates the reshaped value with `checkKindValue` against EVERY kind the
handle feeds on the hydrated surface (a handle bound by a `Kpi` and a `Table` must satisfy both);
drift names the failing kind (`DriftRecord.contractKind`).

No kinds supplied is an error (`output-contract-unbound`), a kind with NO contract (neither the
framework's nor the catalogue's `valueContracts`) is REFUSED (`output-contract-missing`, no drift
record; `validateExperience` reports `output-contract-uncontracted` ahead of it), and `undefined` is
drift.

A host's own kinds declare their contract in `SemanticCatalog.valueContracts` (composed under the
framework's; an entry for a framework kind is `contract-overrides-framework` and ignored).

The input schema pin is checked the same way under both modes.

### Params

A step lists the argument names a load may override (`MCPToolNode.overridable`); a param never
replaces an argument holding a `{{steps.…}}` template and is never itself one. Precedence:
`defaultParams` < `setParams(p)` < `setParams(p, { handle })`, filtered to the provider's declared
names — so an unrelated param change reloads nothing. The cache key carries the params AS DECLARED
(`$now` tokens unresolved) plus the checked kinds; freshness comes from the cache entry's TTL, never
from re-resolving a token.

### Empty upstream (loom ADR 0100)

A step argument `{{steps.<id>.output.<path>}}` whose path indexes past the end of a real ARRAY in
the upstream's output (`rows[0]` over `rows: []`, `rows[3]` over two rows) is not a bad path — the
upstream answered, with no such row. The step fails with `upstream-empty` (a WARN, `step "<id>"
references "<up>" at path "<p>": the upstream has no such row`), and a provider where EVERY step
that failed on its own failed that way (the rest skipped as `dependency-failed`) publishes the
handle's status `empty` with that finding and NO value. Every other miss — a missing key, `null`
mid-path, an index on a non-array, a step with no output — is still `unresolved-step-reference` →
`provider-failed` → `error`, and a bad path anywhere in a step wins over an out-of-range one; any
other failure in the same graph keeps `provider-failed`.

`empty` is an answer (the same question is not re-asked), never cached (there is no value), never
drift and never repaired.

The hydration projection is version `1.1.0`: its fold DROPS `values[handle]` whenever an `empty`
status is published, so an earlier `ready` value never shows under "no data" — loom ADR 0100 makes
clearing it a producer's MUST.

Split and in-process publish the same `empty`: `upstream-empty` is a public code (`no data for this
view`), and a loader's `empty` answer is believed only with a finding. The Lit base draws `<title>:
No data` in a `role="status"` live region (`data-state="empty"`, the finding in `title`), as loom's
React marker does; the terminal prints loom's row `○ <title>: <message>`.

That difference is intended: the Lit base always SAYS "No data" (the reason is in `title`), while
the terminal row IS the finding's message (loom ADR 0100 D1/D2) — so in-process it reads the full
hydration message (`step "<id>" references "<up>" at path "<p>": the upstream has no such row`) and
through split the public `no data for this view`.

**Known masking case:** because the row count is DATA, a FIXED index past the end of a NON-empty
array (`rows[5]` over two rows) also reads as "No data", not as an error — a template that should
never have indexed that far is indistinguishable from an upstream that returned too few rows.
Template the index you mean (usually `[0]`), or check the row count in the upstream's reshaping.

### Relative time

`$now`, `$now±<n><s|m|h|d|w>` become ISO-8601 instants against one clock read per pass, so two steps
asking for "the last day" in the same load ask the same question; anything else that starts `$now`
is refused (`invalid-time-token`) rather than sent to a tool.

Tokens resolve before templates, so tool output is never rewritten.

### Named reshaping

`reshaping.engine: "Named"` looks a step's `scriptRef` up in an injected `ReshaperRegistry`
(`defineReshapers`) and runs it in-process — no sandbox hop — and an unregistered name is a finding,
never a silent fall-through to another engine.

The reshaper receives a COPY of the raw terminal output (`structuredClone`); a raw value the clone
cannot represent (a function anywhere in it) is refused before the reshaper ever runs, never passed
through live.

### Calls

`maxConcurrentCalls` caps transient calls in flight across the WHOLE controller (unbounded by
default) or, server-side, the whole batch (default `DEFAULT_MAX_CONCURRENT_CALLS`, 32 — a client
sizes the batch, so the server bounds its fan-out; an explicit option overrides; it bounds ONE
batch, so for a server-wide bound wrap the invoker once in the exported `limitInvoker` and share it
across batches);

beneath it, one step memo per pass — keyed by principal too — runs an identical step once no matter
how many handles share it, ref-counted so one caller's abort never cancels a call another caller of
the same step is still waiting on.

### Split

The inventory lists, per bound handle, its priority (the Blueprint carries none), the NAMES of its
overridable params and an opaque, KEYED revision (`revisionOf`) — never a tool, an argument or a
script.

`serveHandle`/`serveHandles` treat every request as untrusted (version, handle and params are all
re-checked on the server; an unbound handle is `unknown-handle`; a batch over `maxBatch`, default
256, is refused whole as `batch-too-large` — still answered with one result per request, so a
transport should bound request bodies) and return the same `HandleLoadResult` the in-process
controller publishes. A client only ever receives a finding's PUBLIC form — a fixed code and a
message keyed off it, naming only the handle; the full finding (tool, step, script, hash, exception
text) reaches only the server's own `onFinding` hook.

`HandleLoader` must implement BOTH `load` and `loadMany` — loads the scheduler starts together (the
P0s of one bind, a P1 batch) go out as ONE `loadMany` round trip, so handles sharing an upstream
step share the call server-side too.

As with `invalidate`, a lazy (P2) handle whose question changes waits for the surface's next
`markVisible`.

After a recompose the app serves the NEW experience and hands the client its new inventory; a
request still carrying the previous `versionHash` (in flight across the recompose) is answered
`version-mismatch` and published as an `error` status — the app reloads
(`controller.load(newInventory)`), which asks that handle again under the new version.

## Which entry

`@loom-ui/hydration` (the root entry) is the SERVER side: it executes providers, so it imports
loom's sandbox (QuickJS WASM, worker threads) and MCP plugin (`node:http`, `node:crypto`), and a
browser bundle that imports it grows by megabytes and pulls node modules.

A browser imports `@loom-ui/hydration/client`, which carries only what split hydration needs on the
client: `SplitHydrationController` (`load`/`recompose`, `markVisible`, `setParams`, `invalidate`,
`dispose`), `HydrationStore`, `hydrationProjection` and its `HYDRATION_PROJECTION_ID` /
`HYDRATION_PROJECTION_VERSION` / `HYDRATION_SET_EVENT`, `isReservedHandle`, `checkParams`,
`DEFAULT_TIME_RANGE`, and the types `HandleLoader`, `HandleLoadRequest`, `HandleLoadResult`,
`HandleInventory`, `HandleRef`, `SplitControllerOptions`, `LoadParams`, `HandleSlice`,
`HandleState`, `HandleStatus`, `HydrationScope`, `HydrationState`. It also carries
`HYDRATION_VALUES_PREFIX` and `handleOfPath`, the plan helpers `stepReferences`, `terminalSteps` and
`topoWaves`, `jsonPathSelect`, `outputShapeHashOf`, the `ReshapeFailureKind` / `ReshapeResult` /
`TransientInvoker` / `DriftRecord` types, and the conversation helpers `connectConversation` and
`publishChat`.

The root entry still exports all of these too, so server code needs one import. The in-process
`HydrationController` runs providers, so it is server-side (or a Node-only app).

`clientEntry.test.ts` walks the built `dist/client.js` module graph and fails if it reaches the
sandbox, the MCP plugin, the effect runtime, any node builtin or hydration's server modules, and
bundles it for the browser against a 56 KiB size budget (measured about 54 KB minified).
