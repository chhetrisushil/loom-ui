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
| `@loom-ui/hydration` | Resolves an Experience's provider handles through loom's transient effects (MCP graph → sandbox/JSONPath reshape → shape check), publishes them as one loom projection (`loom-ui.hydration`), schedules by priority, caches per principal, reports drift for the app's durable repair |
| `@loom-ui/renderer-lit` | A loom DOM renderer adapter (`renderBlueprintDom`, subpath `./dom`) and Lit elements registered under loom kinds (`litRegistry`) — every built-in kind plus the framework kinds (`FRAMEWORK_KINDS`: `TimeSeries`, `BarChart`, `Kpi`, `Table`, `StatusCard`, `Note`, `A2UIView`, `SandboxView`); four app-level elements (time-range picker, locale picker, sandbox, A2UI view) |
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

Compile targets loom's Blueprint IR 2.1.0: every grid child is a `GridCell` with the node's span (and placement, below), every bound widget declares `binding.status.path = status.<handle>` beside `values.<handle>` in the hydration projection, and carries `source` (its semantic type and any degradation). loom's React, Lit and terminal renderers all read status and spans from the Blueprint; nothing reads the hydration projection behind it. A `span` takes effect only when the node's parent container is a grid: a grid compiles its children into `GridCell`s that carry the span, while a `row`/`column` parent compiles to a flex layout that has no columns for a span to occupy, so the span does not apply there and is dropped without a finding (loom ADR 0097 D5). `genesis`' default root — the one the reference planner composes into — is therefore a 12-column `grid`, so the span the compose prompt asks the model for ("a 12-column row") lands as a cell. The Lit widgets keep loom-ui's per-kind value contracts, and the terminal plugs the same check into loom's `check` seam. On the web the framework kinds are drawn by loom-ui's Lit widgets only (`LIT_ONLY_KINDS` in `@loom-ui/renderer-lit`): loom's React renderer has no renderer registered for any of them and shows its `[No renderer for …]` placeholder.

