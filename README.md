# loom-ui

loom-ui is a generic UI framework on top of loom. You describe an
**experience** — semantic nodes such as `Metric`, `Trend`, `Collection`, with stable ids, bound to
data by handle — and loom-ui compiles it, per surface, to a loom `Blueprint` that loom's renderers
draw. Composition is recorded as a content-addressed artifact plus the operations that produced
it, so a view can be replayed, revised without losing node identity, and rendered without a model
in the path.

| Package | Job |
|---|---|
| `@loom-ui/core` | Experience Model, operations + deterministic replay, semantic catalogue, compiler to loom `Blueprint`; `./log` subpath for content-addressed persistence |
| `@loom-ui/hydration` | Resolves an Experience's provider handles through loom's transient effects (MCP graph → sandbox/JSONPath/named reshape → a shape pin, or the bound kinds' value contracts), publishes them as one loom projection (`loom-ui.hydration`), schedules by priority, applies per-load params to overridable arguments and resolves relative-time tokens against an injected clock, caches per principal and per params, caps and de-duplicates tool calls, reports drift for the app's durable repair (or proceeds past an input drift for a read-only viewer) — in-process, or split across a trust boundary (`handleInventory` + `serveHandle` on the server, `SplitHydrationController` + a `HandleLoader` on the client, from the browser-safe `@loom-ui/hydration/client` subpath) |
| `@loom-ui/renderer-lit` | A loom DOM renderer adapter (`renderBlueprintDom`, subpath `./dom`, with a container-renderer seam keyed by layout role — `DomRenderOptions.containers`) and Lit elements registered under loom kinds (`litRegistry`) — every built-in kind plus the framework kinds (`FRAMEWORK_KINDS`: `TimeSeries`, `BarChart`, `Kpi`, `Table`, `StatusCard`, `Note`, `A2UIView`, `SandboxView`); four app-level elements (time-range picker, locale picker, sandbox, A2UI view) |
| `@loom-ui/renderer-terminal` | String renderers for every framework kind merged over loom's terminal registry, `renderExperience` (loom's status matrix — a declared channel with no value yet prints loom's loading row `⋯ <title>` — with the framework's value check in loom's `check` seam), and `watch` |
| `@loom-ui/planner` | Planner SPI (`compose`/`revise` → operations) with a reference planner that runs its model call as one `ctx.decide` per plan, a catalogue-derived output contract (a model may set `binding.sensitivity` only on a type whose entry declares `sensitivity: "model-may-set"`), plan-time pins, drift re-authoring (`reviseForDrift`), the conformance kit any planner must pass, and `interpretAction` (experience ops vs business actions) |

Design: `loom/docs/requirements/2026-09-21-loom-ui-design.md`. Contributor notes: `AGENTS.md`.

## Shape of a composition

*Illustrative — not a compiling snippet.* It elides the `meta`, `ctx` and `contentStore` a real
caller supplies, and names a catalogue it does not define.

```ts
import { apply, compile, genesis } from "@loom-ui/core";
import { EXPERIENCE_COMPOSED, putExperience } from "@loom-ui/core/log";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration";

let exp = genesis({ experienceId: "checkout-triage", intent: { objective: "Investigate checkout latency", source: "user" }, meta });
const r = apply(exp, { type: "insertNode", parentId: "root", node: { id: "p99", order: "V", kind: "semantic", type: "Metric", typeVersion: "1.0.0", span: 6, props: { unit: "ms" }, binding: { handle: "latency-p99", priority: "P0" } } });
if (!r.ok) throw new Error(r.finding.message);

// Inside a loom execution: seal, store the bytes, log the reference (a userspace event).
// `putExperience` is total — an experience carrying a value the content address cannot be taken
// over (NaN, a bigint) comes back as an `artifact-unhashable` finding rather than a throw.
const put = await putExperience(contentStore, r.value);
if (!put.ok) throw new Error(put.finding.message);
ctx.emit(EXPERIENCE_COMPOSED, { ref: put.ref, parents: put.experience.parents, ops: [{ op, by: { source: "user" }, at: now }] });

// Anywhere, later, with no model in the path: compile per surface and hand loom the Blueprint.
const { blueprint, findings } = compile(put.experience, { surface: "web", catalog, hydrationProjectionId: HYDRATION_PROJECTION_ID, hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION });
```

## Shape of hydration (illustrative — not a compiling snippet)

```ts
import { HydrationController, HydrationStore, SCHEMA_REPAIRED, remapOperation } from "@loom-ui/hydration";

const store = new HydrationStore(projectionRuntime, { experienceId: experience.experienceId, principalId: viewer.id });
const controller = new HydrationController({
  invoker: effectRuntime,                 // EffectRuntime satisfies TransientInvoker
  store,
  principal: { id: viewer.id, chain: viewer.principalChain },
  onDrift: (report) => durableRepair(report),  // the app's loom execution, not this package
});
controller.load(experience);              // P0 now, P1 in 50 ms, P2 on markVisible
// ...compile(experience, { hydrationProjectionId: HYDRATION_PROJECTION_ID, hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION, ... })

// Inside durableRepair (a loom execution):
const r = remapOperation(report.spec, report.drift);
if (r.ok) { const next = apply(sealedExperience, r.op); /* seal + put + */ ctx.emit(SCHEMA_REPAIRED, { ...report, op: r.op }); }
```

## Hydration options and split hydration (illustrative — not a compiling snippet)

```ts
// Server (Node): the root entry — execution, the split server half, invokers, reshapers.
import { DEFAULT_TIME_RANGE, HydrationController, defineReshapers, handleInventory, serveHandles } from "@loom-ui/hydration";
// Browser: the client entry — never the root entry (see "Which entry" below).
import { HydrationStore, SplitHydrationController } from "@loom-ui/hydration/client";

// A provider may be checked by what its widgets can render instead of an exact output shape:
const provider: ProviderSpec = { ...spec, outputCheck: "contract" };   // an empty list or a null cell is healthy

const controller = new HydrationController({
  invoker: effectRuntime, store,
  outputKinds: { catalog, surface: "web" },   // a handle's kinds = its bound nodes resolved on this surface
  clock: Date.now,                            // `$now`, `$now-7d`, `$now+1h` resolve against it, once per pass
  defaultParams: DEFAULT_TIME_RANGE,          // { from: "$now-24h", to: "$now" }
  maxConcurrentCalls: 4,                      // controller-wide; an identical step runs once per pass, per principal
  inputDrift: "report-and-proceed",           // a read-only viewer: record the drift, retry once, publish
  argumentHook: (args, { params, now }) => args,                      // the host's last word before each call
  reshapers: defineReshapers({ "rows-to-table": (raw) => toTable(raw) }), // reshaping.engine "Named"
});
controller.setParams({ from: "$now-7d" });                       // a time-range picker
controller.setParams({ region: "north" }, { handle: "fleet" });  // one widget's filter

// Split: providers never leave the server. `revisionOf` is REQUIRED and must be a KEYED hash (an
// HMAC over a server secret) — never the spec's own content fingerprint, which a client could
// confirm a guessed provider against offline.
const revisionOf = (handle, fingerprint) =>
  createHmac("sha256", serverSecret).update(`${handle}\0${fingerprint}`).digest("hex");
// server GET  → { blueprint: compile(exp, opts).blueprint, inventory: handleInventory(exp, { revisionOf }).inventory }
// server POST → serveHandles(exp, requests, { invoker: effectRuntime, now: Date.now(), outputKinds, reshapers, cache, onFinding })
//               (serveHandle answers one request; serveHandles is the batch pass it is built from)
const split = new SplitHydrationController({
  store,
  loader: {
    load: (request, signal) => postJson("/hydrate", request, signal),
    loadMany: (requests, signal) => postJson("/hydrate/batch", requests, signal), // required — no fallback to N loads
  },
});
split.load(inventory);
```

- **Contract check.** `outputCheck: "contract"` validates the reshaped value with `checkKindValue` against EVERY kind the handle feeds on the hydrated surface (a handle bound by a `Kpi` and a `Table` must satisfy both); drift names the failing kind (`DriftRecord.contractKind`). No kinds supplied is an error (`output-contract-unbound`), kinds without a contract pass with a warning, and `undefined` is drift. The input schema pin is checked the same way under both modes.
- **Params.** A step lists the argument names a load may override (`MCPToolNode.overridable`); a param never replaces an argument holding a `{{steps.…}}` template and is never itself one. Precedence: `defaultParams` < `setParams(p)` < `setParams(p, { handle })`, filtered to the provider's declared names — so an unrelated param change reloads nothing. The cache key carries the params AS DECLARED (`$now` tokens unresolved) plus the checked kinds; freshness comes from the cache entry's TTL, never from re-resolving a token.
- **Relative time.** `$now`, `$now±<n><s|m|h|d|w>` become ISO-8601 instants against one clock read per pass, so two steps asking for "the last day" in the same load ask the same question; anything else that starts `$now` is refused (`invalid-time-token`) rather than sent to a tool. Tokens resolve before templates, so tool output is never rewritten.
- **Named reshaping.** `reshaping.engine: "Named"` looks a step's `scriptRef` up in an injected `ReshaperRegistry` (`defineReshapers`) and runs it in-process — no sandbox hop — and an unregistered name is a finding, never a silent fall-through to another engine. The reshaper receives a COPY of the raw terminal output (`structuredClone`); a raw value the clone cannot represent (a function anywhere in it) is refused before the reshaper ever runs, never passed through live.
- **Calls.** `maxConcurrentCalls` caps transient calls in flight across the WHOLE controller (unbounded by default) or, server-side, the whole batch (default `DEFAULT_MAX_CONCURRENT_CALLS`, 32 — a client sizes the batch, so the server bounds its fan-out; an explicit option overrides; it bounds ONE batch, so for a server-wide bound wrap the invoker once in the exported `limitInvoker` and share it across batches); beneath it, one step memo per pass — keyed by principal too — runs an identical step once no matter how many handles share it, ref-counted so one caller's abort never cancels a call another caller of the same step is still waiting on.
- **Split.** The inventory lists, per bound handle, its priority (the Blueprint carries none), the NAMES of its overridable params and an opaque, KEYED revision (`revisionOf`) — never a tool, an argument or a script. `serveHandle`/`serveHandles` treat every request as untrusted (version, handle and params are all re-checked on the server; an unbound handle is `unknown-handle`; a batch over `maxBatch`, default 256, is refused whole as `batch-too-large` — still answered with one result per request, so a transport should bound request bodies) and return the same `HandleLoadResult` the in-process controller publishes. A client only ever receives a finding's PUBLIC form — a fixed code and a message keyed off it, naming only the handle; the full finding (tool, step, script, hash, exception text) reaches only the server's own `onFinding` hook. `HandleLoader` must implement BOTH `load` and `loadMany` — loads the scheduler starts together (the P0s of one bind, a P1 batch) go out as ONE `loadMany` round trip, so handles sharing an upstream step share the call server-side too. As with `invalidate`, a lazy (P2) handle whose question changes waits for the surface's next `markVisible`. After a recompose the app serves the NEW experience and hands the client its new inventory; a request still carrying the previous `versionHash` (in flight across the recompose) is answered `version-mismatch` and published as an `error` status — the app reloads (`controller.load(newInventory)`), which asks that handle again under the new version.

**Which entry.** `@loom-ui/hydration` (the root entry) is the SERVER side: it executes providers, so it imports loom's sandbox (QuickJS WASM, worker threads) and MCP plugin (`node:http`, `node:crypto`), and a browser bundle that imports it grows by megabytes and pulls node modules. A browser imports `@loom-ui/hydration/client`, which carries only what split hydration needs on the client: `SplitHydrationController` (`load`/`recompose`, `markVisible`, `setParams`, `invalidate`, `dispose`), `HydrationStore`, `hydrationProjection` and its `HYDRATION_PROJECTION_ID` / `HYDRATION_PROJECTION_VERSION` / `HYDRATION_SET_EVENT`, `isReservedHandle`, `checkParams`, `DEFAULT_TIME_RANGE`, and the types `HandleLoader`, `HandleLoadRequest`, `HandleLoadResult`, `HandleInventory`, `HandleRef`, `SplitControllerOptions`, `LoadParams`, `HandleSlice`, `HandleState`, `HandleStatus`, `HydrationScope`, `HydrationState`. The root entry still exports all of these too, so server code needs one import. The in-process `HydrationController` runs providers, so it is server-side (or a Node-only app). `clientEntry.test.ts` walks the built `dist/client.js` module graph and fails if it reaches the sandbox, the MCP plugin, the effect runtime, any node builtin or hydration's server modules, and bundles it for the browser against a size budget (about 33 KB minified today).

## Rendering (illustrative — not a compiling snippet)

```ts
// Web, React: loom's renderer, unchanged.
<BlueprintRenderer blueprint={blueprint} projectionRuntime={runtime} executionId={store.executionId} registry={defaultRegistry} />

// Web, Lit: the same blueprint through the DOM adapter with the Lit registry.
import { litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
const handle = renderBlueprintDom(document.getElementById("app"), blueprint, { projectionRuntime: runtime, executionId: store.executionId, registry: litRegistry });

// Terminal: loom's registry plus the framework kinds; status comes from the Blueprint.
import { renderExperience, watch } from "@loom-ui/renderer-terminal";
const stop = watch(blueprint, store, (frame) => process.stdout.write(`\x1Bc${frame}`));
```

Compile targets loom's Blueprint IR 2.2.0: every grid child is a `GridCell` with the node's span (and placement, below), every bound widget declares `binding.status.path = status.<handle>` beside `values.<handle>` in the hydration projection, and carries `source` (its semantic type and any degradation). loom's React, Lit and terminal renderers all read status and spans from the Blueprint; nothing reads the hydration projection behind it. A `span` takes effect only when the node's parent container is a grid: a grid compiles its children into `GridCell`s that carry the span, while a `row`/`column` parent compiles to a flex layout that has no columns for a span to occupy, so the span does not apply there and is dropped without a finding (loom ADR 0097 D5). `genesis`' default root — the one the reference planner composes into — is therefore a 12-column `grid`, so the span the compose prompt asks the model for ("a 12-column row") lands as a cell. The Lit widgets keep loom-ui's per-kind value contracts, and the terminal plugs the same check into loom's `check` seam. On the web the framework kinds are drawn by loom-ui's Lit widgets only (`LIT_ONLY_KINDS` in `@loom-ui/renderer-lit`): loom's React renderer has no renderer registered for any of them and shows its `[No renderer for …]` placeholder.

**Placement and section titles.** A node may also carry `row`, `rowSpan` and `column` — 1-based grid lines, the coordinates of CSS grid and of loom's `GridCell` (loom ADR 0098): it occupies columns `column..column+span-1` and rows `row..row+rowSpan-1`; each is optional, and a node with none flows as before. They compile into the node's cell only under a `grid` parent; a placement anywhere else is `placement-outside-grid` and one that leaves the 12 columns is `placement-out-of-range` (loom's own predicate). `validateExperience` reports such state in pre-existing data (the cell then compiles unplaced); every op refuses creating it — `setPlacement`, `insertNode` and `moveNode` raise both codes. A log recorded before these refusals that inserted a placed node off a grid or overflowing it no longer replays. A container may carry a `title` (`LocalizedText`), resolved through `resolveLabel` like a label and emitted as its compiled layout's `title` when non-empty. `placementOf`, `isPlaced`, `placementProblems` and `GRID_COLUMNS` are exported for composers; `placementProblems(node, columns = GRID_COLUMNS)` is width-parametric, like loom's predicate, so a composer can check a node against a grid of any width. Absent fields add nothing to the hashed artifact, so an experience that uses neither keeps its content address. The web renderers (React, Lit) and the terminal agree on reading order only when a grid's cells are all placed or all unplaced; a partially placed grid falls to CSS grid auto-placement on the web and to row-then-column order in the terminal (loom ADR 0098 D4/D6).

**Container roles.** A container may also carry a `role` (Blueprint IR 2.2.0, loom ADR 0099): the open, app-defined name a container renderer is registered under — for containers what a widget's `kind` is for widgets (`"stepped"`, `"tabbed"`, `"collapsible"`, anything the app names; loom-ui ships no role vocabulary). It is never an ARIA role and never display text, so it is not localised: `compile` copies it onto the compiled layout as-is. A role must be well-formed by loom's `isLayoutRole` — a lowercase letter, then lowercase letters, digits or hyphens, at most 64 characters (`LayoutRole` in `@loom-ui/core`). The node schema refuses anything else, so `insertNode` and `setRole` do; a malformed role in pre-existing data is `validateExperience`'s `role-invalid` — a WARN against the container, loom's code and severity, since nothing is lost but the custom rendering — and `compile` leaves it off (every renderer draws the plain container). A well-formed role no renderer knows is not a finding: which roles are registered is a fact about the renderer in use. `direction` stays the geometry; `role` is the presentation a renderer that knows it may give that geometry. An absent role adds nothing to the hashed artifact.

**Framework kinds.** Beside loom's eight built-ins, `@loom-ui/core` declares eight kinds of its own (`FRAMEWORK_KINDS`), each with a zod value contract in `kindValueContracts`: `TimeSeries` (`TimeSeriesValue`; series may carry `format` and `axis` — `ChartAxis`, `"left" | "right"` — and `lu-timeseries` draws a second y-axis, marking a right-hand series "(R)" only when some series is on the left; all-right shares one axis), `BarChart` (`BarChartValue`, value-level `format`), `Kpi` (`KpiValue`: `{ value, unit?, format?, label?, deltaPct? }` — `label` is a caption shown beside the widget title, never in its place, and is spoken and printed with it; `deltaPct` is a fraction drawn ▲/▼ to one decimal via `DELTA_FORMAT`), `Table` (`TableValue`: `{ columns: TableColumn[], rows: TableCell[][] }`, a `TableColumn` being a string or `{ label, format? }` read through `tableColumnLabel` / `tableColumnFormat`, a `TableCell` a string, number or `null`; text sorts in the formatting locale), `StatusCard` (`StatusCardValue`: `{ level: StatusLevel, headline, detail? }` with `StatusLevel` = `"ok" | "warning" | "critical"`, announced through `role="status" aria-live="polite"`), `Note` (static text from its `text` prop, never bound), and `A2UIView` / `SandboxView` (mount `lu-a2ui-view` / `lu-sandbox` with the declared `view` / `code` prop and the bound value as data). They exist because these shapes conflict with loom's `MetricCard` (a number), `DataTable` (records) and `StatusBadge` (a string), whose contracts loom's React renderers depend on and which are never widened. An app declares a framework kind on a semantic entry's `surfaces.web` by copying its contract from `frameworkKindContracts`. A catalogue entry's `textProps` names the props that carry display text; a `LocalizedText` there is resolved at compile through `resolveLabel`, exactly like a node label, so a Blueprint never carries a message key — any other shape in a text prop is a `text-prop-shape` finding.

**Number semantics.** `SemanticFormat` describes what the renderers honour, and nothing more: `semanticType` is one of `number`, `integer`, `decimal`, `percentage`, `currency` (with its ISO 4217 `currency` code, required — a code-less currency is refused, never assumed), plus optional `notation` (`standard` / `compact`) and `minimumFractionDigits` / `maximumFractionDigits` (0–20, min ≤ max; an `integer` takes none — fraction digits on it are refused, not coerced). A consumer with richer semantics (dates, durations, measurements) maps them onto these at its own boundary; extra keys in a payload are tolerated and ignored. Numbers read their semantics in the order value `format`, then widget `props.format`, then the `unit` (`effectiveFormat`: `$`, `€`, `%` or any ISO 4217 code, via `formatFromUnit`). A `percentage` value — and a value whose unit is `%`, when no explicit `format` overrides it — is a FRACTION: `0.25` renders `25%` (an explicit format wins by the precedence above: with `format: { semanticType: "decimal" }` and `unit: "%"`, `25` renders `25 %`). The unit is shown beside the figure unless the format draws its own symbol (`unitSuffix`: a `currency` or `percentage` format drops it, so `USD` / `%` never double; `{ value: 7, unit: "ms", format: { semanticType: "decimal" } }` still reads `7 ms`). A delta's direction is `deltaDirection` — `"up"`, `"down"`, or `"flat"` when it reads as 0% at `DELTA_FORMAT`'s precision (no arrow; spoken "unchanged"), or `"none"` for a non-finite delta, drawn "—" with no arrow and not spoken as a change. `semanticNumberFormatOptions` is the one `SemanticFormat` → `Intl.NumberFormat` options mapping and `formatSemanticNumber` formats at a fixed locale, so the web, the spoken form and the terminal round, group and suffix identically.

**Recomposing.** When the agent revises the experience, do not tear the DOM down. `controller.load(nextExperience)` recomposes hydration (it aborts and drops the handles the new artifact no longer binds and keeps the shared ones), then `handle.update(compile(nextExperience, opts).blueprint)` lands the new Blueprint on the live tree by widget id: a widget that kept its id and kind keeps its element, its subscription and whatever the user has in it — typed text, caret, focus, a scrolled list — while siblings are added, dropped, patched and reordered around it (the child holding `document.activeElement` is never moved). A kind change remounts only that widget, and so does a move the keyed walk cannot follow — to another container, or when its container's ordinal among container siblings shifts or its container changes type or role (containers are keyed by ordinal, type and role); every such widget is listed in `RecomposeReport.remounted`; a changed binding is re-subscribed and gets its first slice at once. `update` never throws: a renderer failure shows loom's error placeholder for that widget and lands in the returned `RecomposeReport.findings`, beside loom's identity report (`identity.added`, `identity.findings` for dropped ids).

**Placement and titles on the web.** `renderBlueprintDom` draws Blueprint IR 2.1.0 the way loom's React renderer does (loom ADR 0098 D4), without its wrapper: a cell's grid lines land on the child's own element — `grid-column: <column> / span <span>` (or `span <span>`), `grid-row: <row> / span <rowSpan ?? 1>` (or `span <rowSpan>`) — and an unplaced span-1 cell writes nothing. A layout with a non-empty `title` renders as `<section aria-label="…"><h2>…</h2><div data-layout …></div></section>`; the section is the grid item, the heading never is. On `handle.update`, a placement change is a style patch on the kept element; a title text change patches the heading; adding or removing a title wraps or unwraps the same layout element — its widgets stay mounted, and a focused control inside it — including one inside a widget's shadow root — keeps focus and selection (moved with `moveBefore` where the platform has it).

**Container renderers on the web.** `DomRenderOptions.containers` is the container counterpart of `registry`: a loom `RendererRegistry<DomContainerRenderer>` keyed by ROLE (build one with `.register` / `.merge`; there is no default). A layout whose well-formed `role` is registered there renders as `<div data-container-role="R">` holding the renderer's chrome and the adapter's own layout element; a titled one keeps the adapter's heading, with the role host inside the section (`<section aria-label><h2>` + role host), so the heading names chrome and body alike. No `containers`, a role it lacks, or a malformed role draws the plain container — DOM-identical to no role. The renderer is `(host, { layout, body, children }) => { update(props), dispose() }`: `body` is the adapter's layout element and `children` its children in document order, each `{ element, node }` (`node` for labels, such as a step's title). `update` is required. **Who owns what:** the adapter keeps everything it owns for a plain container — `body`, the children's mount, keyed reconcile, reorder, grid placement and subscriptions, the focus pin, the section wrap. The app owns only its chrome (what it mounts in `host` outside `body`) and which children are visible, by setting `hidden`, `inert`, `aria-*`, `role`, `id` or `class` on the child elements it is handed; it never adds, removes, reorders or restyles `body`'s children. **Updates:** `handle.update` reconciles the children first, then calls the container's `update` only when the layout's own fields (type, columns, direction, gap, title, role), its child element list or order, or a child's own fields (a widget node, a child layout's title) changed — an identical Blueprint is still zero DOM mutations and zero calls. A role change remounts the container like a type change, its widgets listed in `RecomposeReport.remounted` (for the root too); chrome state (the current step, the open tab) lives in the handle and survives exactly as long as the container does. Hidden children stay mounted and subscribed, so a hidden step's widget keeps receiving its data. **Failure:** a container renderer that throws on mount or `update`, or returns no handle with `update` and `dispose`, is disposed and the container falls back to plain in place — children kept, still subscribed, `hidden` / `inert` / `aria-hidden` removed from them — with a `mount-failed` / `patch-failed` finding (`nodeId: ""`, the message names the role and the layout's path, e.g. `layout.children[1]`); the same role is not retried until the container remounts. The adapter restores only visibility (`hidden`, `inert`, `aria-hidden`); a renderer's `dispose` MUST undo every other attribute it set on the children it was handed (`role="tabpanel"`, `aria-labelledby`, `id`, `class`, …), since after a fallback those children stay mounted in the plain container and would otherwise point at disposed chrome. As with a widget, a failure during the initial `renderBlueprintDom` falls back silently (there is no report to carry it). **Accessibility:** a child the app does not show carries `hidden` (out of the accessibility tree and tab order); one kept in layout, e.g. to animate, carries `inert` and `aria-hidden="true"`. Chrome controls are real `<button>`s with accessible names; a step count or position is `aria-live="polite"`. Tab-like roles put `role="tab"` / `"tablist"` on chrome and may set `role="tabpanel"` and `aria-labelledby` on a child element. When the app hides the child holding focus, it moves focus (to the shown child or its chrome) — the adapter never blurs. A child's element can change under the app — a child container gaining or losing a title swaps its section in or out — and the new list arrives through `update`; set visibility on exactly the elements handed. The terminal has no counterpart: a role is an interaction hint and a one-shot text surface has none, so every child prints under the title in reading order, byte-identical with or without a role (loom ADR 0099 D5); loom's React renderer draws the plain container too.

**The Blueprint's own title.** Beside per-container titles above, `DomRenderOptions.title` controls whether the Blueprint's OWN title renders as the root `<h1>`: `"heading"` (default) is today's behaviour, unchanged; `"none"` mounts no `<h1>` at all, for a host page that already carries its own heading or whose compiled title is not display text. Under `"none"`, `handle.update` never creates, removes or patches a title element — a `blueprint.title` change alone is not a DOM mutation. The mode is fixed for the handle's whole lifetime (read once at `renderBlueprintDom`, not re-read from `update`'s `next`); switching it mid-handle is not supported — dispose and re-mount with the new option instead. The root element carries no landmark or accessible name in either mode; under `"none"` the host owns the page heading, so give the mount point's region its accessible name from that heading (e.g. `aria-labelledby`) where the page needs one.

`@loom-ui/renderer-lit` is browser code: `node -e "import('@loom-ui/renderer-lit/dom')"` fails outside
a bundler, on two counts. No other package here declares it as a dependency, so pnpm never links it
into another package's `node_modules` for bare-specifier resolution to find. And even resolved
directly (`node dist/dom/index.js`), its `moduleResolution: "Bundler"` build emits extensionless
relative specifiers (`./litRegistry`, not `./litRegistry.js`) that only a bundler's resolver
completes — plain Node ESM resolution requires the extension. Its consumer is a bundler (Vite,
webpack, …); that is the supported path, not a plain Node `import()`.

## Consumers

- [genUI](https://github.com/chhetrisushil/genUI) — generative dashboards and authoring; migrating onto loom-ui (loom `docs/requirements/2026-09-23-genui-migration-design.md`).

Theming: every `lu-*` element reads `--lu-*` CSS custom properties (`--lu-text`, `--lu-text-dim`, `--lu-border`, `--lu-panel`, `--lu-panel-2`, `--lu-grid`, `--lu-accent`, `--lu-radius`, `--lu-delta-up`, `--lu-delta-up-bg`, `--lu-delta-down`, `--lu-delta-down-bg`, `--lu-delta-flat`, `--lu-delta-flat-bg`, `--lu-status-ok`, `--lu-status-warning`, `--lu-status-critical`); set them on any ancestor.

## Planning (illustrative — not a compiling snippet)

```ts
import { ReferencePlanner, interpretAction } from "@loom-ui/planner";
import { AnthropicProvider } from "@loom/llm";

// Any `@loom/llm` provider (e.g. `AnthropicProvider`) is a PlannerModel.
const planner = new ReferencePlanner({ model: new AnthropicProvider({ ... }), modelId: "claude-…" });

// Inside a loom flow: the model call is a decision — replay serves the recorded ops.
const { ops, findings, report } = await planner.compose({ intent, catalog, capabilities }, ctx);
const experience = replay(genesis({ experienceId, intent, meta }), ops);            // the fold mints the artifact
await putExperience(content, seal(experience.value));                              // the APP persists and emits EXPERIENCE_COMPOSED

// A revision is ONE prompt op; its materialized primitives replay to the same artifact.
const revision = await planner.revise({ experience: current, request: { text }, catalog, capabilities }, ctx);
```

Capabilities are an INPUT: the app resolves tools, pins `toolSchemaHash`, and supplies a raw `sampleOutput` for each one the planner may bind (no sample ⇒ not bindable). Everything the framework and the operator did not author reaches the model only inside a fenced, untrusted DATA block in the user message — samples, caller context, the current experience's node list, and a capability's tool-server-authored `description`/`inputSchema` (the CAPABILITIES summary line carries only handle, tool@version, schema pin and whether it is bindable).

`ReferencePlanner` fences its own prompts: it does NOT go through `@loom/llm`'s `buildRequest`/`guardRequest`. The caller hands it a provider whose `complete` it calls directly, so the untrusted-content discipline above is the planner's own, applied at prompt assembly.

`sampleOutput` is deliberately NOT part of a plan's decision id. A sample pins shapes, it is not prose the model reasons from — and a new sample is a new REVISION (that is what `reviseForDrift` asks for), never a silent re-plan of a decision a replay is already serving.

A revision describes, and materialises, only the root's DIRECT children. A nested container is shown as a locked placeholder (`{ id, kind: "container", locked: true, descendants }`) and its subtree is not described at all; a draft naming a node inside one is refused as `nested-node`.

Operations beyond insert/remove/move/props/label/bind/remap: `setPlacement { nodeId, span?, row?, rowSpan?, column? }` changes a node's width and grid placement — an absent field is unchanged, `null` clears it (the key is removed, so a cleared node hashes as if it was never placed), and the placed node is validated through the same node schema as `insertNode`. `removeProvider { handle }` retires a provider and is refused (`provider-still-bound`) while any node, at any depth, still binds the handle. `setTitle { nodeId, title }` sets a container's heading (`null` clears it; a semantic node is `not-container` — its heading is its label). `setRole { nodeId, role }` sets a container's role (`null` clears it and removes the key, so the container hashes as if it never had one; the root may carry one; a semantic node is `not-container`; a malformed role is `invalid-operation` against the node). `interpretAction` admits `setPlacement` and `setTitle` on non-root nodes (resizing a widget and renaming a section are direct manipulation, like `moveNode` and `setLabel`), refuses both provider ops (`provider-op-not-interactive`), and refuses `setRole` (`role-op-not-interactive`: a role picks which of the app's container renderers draws a section — presentation structure, like a container's direction, which no op changes — and changing it remounts the container and discards its chrome state). A widget's `insertNode` may still insert a container that already carries a role — harmless, since a new container has no chrome state to lose. `moveNode` refuses to carry a placed node out of a grid (`placement-outside-grid`) or into one it overflows (`placement-out-of-range`): clear it first with `setPlacement { nodeId, row: null, column: null, rowSpan: null }`. A widget resize on a placed node is likewise refused when the new span overflows the grid — the interactive path never clamps; choose a column and span that fit. The reference planner applies a revised `span` through `setPlacement` — on a widening revision that would overflow a placed node it clamps `column` to `GRID_COLUMNS − span + 1` — and ends every plan with a `removeProvider` for each handle its own removals or rebinds orphaned (`orphanedProviders`); a provider the base already held with no binder is left alone.

**Op refusal codes.** The complete list of codes `apply` (and so `replay`) can refuse with, by op. Every op: `invalid-operation` (the op fails the `Operation` schema) and `tree-too-deep` (the base, or the tree an `insertNode` would produce, nests past `MAX_TREE_DEPTH`). `insertNode`: `duplicate-node-id`, `missing-parent`, `not-a-container` (the parent), and `placement-outside-grid` / `placement-out-of-range` for any placed node in the inserted subtree. `removeNode`: `root-immutable`, `missing-node`. `moveNode`: `root-immutable`, `missing-node`, `not-a-container` (the destination is absent or not a container), `cyclic-move`, `placement-outside-grid` / `placement-out-of-range`. `setPlacement`: `root-immutable`, `missing-node`, `empty-placement` (names no field), `placement-outside-grid`, `invalid-operation` (the placed node fails the node schema), `placement-out-of-range`. `setTitle`: `missing-node`, `not-container`. `setRole`: `missing-node`, `not-container`, `invalid-operation` (the roled container fails the node schema — a role that is not `isLayoutRole`). `setProps` / `setLabel` / `bindProvider`: `missing-node`, `not-semantic`. `remapProvider`: `handle-mismatch` (`spec.handle` ≠ `handle`). `removeProvider`: `missing-provider`, `provider-still-bound`. `prompt`: whatever its `materialized` ops return. Note `not-container` (`setTitle` / `setRole` on a semantic node) is a different code from `not-a-container` (an `insertNode` / `moveNode` parent that is not a container). `bindProvider` does not check that the handle is declared; `validateExperience` reports a binder with no provider as `unknown-handle`.

`PlannerModel.complete` may return `usage: { inputTokens, outputTokens }` (the shape `@loom/llm` providers already report). The reference planner records it per attempt and sums it on `PlanReport.usage` — inside the plan's `ctx.decide`, so a replay serves the same token totals with no model call. Absent means unreported, not free; a value that is not two non-negative integers is dropped with a `usage-invalid` warn. `checkPlannerConformance` fails a planner whose replayed report changes its usage (`usage-not-replayed`).

Output drift (`DriftRecord{kind:"output"}`) carries `observedShape` (the RESHAPED value that failed the pin), `observedRawShape` (the raw terminal output's shape, which is what a `reshaping.scriptRef` is authored against) and, when the hydration caller sets `captureSample`, a tainted `observedSample` of the RAW terminal output — raw because a capability's `sampleOutput` is raw by contract. `reviseForDrift` turns a drift report into a repair revision: the handles and node ids go in the request text, the shapes go in `context` (fenced), and the raw sample becomes the drifted capability's `sampleOutput`. A contract drift (`outputCheck: "contract"`) carries `contractKind`, and the repair request names that kind instead of a shape pin.
