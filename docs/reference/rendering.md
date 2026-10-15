# Rendering reference

How a compiled Blueprint is drawn on the web (React, Lit) and in a terminal, and how a live tree is
recomposed in place. Package detail is in
[`@loom-ui/renderer-lit`](../../packages/renderer-lit/README.md) and
[`@loom-ui/renderer-terminal`](../../packages/renderer-terminal/README.md).

## Draw a Blueprint

A sketch, not a compiling snippet: `blueprint`, `runtime` and `store` come from compile and
hydration.

```tsx
// Web, React: loom's renderer, unchanged.
<BlueprintRenderer
  blueprint={blueprint}
  projectionRuntime={runtime}
  executionId={store.executionId}
  registry={defaultRegistry}
/>;
```

```ts
// Web, Lit: the same blueprint through the DOM adapter with the Lit registry.
import { litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";

const handle = renderBlueprintDom(document.getElementById("app"), blueprint, {
  projectionRuntime: runtime,
  executionId: store.executionId,
  registry: litRegistry,
});

// Terminal: loom's registry plus the framework kinds; status comes from the Blueprint.
import { renderExperience, watch } from "@loom-ui/renderer-terminal";

const stop = watch(blueprint, store, (frame) => process.stdout.write(`\x1Bc${frame}`));
```

## What compile targets

Compile targets loom's Blueprint IR 2.5.0 (the container ids arrived in 2.4.0, the redacted widget
in 2.5.0): every container's layout carries its node id (loom ADR 0101), in the one namespace widget
ids share; every grid child is a `GridCell` with the node's span (and placement, below), every bound
widget declares `binding.status.path = status.<handle>` beside `values.<handle>` in the hydration
projection, and carries `source` (its semantic type and any degradation). loom's React, Lit and
terminal renderers all read status and spans from the Blueprint; nothing reads the hydration
projection behind it. A `span` takes effect only when the node's parent container is a grid: a grid
compiles its children into `GridCell`s that carry the span, while a `row`/`column` parent compiles
to a flex layout that has no columns for a span to occupy, so the span does not apply there and is
dropped without a finding (loom ADR 0097 D5).

`genesis`' default root — the one the reference planner composes into — is therefore a 12-column
`grid`, so the span the compose prompt asks the model for ("a 12-column row") lands as a cell.

The Lit widgets keep loom-ui's per-kind value contracts, and the terminal plugs the same check into
loom's `check` seam.

On the web the framework kinds are drawn by loom-ui's Lit widgets only (`LIT_ONLY_KINDS` in
`@loom-ui/renderer-lit`): loom's React renderer has no renderer registered for any of them and shows
its `[No renderer for …]` placeholder.

Node placement, section titles and container roles are specified in the
[composition reference](composition.md).

## Recomposing

When the agent revises the experience, do not tear the DOM down. `controller.load(nextExperience)`
recomposes hydration (it aborts and drops the handles the new artifact no longer binds and keeps the
shared ones), then `handle.update(compile(nextExperience, opts).blueprint)` lands the new Blueprint
on the live tree by widget id: a widget that kept its id and kind keeps its element, its
subscription and whatever the user has in it — typed text, caret, focus, a scrolled list — while
siblings are added, dropped, patched and reordered around it (the child holding
`document.activeElement` is never moved).

A kind change remounts only that widget, and so does a move the keyed walk cannot follow — to
another container, or when its container is not kept.

Containers are keyed by their layout id (Blueprint IR 2.4.0, loom ADR 0101), plus type and role;
`compile` puts every container's node id on its layout, so inserting a container above a section the
user is typing in, or reordering sections, keeps every widget inside them — the same textarea, its
text, caret and focus.

A container is re-created when its id, type or role changes or it moves to another parent.

The ROOT is the exception: it has no siblings to be matched among, so it is keyed by role alone — a
root whose id changes is kept in place (its widgets untouched), and the changed id shows up only in
loom's identity report, as a `dropped-node-id` finding in `RecomposeReport.identity.findings`.

A hand-built layout without an id is keyed by its ordinal among its id-less siblings, as before
2.4.0, so a shift in that ordinal re-creates its widgets; an id'd container never matches an id-less
one, so the first recompose across the upgrade remounts once.

Every such widget is listed in `RecomposeReport.remounted`; a changed binding is re-subscribed and
gets its first slice at once.

`update` never throws: a renderer failure shows loom's error placeholder for that widget and lands
in the returned `RecomposeReport.findings`, beside loom's identity report (`identity.added`,
`identity.findings` for dropped ids).

## Placement and titles on the web

`renderBlueprintDom` draws Blueprint IR 2.1.0 the way loom's React renderer does (loom ADR 0098 D4),
without its wrapper: a cell's grid lines land on the child's own element — `grid-column: <column> /
span <span>` (or `span <span>`), `grid-row: <row> / span <rowSpan ?? 1>` (or `span <rowSpan>`) — and
an unplaced span-1 cell writes nothing.

A layout with a non-empty `title` renders as `<section aria-label="…"><h2>…</h2><div data-layout
…></div></section>`; the section is the grid item, the heading never is.

