# @loom-ui/renderer-lit

A loom DOM renderer adapter (`renderBlueprintDom`, subpath `./dom`) plus Lit custom elements
registered under loom's widget kinds and this framework's own kinds (`litRegistry`). It is a web
rendering surface for the `Blueprint` `@loom-ui/core` compiles, reading the projection state
`@loom-ui/hydration` publishes — an alternative to loom's React renderer for apps built on Lit or
plain custom elements, and the only web surface for the framework kinds loom's React renderer has
no widget for. `@loom-ui/renderer-lit` is ESM (Lit is ESM-only); its consumer is a bundler (Vite,
webpack, …), not a plain Node `import()`.

## Install / import

```jsonc
// package.json of a consumer checked out beside this repo (the packages are not published)
"@loom-ui/renderer-lit": "link:../loom-ui/packages/renderer-lit"
```

```ts
// The root entry carries both the element CLASSES and the DOM adapter — `index.ts` re-exports
// everything `./dom` does, plus the classes, formatting, i18n and a11y helpers. Importing it
// registers NOTHING (see "Registering elements" below).
import { renderBlueprintDom, litRegistry, LuKpi, LuTimeRangePicker, measure } from "@loom-ui/renderer-lit";

// `./dom` is the same adapter (`renderBlueprintDom`, `litRegistry`, …) through a narrower
// subpath — no `LuKpi`/`measure`/i18n/a11y re-exports, just the adapter and its types. It carries
// no widget class at all (a tree-shaking test pins that).
import { renderBlueprintDom as renderBlueprintDomNarrow } from "@loom-ui/renderer-lit/dom";
```

### Registering elements (U20 — a breaking change)

Importing the package used to define every `lu-*` custom element as a side effect, so a host could
not bundle one widget without all of them. Registration is now **explicit**. Importing a widget
class, the root entry or `./dom` defines nothing; a registry that mounts an undefined tag logs one
warning naming the fix and draws an inert element.

**Migrating an existing host: add one line**, anywhere before the first render.

```ts
import "@loom-ui/renderer-lit/register"; // defines every lu-* element (the old behaviour)
// or, to choose the moment:
import { defineAll } from "@loom-ui/renderer-lit/register"; defineAll();
```

**To take only what you draw**, import the per-module entries (each defines its own elements and
nothing else; `package.json` marks only these and `register` as side-effectful, so a bundler drops
the rest):

```ts
import "@loom-ui/renderer-lit/elements/lu-kpi";   // <lu-kpi> only
import "@loom-ui/renderer-lit/elements/lu-simple"; // lu-progress, lu-alert, lu-text, lu-list, lu-approval
```

Entries are named after the widget module: `lu-a2ui-view`, `lu-bar-chart`, `lu-chat`,
`lu-chat-missing`, `lu-data-table`, `lu-embedded` (the A2UI / sandbox widgets, plus the two elements
they nest), `lu-inputs`, `lu-kpi`, `lu-locale-picker`, `lu-media`, `lu-media-missing`,
`lu-metric-card`, `lu-note`, `lu-sandbox`, `lu-simple`, `lu-status-badge`, `lu-status-card`,
`lu-table`, `lu-time-range-picker`, `lu-timeseries`. `defineElement(tag, ctor)` (root entry) is the
idempotent define they use. The opt-in `./media` and `./chat` registries (`createMediaLitRegistry`,
`createChatLitRegistry`, `registerMediaWidgets`, `registerChatWidgets`) define their own elements
when called, so those hosts need no change. Measured effect (minified, esm): `./dom` 178,969 ->
103,042 bytes, `./media` 186,244 -> 134,995, `./chat` 201,022 -> 149,815, a single `elements/lu-kpi`
entry 62,501 against 166,282 for `register`.

## Key concepts

- **One surface, two entry points.** The root entry (`index.ts`) exports every `lu-*` element class
  (a `LitElement` subclass per kind; registered explicitly, see above), the formatting/i18n/a11y
  helpers, and re-exports everything the `./dom` subpath exports — so `renderBlueprintDom`,
  `litRegistry` and the DOM adapter's types are all importable from `@loom-ui/renderer-lit`
  directly. The `./dom` subpath is the same adapter alone, for a narrower import when you don't need
  the elements' classes or the formatting/i18n/a11y helpers by name — `litRegistry` is a
  `RendererRegistry` of element-mounting functions, pre-wired to the `lu-*` elements.
- **`renderBlueprintDom` mirrors loom's React renderer.** Same grid placement (loom ADR 0098), same
  section-title wrapping, same status matrix (loading/empty/stale/error rows) — so a Blueprint
  renders identically whichever renderer draws it, modulo the widget implementation itself.
- **Widget contract (`DomWidgetRenderer`).** A widget renderer mounts into a host element and
  returns a `DomWidgetHandle { update(value, status?), patch?(widget), dispose() }`;
  `elementRenderer(tag)` builds one that mounts `<tag>` and drives its
  `widget`/`value`/`status`/`onAction` properties — what every `litRegistry` entry uses.
