# Catalogue and widget reference

The shape of a semantic catalogue and of every widget kind loom-ui draws. Everything here is read
from the code: `packages/core/src/catalog.ts`, the value contracts (`values.ts`, `kindValues.ts` and
the shared rule modules they call) and the renderer registries
(`packages/renderer-lit/src/dom/litRegistry.ts`, `packages/renderer-terminal/src/registry.ts`). The
topics that have their own depth are linked, not repeated: [Number semantics](composition.md#number-semantics),
[Time semantics](composition.md#time-semantics), [Diagrams](composition.md#diagrams) and
[Source references](composition.md#source-references).

## Contents

- [The catalogue](#the-catalogue)
- [Entry fields](#entry-fields)
- [Surface resolutions](#surface-resolutions)
- [resolveSurface](#resolvesurface)
- [validateExperience and its findings](#validateexperience-and-its-findings)
- [frameworkKindContracts and the other kind contracts](#frameworkkindcontracts-and-the-other-kind-contracts)
- [Kinds at a glance](#kinds-at-a-glance)
- [Data kinds](#data-kinds)
- [Text kinds](#text-kinds)
- [Embedded views](#embedded-views)
- [Media kinds](#media-kinds)
- [Conversation and input kinds](#conversation-and-input-kinds)
- [loom's built-in kinds](#looms-built-in-kinds)
- [Cross-cutting rules](#cross-cutting-rules)
- [Actions](#actions)

## The catalogue

A semantic catalogue is the closed vocabulary an experience may use. Each entry is something a
planner (or your code) may NAME: it declares the props the type accepts, whether it renders bound
data, and, per surface, which loom widget kind draws it there. Nothing outside it can be composed;
a node naming an unknown entry is an `unknown-type` finding. The catalogue is extensible when you
build it and closed at run time.

`defineSemanticCatalog` (`@loomwork/ui-core`) returns its argument unchanged and only types it. The
example below is a complete minimal catalogue: a `Metric` drawn as a `Kpi`, a `Gauge` that degrades
to `Metric` on the terminal, and a `Remark` drawn as a `Note`.

<!-- snippet: imports in catalogue.test.ts -->

```ts
import {
  type SemanticCatalog,
  apply,
  defineSemanticCatalog,
  genesis,
  resolveSurface,
  validateExperience,
} from "@loomwork/ui-core";
import { frameworkKindContracts } from "@loomwork/ui-renderer-lit/dom";
```

<!-- snippet: catalogue in catalogue.test.ts -->

```ts
// A framework kind's loom contract, copied from `frameworkKindContracts` (the one declaration).
const contractOf = (kind: string) => {
  const found = frameworkKindContracts.find((c) => c.kind === kind);
  if (found === undefined) throw new Error(`no contract for ${kind}`);
  return found;
};

const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.ops.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: { web: contractOf("Kpi"), terminal: contractOf("Kpi") },
    },
    {
      // The same widget under a second name; on the terminal it is drawn as a Metric.
      name: "Gauge",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: {
        web: contractOf("Kpi"),
        terminal: { degradeTo: { name: "Metric", version: "1.0.0" } },
      },
    },
    {
      name: "Remark",
      version: "1.0.0",
      props: ["text"],
      textProps: ["text"], // a string or { key, fallback }, resolved at compile
      binding: "none",
      surfaces: { web: contractOf("Note"), terminal: contractOf("Note") },
    },
  ],
});
```

A catalogue is `SemanticCatalog`:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | `string` | yes | Names the catalogue in findings and in the derived loom catalogue (`<id>/<surface>`). |
| `entries` | `SemanticEntry[]` | yes | The vocabulary. An entry is found by exactly `name` and `version`. |
| `valueContracts` | `ContractRegistry` | no | Value contracts for kinds THIS catalogue introduces, by kind (see [below](#frameworkkindcontracts-and-the-other-kind-contracts)). |

## Entry fields

A semantic NODE carries `type` and `typeVersion`; the catalogue entry it names carries `name` and
`version`. The two pairs must be equal for the node to resolve.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `name` | `string` | yes | The node's `type`. |
| `version` | `string` | yes | The node's `typeVersion`. Versions compare as dotted numbers (`compareVersions`: `1.2.0 < 1.10.0`); a non-numeric segment compares as a string. |
| `props` | `string[]` | yes | An allow-list of prop names a node may carry. `[]` is a valid answer (no props); leaving it out is not. A prop outside it is `undeclared-prop`. |
| `binding` | `"required"` \| `"optional"` \| `"none"` | yes | Whether the type renders bound data. `required` with no binding is `missing-binding`; `none` with one is `unexpected-binding`. A node binds a handle OR a projection, never both (`binding-conflict`). |
| `textProps` | `string[]` | no | Props whose value is display text: a string or a `LocalizedText` `{ key, fallback }` (`key` non-empty). `compile` resolves it through `resolveLabel` so a Blueprint never carries a message key. Any other shape is `text-prop-shape`. |
| `sensitivity` | `"caller"` \| `"model-may-set"` | no | Who may set a binding's confidentiality class on a node of this type: the caller composing it (default) or a planner. Declarative only. |
| `surfaces` | `Partial<Record<Surface, SurfaceResolution>>` | yes | Per surface, how the entry is drawn. May be empty, but then every node of the type is `unresolvable-on-surface`. |

A `Surface` is any non-empty string. `WELL_KNOWN_SURFACES` is `["web", "terminal"]`: the two with
first-party renderers (`@loomwork/ui-renderer-lit`, `@loomwork/ui-renderer-terminal`). Any other name
(`"voice"`, `"native"`) is the host's own modality; the framework only uses it as the key
`resolveSurface` looks up.

`chatCatalogEntries()` (`@loomwork/ui-core/chat`) and `mediaCatalogEntries()` (`@loomwork/ui-core/media`)
return ready-made entries for the chat, input and media kinds (versions `1.1.0` and `1.0.0`), each
resolving to the framework kind on `web` and `terminal` by default; splice them into `entries`.
A planner is offered those kinds only if they are in the catalogue.

## Surface resolutions

A `SurfaceResolution` is one of two things.

- **A kind**, `KindContract`: `{ kind, props?, binding? }`. `kind` is the loom widget kind that draws
  the entry on this surface. A kind loom's own `builtinCatalog` already knows (`MetricCard`,
  `DataTable`, `StatusBadge`, ...) takes its contract from there. Any other kind, including every
  framework kind, must declare BOTH `props` (what loom may pass to the widget) and `binding`, or
  `compile` reports `undeclared-kind-contract` and omits the node.
- **A degrade**, `{ degradeTo: { name, version } }`: draw this entry as another entry on this
  surface. Chains are followed; a loop is `degrade-cycle`. When a degrade lands on a kind that cannot
  render a prop the original type declares, `compile` drops the prop and reports `prop-not-rendered`.

An entry's own `binding` and its resolved kind's `binding` must not contradict (`required` against
`none`): that is `binding-contract-conflict`, reported once per catalogue by `compile`. Two entries
that resolve to one kind with different `props` or `binding` are `kind-contract-conflict`.

## resolveSurface

`resolveSurface(catalog, name, version, surface, nodeId?)` follows degrade chains and is
deterministic. It returns `{ ok: true, kind, contract, entry, via }` (`via` lists every
`name@version` visited, in order) or `{ ok: false, finding }`.

<!-- snippet: resolve in catalogue.test.ts -->

```ts
const gauge = resolveSurface(catalog, "Gauge", "1.0.0", "terminal");
if (gauge.ok) {
  gauge.kind; // "Kpi"
  gauge.via; // ["Gauge@1.0.0", "Metric@1.0.0"]
}
const missing = resolveSurface(catalog, "Gauge", "1.0.0", "voice");
if (!missing.ok) missing.finding.code; // "unresolvable-on-surface"
```

Its findings are `unknown-type` (no such `name@version`), `unresolvable-on-surface` (the entry has no
resolution on that surface) and `degrade-cycle`.

## validateExperience and its findings

`validateExperience(experience, catalog, surface, options?)` checks an experience against a
catalogue and reports; it never repairs. It returns `{ ok, findings, nodes }`: `ok` is true when no
finding is an `error`, and `nodes` is the number of semantic nodes visited (an `ok` over zero nodes
proves nothing). `compile` runs it for you.

<!-- snippet: validate in catalogue.test.ts -->

```ts
const start = genesis({
  experienceId: "catalogue-demo",
  intent: { objective: "Show latency", source: "user" },
  meta,
});
const inserted = apply(start, {
  type: "insertNode",
  parentId: "root",
  node: {
    id: "p99",
    order: "V",
    kind: "semantic",
    type: "Metric",
    typeVersion: "1.0.0",
    span: 6,
    props: { unit: "ms", colour: "red" }, // `colour` is not declared by the entry
    binding: { handle: "latency", priority: "P0" }, // no provider declares `latency`
  },
});
if (!inserted.ok) throw new Error(inserted.finding.message);

const result = validateExperience(inserted.value, catalog, "web");
result.findings.map((f) => `${f.severity} ${f.code}`);
// ["warn unknown-handle", "error undeclared-prop"]
```

`options.contentRefArgs` is the table of marked content-reference argument paths per tool (from the
planner's `contentRefArgsFrom`); without it only the `media-arg-suspect` hint runs.

Every code it can report (a `Finding` is `{ code, severity, message, nodeId? }`; branch on the code):

| Code | Severity | Reported when |
| --- | --- | --- |
| `tree-too-deep` | error | The tree nests past `MAX_TREE_DEPTH` (256). Nothing else is checked. |
| `duplicate-node-id` | error | A node id appears twice. |
| `placement-outside-grid` | error | `row`, `rowSpan` or `column` on a node whose parent is not a `grid` (or the root). |
| `placement-out-of-range` | error | A placement under a grid that does not fit its 12 columns. |
| `grid-line-extreme` | warn | `row` or `rowSpan` past `GRID_LINE_WARN_ABOVE` (1000). |
| `role-invalid` | warn | A container `role` that is not a well-formed layout role. |
| `unknown-handle` | warn | A node binds a handle the experience has no provider for. |
| `unknown-type` | error | `type@typeVersion` is not in the catalogue. No follow-on checks run for the node. |
| `undeclared-prop` | error | A prop the entry does not list. |
| `text-prop-shape` | error | A `textProps` prop that is neither a string nor `{ key, fallback }`. |
| `binding-conflict` | error | A node carries both `binding` and `projection`. |
| `missing-binding` / `unexpected-binding` | error | The binding does not match the entry's `binding` rule. |
| `unresolvable-on-surface` / `degrade-cycle` | error | From `resolveSurface`, see above. |
| `media-prop-forbidden`, `media-literal-ref`, `media-prop-too-long`, `media-embedded-ref`, `media-prop-shape` | error | A media node's props break the framework's allow-list (checked whatever the catalogue declares: a composer cannot author an address, URL or autoplay). |
| `media-unbound` | error | An `Image`, `Audio`, `Video` or `File` node with no binding. |
| `chat-prop-forbidden`, `chat-prop-shape` | error | A chat or input node's props break the framework's allow-list (see [Conversation and input kinds](#conversation-and-input-kinds)). |
| `chat-unbound` | error | A `Chat` node with no binding. |
| `embedded-ref`, `text-too-long-to-scan` | warn | A non-media node's text prop embeds a URL or address, or is over 4096 characters and was not scanned. |
| `output-contract-uncontracted` | error | A handle checked by `outputCheck: "contract"` feeds a kind with no value contract. |
| `floor-violation` | error | The experience's `vocabularyFloor` requires a type (at a version) it does not carry. |
| `provider-step-duplicate`, `provider-cycle`, `provider-template-unknown-step`, `provider-handle-mismatch` | error | Provider-graph integrity. |
| `provider-dependency-unknown` | warn | A step depends on a step the provider does not declare. |
| `contract-overrides-framework` | error | The catalogue's `valueContracts` names a framework kind; the framework's contract is enforced and the entry ignored. |
| `media-arg-literal`, `media-arg-unproven-ref` | error | A literal, or an unproven step reference, at a content-reference argument path. |
| `media-arg-suspect` | warn | Address-shaped text in tool arguments elsewhere. |
| `media-arg-schema-unknown` | error or warn | A tool schema mentions the content-reference marker but cannot be read (error), or cannot be read at all (warn). |

`compile` additionally reports, from the derived loom catalogue: `undeclared-kind-contract`,
`binding-contract-conflict`, `kind-contract-conflict` (errors), `kind-without-contract` (error: the
node is omitted), `prop-not-rendered` (warn), `renderer-coverage` and the redaction findings
documented in the [audience reference](audience.md). See also
[troubleshooting](../guides/troubleshooting.md#compile-findings).

## frameworkKindContracts and the other kind contracts

An entry's `surfaces.web` must declare loom's contract for a kind loom does not know. Each renderer
package exports the contracts for the kinds it draws; copy the one you need rather than re-spelling
it:

| Export | Entry | Kinds |
| --- | --- | --- |
| `frameworkKindContracts` | `@loomwork/ui-renderer-lit` (and `/dom`) | `TimeSeries`, `BarChart`, `Kpi`, `Table`, `StatusCard`, `Note`, `Prose`, `A2UIView`, `SandboxView` |
| `diagramKindContracts` | `@loomwork/ui-renderer-lit/diagram` | `Diagram` |
| `mediaKindContracts` | `@loomwork/ui-renderer-lit/media` | `Image`, `Audio`, `Video`, `File`, `MediaInput` |
| `chatKindContracts` | `@loomwork/ui-renderer-lit/chat` | `Chat`, `TextInput`, `FormInput`, `SelectInput`, `MultiSelectInput` |

Each item is `{ kind, props, binding }`, exactly the `KindContract` an entry's `surfaces.web` takes
(see `contractOf` above). The `props` are what loom lets reach the widget, so a prop a kind reads
(for example `Kpi`'s `unit`) must be in both the entry's `props` and its resolution's `props`.

`valueContracts` on the catalogue is for kinds of YOUR OWN: a `ValueContract` is anything with a
zod-shaped `safeParse`, plus an optional `description` and `version`. It is host code run on every
bound value; its issue messages must be value-free (they reach the viewer, capped at 200
characters). A framework kind keeps its own contract.

## Kinds at a glance

`FRAMEWORK_KINDS` (`@loomwork/ui-core`) lists the kinds loom-ui adds to loom's. It is an open set that
grows: check that the kinds you draw are present rather than pinning its length. Today: `TimeSeries`,
`BarChart`, `Kpi`, `Table`, `StatusCard`, `Note`, `Prose`, `Diagram`, `A2UIView`, `SandboxView`, the
media kinds `Image`, `Audio`, `Video`, `File` and `MediaInput`, and the chat kinds `Chat`,
`TextInput`, `FormInput`, `SelectInput` and `MultiSelectInput`.

| Kind | Bound? | Value | Lit element | Registered by |
| --- | --- | --- | --- | --- |
| `TimeSeries` | bound | `TimeSeriesValue` | `lu-timeseries` | default registry |
| `BarChart` | bound | `BarChartValue` | `lu-bar-chart` | default registry |
| `Kpi` | bound | `KpiValue` | `lu-kpi` | default registry |
| `Table` | bound | `TableValue` | `lu-table` | default registry |
| `StatusCard` | bound | `StatusCardValue` | `lu-status-card` | default registry |
| `Note` | static | none | `lu-note` | default registry |
| `Prose` | bound | `ProseValue` | `lu-prose` | default registry |
| `Diagram` | bound | `DiagramValue` | `lu-diagram` | `@loomwork/ui-renderer-lit/diagram` |
| `A2UIView` | bound | any JSON | `lu-a2ui-widget` | default registry |
| `SandboxView` | bound | any JSON | `lu-sandbox-widget` | default registry |
| `Image`, `Audio`, `Video`, `File` | bound | `MediaRef` | `lu-image`, `lu-audio`, `lu-video`, `lu-file` | `@loomwork/ui-renderer-lit/media` |
| `MediaInput` | static | none | `lu-media-input` | `@loomwork/ui-renderer-lit/media` |
| `Chat` | bound | `ChatValue` | `lu-chat` | `@loomwork/ui-renderer-lit/chat` |
| `TextInput`, `FormInput` | static | none | `lu-text-input`, `lu-form-input` | `@loomwork/ui-renderer-lit/chat` |
| `SelectInput` | optional | `string` | `lu-select-input` | `@loomwork/ui-renderer-lit/chat` |
| `MultiSelectInput` | bound | `MultiSelectValue` | `lu-multi-select-input` | `@loomwork/ui-renderer-lit/chat` |

"Default registry" is `litRegistry` / `createLitRegistry()`. For a kind with an opt-in entry the
default registry draws a fixed placeholder (`lu-media-missing`, `lu-chat-missing`,
`lu-diagram-missing`) until you use `createMediaLitRegistry()`, `createChatLitRegistry()` or
`createDiagramLitRegistry()` (or the matching `register...Widgets(registry)`). Defining the elements
is separate: `import "@loomwork/ui-renderer-lit/register"` defines every one, or import
`@loomwork/ui-renderer-lit/elements/<module>` for just yours (`lu-kpi`, `lu-table`, `lu-media`,
`lu-chat`, `lu-inputs`, `lu-diagram`, ...). The opt-in entries define their own elements when
registered.

On the terminal, `loomUiTerminalRegistry` (and `terminalRegistry`, which merges it over loom's) draws
every kind in the list; the per-kind output is given below. A "bound" kind reads its value from
`values.<handle>`; a "static" kind is never bound (a value reaching it is a defect and the widget
shows the error state).

Values below are JSON-shaped. "Optional" fields may be absent; every object is non-strict unless it
says "no other field" (an unrecognised field is then refused).

## Data kinds

### TimeSeries

Bound, `TimeSeriesValue`.

| Field | Type | Notes |
| --- | --- | --- |
| `series` | array, required | Each: `label` (string), `points` (array of `{ timestamp: string, value: number }`) required; `unit` (string), `format` (`SemanticFormat`), `axis` (`"left"` \| `"right"`) optional. |
| `timeFormat` | `{ granularity, timeZone? }`, optional | How the time axis reads ([Time semantics](composition.md#time-semantics)): `granularity` is one of `year`, `half`, `quarter`, `month`, `week`, `day`, `datetime`; `timeZone` a zone `Intl.DateTimeFormat` accepts. |
| `refs` | `WidgetRefs`, optional | See [Cross-cutting rules](#cross-cutting-rules). |

Props read by `lu-timeseries` (declared by `frameworkKindContracts`): `unit`, `format`, `timeFormat`.
They are fallbacks: a series' own `format`/`unit`, then the widget's. The axis reads the value's
`timeFormat`, then the prop (a malformed prop is ignored), then the label inferred from the
timestamps. A series on the `right` axis gets its own scale only when another series is on the left.
Terminal: the title, then one line per series: its label (a right-axis series is marked `(R)` when the
axes are split), a sparkline, and the last value formatted.

```json
{
  "timeFormat": { "granularity": "day" },
  "series": [
    { "label": "p99", "unit": "ms", "points": [
      { "timestamp": "2026-01-01", "value": 410 },
      { "timestamp": "2026-01-02", "value": 388 }
    ] }
  ]
}
```

### BarChart

Bound, `BarChartValue`: `bars` (array of `{ label: string, value: number }`, required), `unit` (string),
`format` (`SemanticFormat`), `refs`. Props: `unit`, `format` (the value's own win). Terminal: one
line per bar: label (12 columns), a 20-cell bar scaled to the largest absolute value, the value.

```json
{ "unit": "req", "bars": [{ "label": "web", "value": 120 }, { "label": "api", "value": 340 }] }
```

### Kpi

Bound, `KpiValue`.

| Field | Type | Notes |
| --- | --- | --- |
| `value` | number, required | |
| `unit` | string | A legacy suffix; `format` supersedes it. |
| `format` | `SemanticFormat` | See [Number semantics](composition.md#number-semantics): `semanticType` (`number`, `integer`, `decimal`, `percentage`, `currency`), `currency` (ISO 4217, required for `currency`), `notation` (`standard`, `compact`), `minimumFractionDigits` / `maximumFractionDigits` (integers 0 to 20, min not above max; an `integer` takes none). |
| `label` | string | A caption beside the widget title, never in its place. |
| `deltaPct` | number or `null` | A FRACTION (`0.12` is +12%), drawn as an up or down marker to one decimal. `null` or absent: no comparison. |
| `refs` | `WidgetRefs` | |

Props: `unit`, `format`. Terminal: `Title (label): 412.4 ms  ▲ 12%`.

```json
{ "value": 412.4, "unit": "ms", "label": "last hour", "deltaPct": -0.04 }
```

### Table

Bound, `TableValue`.

| Field | Type | Limits and notes |
| --- | --- | --- |
| `columns` | array, required | Each a string, or `{ label: string, format?: SemanticFormat }` (numbers in that column use it). |
| `rows` | array of arrays, required | Each cell: string, number, `null`, or a token cell `{ tokens: { id, label }[] }`. Cells are matched to columns by position. |
| `rowKeys` | string[] | One per row, each `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`, unique. |
| `rowActions` | array of arrays | One list per row (so the same length as `rows`); needs `rowKeys`. At most `MAX_ROW_ACTIONS` (4) per row; an action is `{ id, label, primary?, destructive? }`: `id` matches `[a-z][a-z0-9-]{0,31}` and is unique in the row, `label` is 1 to 40 characters, at most one `primary` per row, a `destructive` one cannot be `primary`. |
| `refs` | `WidgetRefs` | |

Token cells: at most `MAX_CELL_TOKENS` (20) tokens, ids like row keys and unique within the cell,
each label 1 to `MAX_TOKEN_LABEL` (80) characters of plain text (never parsed as markup), and no
field other than `tokens` on the cell or other than `id` and `label` on a token. Over a cap the
value is refused, not cut. `tableCellText(cell)` reads any cell as text (a token cell is its labels
joined with `, `; `null` is empty).

Props: none. Lit: sortable columns (numeric-aware; text sorts in the formatting locale), 200 rows at
a time behind a "show more" button (windowed instead with `virtualize`), token chips as buttons, one
button per row action, the `primary` one in the first cell; buttons are disabled with no `onAction`.
Terminal: a header and at most 20 rows (`… N more rows` after), each column at most 24 characters
wide; a token cell prints its labels joined with `, `.

```json
{
  "columns": ["Service", { "label": "Errors", "format": { "semanticType": "integer" } }, "Owners"],
  "rows": [["api", 12, { "tokens": [{ "id": "ana", "label": "Ana" }, { "id": "ben", "label": "Ben" }] }]],
  "rowKeys": ["svc-api"],
  "rowActions": [[{ "id": "restart", "label": "Restart", "destructive": true }]]
}
```

### StatusCard

Bound, `StatusCardValue`: `level` (`"ok"` \| `"warning"` \| `"critical"`, required), `headline`
(string, required), `detail` (string), `refs`. No props. Announced through `role="status"`.
Terminal: `Title: [ok] headline — detail` (the level word is a catalogue message).

```json
{ "level": "warning", "headline": "Queue is backing up", "detail": "p99 above target for 10 minutes" }
```

### Diagram

Bound, `DiagramValue`, drawn only by the opt-in entry (`@loomwork/ui-renderer-lit/diagram`; without it
`lu-diagram-missing` is drawn). Full rules and the reshaping advice are in
[Diagrams](composition.md#diagrams).

| Field | Type | Limits |
| --- | --- | --- |
| `layout` | `"tree"` \| `"flow"` \| `"timeline"` \| `"network"`, required | |
| `nodes` | array, required | 1 to `MAX_DIAGRAM_NODES` (200). Each: `id` (non-empty, unique), `label` required; `kind`, `group`, `at` (a date `Date.parse` accepts; required for every node of a `timeline`) optional. |
| `edges` | array, required | At most `MAX_DIAGRAM_EDGES` (400). Each: `from`, `to` (existing node ids) required; `label`, `kind` optional. A `tree` has one root, one parent per node, no self-edge and no cycle. |
| `title` | string | |
| `timeFormat` | `TimeFormat` | Labels a timeline's dates. |
| `refs` | `WidgetRefs` | |

Props: `timeFormat` (a fallback for a value that declares none). Terminal: the title, the value's
`title`, then the shared outline (`diagramOutline`) one line per entry.

```json
{
  "layout": "flow",
  "nodes": [{ "id": "build", "label": "Build" }, { "id": "test", "label": "Test" }],
  "edges": [{ "from": "build", "to": "test", "label": "on green" }]
}
```

## Text kinds

### Note

Static. Text comes from the `text` prop, which `frameworkKindContracts` declares (`props: ["text"]`).
Declare `textProps: ["text"]` on the entry so a `LocalizedText` is resolved at compile; an uncompiled
one shows its `fallback`, never its key. A `Note` is also what a restricted node becomes for a viewer
(`Restricted`). Terminal: `Title: text`, or the text alone with no title. No value, no actions.

### Prose

Bound, `ProseValue`: a long document drawn block by block.

| Field | Type | Notes |
| --- | --- | --- |
| `format` | `"markdown"` \| `"org"` \| `"plain"`, required | Markdown and org go through the parsers in `@loomwork/ui-core/document`; HTML is never interpreted. |
| `text` | string, required | Over `MD_DOC_MAX_TEXT` (1,048,576 characters) it is cut and says so. |
| `truncated` | boolean | The source already cut the text; the widget says so. |
| `focus` | `{ from, to }` | Non-negative integer character offsets into `text`; that range is marked and scrolled into view. |
| `note` | string | A line shown above the document. |

No props. Lit: 300 blocks at a time behind a "show more" button (a `focus` pages far enough to show
it). Terminal: the note, then the document as plain lines (up to `MD_MAX_LINES`), then a cut notice.

```json
{ "format": "markdown", "text": "# Runbook\n\n1. Page the owner\n2. Roll back", "focus": { "from": 10, "to": 28 } }
```

## Embedded views

### A2UIView

Bound; the bound value is any JSON, used as the data model the view's bindings resolve against.
Prop `view` (declared by `frameworkKindContracts`): `{ catalogId?, nodes: A2UINode[] }`, an
adjacency list with exactly one node `id: "root"`. Lit mounts `lu-a2ui-widget`, which wraps
`lu-a2ui-view`. A `Button` in the view emits `A2UI_ACTION` (see [Actions](#actions)). Terminal: a
fixed line saying the view is a web surface.

### SandboxView

Bound; the bound value is any JSON handed to the component as data. Prop `code` (declared by
`frameworkKindContracts`): untrusted render code, run in a sandboxed iframe
(`sandbox="allow-scripts"`, no same-origin) by `lu-sandbox-widget`. The component's action message
emits `SANDBOX_ACTION`. Terminal: a fixed line saying the component is a web surface.

## Media kinds

Media is claim-checked by ADDRESS: the value is a `MediaRef`, never bytes, and a host-supplied
resolver turns it into a viewer-scoped URL. Opt-in entry `@loomwork/ui-renderer-lit/media`. The full
host seams (`MediaResolver`, `MediaPolicy`, upload) are in the
[`@loomwork/ui-core` README](../../packages/core/README.md).

### Image, Audio, Video, File

Bound, `MediaRef`, strict (no other field).

| Field | Type | Limits |
| --- | --- | --- |
| `address` | string, required | An opaque content address, not a URL: 1 to `MAX_ADDRESS_LENGTH` (512) characters from `A-Za-z0-9._~:+=/@-`, no `//`, no leading `/`, no `.` or `..` segment. |
| `mediaType` | string, required | Lower-case `type/subtype`, at most 127 characters; the family must match the kind (`image/*` for `Image`, `audio/*`, `video/*`; `File` takes any). |
| `size` | integer | Bytes, 0 to `MAX_DECLARED_MEDIA_BYTES` (2^40). |
| `name` | string | At most 255 characters. Untrusted text. |
| `alt` | string | At most 1000 characters. Untrusted text. |
| `origin` | `"host"` \| `"tool"` \| `"user"` | A claim; never grants trust. |

Props (allow-list, whatever the catalogue declares): `Image` `alt`, `caption`; the others `caption`.
A prop that is a literal URL or address, or embeds one, is an error. Default size limits per kind:
`Image` 32 MiB, `Audio` 256 MiB, `Video` 2 GiB, `File` 1 GiB (`DEFAULT_MEDIA_MAX_BYTES`, overridden
by the policy). Without a host `media.resolver` a widget draws its unavailable state. Terminal: one
line, `Image 'chart.png' (image/png, 1 KiB) [untrusted] ref#1a2b3c4d`: the description, a trust
marker and the host's `media.link` (re-checked) or a non-reversible tag, never any part of the
address. Emits nothing.

```json
{ "address": "sha256:9f2c1ab4", "mediaType": "image/png", "size": 20480, "name": "latency.png", "alt": "p99 latency, last day" }
```

### MediaInput

Static (an upload control). Props: `accept` (1 to 16 patterns, each `type/subtype` or `type/*`),
`maxBytes` (positive integer), `label`. The widget enforces `accept` and `maxBytes` before handing the
file to the host's `upload` handler; on success it emits `MEDIA_ATTACH` with the stored ref re-stamped
`origin: "user"`. Terminal: a fixed line saying a file upload is a web control.

## Conversation and input kinds

Opt-in entry `@loomwork/ui-renderer-lit/chat`. Entries come from `chatCatalogEntries()`. Props are an
allow-list: a composer can never author transcript content or a value "entered" by a user, so any
other prop (`entries`, `value`, `defaultValue`, `text`, ...) is `chat-prop-forbidden`.
`submitLabel`-style text props are short text (1 to 200 characters, or a `LocalizedText`).

### Chat

Bound, `ChatValue`, no other field. A node with no binding is `chat-unbound`. Props: `emptyText`,
`editable` (boolean; lets the viewer revise their own earlier turns).

| Field | Type | Limits |
| --- | --- | --- |
| `entries` | array, required | At most `MAX_CHAT_ENTRIES` (500), oldest first; ids unique. |
| `viewer` | `{ actor, tenant?, onBehalfOf? }` | Each at most 256 characters; `actor` non-empty. |
| `older` | string | A cursor `<digits>.<digits>`: earlier entries exist. |
| `state` | `"open"` \| `"closed"` | |
| `running` | boolean | A reply is on its way. |
| `mode` | `"owner"` \| `"shared"` | What the source knows about whose turns these are. |
| `refMarkers` | boolean | The source writes `[[id]]` markers in assistant text; only then are they processed. |

An entry: `id` (short identifier), `turn` (positive integer; 0 only for a rejected user message),
`role` (`user`, `assistant`, `system`) and `status` (`complete`, `streaming` (assistant only),
`interrupted`, `failed`, `rejected`, `restricted`) are required; optional `parts` (at most
`MAX_CHAT_PARTS` (32); a part is `{ type: "text", text, format? }` with `text` at most
`MAX_CHAT_TEXT` (65,536) characters and `format` `plain` or `markdown` (assistant entries only), or
`{ type: "media", ref }`; an entry's text is at most twice the part cap in all), `asker`, `cursor`,
`at` (epoch ms), `reason` (a short token such as `rate-limited`; the renderer owns the words),
`errorId` (a correlation id, shown as a reference only), `editOf` (an earlier turn number), `tools`
(at most 16 of `{ name (at most 64 characters), status: "running" | "done" | "failed" }`),
`reasoning` (assistant only: `{ text, kind: "text" | "summary" | "redacted", streaming, truncated?,
status? }`, text at most 65,536) and `refs` (assistant only: at most `MAX_CHAT_REFS` (64) of
`{ id }`, unique). A `restricted` entry carries none of `parts`, `tools`, `reason`, `errorId`,
`editOf`, `reasoning` or `refs`. All chat text is untrusted and drawn as text; markdown is a closed
subset. At most 20 contract issues are reported.

Terminal: the title, then the transcript lines (speaker, status notes, restricted entries as bare
placeholders, media described without an address), with notices for earlier turns, an empty
transcript, a reply in progress and a closed conversation.

```json
{
  "mode": "owner",
  "viewer": { "actor": "ana" },
  "entries": [
    { "id": "t1.user", "turn": 1, "role": "user", "status": "complete", "parts": [{ "type": "text", "text": "Why is checkout slow?" }] },
    { "id": "t1.assistant", "turn": 1, "role": "assistant", "status": "streaming", "parts": [{ "type": "text", "text": "Looking" }] }
  ],
  "running": true
}
```

### TextInput

Static. Props: `label`, `placeholder`, `submitLabel` (text), `multiline` (boolean), `maxChars`
(integer 1 to `MAX_INPUT_CHARS` (32,000)). Emits `SUBMIT_TEXT`. Terminal: a `> label [text input — answer on an interactive surface]`
prompt.

### FormInput

Static. Props: `label`, `submitLabel` (text), `fields`: 1 to `MAX_FORM_FIELDS` (32) of
`{ name, label, type, required?, options?, maxLength?, min?, max? }`: `name` is a letter then
letters, digits or `_` (at most 64) and unique; `label` 1 to 200 characters; `type` is `text`,
`textarea`, `number`, `boolean` or `select`; `options` only for `select` (see below); `maxLength`
(integer 1 to 32,000) only for text and textarea; `min`/`max` only for `number`, `min` not above
`max`; no other key. Emits `SUBMIT_FORM`. Terminal: a prompt and one line per field, `*` for
required.

```json
{ "label": "Report an issue", "fields": [
  { "name": "title", "label": "Title", "type": "text", "required": true, "maxLength": 120 },
  { "name": "severity", "label": "Severity", "type": "select", "options": [{ "value": "low", "label": "Low" }, { "value": "high", "label": "High" }] }
] }
```

(The JSON above is the node's props, not a bound value.)

### SelectInput

Optionally bound. Props: `label`, `placeholder` (text), `size` (`"default"` or `"compact"`),
`options`: 1 to `MAX_OPTIONS` (64) of `{ value, label }`: `value` 1 to 128 characters without control
characters and unique, `label` 1 to 200, no other key. The bound value is the CURRENT choice, a
string shown as chosen only when it is a declared option (an undeclared value chooses nothing and is
never echoed). Emits `SELECT`. Terminal: a prompt and numbered options, the current one marked.

### MultiSelectInput

Bound, `MultiSelectValue`, no other field: `options` (at most `MAX_MULTI_OPTIONS` (500) of
`{ value, label, hint? }`: `value` 1 to 128 characters without control characters, unique; `label` 1
to 200; `hint` 1 to 40), `selected` (at most `MAX_MULTI_SELECTED` (100) values, each one of the
options, unique), `note` (1 to 200 characters). Props: `label`, `emptyLabel`, `placeholder` (text),
`maxSelected` (integer 1 to 100). Lit shows at most 50 unchosen matches at a time. Emits
`SELECT_MANY` with the whole new choice. Terminal: a prompt, the chosen options, `+ N more options`
and the note.

```json
{ "options": [{ "value": "api", "label": "API", "hint": "prod" }, { "value": "web", "label": "Web" }], "selected": ["api"] }
```

## loom's built-in kinds

`litRegistry` also draws loom's own eight kinds, with the same Blueprint contracts as loom's React
renderers (loom-ui never widens them; a different shape is a new framework kind). On the terminal
they print through loom's own registry (`defaultTerminalRegistry`, merged by `terminalRegistry`).

| Kind | Value | Props read | Lit element |
| --- | --- | --- | --- |
| `MetricCard` | number | `unit`, `format` | `lu-metric-card` |
| `StatusBadge` | string | none | `lu-status-badge` |
| `DataTable` | array of records | `columns` (string[]; else the union of keys) | `lu-data-table` |
| `ProgressBar` | number | `max` (positive, default 100) | `lu-progress` |
| `AlertCard` | string | `severity` (`info`, `warning`, `error`, `critical`) | `lu-alert` |
| `StreamingText` | string | `placeholder` | `lu-text` |
| `Timeline` | array | none (entry `{ timestamp?, message?, level? }`) | `lu-list` |
| `ApprovalCard` | any | `approveLabel`, `rejectLabel` | `lu-approval` |

`ApprovalCard` emits `APPROVE` and `REJECT` (see [Actions](#actions)). A `MetricCard` value is a bare
number, so it cannot carry `refs`.

## Cross-cutting rules

**Source references (`refs`).** `Kpi`, `BarChart`, `TimeSeries`, `Table`, `StatusCard` and `Diagram`
values may carry `refs?: { id: string, label?: string }[]` (`WIDGET_REF_KINDS`): at most
`MAX_WIDGET_REFS` (16), each `id` matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}` and unique, each
`label` at most `MAX_WIDGET_REF_LABEL` (200) characters. Widget-level and value-level only. A marker
emits `REF_OPEN`. Details: [Source references](composition.md#source-references).

**`format` and `timeFormat`.** `SemanticFormat` (what a number means) is on `Kpi`, `BarChart`, each
`TimeSeries` series and each `Table` column; `TimeFormat` (how a time reads) is on `TimeSeries` and
`Diagram`. Precedence is the value's own, then the widget prop, then a legacy `unit`.

**When a value breaks its contract.** `checkKindValue(kind, value, contracts?)` (from
`@loomwork/ui-core`, or zod-free from `@loomwork/ui-core/browser`) returns `{ ok: true }` or
`{ ok: false, finding }`, where the finding is `{ code: "value-contract", severity: "error",
message }` and the message reads `value for kind "Table" does not match its contract at rows.0.1:
<reason>` (the path of the first issue, or `<root>`). An `undefined` value ("not hydrated yet") and an
uncontracted kind both pass; `hasKindContract(kind, contracts)` tells them apart. The framework's
contract wins for a framework kind: `contracts` only adds kinds. Messages never echo the value.
A renderer shows the error state, never a blank or a cut value: the Lit widget draws the title and the
finding message (`data-state="error"`), the terminal prints `✗ Title: <message>`. A host
contract is untrusted code: a throw or a malformed answer is a fixed finding (`contract for "X"
threw`), and its messages are cleaned and capped at 200 characters. A Lit widget of a kind with no
contract anywhere renders with `data-unchecked`.

**Status.** A widget also draws the binding's own state (loading, stale, error, empty) from the
Blueprint; an error or empty status takes precedence over the value check.

## Actions

Every widget action reaches `onAction` as `{ type, widgetId, payload }`, stamped by the renderer with
the widget's own id and `viewedVersion` (whatever id an element sends is replaced) (see [rendering](../guides/rendering.md#actions-and-stale-views)). Payloads are
client input: a host validates them. `key` is a client-minted idempotency key (16 to 128 characters
of `A-Za-z0-9_-`).

| Type | Emitted by | Payload |
| --- | --- | --- |
| `REF_OPEN` | A source marker on `Kpi`, `BarChart`, `TimeSeries`, `Table`, `StatusCard`, `Diagram` | `{ refId, n }` (`n` is 1-based) |
| `TABLE_ROW_ACTION` | A `Table` row button | `{ action, rowKey }` |
| `TABLE_TOKEN` | A `Table` token chip | `{ rowKey, tokenId }`, or `{ rowIndex, tokenId }` without `rowKeys` (never both) |
| `SUBMIT_TEXT` | `TextInput` | `{ text, key }` |
| `SUBMIT_FORM` | `FormInput` | `{ values, key }` |
| `SELECT` | `SelectInput` | `{ value, key }` |
| `SELECT_MANY` | `MultiSelectInput` | `{ values, key }` (the whole new choice) |
| `EDIT_TURN` | `Chat` (`editable`) | `{ turn, text, key }` |
| `LOAD_OLDER` | `Chat` | `{ cursor }` (a read; no key) |
| `LOAD_REASONING` | `Chat` | `{ cursor }` (a read; no key) |
| `CHAT_REF_OPEN` | `Chat` | `{ entryId, refId, n }` (a read; no key) |
| `MEDIA_ATTACH` | `MediaInput` | `{ ref }` (a `MediaRef`, `origin: "user"`) |
| `A2UI_ACTION` | `A2UIView` button | `{ action, context? }` |
| `SANDBOX_ACTION` | `SandboxView` | `{ action, context }` |
| `APPROVE` / `REJECT` | `ApprovalCard` | `{ approved: true }` / `{ approved: false }` |

The host may answer an action with an `ActionOutcome` (`{ ok, reason? }`): input widgets keep what the
user typed until they hear `ok`, and a refused answer is shown in a status line. The terminal
renderers print kinds; actions on the terminal come from `interactiveTerminal`. Without an `onAction`
the controls are inert or disabled.
