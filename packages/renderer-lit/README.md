# @loom-ui/renderer-lit

A loom DOM renderer adapter (`renderBlueprintDom`, subpath `./dom`) plus Lit custom elements
registered under loom's widget kinds and this framework's own kinds (`litRegistry`). It is a web
rendering surface for the `Blueprint` `@loom-ui/core` compiles, reading the projection state
`@loom-ui/hydration` publishes — an alternative to loom's React renderer for apps built on Lit or
plain custom elements, and the only web surface for the framework kinds loom's React renderer has
no widget for. `@loom-ui/renderer-lit` is ESM (Lit is ESM-only); its consumer is a bundler (Vite,
webpack, …), not a plain Node `import()`.

## Install / import

```
pnpm add @loom-ui/renderer-lit
```

```ts
// The DOM adapter and Lit registry — the subpath a bundler resolves.
import { renderBlueprintDom, litRegistry } from "@loom-ui/renderer-lit/dom";

// Registering the custom elements (side-effect import) and reading their exported classes/types
// is the root entry.
import { LuKpi, LuTimeRangePicker, measure } from "@loom-ui/renderer-lit";
```

## Key concepts

- **Two layers.** The root entry defines and registers every `lu-*` custom element (a `LitElement`
  subclass per kind) plus formatting/i18n/a11y helpers. The `./dom` subpath is the adapter that
  mounts a loom `Blueprint` into the DOM using a `RendererRegistry` of element-mounting functions
  — `litRegistry` is that registry, pre-wired to the `lu-*` elements.
- **`renderBlueprintDom` mirrors loom's React renderer.** Same grid placement (loom ADR 0098), same
  section-title wrapping, same status matrix (loading/empty/stale/error rows) — so a Blueprint
  renders identically whichever renderer draws it, modulo the widget implementation itself.
- **Widget contract (`DomWidgetRenderer`).** A widget renderer mounts into a host element and
  returns a `DomWidgetHandle { update(value, status?), patch?(widget), dispose() }`; `elementRenderer(tag)`
  builds one that mounts `<tag>` and drives its `widget`/`value`/`status`/`onAction` properties —
  what every `litRegistry` entry uses.
- **Container renderers (`DomContainerRenderer`, Blueprint IR 2.2.0 role).** A container renderer
  owns only its chrome and its children's *visibility*; the adapter still owns mounting, keyed
  reconciliation, reordering, grid placement, subscriptions and the focus pin. Register one per
  role in a `DomContainerRegistry` and pass it as `DomRenderOptions.containers` — there is no
  default registry.
- **Keyed recompose.** `handle.update(nextBlueprint)` patches the live tree in place by widget id
  and, since Blueprint IR 2.4.0, by container layout id — a widget or container that keeps its id
  and kind keeps its element, subscription and any user-entered DOM state (typed text, caret,
  scroll, focus).
- **Framework kinds are Lit-only.** `LIT_ONLY_KINDS` (= `FRAMEWORK_KINDS` from `@loom-ui/core`) are
  drawn only by this package's widgets; loom's React renderer shows its `[No renderer for …]`
  placeholder for them.

## API

### The DOM adapter (`@loom-ui/renderer-lit/dom`)

- `renderBlueprintDom(host, blueprint, opts: DomRenderOptions): DomRenderHandle` — mounts a
  Blueprint into `host`; `opts` needs `projectionRuntime`, `executionId`, `registry`, and takes
  `containers?`, `onAction?`, `title?: "heading" | "none"`.
- `DomRenderHandle` — `{ element, update(next): RecomposeReport, dispose() }`.
- `litRegistry: DomRegistry` — loom's built-in kinds plus every framework kind, mapped to `lu-*`
  elements via `elementRenderer`.
- `elementRenderer(tag): DomWidgetRenderer` — build a widget renderer that mounts a custom element
  and drives its properties; used to register a custom kind of your own.
- `LIT_ONLY_KINDS`, `frameworkKindContracts` — the framework kinds this registry alone draws, and
  the loom `CatalogEntry` contracts (`kind`, `props`, `binding`) to copy onto a semantic entry's
  `surfaces.web` when declaring one.
- `placeholderFor(kind)`, `projectionPlaceholder(id)` — the DOM nodes shown for an unregistered
  kind or an unregistered projection.
- Types: `DomRenderOptions`, `DomWidgetProps`, `DomWidgetHandle`, `DomWidgetRenderer`,
  `DomRegistry`; `DomContainerProps`, `DomContainerChild`, `DomContainerHandle`,
  `DomContainerRenderer`, `DomContainerRegistry`; `RecomposeReport`, `RecomposeFinding`.

### Custom elements (root entry, registered on import)