- **Container renderers (`DomContainerRenderer`, Blueprint IR 2.2.0 role).** A container renderer
  owns only its chrome and its children's *visibility*; the adapter still owns mounting, keyed
  reconciliation, reordering, grid placement, subscriptions and the focus pin. Register one per role
  in a `DomContainerRegistry` and pass it as `DomRenderOptions.containers` — there is no default
  registry. `referenceContainers()` — from the `@loom-ui/renderer-lit/containers` subpath, so the
  core bundle does not carry it — is an opt-in one for the two roles the reference planner composes
  (`tabs`: a roving-tabindex tablist whose buttons are reused across updates so focus survives, with
  `aria-controls` and a tabbable visible panel; `stepper`: Back/Next and a position line), also
  exported singly as `tabsContainer()` / `stepperContainer()`. Each child is a titled container
  whose title is the label; a host that registers nothing draws both as the plain titled stack,
  children intact (so does the terminal renderer).
- **Keyed recompose.** `handle.update(nextBlueprint)` patches the live tree in place by widget id
  and, since Blueprint IR 2.4.0, by container layout id — a widget or container that keeps its id
  and kind keeps its element, subscription and any user-entered DOM state (typed text, caret,
  scroll, focus).
- **Framework kinds are Lit-only.** `LIT_ONLY_KINDS` (= `FRAMEWORK_KINDS` from `@loom-ui/core`) are
  drawn only by this package's widgets; loom's React renderer shows its `[No renderer for …]`
  placeholder for them.

## API

### The action contract and the stale-view flow

Every action a widget emits reaches `onAction` as loom's `WidgetAction` (`type`, `widgetId`,
`payload`) plus an additive `viewedVersion` (`StampedAction`, from `@loom-ui/core`):
`blueprintId` / `experienceId` / `versionHash` of the view the user was looking at; for a bound
widget `binding: { state, seq }` — the status the widget was last DELIVERED (not a mount-time
snapshot); and `compile`, the fingerprint you declared (`DomRenderOptions.compile`). The version
hash identifies the composition; the binding `seq` is that binding's own status sequence (drawn
from a store-wide counter, so a write to ANOTHER handle never changes it): compare it for equality —
a difference means "the data moved". A bound widget with no `status.path` stamps no binding, so its
data movement cannot be detected. A handler typed `(a: WidgetAction) => void` keeps working.
Without `DomRenderOptions.compile` neither the stamp nor `head()` carries a compile fingerprint and
no compile check runs (a weaker mode: a redacted and an unredacted view of the same artifact look
the same) — supply it whenever compile inputs vary per viewer, and use `compileFingerprint`'s
`extra` for inputs beyond clearance / restricted handles / locale (surface, catalogue, labels).

What the stamp names is what was COMMITTED AND PAINTED: a widget kept across `update(v3)` is stamped
`v2` until the new tree has had a frame (a sandbox message queued, or a click made, before then is
an action on the old view) — or at most 250 ms if frames are paused (a background tab), so a stamp
never lags the commit indefinitely; a widget mounted by the pass is stamped `v3`. A rebound widget
stamps its new binding. Actions from a widget that has been disposed, torn down or remounted (a 3P
renderer calling `onAction` late) are dropped.

The host flow, executable as written — compare against the head THIS renderer last committed
(`handle.head()`), not merely the store's newest Experience (after a half-landed `update` the user
is still on the previous head):

```ts
import { actionFreshness, compileFingerprint, isStaleAction } from "@loom-ui/core";
const compile = compileFingerprint({ clearance, locale, ...result.fingerprint }); // what you compiled with (result = compile(…); `fingerprint` is the OPAQUE form of the restricted lists)
const handle = renderBlueprintDom(host, blueprint, { /* … */, compile, onAction });
// in onAction(action):
if (isStaleAction(action, handle.head())) return refuse(actionFreshness(action, handle.head()));
```

`handle.head()` is `{ experienceId, versionHash, compile?, bindingSeq(widgetId) }`; `bindingSeq`
reads the CURRENT seq of the widget's bound data from the projection runtime. Verdicts:
`fresh`; `stale` (other version, or other `compile` fingerprint — e.g. the approver saw
"Restricted"); `data-moved` (same composition, different seq); `unverifiable` (unsealed version, or
a binding/compile the stamp cannot answer); `unstamped`. `isStaleAction` fails closed on everything
but `fresh`. Pass `action.viewedVersion` into the flow's resume payload so the flow can check it too
(loom-side binding of approvals to the viewed version is tracked as R13).

The stamp is written ONLY by the renderer, after the widget: `widgetId` and `viewedVersion` are
overwritten, so no widget, A2UI tree or sandbox code can spoof provenance — their own
`action`/`context` live nested under `payload`. The stamp is a staleness aid, not authentication of
the actor.

**`A2UI_ACTION` and `SANDBOX_ACTION` are untrusted intent.** A Button's label AND action name are
authored by a model/A2UI producer; a sandbox frame can post `{ type: "action" }` with no user
gesture at all (the iframe's own input is invisible to the parent, so a gesture gate cannot be
enforced from here). They are stamped and staleness-checked like any other action, but they are NOT
the human approval: never treat one as consent to a gated step. Only renderer-owned widget actions
(e.g. `APPROVE` from `ApprovalCard`) are.

The host must dedupe approvals: a renderer may emit a second `APPROVE` / `REJECT` for the same
pending approval (a double click), so the host's handler keys on the pending approval and answers it
once. (The terminal renderer additionally ignores a repeat until the frame moves.)

