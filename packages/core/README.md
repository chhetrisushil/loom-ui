# @loom-ui/core

The Experience Model: the composed node tree, the operations that edit it with deterministic
replay, the semantic catalogue a planner is allowed to name, the compiler that turns a composed
Experience into a loom `Blueprint`, and a `./log` subpath for content-addressed persistence. It
sits at the root of the loom-ui pipeline — an app (or a planner, via `@loom-ui/planner`) composes
an Experience here; `@loom-ui/hydration` resolves the handles it binds; `@loom-ui/renderer-lit`
and `@loom-ui/renderer-terminal` draw the `Blueprint` this package compiles. `@loom-ui/core` is
pure and isomorphic (no Node APIs) except for `./log`, which touches content hashing.

## Install / import

```
pnpm add @loom-ui/core
```

```ts
import { genesis, apply, compile } from "@loom-ui/core";
import { putExperience, EXPERIENCE_COMPOSED } from "@loom-ui/core/log";
```

## Key concepts

- **Experience** — the composed artifact: `{ experienceId, versionHash, parents, intent, root,
  providers, vocabularyFloor, meta }`. `root` is an `ExperienceNode` tree; `intent` (`objective`,
  `source`, optional `constraints`) is inside the content hash and no operation changes it.
- **Node kinds.** A `ContainerNode` (`direction: "row" | "column" | "grid"`, `span`, optional
  `row`/`rowSpan`/`column` placement in its own parent grid, optional `title`, optional `role`,
  `children`) or a `SemanticNode` (a catalogue `type`/`typeVersion`, `span`/placement, optional
  `label`, `props`, optional `binding: { handle, priority, sensitivity? }`). Both carry a stable
  `id` (minted once, never reused) and a fractional `order` key.
- **Semantic catalogue.** What a planner (or a caller) may NAME — closed at runtime. A
  `SemanticEntry` declares its allowed `props`, whether it binds data (`binding`), which props
  carry display text (`textProps`), who may set a binding's `sensitivity`, and how each `Surface`
  (`"web" | "terminal" | "chat"`) resolves it: to a loom widget kind, or a degrade to another
  entry.
