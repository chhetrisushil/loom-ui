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
// The root entry carries both the custom elements (registered on import) and the DOM adapter —
// `index.ts` re-exports everything `./dom` does, plus the elements, formatting, i18n and a11y
// helpers.
import { renderBlueprintDom, litRegistry, LuKpi, LuTimeRangePicker, measure } from "@loom-ui/renderer-lit";

// `./dom` is the same adapter (`renderBlueprintDom`, `litRegistry`, …) through a narrower
// subpath — no `LuKpi`/`measure`/i18n/a11y re-exports, just the adapter and its types. It still
// registers every custom element as a side effect (it imports the widgets module for that).
import { renderBlueprintDom as renderBlueprintDomNarrow } from "@loom-ui/renderer-lit/dom";
```

## Key concepts

- **One surface, two entry points.** The root entry (`index.ts`) defines and registers every
  `lu-*` custom element (a `LitElement` subclass per kind), the formatting/i18n/a11y helpers, and
  re-exports everything the `./dom` subpath exports — so `renderBlueprintDom`, `litRegistry` and
  the DOM adapter's types are all importable from `@loom-ui/renderer-lit` directly. The `./dom`
  subpath is the same adapter alone, for a narrower import when you don't need the elements'
  classes or the formatting/i18n/a11y helpers by name — `litRegistry` is a `RendererRegistry` of
  element-mounting functions, pre-wired to the `lu-*` elements.
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
  default registry. `referenceContainers()` — from the `@loom-ui/renderer-lit/containers` subpath,
  so the core bundle does not carry it — is an opt-in one for the two roles the reference planner
  composes (`tabs`: a roving-tabindex tablist whose buttons are reused across updates so focus
  survives, with `aria-controls` and a tabbable visible panel; `stepper`: Back/Next and a position
  line), also exported singly as `tabsContainer()` / `stepperContainer()`. Each child is a titled
  container whose title is the label; a host that registers nothing draws both as the plain
  titled stack, children intact (so does the terminal renderer).
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
never lags the commit indefinitely; a widget mounted by the pass is stamped `v3`. A rebound widget stamps
its new binding. Actions from a widget that has been disposed, torn down or remounted (a 3P
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
- `createLitRegistry({ chrome?: "widget" | "host" }): DomRegistry` — a new registry; `chrome: "host"`
  mounts every widget with `chrome="host"` for an app that draws its own title bar or frame: no
  VISIBLE title in the body (error/empty/stale text included), while the accessible name keeps it.
  Settable per element too (`el.chrome = "host"`). Only a non-empty string is a
  title: `""` or a non-string (`0`, `5`) is none (the kind stands in; a Note shows no title) —
  exactly as in the terminal renderer. `litRegistry` is `createLitRegistry()`.
- `elementRenderer(tag, opts?): DomWidgetRenderer` — build a widget renderer that mounts a custom element
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
- `describeValue(kind, value, title, props?)` — a spoken summary of a rendered value for a screen
  reader, reading the same `format`/`unit` precedence the widget itself renders with.

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

- **Chat is an opt-in entry (U8): `@loom-ui/renderer-lit/chat`.** `createChatLitRegistry({ media })` is the default
  registry plus `Chat`, `TextInput`, `FormInput` and `SelectInput` (`registerChatWidgets(registry, opts)` adds them to
  one you built; `chatKindContracts` is what a catalogue's `surfaces.web` carries). The default registry draws one fixed
  "Chat renderer not loaded" placeholder for these kinds (no value, title or prop; one console warning). The contract
  rides every bundle (~7 kB, `index`/`dom` budgets 164 -> 172 kB, hydration `client` 64 -> 72 KiB: treat those as the CEILING for
  any future framework kind, not a baseline to spend again); the widgets are this entry (budget 196 kB; it must
  not pull in `ChatFeed` or the host-side code, `browserBundle.test.ts` fails if it does).
  - **`lu-chat`** is a focusable `role="log"` region (`aria-live="polite"`, `aria-busy` while a reply streams, so a screen
    reader hears the settled reply once). Every entry is an `<article>` labelled with its speaker and status. Text is a
    Lit text binding, cleaned again with `sanitizeChatText` (memoised per part): never `unsafeHTML`, markdown or a link; the
    fuzz test asserts no random text ever creates an element or attribute. A restricted entry draws "Restricted" and
    nothing else; a failed / rejected turn draws a FIXED sentence plus `ref <errorId>`. A streaming entry keeps the id its
    durable successor has, so nothing remounts or shifts; it sticks to the bottom only if the reader was at the bottom.
    "Load earlier messages" emits `LOAD_OLDER`, keeps the reader's scroll position and, if its button goes away, hands
    focus to the log. With `editable`, the viewer's own complete turns get an Edit button: an inline editor takes focus,
    Ctrl/Cmd+Enter sends `EDIT_TURN`, Escape cancels back onto the button, a failed send keeps the text and the key.
    Media parts are drawn by the media widgets and the host's resolver when `@loom-ui/renderer-lit/media` is loaded, and
    DESCRIBED (type, name, size; never an address) when it is not.
  - **The inputs** are native controls with labels, `aria-describedby`, `aria-invalid` and a status region that is always
    one line high (no layout shift). The field is read-only (not disabled) while a send is in flight, so focus stays;
    a second submit is ignored. Multi-line text sends with Ctrl/Cmd+Enter and never while an IME composes. An invalid form
    sends nothing and focuses the first bad field. A failed send keeps the draft and the idempotency key.
    `onAction` handlers may return `{ ok, reason? }` (or a promise): the widget waits for it (`renderBlueprintDom` passes
    the return value through).
- **Media is an opt-in entry (U9): `@loom-ui/renderer-lit/media`.** `createMediaLitRegistry({ media })`
  is the default registry plus `Image`, `Audio`, `Video`, `File` and `MediaInput`
  (`registerMediaWidgets(registry, opts)` adds them to one you built; `mediaKindContracts` is what a
  catalogue's `surfaces.web` carries). It is its own entry so a page with no media does not pay for it
  (the default `index` budget grew only by the value contract, ~3 kB). The host passes `media: { resolver,
  policy, upload }` — build them per viewer session:
  - `resolver` (`MediaResolver`) is the ONLY source of a `src`. It must authorise; its URL is re-checked
    (`checkMediaUrl`) before it reaches an element. With none, a media widget draws "Media unavailable"
    and loads nothing. A refusal, a missing blob, a throwing resolver, a rejected URL and an element load
    error are ONE fixed text — a difference would be an existence oracle for an address; the address,
    the URL and the reason are never printed in any state.
  - It resolves only once a value has arrived (so a P2 handle, which hydrates on `markVisible`, resolves
    nothing off-screen) and, where `IntersectionObserver` exists, only once the element is on screen;
    `loading="lazy"` / `preload="none"`; nothing autoplays; `referrerpolicy="no-referrer"`; a file is
    `rel="noopener noreferrer nofollow"` with a sanitised `download` name; name, alt and caption are
    bound, control- and bidi-stripped text set through attribute bindings.
  - A declared size over `policy.maxBytes[kind]` is refused BEFORE the resolver is asked; a larger size
    observed by the resolver is refused too. Media is drawn with an untrusted marker unless the resolver
    answers `trusted: true` (never for `origin: "user"`); `policy.untrusted: "block"` draws a placeholder.
  - Untrusted bytes of an active type (HTML, SVG, XML, script) are `blocked`, never drawn; untrusted media on a
    same-origin `/path` or `blob:` URL is `blocked` unless `policy.allowSameOriginUntrusted`. **The resolver's
    response duties** (this package cannot enforce them): `X-Content-Type-Options: nosniff`, `Content-Disposition:
    attachment` for files, `Content-Security-Policy: sandbox`, and a `Content-Type` equal to the ref's
    `mediaType`. A file whose name's extension disagrees with its type is shown with the type beside it and a
    `data-type-mismatch` attribute, and its download name drops the misleading extension.
  - **The default registry draws a fixed "Media renderer not loaded" placeholder** for the media kinds (and
    warns once on the console) instead of an empty hole; `createMediaLitRegistry` replaces it with the real widgets.
  - `MEDIA_ATTACH` is client input: the host MUST run `acceptMediaAttach` (`@loom-ui/core/media`) on it. The
    widget's checks and the `origin: "user"` stamp are courtesy; ownership of the address, freshness and the
    strict re-parse are the host's.
  - `MediaInput` hands the chosen file to `upload` (a `MediaUploadHandler`), validates the ref it returns
    against the `File` contract and `accept`/`maxBytes`, re-stamps it `origin: "user"` and emits
    `{ type: "MEDIA_ATTACH", payload: { ref } }`, which the adapter stamps with `viewedVersion` like every
    action. The type and size checks are courtesy only: the host's handler enforces. A result that
    arrives after the widget was patched or removed is DROPPED (state `stale`) rather than stamped onto a
    view the user did not choose the file in. No handler = "Uploads are not available"; bytes are never
    read or stored here.


- **A restricted node is a `Note`.** `compile({ viewer })` replaces a node the viewer may not see
  with a static, unbound `Note` (title and `text` "Restricted"), which `lu-note` draws with
  `role="note"` and that text as its accessible name — no value, label or binding of the original.
  Redaction happens in `compile` and hydration, not here; a renderer draws what it is given.

- **User-entered state is DOM state.** A renderer overwrites a bound input's value only when the
  value actually changed — never on an unrelated `patch` or re-render — so typed text, caret
  position and scroll survive a recompose the change did not cause.
- **A focused subtree never moves.** During `handle.update`, the element holding
  `document.activeElement` is never remounted or relocated, even when its container reorders
  around it.
- **Charts size themselves in an auto-height container.** `lu-timeseries` / `lu-bar-chart` draw an
  SVG the size of their own box; the plot is out of flow, so it cannot feed back into that
  measurement (the old behaviour grew without bound in a flex column or stack). With no definite
  height to resolve `height: 100%` against, a chart takes `aspect-ratio: var(--lu-chart-aspect,
  16 / 9)` floored by `min-height: var(--lu-chart-min-height, 120px)`; a definite-height grid cell
  still wins. Both properties are yours to set.
  Behaviour changes from earlier releases: the `min-height` floor was `0` and is now `120px`
  (a host that wants the old behaviour sets `--lu-chart-min-height: 0`), and a chart's non-ready
  states (loading, error, empty) now reserve the same 16:9 box rather than collapsing to a line of
  text, so a dashboard does not reflow when data arrives. The chart host is `box-sizing:
  border-box`, so `width: 100%` plus padding or a border never overflows its container.
- **Accessible descriptions name the kind.** A chart's name reads `<title>: line chart, <series…>`
  / `<title>: bar chart, <bars…>` (and a table's `<title>: table with N rows`, singular `1 row`).
  Every phrase passes through the package's `t()` seam, and counted nouns (`row`/`rows`,
  `entry`/`entries`, the table footer's "Showing N of M rows") are keyed `row.one` / `row.other`
  (plus `few`/`many`/… where a locale has them). The active locale's plural category
  (`Intl.PluralRules`: French 0 is `one`, Japanese has only `other`, Russian has one/few/many)
  selects the form ONLY when `t(<key>.<category>)` returns a translation, i.e. anything other than
  the English fallback. Otherwise the category is chosen by the English rules, so the English text
  is always grammatical: `ja` and `fr` read "1 row" and "0 rows", never "1 rows" or "0 row". Today
  `t` is an identity function with no host override, so the spoken text is English; a way for a
  host to supply translations is a separate capability this package does not have yet.
- **A container renderer's failure never loses children.** A container renderer that throws on
  mount or `update` is disposed and the container falls back to the plain container in place;
  children stay mounted and subscribed, with a `mount-failed`/`patch-failed` finding reported.
- **`update` is never re-entrant.** Calling `handle.update` from inside a widget or container
  renderer's own `patch`/`update` during a pass is refused (a `re-entrant update` finding) and
  changes nothing.
- **`@loom-ui/renderer-lit/dom` is bundler-only.** It has `moduleResolution: "Bundler"` output
  (extensionless relative specifiers); running it under plain Node ESM resolution fails — the
  supported path is a bundler like Vite or webpack.
- **Value contracts are enforced, not assumed.** The shared `LuWidget` base every bound widget
  extends checks its value with `@loom-ui/core`'s `checkKindValue` before drawing it and shows a
  visible error state on a mismatch — the built-in kinds (`LuMetricCard`, `LuStatusBadge`,
  `LuDataTable`, …) get this as much as the framework kinds, not only the latter. A host kind (your own Lit element extending `LuWidget`) is checked against
  `el.contracts` — `createLitRegistry({ contracts })` / `elementRenderer(tag, { contracts })` set
  it from the catalogue's `valueContracts`; with no contract for its kind it still renders but the
  state wrapper carries `data-unchecked`, never silently as if checked. (The terminal renderer's
  own widgets are all framework kinds, whose contracts a host cannot change; its `renderExperience`
  `contracts` option feeds loom's check for host kinds.)

## See also

- [../core/README.md](../core/README.md) — `Blueprint` compilation, framework kinds and number
  semantics this package renders.
- [../hydration/README.md](../hydration/README.md) — the projection state this package's widgets
  subscribe to.
- [../renderer-terminal/README.md](../renderer-terminal/README.md) — the non-DOM counterpart
  surface for the same framework kinds.
- [../../README.md](../../README.md) — root overview, including the full container-renderer
  ownership rules and recompose semantics.