A2UI Buttons emit `{ type: "A2UI_ACTION", payload: { action, context } }` and sandbox frames emit
`{ type: "SANDBOX_ACTION", payload: { action, context } }` through the same `onAction`. When
`onAction` is wired, the DOM `a2ui-action` event is NOT fired (it carries no provenance, and a host
listening to both would act twice); without `onAction` it still fires, **deprecated**.
`@loom-ui/renderer-terminal` is read-only (no interactive actions), so it emits none.

### The DOM adapter (`@loom-ui/renderer-lit/dom`)

- `renderBlueprintDom(host, blueprint, opts: DomRenderOptions): DomRenderHandle` — mounts a
  Blueprint into `host`; `opts` needs `projectionRuntime`, `executionId`, `registry`, and takes
  `containers?`, `onAction?`, `title?: "heading" | "none"`.
- `DomRenderHandle` — `{ element, update(next): RecomposeReport, dispose() }`.
- `litRegistry: DomRegistry` — loom's built-in kinds plus every framework kind, mapped to `lu-*`
  elements via `elementRenderer`.
- `createLitRegistry({ chrome?: "widget" | "host" }): DomRegistry` — a new registry; `chrome:
  "host"` mounts every widget with `chrome="host"` for an app that draws its own title bar or frame:
  no VISIBLE title in the body (error/empty/stale text included), while the accessible name keeps
  it. Settable per element too (`el.chrome = "host"`). Only a non-empty string is a title: `""` or a
  non-string (`0`, `5`) is none (the kind stands in; a Note shows no title) — exactly as in the
  terminal renderer. `litRegistry` is `createLitRegistry()`.
- `elementRenderer(tag, opts?): DomWidgetRenderer` — build a widget renderer that mounts a custom
  element and drives its properties; used to register a custom kind of your own.
- `LIT_ONLY_KINDS`, `frameworkKindContracts` — the framework kinds this registry alone draws, and
  the loom `CatalogEntry` contracts (`kind`, `props`, `binding`) to copy onto a semantic entry's
  `surfaces.web` when declaring one.
- `placeholderFor(kind)`, `projectionPlaceholder(id)` — the DOM nodes shown for an unregistered kind
  or an unregistered projection.
- Types: `DomRenderOptions`, `DomWidgetProps`, `DomWidgetHandle`, `DomWidgetRenderer`,
  `DomRegistry`; `DomContainerProps`, `DomContainerChild`, `DomContainerHandle`,
  `DomContainerRenderer`, `DomContainerRegistry`; `RecomposeReport`, `RecomposeFinding`.

### Custom elements (root entry exports the classes; register them explicitly)

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

### Scale (U17)

All opt-in; with none of it configured nothing changes.

- **Visibility (`onVisible`).** `renderBlueprintDom(..., { onVisible })` watches every BOUND
  widget's host with ONE shared `IntersectionObserver` (disconnected by `dispose()`;
  `visibilityRootMargin`, default `"100px"`) and calls `onVisible(widget)` on entry into view, on
  each re-entry, and when a binding changes while on screen. This is what fetches a P2 hydration
  handle: `onVisible: (w) => { const h = w.binding && handleOfPath(w.binding.path); if (h)
  controller.markVisible(h); }` (`handleOfPath` from `@loom-ui/hydration/client`; the renderer knows
  nothing of hydration). With no `IntersectionObserver` every bound widget is reported at mount
  (fail open: a P2 handle that never loads is worse than one that loads early).