- **Operations.** An `Operation` is one of `insertNode`, `removeNode`, `moveNode`, `setProps`,
  `setLabel`, `setTitle`, `setRole`, `setPlacement`, `bindProvider`, `remapProvider`,
  `removeProvider`, `prompt`. `apply`/`replay` are deterministic and never throw on bad input —
  every refusal is a typed `Finding` (the full code list is in the root README's "Op refusal
  codes").
- **Compile.** `compile(exp, opts)` turns a sealed or unsealed Experience into a loom `Blueprint`
  for one surface, resolving every semantic node through the catalogue and validating as it goes.
- **Content log (`./log`).** Composition is an event, not a database row: `seal`/`mintVersionHash`
  mint a content address over the artifact (parsed, then canonicalised), `putExperience` /
  `getExperience` round-trip it through loom's `ContentStore`, and an app emits
  `EXPERIENCE_COMPOSED` from inside a loom execution — a userspace event the kernel's fold skips.

## API

### Building and editing

- `genesis(input: GenesisInput): Experience` — a fresh, unpersisted lineage. `root` defaults to an
  empty 12-column `grid` (`GRID_COLUMNS`) so a child's `span` always lands in a cell (ADR 0097 D5).
  Throws only if a supplied `root` nests past `MAX_TREE_DEPTH` — a programmer error at
  construction time.
- `apply(base: Experience, op: Operation): OpResult<Experience>` — apply one operation;
  `{ ok: true, value }` or `{ ok: false, finding }`.
- `replay(genesis: Experience, ops: readonly Operation[]): OpResult<Experience>` — fold a whole
  operation log; stops at the first refusal.
- `Operation` — the operation's zod schema (the discriminated union documented above).
- `Provenance` — `{ source: "user" | "agent" | "application" | "system", agentId?, modelId?,
  ref? }`: who/what authored an op.
- `RecordedOperation` — `{ op: Operation, by: Provenance, at: string }`: one op as a caller logs
  it, `at` an ISO-8601 string.

### Reading the tree

- `walk`, `findNode`, `nodeIds`, `isContainer`, `treeDepth`, `normalize`, `rebuild` — traversal and
  structural helpers.
- `isPlaced`, `placementOf`, `placementProblems`, `roleProblem`, `GRID_COLUMNS` — grid placement
  and role validity; `placementProblems(node, columns = GRID_COLUMNS)` is width-parametric.
- `Placement` — `Pick<SemanticNode, "row" | "rowSpan" | "column">`, what `placementOf` returns.
- `Priority` — `"P0" | "P1" | "P2"`, a binding's load priority.
- A `ContainerNode` may also carry `gap?: number`, the spacing between its children (alongside
  `direction`, `span`, `row`/`rowSpan`/`column`, `title`, `role`).
- `experienceNodeIds`, `preservesNodes` — the id set an Experience holds, and whether an edit kept
  every id an `IdentityReport` cares about (used by recompose reporting downstream).
- `IdentityFinding` — one dropped-id finding inside an `IdentityReport` (`{ code:
  "dropped-node-id", severity: "error", nodeId, message }`).

### The semantic catalogue

- `defineSemanticCatalog(catalog): SemanticCatalog` — identity function; documents intent at the
  call site.
- `findEntry(catalog, name, version)`, `resolveSurface(catalog, name, version, surface, nodeId?)`,
  `compareVersions(a, b)` — look an entry up, resolve it for one surface (following degrade
  chains), order two dotted versions numerically per segment.
- `checkFloor(exp, floor: VocabularyFloor): Finding[]` — every type/version the floor requires
  that the Experience does not use.
- `validateExperience(exp, catalog, surface): ExperienceValidation` — the full structural +
  catalogue check (duplicate ids, tree depth, placement, roles, unresolved/degraded types); the
  result carries `nodes` (semantic nodes visited) so `ok` over zero nodes is visible, not silent.
- `loomCatalogFor(catalog, surface, base = builtinCatalog)` — maps a `SemanticCatalog` to loom's
  `WidgetCatalog` shape for one surface, for registering against a loom renderer; returns
  `{ catalog, findings }` (`undeclared-kind-contract`, `binding-contract-conflict`,
  `kind-contract-conflict` for a kind outside `base` that conflicts with or omits its own
  contract).
- `KindContract` — `{ kind, props?, binding? }`: the loom widget kind (plus, for a kind outside
  loom's `builtinCatalog`, the contract loom checks against) a `SemanticEntry.surfaces[surface]`
  resolves to.

### Compiling to a Blueprint

- `compile(exp: Experience, opts: CompileOptions): CompileResult` — `{ blueprint, findings, ok }`
  for one surface. `opts.title` overrides the default `exp.intent.objective` (or
  `{ omit: true }` to compile `title: ""`); `opts.registry` turns an unregistered kind into a
  `renderer-coverage` finding; `opts.resolveLabel` resolves a `LocalizedText` (default: its
  fallback text); `opts.baseCatalog` is the loom catalogue built-in kinds resolve against
  (default `builtinCatalog`).
- `hydrationPath`, `hydrationStatusPath`, `HYDRATION_VALUES_PREFIX`, `HYDRATION_STATUS_PREFIX` —
  the compiled projection paths a binding's `values.<handle>` / `status.<handle>` live at.
- `experienceHandles(exp): HandleUse[]` — every bound handle, once, with its highest-priority use
  and the node ids that want it.
- `handleKinds(exp, catalog, surface): Map<string, string[]>` — the widget kinds each bound handle
  feeds on one surface; what an `outputCheck: "contract"` provider is checked against.

### Framework kinds and number formatting

- `FRAMEWORK_KINDS` — the eight kinds this package adds beside loom's built-ins: `TimeSeries`,
  `BarChart`, `Kpi`, `Table`, `StatusCard`, `Note`, `A2UIView`, `SandboxView`.
- `kindValueContracts`, `kindValueContract(kind)`, `checkKindValue(kind, value)` — the zod
  contract per kind (loom's built-ins included) and the check a renderer runs before drawing a
  value; `undefined` (not hydrated yet) or an unknown kind always passes.
- `TimeSeriesValue`, `BarChartValue`, `KpiValue`, `TableValue`, `TableColumn`, `TableCell`,
  `StatusCardValue`, `StatusLevel`, `ChartAxis` — the value shapes; `tableColumnLabel(column)` /
  `tableColumnFormat(column)` read a `TableColumn` regardless of its string-or-object form.
- `SemanticFormat`, `effectiveFormat`, `formatFromUnit`, `formatSemanticNumber`,
  `semanticNumberFormatOptions`, `unitSuffix`, `deltaDirection`, `DELTA_FORMAT` — what a bound
  number MEANS (`number` / `integer` / `decimal` / `percentage` / `currency`, with `notation` and
  fraction-digit bounds) and how every renderer formats, rounds and suffixes it identically.

### Content log (`@loom-ui/core/log`)

- `mintVersionHash(exp)`, `seal(exp)` — the content address (parse, then canonicalise) and the
  sealed Experience carrying it.
- `putExperience(store, exp)`, `getExperience(store, ref)` — total round-trip through a loom
  `ContentStore`; both report a `Finding` (`artifact-unhashable`, `artifact-missing`,
  `artifact-invalid`, `artifact-tampered`) instead of throwing on bad input.
- `EXPERIENCE_COMPOSED`, `ExperienceComposedPayload` — the userspace event name and
  `{ ref, parents, ops }` payload an app emits after `putExperience`, from inside a loom
  execution.
- `decodeValue`, `encodeValue` — the content codec, re-exported so a caller inspecting a stored
  blob by hand uses the same pair.

### Ordering

- `orderKeyBetween(a, b)` — a fractional order key strictly between `a` and `b` (either `null` for
  ±∞); `orderKeyAfterAll(siblings: ReadonlyArray<{ order: string }>)` — the key that sorts after
  every sibling, for an append. Order keys (`ExperienceNode.order`) let concurrent inserts never
  collide.

## Examples

Composing and compiling an Experience (illustrative — not a compiling snippet: it elides a real
catalogue):

```ts
import { apply, compile, genesis } from "@loom-ui/core";

let exp = genesis({
  experienceId: "checkout-triage",
  intent: { objective: "Investigate checkout latency", source: "user" },
  meta: { author: "user:alice", createdAt: new Date().toISOString(), sourceKind: "manual" },
});

const r = apply(exp, {
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
});
if (!r.ok) throw new Error(r.finding.message);
exp = r.value;

const { blueprint, findings, ok } = compile(exp, {
  surface: "web",
  catalog,
  hydrationProjectionId: "loom-ui.hydration",
  hydrationProjectionVersion: "1.1.0",
});
```

Persisting the sealed artifact (illustrative — inside a loom execution):

```ts
import { EXPERIENCE_COMPOSED, putExperience } from "@loom-ui/core/log";

const put = await putExperience(contentStore, exp);
if (!put.ok) throw new Error(put.finding.message);
ctx.emit(EXPERIENCE_COMPOSED, {
  ref: put.ref,
  parents: put.experience.parents,
  ops: [{ op, by: { source: "user" }, at: new Date().toISOString() }],
});
```

## Notable behaviours and guarantees

- **Deterministic replay.** The same base plus the same ops always fold to a byte-identical
  Experience; `apply`/`replay` report every rejection as a `Finding`, never a thrown exception, so
  a stored log always tells you why it stopped replaying.
- **Runtime-closed catalogue.** A planner or caller can only name what `SemanticCatalog` declares;
  `resolveSurface` following a degrade chain is the only widening. An unresolved or degraded type
  is a `validateExperience` finding, not a compile-time failure — the Blueprint still compiles, so
  a caller can degrade gracefully.
- **Content-hash stability.** Fields with no default (`row`, `rowSpan`, `column`, a container's
  `title`/`role`, `MCPToolNode.overridable`, `ProviderSpec.outputCheck`) add nothing to the hashed
  artifact when absent — an Experience that never used a capability keeps its `versionHash` across
  a version that adds it.
- **Placement is strict where span is lenient.** `span` applies only under a `grid` parent and is
  silently dropped under `row`/`column` (ADR 0097 D5, no finding). `row`/`rowSpan`/`column` are
  stricter: the wrong parent or an out-of-range column is a hard `placement-outside-grid` /
  `placement-out-of-range` refusal from `apply`/`insertNode`/`moveNode`/`setPlacement` — never
  silently dropped.
- **One spelling of a role.** A container's `role` is checked against loom's own `isLayoutRole`
  (exported here as `LayoutRole`) — never re-implemented. A malformed role already in stored data
  is a warn (`role-invalid`), and `compile` leaves it off rather than refusing to compile.
- **Totality at the storage boundary.** `putExperience`/`getExperience` catch every hashing or
  parsing failure and return a `Finding`; a corrupted or tampered blob is diagnosable data, not a
  crash.

## See also

- [../hydration/README.md](../hydration/README.md) — resolves the provider handles a compiled
  Blueprint binds.
- [../planner/README.md](../planner/README.md) — composes and revises the Experience this package
  models.
- [../renderer-lit/README.md](../renderer-lit/README.md) and
  [../renderer-terminal/README.md](../renderer-terminal/README.md) — draw the compiled Blueprint.
- [../../README.md](../../README.md) — root overview.