On `handle.update`, a placement change is a style patch on the kept element; a title text change
patches the heading; adding or removing a title wraps or unwraps the same layout element — its
widgets stay mounted, and a focused control inside it — including one inside a widget's shadow root
— keeps focus and selection (moved with `moveBefore` where the platform has it).

## Container renderers on the web

`DomRenderOptions.containers` is the container counterpart of `registry`: a loom
`RendererRegistry<DomContainerRenderer>` keyed by ROLE (build one with `.register` / `.merge`; there
is no default).

A layout whose well-formed `role` is registered there renders as `<div data-container-role="R">`
holding the renderer's chrome and the adapter's own layout element; a titled one keeps the adapter's
heading, with the role host inside the section (`<section aria-label><h2>` + role host), so the
heading names chrome and body alike. No `containers`, a role it lacks, or a malformed role draws the
plain container — DOM-identical to no role.

The renderer is `(host, { layout, body, children }) => { update(props), dispose() }`: `body` is the
adapter's layout element and `children` its children in document order, each `{ element, node }`
(`node` for labels, such as a step's title). `update` is required.

**Who owns what:** the adapter keeps everything it owns for a plain container — `body`, the
children's mount, keyed reconcile, reorder, grid placement and subscriptions, the focus pin, the
section wrap. The app owns only its chrome (what it mounts in `host` outside `body`) and which
children are visible, by setting `hidden`, `inert`, `aria-*`, `role`, `id` or `class` on the child
elements it is handed; it never adds, removes, reorders or restyles `body`'s children.

**Updates:** `handle.update` reconciles the children first, then calls the container's `update` only
when the layout's own fields (type, columns, direction, gap, title, role), its child element list or
order, or a child's own fields (a widget node, a child layout's title) changed — an identical
Blueprint is still zero DOM mutations and zero calls. A role change remounts the container like a
type change, its widgets listed in `RecomposeReport.remounted` (for the root too); chrome state (the
current step, the open tab) lives in the handle and survives exactly as long as the container does.
Hidden children stay mounted and subscribed, so a hidden step's widget keeps receiving its data.

**Failure:** a container renderer that throws on mount or `update`, or returns no handle with
`update` and `dispose`, is disposed and the container falls back to plain in place — children kept,
still subscribed, `hidden` / `inert` / `aria-hidden` removed from them — with a `mount-failed` /
`patch-failed` finding (`nodeId` is the layout's id, or `""` for a layout without one; the message
names the role and the layout's path, e.g. `layout.children[1]`); the same role is not retried until
the container remounts. The adapter restores only visibility (`hidden`, `inert`, `aria-hidden`); a
renderer's `dispose` MUST undo every other attribute it set on the children it was handed
(`role="tabpanel"`, `aria-labelledby`, `id`, `class`, …), since after a fallback those children stay
mounted in the plain container and would otherwise point at disposed chrome. As with a widget, a
failure during the initial `renderBlueprintDom` falls back silently (there is no report to carry
it).

**Accessibility:** a child the app does not show carries `hidden` (out of the accessibility tree and
tab order); one kept in layout, e.g. to animate, carries `inert` and `aria-hidden="true"`. Chrome
controls are real `<button>`s with accessible names; a step count or position is
`aria-live="polite"`. Tab-like roles put `role="tab"` / `"tablist"` on chrome and may set
`role="tabpanel"` and `aria-labelledby` on a child element. When the app hides the child holding
focus, it moves focus (to the shown child or its chrome) — the adapter never blurs. A child's
element can change under the app — a child container gaining or losing a title swaps its section in
or out — and the new list arrives through `update`; set visibility on exactly the elements handed.
The terminal has no counterpart: a role is an interaction hint and a one-shot text surface has none,
so every child prints under the title in reading order, byte-identical with or without a role (loom
ADR 0099 D5); loom's React renderer draws the plain container too.

## The Blueprint's own title

Beside per-container titles above, `DomRenderOptions.title` controls whether the Blueprint's OWN
title renders as the root `<h1>`: `"heading"` (default) is today's behaviour, unchanged; `"none"`
mounts no `<h1>` at all, for a host page that already carries its own heading or whose compiled
title is not display text.

Under `"none"`, `handle.update` never creates, removes or patches a title element — a
`blueprint.title` change alone is not a DOM mutation.

The mode is fixed for the handle's whole lifetime (read once at `renderBlueprintDom`, not re-read
from `update`'s `next`); switching it mid-handle is not supported — dispose and re-mount with the
new option instead.

The root element carries no landmark or accessible name in either mode; under `"none"` the host owns
the page heading, so give the mount point's region its accessible name from that heading (e.g.
`aria-labelledby`) where the page needs one.

## Browser code only

`@loom-ui/renderer-lit` is browser code: `node -e "import('@loom-ui/renderer-lit/dom')"` fails
outside a bundler, on two counts. No other package here declares it as a dependency, so pnpm never
links it into another package's `node_modules` for bare-specifier resolution to find. And even
resolved directly (`node dist/dom/index.js`), its `moduleResolution: "Bundler"` build emits
extensionless relative specifiers (`./litRegistry`, not `./litRegistry.js`) that only a bundler's
resolver completes — plain Node ESM resolution requires the extension. Its consumer is a bundler
(Vite, webpack, …); that is the supported path, not a plain Node `import()`.
