# Composition reference

How an experience is built, edited, sealed and compiled. This page holds the detail that the
[README](../../README.md) only summarises; the API surface lives in
[`@loom-ui/core`](../../packages/core/README.md).

## Compose, seal, log, compile

A worked sequence. It is a sketch rather than a compiling snippet: it elides the `meta`, `ctx`,
`contentStore` and `catalog` a real caller supplies.

```ts
import { apply, compile, genesis } from "@loom-ui/core";
import { EXPERIENCE_COMPOSED, putExperience } from "@loom-ui/core/log";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration";

const exp = genesis({
  experienceId: "checkout-triage",
  intent: { objective: "Investigate checkout latency", source: "user" },
  meta,
});
const op = {
  type: "insertNode",
  parentId: "root",
  node: {
    id: "p99",
    order: "V",
    kind: "semantic",
    type: "Metric",
    typeVersion: "1.0.0",
    span: 6,
    props: { unit: "ms" },
    binding: { handle: "latency-p99", priority: "P0" },
  },
} as const;
const r = apply(exp, op);
if (!r.ok) throw new Error(r.finding.message);

// Inside a loom execution: seal, store the bytes, log the reference (a userspace event).
// `putExperience` is total — an experience carrying a value the content address cannot be taken
// over (NaN, a bigint) comes back as an `artifact-unhashable` finding rather than a throw.
const put = await putExperience(contentStore, r.value);
if (!put.ok) throw new Error(put.finding.message);
ctx.emit(EXPERIENCE_COMPOSED, {
  ref: put.ref,
  parents: put.experience.parents,
  ops: [{ op, by: { source: "user" }, at: now }],
});

// Anywhere, later, with no model in the path: compile per surface and hand loom the Blueprint.
const { blueprint, findings } = compile(put.experience, {
  surface: "web",
  catalog,
  hydrationProjectionId: HYDRATION_PROJECTION_ID,
  hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
});
```

## Placement and section titles

