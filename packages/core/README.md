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
  (an OPEN string — `"web"` and `"terminal"` have first-party renderers, any other name is the
  host's own modality) resolves it: to a loom widget kind, or a degrade to another entry. The
  catalogue's optional `valueContracts` give the host's own kinds a value contract (composed under
  the framework's, which a host cannot override). A host `ValueContract` is untrusted code: a throw
  or malformed return is a fixed-text `value-contract` finding (never the exception), an echoed
  issue message is capped at 200 characters with control characters stripped and MUST be
  value-free, and the host owns its contract's cost. An optional `version` is folded into the
  hydration cache key; a contract without one needs `HydrationCache.invalidate()` after a change.
- **Operations.** An `Operation` is one of `insertNode`, `removeNode`, `moveNode`, `setProps`,
  `setLabel`, `setTitle`, `setRole`, `setPlacement`, `bindProvider`, `declassifyHandle`,
  `remapProvider`, `removeProvider`, `prompt`. `apply`/`replay` are deterministic and never throw on bad input —
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
- `applyAt(base, op, { baseVersion? })` — `apply` with an optimistic-concurrency precondition: when
  `baseVersion` (the `versionHash` the author composed against) is not `base.versionHash`, the op is
  refused with a `stale-base-version` finding and nothing is applied (never a throw); an unsealed
  base cannot be verified and is refused too. No `baseVersion` = no precondition = exactly `apply`
  (last-writer-wins). `apply`/`replay` fold unsealed intermediates and are unchanged, so a recorded
  log replays identically; `RecordedOperation.baseVersion` carries the declared base in the log.
  This is detection only — rebase/merge of a stale op is not provided: re-read and re-author.
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
  `{ omit: true }` to compile `title: ""`); `opts.viewer` is who the Blueprint is for (see
  "Sensitivity is enforced" below) and `opts.restrictedLabel` the placeholder's text; `opts.registry` turns an unregistered kind into a
  `renderer-coverage` finding; `opts.resolveLabel` resolves a `LocalizedText` (default: its
  fallback text); `opts.baseCatalog` is the loom catalogue built-in kinds resolve against
  (default `builtinCatalog`).
- `Viewer` (`{ clearance?: DataClass }`), `mayView(viewer, sensitivity)`, `strictestClass` — who may
  see which `Sensitivity` class (`@loom/classify`'s `secret > sensitive > internal`).
  `Intent.sensitivity` classifies the objective text itself.
- `hydrationPath`, `hydrationStatusPath`, `HYDRATION_VALUES_PREFIX`, `HYDRATION_STATUS_PREFIX` —
  the compiled projection paths a binding's `values.<handle>` / `status.<handle>` live at.
  A browser client maps `values.<handle>` back with `handleOfPath` from
  `@loom-ui/hydration/client`.
- `experienceHandles(exp): HandleUse[]` — every bound handle, once, with its highest-priority use
  and the node ids that want it.
- `handleKinds(exp, catalog, surface): Map<string, string[]>` — the widget kinds each bound handle
  feeds on one surface; what an `outputCheck: "contract"` provider is checked against.

### Data-provider kinds on a step

`MCPToolNode` (also exported as `ProviderStep`) is the step of every kind. `kind` is optional: absent
means MCP, so an MCP step has NO `kind` key and an Experience written before kinds existed hashes
byte-identically (pinned in `providerKind.test.ts`). `kind: "mcp"` spelled out is refused — one meaning,
one spelling, one content address. Any other kind is an id (`STEP_KIND_PATTERN`) the host registered a
hydration `DataProvider` for; `toolName` is then the target's id within that kind and `toolSchemaHash`
the kind's pin of its contract. `stepKind(step)` reads the kind (default `"mcp"`); `toolKey(step)` is
the identity `toolClasses` keys on — bare `toolName` for MCP, `<kind>:<toolName>` otherwise. An
older reader parsing a kinded step drops the unknown key and would run it as MCP (and fail on an
unknown tool); upgrade readers before authoring non-MCP steps.

### Binding to any projection (not only hydration)

A semantic node binds either a hydrated **handle** (`binding`) or **any other loom projection**
(`projection`) — an agent status, an approval queue, a transcript. Never both
(`binding-conflict`, an error; `compile` omits the node).

- Declare: `node.projection = { id, path, statusPath?, version, sensitivity? }`. `id` is the loom
  projection id, `path` the value path in that projection's state, `statusPath` the delivery
  status channel in the SAME state (loom IR 2.0.0 binding status; omit for none), `version` the
  projection version you composed against (loom ADR 0095), `sensitivity` your class for the data.
  Edit with the `bindProjection` operation, which replaces a handle binding and never lowers a
  class (the handle it leaves keeps its sticky class; re-binding keeps the strictest class).
- Compile: `CompileOptions.projections` is the host's catalogue (`ProjectionDescriptor[]`: `id`,
  `version`, optional `sensitivity`). The node compiles to a widget whose IR `DataBinding` is
  `{ projectionId: id, path, status?: { path: statusPath }, sensitivity }`, and the Blueprint's
  `projections` / `projectionVersions` gain that id and the offered version (hydration first, then
  the others sorted). The loom IR already carries all of this — no IR change.
  Findings (all errors): `projection-unknown` (not in the catalogue, or no catalogue:
  fail-closed), `projection-version-mismatch` (pin differs from the offered version),
  `projection-catalog-conflict` (the catalogue lists one id at two versions; same-version
  duplicates merge, strictest class wins), `projection-reserved` (the hydration id),
  `projection-binding-invalid` (also a bound breach: `id`/`version` <= 128 chars, `path` /
  `statusPath` <= 512), `binding-conflict`. A reserved, invalid or conflicting node is omitted;
  an UNKNOWN or VERSION-DRIFTED one compiles to the same `Note` placeholder as a restricted one,
  so the viewer cannot tell "restricted" from "does not exist" from "wrong version" (the host
  keeps the error; the offered version appears in a message only for a viewer cleared for the
  class). An experience with no projection node compiles byte-identically to before, and its
  content address is unchanged (`projection` is absent from a node that has none).
- Class (per PROJECTION, like a handle): the class in force for a projection id is the strictest
  of every node's `sensitivity` on it, the Experience's sticky `projectionClasses` and the
  catalogue's, applied to EVERY node on that id (one projection gives each the same state). A
  viewer who may not see it gets the `Note` placeholder on all of them (`node-restricted`) and the
  Blueprint does not declare the projection at all; no viewer is the most restrictive viewer.
  `projectionClasses` is folded by `insertNode` / `removeNode` / `bindProjection` /
  `bindProvider` (never lower; a node leaving a projection leaves its class on it) and lowered
  only by `declassifyProjection { projection, to? }`, which needs `{ allowDeclassify: true }` and
  is refused inside a `prompt` op, exactly like `declassifyHandle`. It is hashed only for the part
  live nodes do not imply. Hydration never fetches or serves these: `experienceHandles` lists only
  handle bindings.
- Stamps: `CompileResult.restrictedProjectionNodes` lists the placeholder-compiled projection
  nodes; pass it, and the catalogue's `id -> version`, to `compileFingerprint({ ...,
  restrictedProjectionNodes, projectionVersions })` (both fold in only when non-empty, so existing
  fingerprints are unchanged).
- Reading it: `renderer-lit` already reads and subscribes to every declared projection on the
  runtime it is given (publish that projection's events under the surface's `executionId`);
  `renderer-terminal` takes `projectionState` / `projectionSubscribe` options. Note: a projection
  state is read per `executionId`, which for a per-viewer `HydrationStore` includes the principal —
  route the other projection's events per viewer the same way.
- Not (yet) here: planner exposure (`ProjectionDescriptor[]` as an offered-projections list in the
  planner prompt/contract) and an unbind operation.

`CompileResult.findings`, `ok` and `restrictedProjectionNodes` are **host-only**: they still tell the restricted, unknown and version-drifted cases apart (the Blueprint does not), so a host must never forward them to the viewer.

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

### Browser entry (`@loom-ui/core/browser`)

The zod-free slice a browser renderer needs: number formatting (`formatSemanticNumber`,
`effectiveFormat`, `unitSuffix`, `deltaDirection`, `DELTA_FORMAT`), `checkKindValue` (a hand-written
twin of the main entry's, same verdict and same finding message — pinned by a differential test
against the zod contracts), `FRAMEWORK_KINDS`, `tableColumnLabel`/`tableColumnFormat`,
`isLocalizedText`, the `hydrationPath`/`hydrationStatusPath` spellings, and the value types. The
main entry's zod schemas cannot be tree-shaken (~60 kB minified in a page), so a bundle that
imports the main entry pays for them; `@loom-ui/renderer-lit` imports this subpath and a bundle
test holds it zod-free.

### Content log (`@loom-ui/core/log`)

- `mintVersionHash(exp)`, `seal(exp)` — the content address (parse, then canonicalise) and the
  sealed Experience carrying it.
- `putExperience(store, exp)`, `getExperience(store, ref)` — total round-trip through a loom
  `ContentStore`; both report a `Finding` (`artifact-unhashable`, `artifact-missing`,
  `artifact-invalid`, `artifact-tampered`) instead of throwing on bad input. The stored bytes are
  canonical JSON (keys sorted at every depth, arrays in order), so the `ref` is independent of the
  key order the experience arrived in — including from a store that reorders keys, e.g. a JSONB
  column. `seal` returns the experience in that same key order. `getExperience` reads any key
  order, so blobs written by earlier versions (insertion order) still load under their old `ref`.
- `EXPERIENCE_COMPOSED`, `ExperienceComposedPayload` — the userspace event name and
  `{ ref, parents, ops }` payload an app emits after `putExperience`, from inside a loom
  execution.
- `decodeValue`, `encodeValue` — the content codec, re-exported so a caller inspecting a stored
  blob by hand uses the same pair.

### Describing a change (U7)

`describeChange(prev, next, { viewer, ops?, summary?, summaryClass?, projections?, classify?, maxEntries? })` is pure, deterministic
and bounded: nodes added / removed / moved / rebound / reclassified / edited, provider and intent
changes, an identity report over the VISIBLE nodes, an `attention` level (`none | info | attention |
urgent`, default classifier or the host's) and the author's summary as `UntrustedText` when the
viewer may see the strictest class of everything either version holds (`experienceClassFloor`) and of
what the planner read (`summaryClass`). Projections follow `compile`: pass the same `ProjectionCatalog`
as `projections`; none, an unknown id, or a drifted version pin HIDES the node (fail-closed). Fail-closed for the viewer: anything it may not see, in either version,
collapses into one bare `{ kind: "restricted-changed" }` (no id, type or count); no viewer = no
clearance. `boundSummary` bounds and strips model text. `HeadChange` / `HeadSignal` are the types of a
"this experience has a new head" signal (implementations: `@loom-ui/changes`). See
[`@loom-ui/changes`](../changes/README.md).

### Provenance and "why is this here" (U12)

Every recorded op already says who made it; `foldProvenance(base, steps)` turns a lineage's ops into a
per-node **ledger** (which op created each node, which last changed it, how many changes, and the
last op to bind/remap/declassify each provider handle or projection), keyed by id and handle only: it
holds no node content, prop or value, is derived from the log, and is never part of the artifact or its
content address. `Provenance.decisionId` (optional; the planner's `PlanReport.decisionId`) links an op
to the loom decision that recorded the model call. `explainNode(experience, nodeId, { viewer, ledger,
notes, projections })` answers for ONE viewer: the node's type, what it is fed from (a provider
handle and the tool NAMES it calls, or a projection id/version, never an argument), who created and
last changed it, and (as `UntrustedText`) the author's summary of the version that created it and the
request that prompted the op. FAIL-CLOSED: an unknown node, a node this viewer may not see and an
unreadable input all answer the same bare `{ available: false }` (no oracle); the words are shown only when
the viewer may see the strictest class of everything the version holds, of what the planner read
(`summaryClass`) and of `extraFloor`; no viewer is the most restrictive viewer. `inspectExperience`
(shared with `describeChange`) is the one reading of "what may this viewer see".

### What a viewer saw (U12)

`snapshotSeen(experience, { viewer, read })` captures the values a viewer was actually shown:
one entry per data source (a handle, or a projection id+path), each with the class it was captured
under, a delivery state (`seen`, `absent`, `oversize`, `over-budget`, `unreadable`) and, when it fit
(16 KiB a value, 512 KiB and 256 sources a snapshot), a detached JSON copy of the value. `read` is
never called for a source the viewer may not see; the snapshot says only that something was
`restricted`. `redactSeen(entries, experience, { viewer })` is the read side: it re-derives each
class from the artifact the record names, takes the stricter of that and the stamp, restamps, and
withholds a missing or unknown stamp (no artifact = everything withheld). `seenToState` rebuilds the
`values.<handle>` / `status.<handle>` store shape so a surface can be replayed as it was shown.
Persistence is `@loom-ui/lineage`'s `SeenLog`: refs are sealed under a per-viewer key (erase a viewer by destroying it), blobs are reclaimed by a mark-and-sweep collector, and old views roll off by retention.

### Ordering

- `orderKeyBetween(a, b, { salt? })` — a fractional order key strictly between `a` and `b` (either
  `null` for ±∞); `orderKeyAfterAll(siblings, { salt? })` — the key that sorts after every sibling,
  for an append. Guarantees: always strictly between the bounds; WITHOUT a salt the key is a pure
  function of the bounds (two authors minting for one gap get the SAME key — the legacy behaviour);
  WITH a salt (an author/replica id, hashed to a 3-char suffix) authors with different salts get
  different keys for one gap — the suffix space is 62·62·61 ≈ 235k, so a salt-hash collision is possible and the
  render order is also totalled by id. A salt identifies an AUTHOR, not an insert: the same author
  inserting twice into one gap mints the same key (a tie, resolved at render by id). Keys are minted
  when an op is authored and recorded in the op (`node.order`, `newOrder`); `apply`/`replay` never
  mint one. The planner takes the salt as `ReferencePlannerOptions.orderSalt` (concurrent planners
  should each pass a distinct author id; omitted = unsalted legacy keys, output byte-identical).
  Two orderings, by design: everything HASHED or FOLDED (`normalize` in `experienceArtifact`,
  `apply`/`replay`) sorts by `order` only with a stable sort, so tied keys keep insertion order and
  NO stored experience's content address moves — ties included. Only the render/compile boundary
  (`compile`) uses the total order (`order`, then node id), so a render never depends on insertion
  order. There is no key below `"0"` or between
  `k` and `k + "0"`; salted keys never end in `"0"` for that reason.

### Action provenance

`StampedAction`, `ViewedVersion`, `viewedVersionOf(blueprintId, binding?, compile?)`,
`parseBlueprintId`, `compileFingerprint({ clearance, restrictedHandles, locale })`,
`actionFreshness(action, head): "fresh" | "stale" | "data-moved" | "unstamped" | "unverifiable"` and
the fail-closed `isStaleAction(action, head)` — renderers stamp every action with the version the
user saw; a host compares it with the head before acting. `CurrentHead` is
`{ experienceId, versionHash, bindingSeq?(widgetId), compile? }`: with `bindingSeq` a bound
widget's stamped seq must equal the current one (else `data-moved`; unknown is `unverifiable`), with
`compile` the view fingerprint must match. The renderer's `handle.head()` fills all of it. Also on
`@loom-ui/core/browser` (no zod). See the renderer-lit README for the flow.

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

- **Sensitivity is enforced (at the output boundaries), fail-closed.** A binding's `sensitivity`
  is checked against a `Viewer` in two places: `compile` (here) and hydration (`@loom-ui/hydration`).
  A viewer's `clearance` is the strictest class it may see; one with none sees only unclassified
  bindings, and **no viewer at all is a viewer with no clearance**. Unclassified bindings are never
  affected, so an experience that classifies nothing compiles byte-identically. A handle carries
  one value for every node that binds it, so its class is the strictest of those nodes' (and a
  node is redacted when ITS handle is). **A handle's class is sticky**: `Experience.handleClasses`
  (optional) records the strictest class any node ever bound it with, folded in by
  `insertNode` / `removeNode` / `bindProvider` and never lowered by them: removing, renaming or
  rebinding the classified node does not declassify its handle, whatever the op order or the
  planner drafts. **A tool's class is sticky too (tool-level, fail-closed).** A handle id hashes
  its tool, args and path, so a changed argument mints a NEW handle; `Experience.toolClasses`
  (keyed by `toolName` alone, so a version bump does not shed it, and over-classifying two
  servers' same-named tools rather than under-classifying) records the strictest class any handle
  on that tool ever carried, and `remapProvider` gives every new handle on such a tool that class
  (the planner adds a `sensitivity-inherited` warn). The class is applied at READ time to every
  handle (`experienceHandles`, the one choke point `compile` and hydration share): a handle's
  effective class is the strictest of its live nodes, its sticky `handleClasses` entry and the class
  of every tool its provider calls, so a sibling bound BEFORE its tool was classified is gated as
  soon as the tool is. **A tool's class can also be DECLARED up front** — it is not
  inferred only from nodes that already carry one. The host passes `declaredToolClasses`
  (`Record<toolKey, DataClass>`, the same `sensitivity` a planner's `CapabilityRef` declares) to
  every read path and it floors each handle whose provider calls that tool, whatever the stored
  nodes say: `compile`, `experienceHandles`, `inspectExperience` / `experienceClassFloor`,
  `describeChange` (and `LineageChangeFeed`), `explainNode` (and `Lineage.explain`), `snapshotSeen` /
  `redactSeen` (and `SeenLog.record` / `read`), and hydration (`HydrationController`,
  `handleInventory`, `serveHandle(s)`). It is a table the host passes, not stored state: it only
  ever RAISES a read, it is not part of the content address, and omitting it from a call
  means that call reads only the experience's own classes — so pass the same table everywhere.
  Where two tables meet (a constructor-level one and a per-call one, e.g. `LineageChangeFeed`),
  `mergeDeclaredToolClasses` joins them key by key, strictest wins: a per-call table can only ADD,
  never lower — `{}` or `undefined` leaves the bound floor intact. **Bind the policy ONCE.** The
  free read functions above take the table per call, so a host that forgets it on one call leaks on
  that path; they are the LOW-LEVEL API. Prefer the BOUND surfaces, which take a `ReadPolicy`
  (`{ declaredToolClasses?, projections?, hydrationProjectionId?, undeclared? }`) at construction and
  apply it to every read without per-call options: `new Lineage({ readPolicy })` (`explain`; a
  `SeenLog` or `LineageChangeFeed` built over it inherits it), `new SeenLog({ readPolicy })`,
  `new LineageChangeFeed({ readPolicy })`, and `createServeSurface(policy)` in hydration. A per-call
  value may only ADD (`mergeReadPolicy(bound, perCall)`: tables join strictest-wins, `"deny"` sticks,
  a bound `projections` catalogue is not replaced; when NO `projections` / `hydrationProjectionId` is
  bound, a per-call one may still supply it (the original behaviour) — bind it to prevent that). Build the table from the SAME `CapabilityRef`s the
  planner uses, so host and planner cannot disagree: `declaredToolClassesFrom(capabilities)`
  (`@loom-ui/planner`). **`undeclared: "allow" | "deny"`** (default `"allow"`): with `"deny"`, a
  handle whose provider calls any tool the table (when one is present) does NOT list reads as a class
  no clearance ranks (`UNDECLARED_TOOL_CLASS`), on every read path — a new tool fails closed until it
  is declared. `"deny"` also CLOSES the table's key set (a later or per-call table may raise a
  listed tool but never list a new one, so a per-call table cannot open a tool the host left
  undeclared), and `"deny"` with NO table means an empty one: every tool-bound handle is unreadable.
  **The declared table wins over
  `declassifyHandle`**: declassifying a handle lowers its stored class, but a tool the host declares
  keeps flooring every handle that calls it, so `declassifyHandle` has no read-time effect on a
  declared tool (lower the declaration to lower the read; covered by a test). `CompileResult.restrictedHandles` lists
  the handles redacted for the viewer; feed it to `compileFingerprint` (`restrictedHandles`) so a
  RAISED declaration changes freshness. **A container is classified by what it would show**: when every
  child it compiles is a bare placeholder (a restricted node, or itself a collapsed container — the rule
  runs bottom-up) the container is emitted as the SAME bare placeholder, its id only: no title, no role,
  no child count, no per-child placeholders (`node-restricted` is reported against it). One visible
  descendant keeps the container, title and role as authored. An EMPTY container (or one whose children
  all failed to compile) holds nothing restricted and stays as authored; a root that collapses is a
  plain column holding the one placeholder. The collapse is a function of the restricted handles and
  projection nodes, so a raised class that causes one already changes `compileFingerprint`. The readers
  agree: `inspectExperience` gives a container the weakest class among its non-blocked children, so
  `describeChange` reports a hidden container's addition, removal or edit as a bare `restricted-changed`,
  and `explainNode` / `Lineage.explain` answer `{ available: false }` for it. The
  reference planner also applies a capability's class to the nodes it writes (see
  `@loom-ui/planner`), so this floor is the backstop for nodes it did not write (an older planner, a
  raw op). Limits: a class follows MCP tool NAMES only — a provider whose execution
  graph calls no tool takes no tool class (it fetches nothing), and a different name for the same
  data (an alias, a renamed tool, a different server's tool name) is not caught. **Lowering** is `declassifyHandle { handle, to?, tool? }`, the only
  op that does it: it lowers the handle, and with `tool: true` also its tools; lowering the handle
  alone is undone the next time a handle is remapped onto a still-classified tool, and a
  still-classified sibling handle keeps its tool classified, so lower both when both are set.
  **Authority:** `apply` / `applyAt` / `replay` refuse `declassifyHandle`
  (`declassify-not-allowed`, experience unchanged) unless the CALLER passes
  `{ allowDeclassify: true }`. It is an argument of the call, never a field of the op, so a
  producer that controls only op data (a planner's `PlanResult.ops`, a client request) cannot mint
  it; the host applies untrusted ops without it and passes it only for ops it authored, or when
  replaying a log of its own already-authorised ops — passing it to `replay` over a log an
  untrusted party supplied gives that log full declassify power; prefer `apply`/`applyAt` for a
  single trusted op. A `prompt` op carrying a declassify is
  refused even with it, and the reference planner never emits one. **When a hash changes:** only
  the part of the class maps that live nodes do NOT already imply is hashed, so an experience
  whose classified nodes are all still present hashes exactly as it did before classes were
  stored; the content address moves only when a class outlives the node that carried it
  (removed or rebound) or is inherited by tool, which is new information. An unrecognised class
  ranks strictest (`strictestClass` is monotone, fail-closed). In `compile` a restricted node becomes a static `Note`
  placeholder: same id, same grid cell (no reflow), neutral "Restricted" title/text
  (`restrictedLabel`), and no binding, props, label, type or handle of the node it replaced; a
  `node-restricted` warn names only the node id. The classified-but-no-viewer case adds one
  `viewer-not-supplied` warn. The default Blueprint title (`intent.objective`) is withheld (`""`,
  `title-restricted` warn) when `intent.sensitivity` is above the viewer; an explicit `opts.title`
  is the app's own text and always wins. The `Experience` artifact itself is NOT redacted —
  compile for a restricted viewer on the trusted side and send only the Blueprint. Pass
  `viewer: { clearance: "secret" }` for full access. Enforcement is the output boundary's job, not
  a renderer's: a renderer draws what it is given. **Scope limits:** only bindings and
  `Intent.sensitivity` are classified. Container titles, static-node props/labels and node ids are
  author text and are never gated, so do not put classified text there. Planner inputs
  (`ReviseInput.observed`, a capability's `sampleOutput`, drift context) and outputs (summary,
  labels) are not viewer-filtered: `observed` taken from the same controller excludes restricted
  handles, but host-supplied material is unchecked.

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