**Placement and section titles.** A node may also carry `row`, `rowSpan` and `column` — 1-based grid lines, the coordinates of CSS grid and of loom's `GridCell` (loom ADR 0098): it occupies columns `column..column+span-1` and rows `row..row+rowSpan-1`; each is optional, and a node with none flows as before. They compile into the node's cell only under a `grid` parent; `validateExperience` reports a placement anywhere else (`placement-outside-grid`) and one that leaves the 12 columns (`placement-out-of-range`, loom's own predicate — the cell then compiles unplaced). A container may carry a `title` (`LocalizedText`), resolved through `resolveLabel` like a label and emitted as its compiled layout's `title` when non-empty. `placementOf`, `isPlaced`, `placementProblems` and `GRID_COLUMNS` are exported for composers. Absent fields add nothing to the hashed artifact, so an experience that uses neither keeps its content address. React and Lit agree on reading order only for a grid whose cells are all placed or all unplaced (loom ADR 0098 D4); a partially placed grid falls to CSS grid's auto-placement on the web and to row-then-column order in the terminal.

**Framework kinds.** Beside loom's eight built-ins, `@loom-ui/core` declares eight kinds of its own (`FRAMEWORK_KINDS`), each with a zod value contract in `kindValueContracts`: `TimeSeries` (`TimeSeriesValue`; series may carry `format` and `axis` — `ChartAxis`, `"left" | "right"` — and `lu-timeseries` draws a second y-axis, marking a right-hand series "(R)" only when some series is on the left; all-right shares one axis), `BarChart` (`BarChartValue`, value-level `format`), `Kpi` (`KpiValue`: `{ value, unit?, format?, label?, deltaPct? }` — `label` is a caption shown beside the widget title, never in its place, and is spoken and printed with it; `deltaPct` is a fraction drawn ▲/▼ to one decimal via `DELTA_FORMAT`), `Table` (`TableValue`: `{ columns: TableColumn[], rows: TableCell[][] }`, a `TableColumn` being a string or `{ label, format? }` read through `tableColumnLabel` / `tableColumnFormat`, a `TableCell` a string, number or `null`; text sorts in the formatting locale), `StatusCard` (`StatusCardValue`: `{ level: StatusLevel, headline, detail? }` with `StatusLevel` = `"ok" | "warning" | "critical"`, announced through `role="status" aria-live="polite"`), `Note` (static text from its `text` prop, never bound), and `A2UIView` / `SandboxView` (mount `lu-a2ui-view` / `lu-sandbox` with the declared `view` / `code` prop and the bound value as data). They exist because these shapes conflict with loom's `MetricCard` (a number), `DataTable` (records) and `StatusBadge` (a string), whose contracts loom's React renderers depend on and which are never widened. An app declares a framework kind on a semantic entry's `surfaces.web` by copying its contract from `frameworkKindContracts`. A catalogue entry's `textProps` names the props that carry display text; a `LocalizedText` there is resolved at compile through `resolveLabel`, exactly like a node label, so a Blueprint never carries a message key — any other shape in a text prop is a `text-prop-shape` finding.

**Number semantics.** `SemanticFormat` describes what the renderers honour, and nothing more: `semanticType` is one of `number`, `integer`, `decimal`, `percentage`, `currency` (with its ISO 4217 `currency` code, required — a code-less currency is refused, never assumed), plus optional `notation` (`standard` / `compact`) and `minimumFractionDigits` / `maximumFractionDigits` (0–20, min ≤ max; an `integer` takes none — fraction digits on it are refused, not coerced). A consumer with richer semantics (dates, durations, measurements) maps them onto these at its own boundary; extra keys in a payload are tolerated and ignored. Numbers read their semantics in the order value `format`, then widget `props.format`, then the `unit` (`effectiveFormat`: `$`, `€`, `%` or any ISO 4217 code, via `formatFromUnit`). A `percentage` value — and a value whose unit is `%`, when no explicit `format` overrides it — is a FRACTION: `0.25` renders `25%` (an explicit format wins by the precedence above: with `format: { semanticType: "decimal" }` and `unit: "%"`, `25` renders `25 %`). The unit is shown beside the figure unless the format draws its own symbol (`unitSuffix`: a `currency` or `percentage` format drops it, so `USD` / `%` never double; `{ value: 7, unit: "ms", format: { semanticType: "decimal" } }` still reads `7 ms`). A delta's direction is `deltaDirection` — `"up"`, `"down"`, or `"flat"` when it reads as 0% at `DELTA_FORMAT`'s precision (no arrow; spoken "unchanged"), or `"none"` for a non-finite delta, drawn "—" with no arrow and not spoken as a change. `semanticNumberFormatOptions` is the one `SemanticFormat` → `Intl.NumberFormat` options mapping and `formatSemanticNumber` formats at a fixed locale, so the web, the spoken form and the terminal round, group and suffix identically.

**Recomposing.** When the agent revises the experience, do not tear the DOM down. `controller.load(nextExperience)` recomposes hydration (it aborts and drops the handles the new artifact no longer binds and keeps the shared ones), then `handle.update(compile(nextExperience, opts).blueprint)` lands the new Blueprint on the live tree by widget id: a widget that kept its id and kind keeps its element, its subscription and whatever the user has in it — typed text, caret, focus, a scrolled list — while siblings are added, dropped, patched and reordered around it (the child holding `document.activeElement` is never moved). A kind change remounts only that widget, and so does a move the keyed walk cannot follow — to another container, or when its container's ordinal among container siblings shifts or its container changes type (containers are keyed by ordinal and type); every such widget is listed in `RecomposeReport.remounted`; a changed binding is re-subscribed and gets its first slice at once. `update` never throws: a renderer failure shows loom's error placeholder for that widget and lands in the returned `RecomposeReport.findings`, beside loom's identity report (`identity.added`, `identity.findings` for dropped ids).

**Placement and titles on the web.** `renderBlueprintDom` draws Blueprint IR 2.1.0 the way loom's React renderer does (loom ADR 0098 D4), without its wrapper: a cell's grid lines land on the child's own element — `grid-column: <column> / span <span>` (or `span <span>`), `grid-row: <row> / span <rowSpan>` (or `span <rowSpan>`) — and an unplaced span-1 cell writes nothing. A layout with a non-empty `title` renders as `<section aria-label="…"><h2>…</h2><div data-layout …></div></section>`; the section is the grid item, the heading never is. On `handle.update`, a placement change is a style patch on the kept element; a title text change patches the heading; adding or removing a title wraps or unwraps the same layout element — its widgets stay mounted, and a focused control inside it keeps focus and selection.

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

Output drift (`DriftRecord{kind:"output"}`) carries `observedShape` (the RESHAPED value that failed the pin), `observedRawShape` (the raw terminal output's shape, which is what a `reshaping.scriptRef` is authored against) and, when the hydration caller sets `captureSample`, a tainted `observedSample` of the RAW terminal output — raw because a capability's `sampleOutput` is raw by contract. `reviseForDrift` turns a drift report into a repair revision: the handles and node ids go in the request text, the shapes go in `context` (fenced), and the raw sample becomes the drifted capability's `sampleOutput`.
