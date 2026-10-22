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

The data kinds below carry the charts, tables and status shapes. They exist because these shapes
conflict with loom's `MetricCard` (a number), `DataTable` (records) and `StatusBadge` (a string),
whose contracts loom's React renderers depend on and which are never widened.

| Kind | Value type and notes |
| --- | --- |
| `TimeSeries` | `TimeSeriesValue`. A series may carry `format` and `axis` (`ChartAxis`, `"left"` or `"right"`); `lu-timeseries` draws a second y-axis, and marks a right-hand series "(R)" only when some series is on the left (all-right shares one axis). |
| `BarChart` | `BarChartValue`, with a value-level `format`. |
| `Kpi` | `KpiValue`: `{ value, unit?, format?, label?, deltaPct? }`. `label` is a caption shown beside the widget title, never in its place, and is spoken and printed with it. `deltaPct` is a fraction drawn as an up or down triangle to one decimal via `DELTA_FORMAT`. |
| `Table` | `TableValue`: `{ columns: TableColumn[], rows: TableCell[][] }`. A `TableColumn` is a string or `{ label, format? }`, read through `tableColumnLabel` and `tableColumnFormat`; a `TableCell` is a string, number or `null`. Text sorts in the formatting locale. Optional `rowKeys` (one stable key per row) and `rowActions` (at most 4 per row: `{ id, label, primary?, destructive? }`; needs `rowKeys`) draw a trailing actions cell, one named button per action, and the `primary` one in the first cell; each emits `TABLE_ROW_ACTION { action, rowKey }` through `onAction` (buttons are disabled with no handler). A value that breaks a rule is refused by `checkKindValue`. |
| `StatusCard` | `StatusCardValue`: `{ level: StatusLevel, headline, detail? }`, where `StatusLevel` is `"ok"`, `"warning"` or `"critical"`. Announced through `role="status" aria-live="polite"`. |
| `Note` | Static text from its `text` prop; never bound. |
| `A2UIView`, `SandboxView` | Mount `lu-a2ui-view` / `lu-sandbox` with the declared `view` / `code` prop and the bound value as data. |

The media and conversation kinds (`Image`, `Audio`, `Video`, `File`, `MediaInput`, `Chat`,
`TextInput`, `FormInput`, `SelectInput`) are also in `FRAMEWORK_KINDS`; their value contracts are
described in the [`@loom-ui/core` README](../../packages/core/README.md) under "Media" and "Chat and
inputs". `SelectInput` is the one input that may bind (optionally): the bound value is its current
choice, shown only when it is a declared option.

An app declares a framework kind on a semantic entry's `surfaces.web` by copying its contract from
`frameworkKindContracts`.

A catalogue entry's `textProps` names the props that carry display text; a `LocalizedText` there is
resolved at compile through `resolveLabel`, exactly like a node label, so a Blueprint never carries
a message key. Any other shape in a text prop is a `text-prop-shape` finding.

## Number semantics

`SemanticFormat` describes what the renderers honour, and nothing more: `semanticType` is one of
`number`, `integer`, `decimal`, `percentage`, `currency` (with its ISO 4217 `currency` code,
required — a code-less currency is refused, never assumed), plus optional `notation` (`standard` /
`compact`) and `minimumFractionDigits` / `maximumFractionDigits` (0–20, min ≤ max; an `integer`
takes none — fraction digits on it are refused, not coerced).

A consumer with richer semantics (dates, durations, measurements) maps them onto these at its own
boundary; extra keys in a payload are tolerated and ignored. Numbers read their semantics in the
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