A node may also carry `row`, `rowSpan` and `column` — 1-based grid lines, the coordinates of CSS
grid and of loom's `GridCell` (loom ADR 0098): it occupies columns `column..column+span-1` and rows
`row..row+rowSpan-1`; each is optional, and a node with none flows as before. They compile into the
node's cell only under a `grid` parent; a placement anywhere else is `placement-outside-grid` and
one that leaves the 12 columns is `placement-out-of-range` (loom's own predicate).

`validateExperience` reports such state in pre-existing data (the cell then compiles unplaced);
every op refuses creating it — `setPlacement`, `insertNode` and `moveNode` raise both codes.

A log recorded before these refusals that inserted a placed node off a grid or overflowing it no
longer replays.

A container may carry a `title` (`LocalizedText`), resolved through `resolveLabel` like a label and
emitted as its compiled layout's `title` when non-empty.

`placementOf`, `isPlaced`, `placementProblems` and `GRID_COLUMNS` are exported for composers;
`placementProblems(node, columns = GRID_COLUMNS)` is width-parametric, like loom's predicate, so a
composer can check a node against a grid of any width.

Absent fields add nothing to the hashed artifact, so an experience that uses neither keeps its
content address.

The web renderers (React, Lit) and the terminal agree on reading order only when a grid's cells are
all placed or all unplaced; a partially placed grid falls to CSS grid auto-placement on the web and
to row-then-column order in the terminal (loom ADR 0098 D4/D6).

`row` and `rowSpan` stay unbounded (ADR 0098 D1), but a value past `GRID_LINE_WARN_ABOVE` (1000) is
a `grid-line-extreme` WARN from `validateExperience` so a runaway plan is flagged; nothing is
rejected and the experience still compiles.

## Container roles

A container may also carry a `role` (Blueprint IR 2.2.0, loom ADR 0099): the open, app-defined name
a container renderer is registered under — for containers what a widget's `kind` is for widgets
(`"stepped"`, `"tabbed"`, `"collapsible"`, anything the app names; loom-ui ships no role
vocabulary). It is never an ARIA role and never display text, so it is not localised: `compile`
copies it onto the compiled layout as-is. A role must be well-formed by loom's `isLayoutRole` — a
lowercase letter, then lowercase letters, digits or hyphens, at most 64 characters (`LayoutRole` in
`@loom-ui/core`). The node schema refuses anything else, so `insertNode` and `setRole` do; a
malformed role in pre-existing data is `validateExperience`'s `role-invalid` — a WARN against the
container, loom's code and severity, since nothing is lost but the custom rendering — and `compile`
leaves it off (every renderer draws the plain container).

A well-formed role no renderer knows is not a finding: which roles are registered is a fact about
the renderer in use.

`direction` stays the geometry; `role` is the presentation a renderer that knows it may give that
geometry. An absent role adds nothing to the hashed artifact.

## Framework kinds

Beside loom's eight built-in kinds, `@loom-ui/core` declares kinds of its own in `FRAMEWORK_KINDS`,
each with a zod value contract in `kindValueContracts`. The list is an open set that grows as
vocabulary slices land: check that the kinds you render are present rather than pinning its length.
The [catalogue and widget reference](catalogue.md) gives the full shape of a catalogue entry and, for
every kind, its value fields and limits, props, actions and renderers; this section keeps the summary.

The data kinds below carry the charts, tables and status shapes. They exist because these shapes
conflict with loom's `MetricCard` (a number), `DataTable` (records) and `StatusBadge` (a string),
whose contracts loom's React renderers depend on and which are never widened.

| Kind | Value type and notes |
| --- | --- |
| `TimeSeries` | `TimeSeriesValue`. A series may carry `format` and `axis` (`ChartAxis`, `"left"` or `"right"`); `lu-timeseries` draws a second y-axis, and marks a right-hand series "(R)" only when some series is on the left (all-right shares one axis). |
| `BarChart` | `BarChartValue`, with a value-level `format`. |
| `Kpi` | `KpiValue`: `{ value, unit?, format?, label?, deltaPct? }`. `label` is a caption shown beside the widget title, never in its place, and is spoken and printed with it. `deltaPct` is a fraction drawn as an up or down triangle to one decimal via `DELTA_FORMAT`. |
| `Table` | `TableValue`: `{ columns: TableColumn[], rows: TableCell[][] }`. A `TableColumn` is a string or `{ label, format? }`, read through `tableColumnLabel` and `tableColumnFormat`; a `TableCell` is a string, number, `null` or a token cell `{ tokens: { id, label }[] }` (at most 20 tokens, short unique ids, a plain-text label of 1 to 80 characters), drawn as wrapping chips that are real buttons named by their label, read as text through `tableCellText` (the labels joined with ", "). A chip emits `TABLE_TOKEN { rowKey, tokenId }` through `onAction`, or `{ rowIndex, tokenId }` for a table without `rowKeys` (the index into `rows` as sent, not the sorted position; never both). Text sorts in the formatting locale. Optional `rowKeys` (one stable key per row) and `rowActions` (at most 4 per row: `{ id, label, primary?, destructive? }`; needs `rowKeys`) draw a trailing actions cell, one named button per action, and the `primary` one in the first cell; each emits `TABLE_ROW_ACTION { action, rowKey }` through `onAction` (buttons are disabled with no handler). A value that breaks a rule is refused by `checkKindValue`. |
| `StatusCard` | `StatusCardValue`: `{ level: StatusLevel, headline, detail? }`, where `StatusLevel` is `"ok"`, `"warning"` or `"critical"`. Announced through `role="status" aria-live="polite"`. |
| `Note` | Static text from its `text` prop; never bound. |
| `Diagram` | `DiagramValue`: a tree, flow, timeline or network as nodes and edges. See [Diagrams](#diagrams). Drawn by the opt-in `@loom-ui/renderer-lit/diagram` entry; the default registry draws a fixed placeholder. |
| `A2UIView`, `SandboxView` | Mount `lu-a2ui-view` / `lu-sandbox` with the declared `view` / `code` prop and the bound value as data. |

The media and conversation kinds (`Image`, `Audio`, `Video`, `File`, `MediaInput`, `Chat`,
`TextInput`, `FormInput`, `SelectInput`, `MultiSelectInput`) are also in `FRAMEWORK_KINDS`; their value contracts are
described in the [`@loom-ui/core` README](../../packages/core/README.md) under "Media" and "Chat and
inputs". `SelectInput` may bind (optionally): the bound value is its current choice, shown only when it is a
declared option. `MultiSelectInput` must bind its options and choice (`{ options, selected, note? }`); its
change emits `SELECT_MANY`, checked against the host's `optionsOf`.

An app declares a framework kind on a semantic entry's `surfaces.web` by copying its contract from
`frameworkKindContracts` (`@loom-ui/renderer-lit`: the nine kinds of the default registry), or, for the
opt-in kinds, from `mediaKindContracts`, `chatKindContracts` or `diagramKindContracts` (their entries). The
full entry and value shape of every kind is in the [catalogue reference](catalogue.md).

A catalogue entry's `textProps` names the props that carry display text; a `LocalizedText` there is
resolved at compile through `resolveLabel`, exactly like a node label, so a Blueprint never carries
a message key. Any other shape in a text prop is a `text-prop-shape` finding.

## Number semantics

`SemanticFormat` describes what the renderers honour, and nothing more: `semanticType` is one of
`number`, `integer`, `decimal`, `percentage`, `currency` (with its ISO 4217 `currency` code,
required — a code-less currency is refused, never assumed), plus optional `notation` (`standard` /
`compact`) and `minimumFractionDigits` / `maximumFractionDigits` (0–20, min ≤ max; an `integer`
takes none — fraction digits on it are refused, not coerced).

A consumer with richer semantics (durations, measurements) maps them onto these at its own
boundary (points in time have their own contract, `TimeFormat`, below); extra keys in a payload are tolerated and ignored. Numbers read their semantics in the
order value `format`, then widget `props.format`, then the `unit` (`effectiveFormat`: `$`, `€`, `%`
or any ISO 4217 code, via `formatFromUnit`).

A `percentage` value — and a value whose unit is `%`, when no explicit `format` overrides it — is a
FRACTION: `0.25` renders `25%` (an explicit format wins by the precedence above: with `format: {
semanticType: "decimal" }` and `unit: "%"`, `25` renders `25 %`).

The unit is shown beside the figure unless the format draws its own symbol (`unitSuffix`: a
`currency` or `percentage` format drops it, so `USD` / `%` never double; `{ value: 7, unit: "ms",
format: { semanticType: "decimal" } }` still reads `7 ms`).

A delta's direction is `deltaDirection` — `"up"`, `"down"`, or `"flat"` when it reads as 0% at
`DELTA_FORMAT`'s precision (no arrow; spoken "unchanged"), or `"none"` for a non-finite delta, drawn
"—" with no arrow and not spoken as a change.

`semanticNumberFormatOptions` is the one `SemanticFormat` → `Intl.NumberFormat` options mapping and
`formatSemanticNumber` formats at a fixed locale, so the web, the spoken form and the terminal
round, group and suffix identically.

## Time semantics

`TimeFormat` says how a point in time READS, so no renderer guesses it from the timestamps:
`{ granularity, timeZone? }`, where `granularity` is `year` ("2026"), `half` ("H1 2026"),
`quarter` ("Q1 2026"), `month` ("Jan 2026"), `week` ("Week of Jan 5, 2026"), `day`
("Jan 5, 2026") or `datetime` ("Jan 5, 2026, 9:30 AM"), in the reader's locale. `timeZone` is a zone
`Intl.DateTimeFormat` accepts (an IANA name or `"UTC"`; any other is refused). Without it, every
granularity coarser than `datetime` reads in UTC, because a period is a calendar label and not an
instant (`"2026-01"` is January in every reader's zone), and `datetime` reads in the reader's zone.

It is a separate contract from `SemanticFormat`, which says what a NUMBER means: a time series
carries both, the numbers per series (`series[i].format`) and the shared time axis once
(`TimeSeriesValue.timeFormat`). The axis reads its format in the order value `timeFormat`, then
widget `props.timeFormat` (an unchecked prop that is malformed is ignored), then the label inferred
from the timestamp (a date-only one in UTC as a date, a timestamp in the reader's zone).

A week is labelled by the timestamp's own date: the host sets it to the week's first day under its
own week rule, since which day starts a week differs by region. A half or a quarter reads the
timestamp's month, so any day inside the period works. With a declared granularity the axis ticks
the first point of each period only, so a label never repeats (daily points under `month` tick
once a month) and a coarse granularity never shows a time of day. `formatTimeLabel(iso, format,
locale, words)` is the one formatter (the catalogue words `lu.time.half`, `lu.time.quarter` and
`lu.time.weekOf` come from the caller, so a host translates them); `isTimeFormat` is the contract
without zod. The spoken summary and the terminal's sparkline draw no time labels.

## Diagrams

`Diagram` binds a diagram to data: an org chart or other hierarchy (`tree`), a process (`flow`), dated
events (`timeline`) or relationships (`network`).

```ts
type DiagramValue = {
  layout: "tree" | "flow" | "timeline" | "network";
  title?: string;
  timeFormat?: TimeFormat;   // labels a timeline's dates (the Time semantics above)
  nodes: { id: string; label: string; kind?: string; group?: string; at?: string }[];
  edges: { from: string; to: string; label?: string; kind?: string }[];
};
```

**Caps.** 1 to `MAX_DIAGRAM_NODES` (200) nodes and at most `MAX_DIAGRAM_EDGES` (400) edges. Over the
cap the value is REFUSED (the widget's error state) and never truncated: a cut diagram would be a
false picture. The cost of that refusal is bounded: nothing is walked once a cap is broken.

**Rules**, one zod-free checker (`diagramProblems`) that both the zod contract and the browser checker
call, so they cannot disagree. Each is a finding with a fixed message that never echoes a label.

- Node ids are non-empty and unique; every edge's `from` and `to` name an existing node.
- `tree`: no self-edge, exactly one root (a node with no incoming edge), every other node has exactly
  one parent, and every node is reachable from the root (so no cycle).
- `timeline`: every node has an `at` that `Date.parse` accepts. Other layouts ignore `at`.
- `flow` may contain cycles (drawn as dashed back-edges); `network` takes anything beyond the id rules.

All checks are O(nodes + edges) and iterative: a 200-deep chain is a valid tree and recurses nowhere.

**The outline.** `diagramOutline(value, locale, words)` is the one text form: a tree as an indented
outline (depth first, children in edge order), a flow or network as one `A → B (label)` line per edge
(a flow by the layer of the edge's source, then input order; nodes with no edge after), a timeline as
`date — label` lines sorted by `at` (stable for ties), the date through `formatTimeLabel` with the value's
`timeFormat` (else `day`). Labels are DATA: never translated, never parsed as markup. The web widget's
hidden list, the terminal's lines and the conformance check all read this one function. A flow's
layers come from `diagramGraph`, which also supplies the web drawing, so the order a listener hears
is the order a sighted reader sees.

**What each renderer draws.** `lu-diagram` (opt-in entry `@loom-ui/renderer-lit/diagram`,
`createDiagramLitRegistry` / `registerDiagramWidgets`, `diagramKindContracts`) draws SVG at its natural
size inside a scroll container (no zoom): a tidy top-down tree, a layered left-to-right flow
(longest-path layers, barycenter ordering, back-edges dashed), a timeline with time-proportional x
and a labelled axis, and a network on a circle in input order. A `group` picks a colour by first
appearance; `kind` is a `data-kind` attribute. The SVG is hidden from assistive technology; the
accessible name is "title: diagram, tree, 12 nodes" and the whole structure is a visually hidden
list (nested for a tree). The terminal prints the title and then the outline lines.

**Reshaping data into a `DiagramValue`.** A hierarchy (an org chart, a folder tree): one node per
item and one edge from each parent to its child; the single top item is the root. A graph with
cycles (dependencies, a process with retries): `flow`, or `network` when direction does not matter.
Dated events: `timeline`, with ISO dates in `at`; edges are optional (an ordering, a causation). When
the data is over the cap, reduce it before binding: show the top levels of a hierarchy and one node
for each collapsed subtree (`label: "Platform (+14)"`), group a graph's leaves into a single node,
or bind a window of the events. A tree that arrives with several roots or a shared child is not a
tree: add one synthetic root, or use `flow`.

## Source references

A chart or figure can show which sources it came from. A `Kpi`, `BarChart`, `TimeSeries`, `Table`, `StatusCard` or
`Diagram` VALUE may carry:

```ts
refs?: { id: string; label?: string }[];
```

- **Value-level, widget-level.** `refs` is part of the hydrated data, never a planner prop, and it belongs to the
  whole widget: there are no per-row or per-point refs. (`MetricCard`'s value is a bare number, so it cannot carry any.)
- **Caps and rules**, one zod-free checker (`widgetRefProblems`) that both the zod contract and the browser checker
  call, so verdicts and messages match; a message never echoes data. At most `MAX_WIDGET_REFS` (16) refs ("at most 16
  refs"); each `id` matches chat's ref id rule, `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` ("a ref id must be a short
  identifier") and is unique in the list ("ref ids must be unique"); a `label` is a string of at most
  `MAX_WIDGET_REF_LABEL` (200) characters ("a ref label is at most 200 characters"). A value that breaks a rule is
  the widget's error state, never drawn with a cut list.
- **Activation uses the action channel.** Markers are numbered 1, 2, ... in array order. Activating one emits the
  widget action `REF_OPEN` (`REF_OPEN_ACTION`) with `payload: { refId, n }` and the widget's id in `widgetId`, exactly
  as a table row action or a chat reference does; the host decides what "open" means and answers (`{ ok: false }` or a
  rejection is shown as a refused or failed answer, any other return is success). With no `onAction` (no host
  listening) the markers are inert text, not controls.
- **What each renderer draws.** renderer-lit: a strip of markers after the widget's content, buttons only with an
  `onAction`, each named "Source 1: <label>" (the label as text, never markup), and ", N sources" in the spoken
  summary. renderer-terminal: `[1] label` footnote lines under the widget's output, the label cut to one clean line.
  A value without `refs` draws exactly as before.

## Operations beyond insert, remove and move

Operations beyond insert/remove/move/props/label/bind/remap: `setPlacement { nodeId, span?, row?,
rowSpan?, column? }` changes a node's width and grid placement — an absent field is unchanged,
`null` clears it (the key is removed, so a cleared node hashes as if it was never placed), and the
placed node is validated through the same node schema as `insertNode`.

`removeProvider { handle }` retires a provider and is refused (`provider-still-bound`) while any
node, at any depth, still binds the handle.

`setTitle { nodeId, title }` sets a container's heading (`null` clears it; a semantic node is
`not-container` — its heading is its label).

`setRole { nodeId, role }` sets a container's role (`null` clears it and removes the key, so the
container hashes as if it never had one; the root may carry one; a semantic node is `not-container`;
a malformed role is `invalid-operation` against the node).

`interpretAction` admits `setPlacement` and `setTitle` on non-root nodes (resizing a widget and
renaming a section are direct manipulation, like `moveNode` and `setLabel`), refuses both provider
ops (`provider-op-not-interactive`), and refuses `setRole` (`role-op-not-interactive`: a role picks
which of the app's container renderers draws a section — presentation structure, like a container's
direction, which no op changes — and changing it remounts the container and discards its chrome
state). A widget's `insertNode` may still insert a container that already carries a role — harmless,
since a new container has no chrome state to lose.

`moveNode` refuses to carry a placed node out of a grid (`placement-outside-grid`) or into one it
overflows (`placement-out-of-range`): clear it first with `setPlacement { nodeId, row: null, column:
null, rowSpan: null }`.

A widget resize on a placed node is likewise refused when the new span overflows the grid — the
interactive path never clamps; choose a column and span that fit.

The reference planner applies a revised `span` through `setPlacement` — on a widening revision that
would overflow a placed node it clamps `column` to `GRID_COLUMNS − span + 1` — and ends every plan
with a `removeProvider` for each handle its own removals or rebinds orphaned (`orphanedProviders`);
a provider the base already held with no binder is left alone.

## Op refusal codes

The complete list of codes `apply` (and so `replay`) can refuse with, by op. Every op:
`invalid-operation` (the op fails the `Operation` schema) and `tree-too-deep` (the base, or the tree
an `insertNode` would produce, nests past `MAX_TREE_DEPTH`). `insertNode`: `duplicate-node-id`,
`missing-parent`, `not-a-container` (the parent), and `placement-outside-grid` /
`placement-out-of-range` for any placed node in the inserted subtree. `removeNode`:
`root-immutable`, `missing-node`. `moveNode`: `root-immutable`, `missing-node`, `not-a-container`
(the destination is absent or not a container), `cyclic-move`, `placement-outside-grid` /
`placement-out-of-range`. `setPlacement`: `root-immutable`, `missing-node`, `empty-placement` (names
no field), `placement-outside-grid`, `invalid-operation` (the placed node fails the node schema),
`placement-out-of-range`. `setTitle`: `missing-node`, `not-container`. `setRole`: `missing-node`,
`not-container`, `invalid-operation` (the roled container fails the node schema — a role that is not
`isLayoutRole`).

`setProps` / `setLabel` / `bindProvider` / `unbindProvider`: `missing-node`, `not-semantic`;
`bindProvider` also `missing-provider` (the handle is not declared: `remapProvider` it first,
earlier in the same list is fine; re-pinning the node's CURRENT handle is not a new bind and is
accepted; `lineage.verify` replays recorded history with `{ legacyBind: true }`, so a version
recorded before this check still verifies, and a new write never gets that leniency);
`unbindProvider` also `not-bound` (the node has no handle binding). `setLabel` with `label: null`
clears the label.

`remapProvider`: `handle-mismatch` (`spec.handle` ≠ `handle`). `removeProvider`: `missing-provider`,
`provider-still-bound`.

`declassifyHandle`: `declassify-not-allowed` (the call did not pass `{ allowDeclassify: true }`; it
lowers a sticky class and is trusted-caller-only).

`prompt`: whatever its `materialized` ops return, and `declassify-in-prompt` when any of them (at
any nesting) is a `declassifyHandle`.

`applyAt` only: `stale-base-version` (the op declares a base version that is not the artifact it is
applied to).

Note `not-container` (`setTitle` / `setRole` on a semantic node) is a different code from
`not-a-container` (an `insertNode` / `moveNode` parent that is not a container).
`validateExperience` still reports a binder with no provider as `unknown-handle` (`apply` checks
`bindProvider` only, not the handle of an `insertNode`d node).

## Compile's title option

By default the compiled Blueprint's `title` is `exp.intent.objective` verbatim — the free-text
objective the experience was composed to satisfy, unchanged since the first compile.

That default is convenient, but the objective sits inside the experience's content hash and can be
private (the composer's own request, not something meant for every later viewer), and an app with
its own renamable, localizable display title has no way to use it. `compile(exp, { ..., title })`
overrides it: a `LocalizedText` resolves through `resolveLabel` exactly like a container title or a
node label (same resolver, same locale, same fallback text), and `{ omit: true }` drops the
objective entirely — loom's `Blueprint.title` is a required string, so this compiles to `""`, which
every renderer already treats as untitled (`renderBlueprintDom`'s `"heading"` mode mounts an empty
`<h1>`; its `"none"` mode, below, mounts none at all).

Leaving `title` unset is unchanged and byte-identical to every prior compile.
