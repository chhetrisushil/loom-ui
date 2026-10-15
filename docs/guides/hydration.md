# Hydrating an experience

**Purpose.** Fill a compiled blueprint with data: choose between in-process and split hydration,
pass parameters such as a time range, pick the right package entry for the browser or the server,
and handle drift safely.

**Prerequisites.** A compiled blueprint and an experience whose nodes bind providers
([getting started](../getting-started.md), steps 1 to 3). Snippets are mirrored from
[`hydration.test.ts`](../snippets/src/hydration.test.ts).

## How hydration fits

An experience's nodes bind **handles**; its `providers` map each handle to a **provider**: an
execution graph of tool calls (`stepId`, `toolName`, `toolSchemaHash`, `arguments`, `dependsOn`), a
**reshaping** step that turns the raw output into the value the widget wants, a `cachePolicy` and an
optional `outputCheck`. Hydration runs providers and publishes every result into one loom
projection (`HYDRATION_PROJECTION_ID`) as `values.<handle>` and `status.<handle>`. A handle's status
is `pending`, `ready`, `stale`, `error` or `empty`. The compiled blueprint reads exactly those paths,
so a renderer needs no knowledge of providers.

Hydration is **read-only and log-free**: it only calls `invokeTransient` and never emits a durable
event. Repairing a provider is your own loom execution's job.

## Choose a mode

| | In-process | Split |
| --- | --- | --- |
| Controller | `HydrationController` | `SplitHydrationController` |
| Runs where | one process holds the experience and the invoker | server executes; browser only asks |
| The client learns | everything (it is the server) | handle names, priorities, param **names**, an opaque revision; never a tool, argument or script |
| Use for | a CLI, a TUI, a server-rendered page, tests | a browser UI, anything past a trust boundary |

Both publish the same `HandleLoadResult` shape, so the two paths cannot disagree.

## Which entry to import

| Where | Import from | Why |
| --- | --- | --- |
| Node / server | `@loom-ui/hydration` | executes providers; its module graph reaches loom's sandbox (QuickJS WASM, worker threads) and the MCP plugin (`node:http`, `node:crypto`) |
| Browser | `@loom-ui/hydration/client` | the split controller, the loader contract, `HydrationStore` and param checks only; fitness tests walk the built graph to keep it free of the sandbox, MCP, the effect runtime and node builtins |

Importing the root entry into a browser bundle grows it by megabytes and pulls node modules. If your
bundler complains about `node:*` modules, or the bundle is far larger than expected, you imported
the wrong entry. The same holds for `@loom-ui/lineage`, `@loom-ui/changes` and `@loom-ui/learning`:
they are server-side and must never enter a client graph.

<!-- snippet: imports -->

```ts
import { createHmac } from "node:crypto";
import { type Experience, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  DEFAULT_TIME_RANGE,
  type DriftReport,
  HydrationCache,
  HydrationController,
  type RevisionFn,
  type TransientInvoker,
  defineReshapers,
  handleInventory,
  remapOperation,
  serveHandles,
} from "@loom-ui/hydration";
import {
  type HandleLoader,
  HydrationStore,
  SplitHydrationController,
} from "@loom-ui/hydration/client";
import { TypedFailure } from "@loom/core";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
```

## Split hydration, end to end

**Server.** Two endpoints. A page `GET` returns the compiled blueprint and
`handleInventory(experience, { revisionOf })`. A hydrate `POST` runs untrusted requests through
`serveHandles` (one pass, handles that share an upstream step share the call) or `serveHandle` (one
request).

<!-- snippet: server -->

```ts
// The revision a client sees must be KEYED: an HMAC over a server secret. A bare hash of the
// provider would let a client confirm a guessed provider offline.
const revisionOf: RevisionFn = (handle, fingerprint) =>
  createHmac("sha256", serverSecret).update(`${handle}\0${fingerprint}`).digest("hex");

// Page GET: the inventory lists handles, priorities, param NAMES and revisions. No provider.
const { inventory } = handleInventory(experience, { revisionOf });

// Hydrate POST: untrusted requests in, `HandleLoadResult`s out, in request order.
const cache = new HydrationCache(Date.now);
const serve = (requests: Parameters<typeof serveHandles>[1]) =>
  serveHandles(experience, requests, {
    invoker,
    now: Date.now(),
    contentRefArgs: "none",
    outputKinds: { catalog, surface: "web" },
    reshapers,
    cache,
  });
```

Two details are load-bearing:

- **`revisionOf` is required and must be keyed.** It lets a client notice that the provider behind a
  handle changed without learning anything about it. If it were a plain hash of the provider, a
  client could confirm a guessed provider offline. Use an HMAC over a server secret; the call
  throws if you omit it or return the fingerprint unchanged. Rotating the key, or any provider edit,
  changes every revision, and the client re-asks each changed handle once.
- **Every request is untrusted.** `serveHandles` checks the version, the handle and the params
  (against the names the provider declares), bounds the batch (`maxBatch`, default 256) and the
  upstream fan-out (`maxConcurrentCalls`, default 32), and returns public, fixed-text findings. The
  full findings go to your `onFinding` hook, for your own logs only.