- Bound widgets: `LuMetricCard` (`lu-metric-card`), `LuStatusBadge` (`lu-status-badge`),
  `LuDataTable` (`lu-data-table`), `LuTimeseries` (`lu-timeseries`), `LuBarChart`
  (`lu-bar-chart`), `LuKpi` (`lu-kpi`), `LuTable` (`lu-table`), `LuStatusCard`
  (`lu-status-card`), `LuNote` (`lu-note`), `LuAlert`/`LuApproval`/`LuList`/`LuProgress`/`LuText`
  (`lu-alert`/`lu-approval`/`lu-list`/`lu-progress`/`lu-text`).
- Embedded/sandboxed surfaces: `LuA2UIView` (`lu-a2ui-view`), `LuSandbox` (`lu-sandbox`),
  `LuA2UIWidget`/`LuSandboxWidget` (`lu-a2ui-widget`/`lu-sandbox-widget` — the widget-bound wrappers
  `litRegistry` mounts for the `A2UIView`/`SandboxView` kinds).
- App-level (unbound) elements: `LuTimeRangePicker` (`lu-time-range-picker`, types `TimeRange`,
  `TimeRangePreset`), `LuLocalePicker` (`lu-locale-picker`).

### Number and value formatting

- `measure(value, format?): string`, `tick(value, format?): string` — the reader (accessible name)
  and the compact axis-tick form of a semantic number, both delegating to `@loom-ui/core`'s
  `formatSemanticNumber`/`effectiveFormat` so the DOM and terminal renderers never disagree.
- `timeTick(iso, spanMs): string` — a compact time-axis tick label sized to the series' span.
- `describeValue(kind, value, props)` — a spoken summary of a rendered value for a screen reader,
  reading the same `format`/`unit` precedence the widget itself renders with.

### Localization

- `currentLocale()`, `setLocale(next)`, `onLocaleChange(listener)`, `isRtl(locale?)`,
  `localeLabel(locale)` — the locale a widget formats with, a change signal so an element
  re-renders on change, and the RTL question; loading message catalogs stays with the host app.

### A2UI and sandbox support

- `planView(view: A2UIView, data): A2UIRender`, `resolvePointer(doc, pointer)` — resolve an A2UI
  declarative view tree plus bound data into a render plan.
- `buildSandboxSrcdoc()`, `hostMessage(message)`, `parseFrameMessage(raw)`, `SANDBOX_ALLOW` — the
  sandboxed-iframe protocol `lu-sandbox`/`lu-sandbox-widget` speak to the untrusted frame.

## Examples

Mounting a compiled Blueprint (illustrative — not a compiling snippet):

```ts
import { litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";

const handle = renderBlueprintDom(document.getElementById("app")!, blueprint, {
  projectionRuntime: runtime,
  executionId: store.executionId,
  registry: litRegistry,
});

// Later, after a revision: recomposes in place, keyed by widget/container id.
handle.update(nextBlueprint);
```

Declaring a framework kind on a semantic entry (illustrative):

```ts
import { frameworkKindContracts } from "@loom-ui/renderer-lit/dom";

const kpiContract = frameworkKindContracts.find((c) => c.kind === "Kpi")!;
// copy `kpiContract` onto a SemanticEntry's `surfaces.web` to resolve that entry to a Kpi widget
```

## Notable behaviours and guarantees

- **User-entered state is DOM state.** A renderer overwrites a bound input's value only when the
  value actually changed — never on an unrelated `patch` or re-render — so typed text, caret
  position and scroll survive a recompose the change did not cause.
- **A focused subtree never moves.** During `handle.update`, the element holding
  `document.activeElement` is never remounted or relocated, even when its container reorders
  around it.
- **A container renderer's failure never loses children.** A container renderer that throws on
  mount or `update` is disposed and the container falls back to the plain container in place;
  children stay mounted and subscribed, with a `mount-failed`/`patch-failed` finding reported.
- **`update` is never re-entrant.** Calling `handle.update` from inside a widget or container
  renderer's own `patch`/`update` during a pass is refused (a `re-entrant update` finding) and
  changes nothing.
- **`@loom-ui/renderer-lit/dom` is bundler-only.** It has `moduleResolution: "Bundler"` output
  (extensionless relative specifiers); running it under plain Node ESM resolution fails — the
  supported path is a bundler like Vite or webpack.
- **Value contracts are enforced, not assumed.** Every framework-kind widget checks its bound
  value with `@loom-ui/core`'s `checkKindValue` before drawing it and shows a visible error state
  on a mismatch, rather than rendering `undefined` fields silently.

## See also

- [../core/README.md](../core/README.md) — `Blueprint` compilation, framework kinds and number
  semantics this package renders.
- [../hydration/README.md](../hydration/README.md) — the projection state this package's widgets
  subscribe to.
- [../renderer-terminal/README.md](../renderer-terminal/README.md) — the non-DOM counterpart
  surface for the same framework kinds.
- [../../README.md](../../README.md) — root overview, including the full container-renderer
  ownership rules and recompose semantics.