- **Update coalescing.** `coalesceUpdates(handle, { schedule? })` wraps a render handle: any number
  of `update(blueprint)` calls between two frames are ONE reconcile of the newest Blueprint (default
  scheduler `animationFrameScheduler`: next frame, or a 250 ms deadline in a hidden tab). Each call
  resolves with the report of the pass that landed. Per widget, `createLitRegistry({ coalesce:
  animationFrameScheduler })` holds value updates until the frame and hands the element only the
  newest pair (the first value, at mount, is never delayed). Known one-frame effect: a `patch` (the
  widget's definition changed, including a rebind to another binding path) applies at once while its
  value is held to the frame, so for at most one frame the widget carries the NEW definition with
  the PREVIOUS value. It is the same viewer's data (the registry never mixes viewers); a host that
  cannot show that for a frame renders a rebinding without `coalesce`.
- **Virtualization.** `createLitRegistry({ virtualize: true | { rowHeight, overscan, minRows } })`.
  `lu-table` and `lu-data-table` mount only the rows near the scroll position (fixed row height,
  default 30 px; 8 rows overscan; windowing starts above 200 rows) with two spacer rows,
  `aria-rowcount` / `aria-rowindex` for assistive tech, scroll reset on sort, and a re-render only
  when the mounted window changes; every row is reachable by scrolling, so there is no "show more".
  `lu-chat` (variable-height turns) lets the browser skip layout and paint of off-screen turns
  (`content-visibility: auto`) past `minRows` entries, so stick-to-bottom and the load-earlier
  anchor keep working. `virtualWindow(total, rowHeight, scrollTop, viewport, overscan)` is the pure
  core, exported. The host element must be the scroll container (give `lu-table` / `lu-data-table` a
  definite `height` and `overflow: auto`); a host that is not (no layout box, or its content is not
  taller than its box, so the page scrolls instead) falls back to the classic rendering and its
  200-row cap rather than leave rows blank.

### Number and value formatting

- `measure(value, format?): string`, `tick(value, format?): string` — the reader (accessible name)
  and the compact axis-tick form of a semantic number, both delegating to `@loom-ui/core`'s
  `formatSemanticNumber`/`effectiveFormat` so the DOM and terminal renderers never disagree.
- `timeTick(iso, spanMs): string` — a compact time-axis tick label sized to the series' span.
- `describeValue(kind, value, title, props?)` — a spoken summary of a rendered value for a screen
  reader, reading the same `format`/`unit` precedence the widget itself renders with.

### Localization

- `currentLocale()`, `setLocale(next)`, `onLocaleChange(listener)`, `isRtl(locale?)`,
  `localeLabel(locale)` — the locale a widget formats with, a change signal so an element
  re-renders on change, and the RTL question.
- `configureI18n(override)`, `LU_MESSAGES`, `LU_MESSAGE_KEYS` — the host's words for every fixed
  string; see "Localising the renderer" below. Loading message catalogs stays with the host app.

### Localising the renderer

Every fixed, user-visible English string this package draws (empty states, aria-labels,
placeholders, buttons, status lines) is a key in ONE catalogue, `LU_MESSAGES` in `@loom-ui/core`,
re-exported here with the typed key list `LU_MESSAGE_KEYS` and the `LuMessageKey` / `LuI18n` types.
English is the default, so with no override the output is unchanged. A host installs its words once,
before mounting:

```ts
import { configureI18n, LU_MESSAGE_KEYS } from "@loom-ui/renderer-lit";

configureI18n({
  locale: "de-DE", // numbers, dates, plural categories
  messages: { "lu.empty.noData": "Keine Daten", "lu.chat.send": "Senden" }, // a catalogue ...
  translate: (key, english) => myFormatter(key, english), // ... and/or a function; undefined = English
});
```

- The catalogue is consulted first, then `translate(key, english)` (a message-format library plugs
  in here), then the English default. A `translate` that throws is English, never a broken render.
- A message may carry `{name}` placeholders (`lu.table.showing` is `Showing {shown} of {total}
  {noun}`); keep them in the translation. A placeholder with no value is left as written.
- A counted noun is `<base>.<category>` (`lu.plural.row.one` / `.other`, and `.few` / `.many` / ...
  for a locale that has them). The locale's plural category selects the form only when the host
  translated it; otherwise English rules choose, so the English text stays grammatical.
- `configureI18n` is a **module-level singleton**: one locale/catalogue per page (per loaded module
  instance of the renderer). Two hosts on one page share it; the terminal renderer's `i18n` option,
  by contrast, is per registry. An empty or whitespace-only entry counts as unset (it falls through
  to `translate`, then English) rather than blanking the control.
- Calling `configureI18n` again swaps the override and re-renders every mounted element;
  `configureI18n(undefined)` removes it. The locale also changes through `setLocale`.
- Text that is DATA (titles, labels, headlines, cells, chat messages) is the experience's own words
  and is never touched. Developer diagnostics (`onFail` findings, thrown errors) stay English.
- Defaults live in `@loom-ui/core`'s `LU_MESSAGES`; a test (`i18nFitness.test.ts`) fails on any new
  inline English literal in a renderer source and on any key no renderer uses.

The keys this renderer asks for (the English default beside each; `{x}` is a placeholder):

| Key | English default |
| --- | --- |
| `lu.empty.noData` | `No data` |
| `lu.state.loading` | `loading` |
| `lu.state.error` | `error` |
| `lu.state.stale` | `stale` |
| `lu.state.emptyView` | `empty view` |
| `lu.state.noComponentCode` | `no component code` |
| `lu.state.unknownComponent` | `unknown component: {name}` |
| `lu.state.noValue` | `— no value` |
| `lu.state.sourceShownAs` | `{type}, shown as {kind}` |
| `lu.dom.noRenderer` | `[No renderer for {kind}]` |
| `lu.dom.rendererError` | `[Renderer error for {kind}]` |
| `lu.dom.rendererErrorDetail` | `[Renderer error for {kind}: {detail}]` |
| `lu.dom.projectionMissing` | `[Projection "{id}" is not registered]` |
| `lu.approval.approve` | `Approve` |
| `lu.approval.reject` | `Reject` |
| `lu.approval.none` | `No pending approval` |
| `lu.a11y.lineChart` | `line chart` |
| `lu.a11y.barChart` | `bar chart` |
| `lu.a11y.tableWith` | `table with {rows} {noun}` |
| `lu.a11y.unchanged` | `unchanged` |
| `lu.a11y.up` | `up` |
| `lu.a11y.down` | `down` |
| `lu.a11y.rightAxis` | `R` |
| `lu.plural.row.one` | `row` |
| `lu.plural.row.other` | `rows` |
| `lu.plural.entry.one` | `entry` |
| `lu.plural.entry.other` | `entries` |
| `lu.level.ok` | `ok` |
| `lu.level.warning` | `warning` |
| `lu.level.critical` | `critical` |
| `lu.table.showing` | `Showing {shown} of {total} {noun}` |
| `lu.table.showMore` | `Show {n} more` |
| `lu.table.actions` | `Actions` |
| `lu.table.rowAction` | `{label}: {row}` |
| `lu.container.tab` | `Tab` |
| `lu.container.step` | `Step` |
| `lu.container.steps` | `Steps` |
| `lu.container.back` | `Back` |
| `lu.container.next` | `Next` |
| `lu.container.stepOf` | `Step {current} / {total}: {label}` |
| `lu.locale.language` | `Language` |
| `lu.locale.noOthers` | `No other languages are available yet` |
| `lu.range.title` | `Time range` |
| `lu.range.24h` | `24h` |
| `lu.range.7d` | `7d` |
| `lu.range.30d` | `30d` |
| `lu.range.90d` | `90d` |
| `lu.range.12m` | `12m` |
| `lu.range.custom` | `Custom` |
| `lu.range.from` | `From` |
| `lu.range.to` | `To` |
| `lu.media.kind.image` | `image` |
| `lu.media.kind.audio` | `audio` |
| `lu.media.kind.video` | `video` |
| `lu.media.kind.file` | `file` |
| `lu.media.notLoaded` | `Media renderer not loaded` |
| `lu.media.untrusted` | `untrusted content` |
| `lu.media.tooLarge` | `Media too large to display` |
| `lu.media.blocked` | `Untrusted media blocked` |
| `lu.media.unavailable` | `Media unavailable` |
| `lu.media.loading` | `Loading media` |
| `lu.media.upload.uploading` | `Uploading…` |
| `lu.media.upload.attached` | `Attached` |
| `lu.media.upload.notAccepted` | `That file type is not accepted` |
| `lu.media.upload.tooLarge` | `That file is too large` |
| `lu.media.upload.failed` | `Upload failed` |
| `lu.media.upload.unavailable` | `Uploads are not available` |
| `lu.media.upload.stale` | `The view changed; choose the file again` |
| `lu.media.upload.attach` | `Attach a file` |
| `lu.chat.notLoaded` | `Chat renderer not loaded` |
| `lu.chat.empty` | `No messages yet.` |
| `lu.chat.loadEarlier` | `Load earlier messages` |
| `lu.chat.loading` | `Loading…` |
| `lu.chat.replying` | `The assistant is replying…` |
| `lu.chat.closed` | `This conversation is closed.` |
| `lu.chat.restrictedMessage` | `Restricted message` |
| `lu.chat.restricted` | `Restricted` |
| `lu.chat.ref` | `Source {n}` |
| `lu.chat.table` | `Table` |
| `lu.chat.edit` | `Edit` |
| `lu.chat.editThis` | `Edit this message` |
| `lu.chat.editYour` | `Edit your message` |
| `lu.chat.editHint` | `Sent as a new message. Ctrl+Enter sends, Escape cancels.` |
| `lu.chat.send` | `Send` |
| `lu.chat.cancel` | `Cancel` |
| `lu.chat.sending` | `Sending…` |
| `lu.chat.typeFirst` | `Type a message first.` |
| `lu.chat.who.assistant` | `Assistant` |
| `lu.chat.who.notice` | `Notice` |
| `lu.chat.who.you` | `You` |
| `lu.chat.who.user` | `User` |
| `lu.chat.who.userNamed` | `User "{name}"` |
| `lu.chat.status.replying` | `replying` |
| `lu.chat.status.interrupted` | `interrupted` |
| `lu.chat.status.failed` | `failed` |
| `lu.chat.status.rejected` | `not accepted` |
| `lu.chat.status.editOf` | `edit of turn {turn}` |
| `lu.chat.line.restricted` | `[restricted {role} turn]` |
| `lu.chat.line.restrictedFrom` | `[restricted {role} turn from {by}]` |
| `lu.chat.line.ref` | `(ref {id})` |
| `lu.chat.line.tools` | `[tools: {tools}]` |
| `lu.chat.reasoning.label` | `Reasoning` |
| `lu.chat.reasoning.summaryLabel` | `Reasoning summary` |
| `lu.chat.reasoning.summaryNote` | `A summary of the model's reasoning, not the full reasoning.` |
| `lu.chat.reasoning.inProgress` | `in progress` |
| `lu.chat.reasoning.redacted` | `The model's reasoning is redacted.` |
| `lu.chat.reasoning.erased` | `Reasoning removed.` |
| `lu.chat.reasoning.unverified` | `The stored reasoning could not be verified and is not shown.` |
| `lu.chat.reasoning.unavailable` | `No reasoning is available for this reply.` |
| `lu.chat.reasoning.loading` | `Loading reasoning…` |
| `lu.chat.reasoning.truncated` | `Shortened: only part of the reasoning is shown.` |
| `lu.chat.line.reasoning` | `[reasoning: {text}]` |
| `lu.chat.line.reasoningSummary` | `[reasoning summary: {text}]` |
| `lu.chat.line.reasoningRedacted` | `[reasoning redacted]` |
| `lu.chat.line.reasoningErased` | `[reasoning removed]` |
| `lu.chat.reason.model-error` | `The assistant ran into a problem.` |
| `lu.chat.reason.denied` | `That was not permitted.` |
| `lu.chat.reason.turn-failed` | `The turn could not be completed.` |
| `lu.chat.reason.cancelled` | `The turn was cancelled.` |
| `lu.chat.reason.too-long` | `The message was too long.` |
| `lu.chat.reason.prompt-too-large` | `The message was too large to answer.` |
| `lu.chat.reason.malformed` | `The message was not understood.` |
| `lu.chat.reason.unauthenticated` | `The message could not be verified.` |
| `lu.chat.reason.replayed` | `The message was already received.` |
| `lu.chat.reason.stale` | `The message arrived too late.` |
| `lu.chat.reason.not-a-participant` | `You are not a participant in this conversation.` |
| `lu.chat.reason.edit-invalid` | `That edit could not be applied to the earlier message.` |
| `lu.chat.reason.generic` | `The message was not processed.` |
| `lu.chat.dispatch.stale` | `The view changed. Review it and send again.` |
| `lu.chat.dispatch.unavailable` | `Sending is not available here.` |
| `lu.chat.dispatch.failed` | `Not sent. Try again.` |
| `lu.input.message` | `Message` |
| `lu.input.hint` | `Press Ctrl+Enter to send.` |
| `lu.input.sent` | `Sent` |
| `lu.input.tooLong` | `That message is too long.` |
| `lu.input.form` | `Form` |
| `lu.input.submit` | `Submit` |
| `lu.input.choose` | `Choose` |
| `lu.input.chooseEllipsis` | `Choose…` |
| `lu.input.fixFields` | `Fix the marked fields.` |
| `lu.input.formUnavailable` | `This form is not available.` |
| `lu.input.choiceUnavailable` | `This choice is not available.` |
| `lu.input.error.required` | `This field is required.` |
| `lu.input.error.tooLong` | `This is too long.` |
| `lu.input.error.range` | `This is out of range.` |
| `lu.input.error.option` | `Choose one of the options.` |
| `lu.input.error.unknownField` | `This field is not part of the form.` |
| `lu.input.error.invalid` | `This is not valid.` |

### A2UI and sandbox support

- `planView(view: A2UIView, data): A2UIRender`, `resolvePointer(doc, pointer)` — resolve an A2UI
  declarative view tree plus bound data into a render plan.
- `buildSandboxSrcdoc()`, `hostMessage(message)`, `parseFrameMessage(raw)`, `SANDBOX_ALLOW` — the
  sandboxed-iframe protocol `lu-sandbox`/`lu-sandbox-widget` speak to the untrusted frame.

## Interaction signals (U11)

`@loom-ui/renderer-lit/signals` (opt-in entry; not in `index`/`dom`, so the bundle budgets are
untouched) is `observeSignals(handle, collector, { placeholders, compile })`: one
IntersectionObserver, one click listener and one `toggle` listener over the handle's element,
driving a `@loom-ui/core/signals` `SignalCollector`. Exposure = a widget at least half visible while
the page is visible (no IntersectionObserver means no exposure is claimed); dwell is accumulated and
sent as a bucket; a click anywhere in a widget, or a `<details>` opening, is an engagement on it. It
reads only `data-widget-id` — never text or values. Call `refresh()` after `handle.update(next)`: a
new Blueprint id starts a new view. Hide/`pagehide` flushes by default. An explicit rating or
outcome comes from an action: `collector.observeAction(action)` in `onAction` maps `feedback` (`{
rating }`) and `outcome` (`{ name, success }`) and never copies the rest of the payload.

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

- **Chat is an opt-in entry (U8): `@loom-ui/renderer-lit/chat`.** `createChatLitRegistry({ media })`
  is the default registry plus `Chat`, `TextInput`, `FormInput` and `SelectInput`
  (`registerChatWidgets(registry, opts)` adds them to one you built; `chatKindContracts` is what a
  catalogue's `surfaces.web` carries). The default registry draws one fixed "Chat renderer not
  loaded" placeholder for these kinds (no value, title or prop; one console warning). The contract
  rides every bundle (~7 kB, `index`/`dom` budgets 164 -> 172 kB, hydration `client` 64 -> 72 KiB:
  treat those as the CEILING for any future framework kind, not a baseline to spend again); the
  widgets are this entry (budget 196 kB; it must not pull in `ChatFeed` or the host-side code,
  `browserBundle.test.ts` fails if it does).
  - **`lu-chat`** is a focusable `role="log"` region (`aria-live="polite"`, `aria-busy` while a
    reply streams, so a screen reader hears the settled reply once). Every entry is an `<article>`
    labelled with its speaker and status. Text is a Lit text binding, cleaned again with
    `sanitizeChatText` (memoised per part): never `unsafeHTML` or an auto-link. A part marked
    `format: "markdown"` (assistant entries only, opt-in) is drawn by `chatMarkdown.ts` from core's closed
    tree as elements the template builds: links only http, https and mailto, `target="_blank"` with
    `rel="noopener noreferrer nofollow"`, the host shown after the label, no images, no html. The fuzz test
    asserts no random text ever creates an element or attribute, and the markdown test walks the DOM of a
    hostile corpus for any tag, attribute or address outside a closed list. A restricted entry draws
    "Restricted" and nothing else; a failed / rejected turn draws a FIXED sentence plus `ref
    <errorId>`. A streaming entry keeps the id its durable successor has, so nothing remounts or
    shifts; it sticks to the bottom only if the reader was at the bottom. "Load earlier messages"
    emits `LOAD_OLDER`, keeps the reader's scroll position and, if its button goes away, hands focus
    to the log. A reply that carries `reasoning` (only when the host enabled it in `ChatFeed`) gets a
    collapsed-by-default "Reasoning" disclosure: a native button with `aria-expanded` and
    `aria-controls` for a `role="region"` labelled by it, `aria-live="off"` so streaming reasoning is
    never announced unprompted. The text is drawn like reply text (a Lit text binding, cleaned again;
    never markup) and updates live while it streams; a `summary` is labelled "Reasoning summary" and says
    it is not the full reasoning; `redacted` is a marker with no text; removed, unverifiable, unavailable
    and truncated reasoning each have a fixed sentence. A reply whose stored reasoning is not fetched yet
    emits `LOAD_REASONING { cursor }` once, on first expand. Style with `--lu-text-dim`, `--lu-border`,
    `--lu-radius`. A reply without reasoning draws exactly as before. When the value says `refMarkers`, `[[id]]` in an assistant
    text part is drawn, for an id the entry lists in `refs`, as `<button class="ref" aria-label="Source n">n</button>`
    (numbered by first appearance); an unlisted marker is removed, every marker is hidden while the reply streams, and
    a press emits `CHAT_REF_OPEN { entryId, refId, n }`, awaits the host and shows a refused answer in a status line
    (the button is `aria-disabled` while it is in flight). Style with `--lu-accent`, `--lu-panel-2`. With `editable`, the viewer's own complete turns get an Edit button: an inline
    editor takes focus, Ctrl/Cmd+Enter sends `EDIT_TURN`, Escape cancels back onto the button, a
    failed send keeps the text and the key. Media parts are drawn by the media widgets and the
    host's resolver when `@loom-ui/renderer-lit/media` is loaded, and DESCRIBED (type, name, size;
    never an address) when it is not.
  - **The inputs** are native controls with labels, `aria-describedby`, `aria-invalid` and a status
    region that is always one line high (no layout shift). The field is read-only (not disabled)
    while a send is in flight, so focus stays; a second submit is ignored. Multi-line text sends
    with Ctrl/Cmd+Enter and never while an IME composes. An invalid form sends nothing and focuses
    the first bad field. A failed send keeps the draft and the idempotency key. `onAction` handlers
    may return `{ ok, reason? }` (or a promise): the widget waits for it (`renderBlueprintDom`
    passes the return value through).
- **Media is an opt-in entry (U9): `@loom-ui/renderer-lit/media`.** `createMediaLitRegistry({ media
  })` is the default registry plus `Image`, `Audio`, `Video`, `File` and `MediaInput`
  (`registerMediaWidgets(registry, opts)` adds them to one you built; `mediaKindContracts` is what a
  catalogue's `surfaces.web` carries). It is its own entry so a page with no media does not pay for
  it (the default `index` budget grew only by the value contract, ~3 kB). The host passes `media: {
  resolver, policy, upload }` — build them per viewer session:
  - `resolver` (`MediaResolver`) is the ONLY source of a `src`. It must authorise; its URL is
    re-checked (`checkMediaUrl`) before it reaches an element. With none, a media widget draws
    "Media unavailable" and loads nothing. A refusal, a missing blob, a throwing resolver, a
    rejected URL and an element load error are ONE fixed text — a difference would be an existence
    oracle for an address; the address, the URL and the reason are never printed in any state.
  - It resolves only once a value has arrived (so a P2 handle, which hydrates on `markVisible`,
    resolves nothing off-screen) and, where `IntersectionObserver` exists, only once the element is
    on screen; `loading="lazy"` / `preload="none"`; nothing autoplays;
    `referrerpolicy="no-referrer"`; a file is `rel="noopener noreferrer nofollow"` with a sanitised
    `download` name; name, alt and caption are bound, control- and bidi-stripped text set through
    attribute bindings.
  - A declared size over `policy.maxBytes[kind]` is refused BEFORE the resolver is asked; a larger
    size observed by the resolver is refused too. Media is drawn with an untrusted marker unless the
    resolver answers `trusted: true` (never for `origin: "user"`); `policy.untrusted: "block"` draws
    a placeholder.
  - Untrusted bytes of an active type (HTML, SVG, XML, script) are `blocked`, never drawn; untrusted
    media on a same-origin `/path` or `blob:` URL is `blocked` unless
    `policy.allowSameOriginUntrusted`. **The resolver's response duties** (this package cannot
    enforce them): `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` for files,
    `Content-Security-Policy: sandbox`, and a `Content-Type` equal to the ref's `mediaType`. A file
    whose name's extension disagrees with its type is shown with the type beside it and a
    `data-type-mismatch` attribute, and its download name drops the misleading extension.
  - **The default registry draws a fixed "Media renderer not loaded" placeholder** for the media
    kinds (and warns once on the console) instead of an empty hole; `createMediaLitRegistry`
    replaces it with the real widgets.
  - `MEDIA_ATTACH` is client input: the host MUST run `acceptMediaAttach` (`@loom-ui/core/media`) on
    it. The widget's checks and the `origin: "user"` stamp are courtesy; ownership of the address,
    freshness and the strict re-parse are the host's.
  - `MediaInput` hands the chosen file to `upload` (a `MediaUploadHandler`), validates the ref it
    returns against the `File` contract and `accept`/`maxBytes`, re-stamps it `origin: "user"` and
    emits `{ type: "MEDIA_ATTACH", payload: { ref } }`, which the adapter stamps with
    `viewedVersion` like every action. The type and size checks are courtesy only: the host's
    handler enforces. A result that arrives after the widget was patched or removed is DROPPED
    (state `stale`) rather than stamped onto a view the user did not choose the file in. No handler
    = "Uploads are not available"; bytes are never read or stored here.


- **A restricted node is a `Note`.** `compile({ viewer })` replaces a node the viewer may not see
  with a static, unbound `Note` (title and `text` "Restricted"), which `lu-note` draws with
  `role="note"` and that text as its accessible name — no value, label or binding of the original.
  Redaction happens in `compile` and hydration, not here; a renderer draws what it is given.

- **User-entered state is DOM state.** A renderer overwrites a bound input's value only when the
  value actually changed — never on an unrelated `patch` or re-render — so typed text, caret
  position and scroll survive a recompose the change did not cause.
- **A focused subtree never moves.** During `handle.update`, the element holding
  `document.activeElement` is never remounted or relocated, even when its container reorders around
  it.
- **Charts size themselves in an auto-height container.** `lu-timeseries` / `lu-bar-chart` draw an
  SVG the size of their own box; the plot is out of flow, so it cannot feed back into that
  measurement (the old behaviour grew without bound in a flex column or stack). With no definite
  height to resolve `height: 100%` against, a chart takes `aspect-ratio: var(--lu-chart-aspect, 16 /
  9)` floored by `min-height: var(--lu-chart-min-height, 120px)`; a definite-height grid cell still
  wins. Both properties are yours to set. Behaviour changes from earlier releases: the `min-height`
  floor was `0` and is now `120px` (a host that wants the old behaviour sets `--lu-chart-min-height:
  0`), and a chart's non-ready states (loading, error, empty) now reserve the same 16:9 box rather
  than collapsing to a line of text, so a dashboard does not reflow when data arrives. The chart
  host is `box-sizing: border-box`, so `width: 100%` plus padding or a border never overflows its
  container.
- **Accessible descriptions name the kind.** A chart's name reads `<title>: line chart, <series…>` /
  `<title>: bar chart, <bars…>` (and a table's `<title>: table with N rows`, singular `1 row`).
  Every phrase is a catalogue key asked through the package's `t()` seam, and counted nouns
  (`row`/`rows`, `entry`/`entries`, the table footer's "Showing N of M rows") are keyed
  `lu.plural.row.one` / `lu.plural.row.other` (plus `few`/`many`/… where a locale has them). The
  active locale's plural category (`Intl.PluralRules`: French 0 is `one`, Japanese has only `other`,
  Russian has one/few/many) selects the form ONLY when `t(<key>.<category>)` returns a translation,
  i.e. anything other than the English fallback. Otherwise the category is chosen by the English
  rules, so the English text is always grammatical: `ja` and `fr` read "1 row" and "0 rows", never
  "1 rows" or "0 row". A host supplies translations with `configureI18n` (see "Localising the
  renderer").
- **A container renderer's failure never loses children.** A container renderer that throws on mount
  or `update` is disposed and the container falls back to the plain container in place; children
  stay mounted and subscribed, with a `mount-failed`/`patch-failed` finding reported.
- **`update` is never re-entrant.** Calling `handle.update` from inside a widget or container
  renderer's own `patch`/`update` during a pass is refused (a `re-entrant update` finding) and
  changes nothing.
- **`@loom-ui/renderer-lit/dom` is bundler-only.** It has `moduleResolution: "Bundler"` output
  (extensionless relative specifiers); running it under plain Node ESM resolution fails — the
  supported path is a bundler like Vite or webpack.
- **Value contracts are enforced, not assumed.** The shared `LuWidget` base every bound widget
  extends checks its value with `@loom-ui/core`'s `checkKindValue` before drawing it and shows a
  visible error state on a mismatch — the built-in kinds (`LuMetricCard`, `LuStatusBadge`,
  `LuDataTable`, …) get this as much as the framework kinds, not only the latter. A host kind (your
  own Lit element extending `LuWidget`) is checked against `el.contracts` — `createLitRegistry({
  contracts })` / `elementRenderer(tag, { contracts })` set it from the catalogue's
  `valueContracts`; with no contract for its kind it still renders but the state wrapper carries
  `data-unchecked`, never silently as if checked. (The terminal renderer's own widgets are all
  framework kinds, whose contracts a host cannot change; its `renderExperience` `contracts` option
  feeds loom's check for host kinds.)

## See also

- [../core/README.md](../core/README.md) — `Blueprint` compilation, framework kinds and number
  semantics this package renders.
- [../hydration/README.md](../hydration/README.md) — the projection state this package's widgets
  subscribe to.
- [../renderer-terminal/README.md](../renderer-terminal/README.md) — the non-DOM counterpart
  surface for the same framework kinds.
- [../../docs/reference/rendering.md](../../docs/reference/rendering.md) — the container-renderer
  ownership rules and recompose semantics.
- [../../docs/reference/theming.md](../../docs/reference/theming.md) — the `--lu-*` tokens.
- [../../README.md](../../README.md) — root overview.

## Conformance

`src/conformance.test.ts` runs `@loom-ui/renderer-conformance` against this renderer (with the chat
and media entries registered); `src/conformanceAdapter.test-support.ts` is the adapter. A
third-party renderer does the same: see
[../renderer-conformance/README.md](../renderer-conformance/README.md).