**Client.** `SplitHydrationController` takes a `HandleLoader`, which is your transport (two `fetch`
calls in an app). `loadMany` is required, not optional: the scheduler starts every `P0` handle of
one bind together and sends them as a single round trip.

<!-- snippet: client -->

```ts
// The transport is yours; here the two calls go straight to the server function above.
const loader: HandleLoader = {
  load: async (request) => (await serve([request]))[0] as Awaited<ReturnType<typeof serve>>[0],
  loadMany: (requests) => serve(requests),
};

const store = new HydrationStore(new InMemoryProjectionRuntime(), {
  experienceId: inventory.experienceId,
});
const split = new SplitHydrationController({
  store,
  loader,
  defaultParams: DEFAULT_TIME_RANGE, // { from: "$now-24h", to: "$now" }
});
split.load(inventory);
```

Priorities schedule the loads: `P0` immediately, `P1` after a short batching window, `P2` when you
call `markVisible(handle)` (for example from an `IntersectionObserver` through the Lit adapter's
`onVisible`). An identical step (same tool, same arguments) runs once per pass.

## Parameters and time ranges

A step lists which argument names a load may override with `overridable`. A param can never
replace an argument that holds a `{{steps.<id>...}}` template, and a name the provider did not
declare is dropped from the request. Precedence is `defaultParams`, then `setParams(p)`, then
`setParams(p, { handle })`.

<!-- snippet: params -->

```ts
split.setParams({ from: "$now-7d" }); // a time-range picker: every handle that declares `from`
split.setParams({ to: "$now-1h" }, { handle: "latency-p99" }); // one widget's filter
```

Relative time tokens (`$now`, `$now-24h`, `$now+1h`, units `s m h d w`) resolve to ISO-8601
instants against **one** clock read per pass, on the server in split mode, so two steps asking for
"the last day" ask the same question. Anything else beginning `$now` is refused
(`invalid-time-token`) rather than sent to a tool. `DEFAULT_TIME_RANGE` is
`{ from: "$now-24h", to: "$now" }`.

In process, the same methods exist on `HydrationController`, which also accepts `clock`,
`defaultParams`, `maxConcurrentCalls` and an `argumentHook` that gets the last word on each call's
arguments. Option names and defaults are in the [hydration reference](../reference/hydration.md).

## Drift

A provider can go stale in two ways, and hydration only **reports** them:

| Drift | Cause | Repair |
| --- | --- | --- |
| `input` | a tool's input-schema pin moved (`schemaDrift`) | `remapOperation(spec, drift)` gives the operation |
| `output` | the reshaped value no longer fits its pin or its widget's contract, or reshaping failed | only a [planner](planners-and-learning.md) can re-author it |

<!-- snippet: drift -->

```ts
const reports: DriftReport[] = [];
const controller = new HydrationController({
  invoker: moved,
  store,
  contentRefArgs: "none",
  reshapers: defineReshapers({ "to-kpi": (raw) => raw }),
  // Reported, never repaired here: hydration is read-only and writes no event.
  onDrift: (report) => reports.push(report),
});
controller.load(experience);
// ... later, once `onDrift` has fired, in the durable execution that owns the experience:
const report = reports[0];
const repair = report && remapOperation(report.spec, report.drift);
if (repair?.ok) console.log(repair.op); // a `remapProvider` operation with the new pin
```

`inputDrift: "report-and-proceed"` suits a read-only viewer that cannot persist a repair: it
records the drift, retries once and publishes. Two rules for your repair loop: dedupe on
`(versionHash, handle)` and cap attempts (loom-ui never bounds repairs, and a repair that does not
fix the output would otherwise re-plan on every load); and never forward `observedSample` (raw tool
output) to a client.

Choose how a provider's output is checked: `outputCheck: "contract"` validates the reshaped value
against the contract of **every** kind the handle feeds on the hydrated surface (supply
`outputKinds: { catalog, surface }`), so an empty list or a null cell is healthy, where the default
shape pin would call it drift. Pin a shape hash with `outputShapeHashOf`, nothing else.

## Gotchas

- `contentRefArgs` is required on the controller and on `serveHandles`. Pass `"none"` when no tool
  takes a content reference; a media-bound handle then reports `media-content-refs-unguarded`.
- Give a classified surface the same `viewer` and `audience` in `compile`, `handleInventory` and
  `serveHandles`, or the data boundary and the screen disagree. See
  [sensitivity and audiences](sensitivity-and-audiences.md).
- A `HydrationStore` is per (experience, principal, audience). A controller whose audience differs
  from its store's throws `HydrationAudienceMismatchError`.
- `HydrationCache` is bounded (LRU, `maxEntries`, default 10,000); an evicted entry is a miss.
- A reshaper receives a copy of the raw output. An unregistered `Named` reshaper is a finding, never
  a silent fall-through to another engine.
- After a recompose, call `controller.load(nextExperience)`: handles the new artifact no longer
  binds are aborted and dropped, shared ones are kept.

## See also

- Reference: [hydration](../reference/hydration.md).
- Package: [`@loom-ui/hydration`](../../packages/hydration/README.md).
- Examples (in `loom-examples`): `split-hydration` (a weather board across a trust boundary, with
  drift and shared upstream calls).
- Next: [rendering](rendering.md), [sensitivity and audiences](sensitivity-and-audiences.md).
