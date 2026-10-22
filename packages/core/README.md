# @loom-ui/core

The Experience Model: the composed node tree, the operations that edit it with deterministic
replay, the semantic catalogue a planner is allowed to name, the compiler that turns a composed
Experience into a loom `Blueprint`, and a `./log` subpath for content-addressed persistence. It
sits at the root of the loom-ui pipeline — an app (or a planner, via `@loom-ui/planner`) composes
an Experience here; `@loom-ui/hydration` resolves the handles it binds; `@loom-ui/renderer-lit`
and `@loom-ui/renderer-terminal` draw the `Blueprint` this package compiles. `@loom-ui/core` is
pure and isomorphic (no Node APIs) except for `./log`, which touches content hashing.

## Install / import

```jsonc
// package.json of a consumer checked out beside this repo (the packages are not published)
"@loom-ui/core": "link:../loom-ui/packages/core"
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
  `SemanticEntry` declares its allowed `props`, whether it binds data (`binding`), which props carry
  display text (`textProps`), who may set a binding's `sensitivity`, and how each `Surface` (an OPEN
  string — `"web"` and `"terminal"` have first-party renderers, any other name is the host's own
  modality) resolves it: to a loom widget kind, or a degrade to another entry. The catalogue's
  optional `valueContracts` give the host's own kinds a value contract (composed under the
  framework's, which a host cannot override). A host `ValueContract` is untrusted code: a throw or
  malformed return is a fixed-text `value-contract` finding (never the exception), an echoed issue
  message is capped at 200 characters with control characters stripped and MUST be value-free, and
  the host owns its contract's cost. An optional `version` is folded into the hydration cache key; a
  contract without one needs `HydrationCache.invalidate()` after a change.
- **Operations.** An `Operation` is one of `insertNode`, `removeNode`, `moveNode`, `setProps`,
  `setLabel` (`label: null` clears), `setTitle`, `setRole`, `setPlacement`, `bindProvider`,
  `unbindProvider`, `declassifyHandle`, `remapProvider`, `removeProvider`, `prompt`.
  `apply`/`replay` are deterministic and never throw on bad input — every refusal is a typed
  `Finding` (the full code list is in the [composition
  reference](../../docs/reference/composition.md#op-refusal-codes)).
- **Compile.** `compile(exp, opts)` turns a sealed or unsealed Experience into a loom `Blueprint`
  for one surface, resolving every semantic node through the catalogue and validating as it goes. A
  SEALED experience's result is memoized per (version, options) in a small LRU
  (`CompileOptions.memo`: `false` = off, or your own `createCompileMemo({ max })`); every call gets
  a private copy. A custom `resolveLabel` is memoized only with a `resolveLabelKey` (scoped to that
  resolver's identity), a `registry` never (see `compileMemo.ts` for the full key). Hits require
  HOLDING the sealed object (content is compared by reference; a re-read copy is a plain compile and
  does not evict the held entry). Treat catalogs, `root` and `providers` as immutable
  (identity-keyed). A result that cannot be structured-cloned is served uncached; a hit costs a
  clone (~half a compile).
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

### Merging two lines of edits

- `mergeExperiences(base, ours, theirs): { experience, conflicts }` — the three-way merge of two
  Experiences that both started at `base`. Pure and deterministic; it never throws and **always**
  returns an ours-biased partial: where the sides disagree `ours` wins and the disagreement is
  listed in `conflicts` (`{ plane, kind, ref, detail }`, `ref` = the node id, handle or key). The
  partial is UNSEALED (`versionHash: ""`, `parents: []`): the caller sets the parents (normally the
  two heads) and `seal`s it.
  - **Layout** merges on stable node ids over three independent dimensions (parent, sibling order
    key, the node's own content), so a move on one side and an edit on the other is clean.
    Conflicts: `move/move` (reparented or reordered differently), `remove/edit`, `edit/edit`,
    `add/add`, `orphan` (a survivor's parent is gone, or two moves made a cycle: nothing is dropped
    silently), `depth` (a tree, or the combined tree, past `MAX_TREE_DEPTH`; or a value too deep to
    compare).
  - **Providers** merge by handle, each provider atomic: `provider/provider`.
  - **Classes** (`handleClasses`/`toolClasses`/`projectionClasses`) are the strictest anything
    either side or the base ever carried; a class is never lowered by a merge. `vocabularyFloor` is
    the union of both sides' types.
  - **Intent** is merged field by field (`intent/intent`, `ref` = the field), so a change on one
    side to `sensitivity` never conflicts with an edit of `objective` on the other. The merged
    `intent.sensitivity` is ALWAYS the strictest of base, ours and theirs, whatever else conflicted.
  - **Declassification does not survive a merge** (intended, fail closed): classes are re-folded
    from base and both sides, strictest wins, so a one-sided `declassifyHandle` /
    `declassifyProjection` (or a lowered intent class) comes back. Each is reported as a
    `declassify/merge` conflict on the `classes` plane (`ref` = the handle, `tool:<key>`,
    `projection:<id>` or `intent`); the node-level `binding.sensitivity` of the nodes bound to it is
    raised to the effective class so it never disagrees with the sticky `handleClasses`. **A
    declassification must be re-applied after a merge with `declassifyHandle`.**
  - **Order keys:** two sides inserting different nodes at the same gap mint the same key; the merge
    re-keys such a tie (in node-id order, the render tie-break) so sibling keys are strictly
    increasing and a later `orderKeyBetween` between them cannot throw. A tie one side already had
    is kept as is.
  - **Deep values:** a value too deep to compare (node props, a provider spec, an intent field, a
    tree past `MAX_TREE_DEPTH`) is a `depth` conflict for that ref and ours is kept; the merge never
    throws.
  - **Localization keys:** `message/message` when two branches give the SAME `LocalizedText.key`
    different `fallback` text from DIFFERENT nodes (read from `label`, `title` and any
    `LocalizedText` inside `props`). Every other plane merges such a pair cleanly, yet the result
    has one key meaning two things. Only checked when both sides changed the layout. Equal order
    keys keep the position they had in `ours`, then `theirs`.
- `keyConflicts(ours, theirs, merged)` — the localization check on its own.

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
  for one surface. `opts.title` overrides the default `exp.intent.objective` (or `{ omit: true }` to
  compile `title: ""`); `opts.viewer` is who the Blueprint is for (see "Sensitivity is enforced"
  below) and `opts.restrictedLabel` the placeholder's text; `opts.registry` turns an unregistered
  kind into a `renderer-coverage` finding; `opts.resolveLabel` resolves a `LocalizedText` (default:
  its fallback text); `opts.baseCatalog` is the loom catalogue built-in kinds resolve against
  (default `builtinCatalog`).
- `Viewer` (`{ clearance?: DataClass }`), `mayView(viewer, sensitivity)`, `strictestClass` — who may
  see which `Sensitivity` class (`@loom/classify`'s `secret > sensitive > internal`).
  `Intent.sensitivity` classifies the objective text itself.
- `hydrationPath`, `hydrationStatusPath`, `HYDRATION_VALUES_PREFIX`, `HYDRATION_STATUS_PREFIX` — the
  compiled projection paths a binding's `values.<handle>` / `status.<handle>` live at. A browser
  client maps `values.<handle>` back with `handleOfPath` from `@loom-ui/hydration/client`.
- `experienceHandles(exp): HandleUse[]` — every bound handle, once, with its highest-priority use
  and the node ids that want it.
- `handleKinds(exp, catalog, surface): Map<string, string[]>` — the widget kinds each bound handle
  feeds on one surface; what an `outputCheck: "contract"` provider is checked against.

### Data-provider kinds on a step

`MCPToolNode` (also exported as `ProviderStep`) is the step of every kind. `kind` is optional:
absent means MCP, so an MCP step has NO `kind` key and an Experience written before kinds existed
hashes byte-identically (pinned in `providerKind.test.ts`). `kind: "mcp"` spelled out is refused —
one meaning, one spelling, one content address. Any other kind is an id (`STEP_KIND_PATTERN`) the
host registered a hydration `DataProvider` for; `toolName` is then the target's id within that kind
and `toolSchemaHash` the kind's pin of its contract. `stepKind(step)` reads the kind (default
`"mcp"`); `toolKey(step)` is the identity `toolClasses` keys on — bare `toolName` for MCP,
`<kind>:<toolName>` otherwise. An older reader parsing a kinded step drops the unknown key and would
run it as MCP (and fail on an unknown tool); upgrade readers before authoring non-MCP steps.

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

`CompileResult.findings`, `ok` and `restrictedProjectionNodes` are **host-only**: they still tell
the restricted, unknown and version-drifted cases apart (the Blueprint does not), so a host must
never forward them to the viewer.

### Framework kinds and number formatting

- `FRAMEWORK_KINDS` — the kinds this package adds beside loom's built-ins (the charts and tables
  such as `TimeSeries`, `BarChart`, `Kpi`, `Table`, plus `StatusCard`, `Note`, `A2UIView`,
  `SandboxView`, the media kinds in "Media" below and the chat kinds). It is an OPEN set that grows
  with each vocabulary slice: a host that renders a subset should assert its kinds are present
  (`arrayContaining`), never pin the length or the whole list.
- `kindValueContracts`, `kindValueContract(kind)`, `checkKindValue(kind, value)` — the zod contract
  per kind (loom's built-ins included) and the check a renderer runs before drawing a value;
  `undefined` (not hydrated yet) or an unknown kind always passes.
- `TimeSeriesValue`, `BarChartValue`, `KpiValue`, `TableValue`, `TableColumn`, `TableCell`,
  `StatusCardValue`, `StatusLevel`, `ChartAxis` — the value shapes; `tableColumnLabel(column)` /
  `tableColumnFormat(column)` read a `TableColumn` regardless of its string-or-object form. A `Table` may carry
  `rowKeys` (one stable key per row) and `rowActions` (up to `MAX_ROW_ACTIONS` per row, `TableRowAction`);
  `tableRowProblems(v)` is the one zod-free rule check both contracts call, and the widget emits `TABLE_ROW_ACTION`.
- `SemanticFormat`, `effectiveFormat`, `formatFromUnit`, `formatSemanticNumber`,
  `semanticNumberFormatOptions`, `unitSuffix`, `deltaDirection`, `DELTA_FORMAT` — what a bound
  number MEANS (`number` / `integer` / `decimal` / `percentage` / `currency`, with `notation` and
  fraction-digit bounds) and how every renderer formats, rounds and suffixes it identically.

### Media (U9, `@loom-ui/core/media`)

Media is never bytes in an Experience, a Blueprint, a seen log or a change feed. Four DISPLAY kinds
(`Image`, `Audio`, `Video`, `File`) are bound like any data widget; the bound value is a
**`MediaRef`**:

```ts
{ address: string,      // an opaque content address ("sha256:..."), a HANDLE, never a URL
  mediaType: string,    // lower-case type/subtype, no parameters; Image needs image/*, and so on
  size?: number, name?: string, alt?: string,
  origin?: "host" | "tool" | "user" }   // a claim; it never grants trust
```

The contract is strict (a field outside the list — inline bytes, a `url` — is refused), checked by
`checkKindValue` like every other kind, and its messages never echo the value. `MediaInput` is the
static upload control (props `accept`, `maxBytes`, `label`; a value reaching it is a defect).
`mediaCatalogEntries()` returns the five semantic entries (`@1.1.0`) to splice into a catalogue; a
catalogue without them cannot compose a media node, so a planner is offered media only if the host
chose to. Node props are text only (`alt`, `caption`, `label`) plus the upload control's `accept` /
`maxBytes`.

**The leak model.** An address is a capability: the content store has no tenancy of its own (loom
ADR 0120), so whoever can name an address can read the bytes. It therefore travels ONLY as a
hydrated value, which the data boundary already gates:

- it is never a node prop. `validateExperience` checks every media node against the FRAMEWORK's
  allow-list, whatever the catalogue declares: an unknown prop (`src`, `address`, `autoplay`…) is
  `media-prop-forbidden`, a prop whose whole value is a URL or address is `media-literal-ref`, an
  unbound display node is `media-unbound`. A composition-time guard refuses a model that tries to
  author a reference (a hint; the boundary is that a reference is only ever delivered by a binding);
- a handle the viewer may not see is never loaded (hydration), a restricted node compiles to an
  opaque placeholder with no binding, `snapshotSeen` never asks the host's reader for it, and
  `describeChange` / `explainNode` name no data. `mediaLeak.test.ts` is the property test: over 300
  seeded experiences x 4 viewers, no hidden node's address, file name or caption appears in the
  Blueprint, fingerprint, change description, seen snapshot or explanation, while the cleared
  viewer's own does;
- a media value is bounded: the seen log keeps at most 16 KiB per value, so a value carrying bytes
  is recorded as `oversize` with no content.

**Resolving and uploading are the HOST's.** loom-ui never fetches an address and never builds a URL
from one. `MediaResolver(request, { signal }) => MediaResolution` turns a ref into a viewer-scoped
URL (short-lived and signed, or same-origin behind the host's own auth) or refuses; it MUST
authorise. Build it per viewer session. `MediaUploadHandler` takes a file the user chose, stores it
(authorising, scanning, size-limiting) and returns a `MediaRef`; loom-ui stores no bytes.
`checkMediaUrl` re-checks every URL a resolver returns before an element sees it: https (http only
with `allowInsecure`), `blob:` or a same-origin path; never `javascript:`/`data:`/`file:`,
credentials in the URL, or (by default) a private, loopback, link-local or single-label host — a
resolver bug must not turn the viewer's browser into a probe of the host's network. `MediaPolicy`
carries the limits (`maxBytes` per kind, checked on the DECLARED size before the resolver is asked),
`untrusted: "mark" | "block"` and the URL switches.

**Untrusted active content and origins.** Untrusted bytes of an ACTIVE type (`isActiveMediaType`:
`text/html`, `application/xhtml+xml`, `image/svg+xml`, `text/xml`, `application/xml`, any `+xml`,
script types, Flash) are never drawn: the same bytes opened in a tab are a page, and `download` does
not stop open-in-new-tab. Untrusted media is also refused on a same-origin `/path`, `blob:` or
absolute URL on the app's origin (`policy.appOrigin`, default `location.origin` on the web; unset on
a terminal) (it would run in the app's own origin) unless `policy.allowSameOriginUntrusted: true`.
**The resolver's response must carry the headers that make this real:** `X-Content-Type-Options:
nosniff`, `Content-Disposition: attachment` for `File`, and `Content-Security-Policy: sandbox` (plus
a `Content-Type` equal to the ref's `mediaType`). `checkMediaUrl` refuses private, loopback,
link-local, CGNAT, multicast/reserved IPv4, v4-mapped / IPv4-compatible / NAT64 / 6to4 IPv6
(embedded v4 checked), `localhost[.localdomain]`, `.local`/`.internal`/`.lan`/`.home.arpa` and
single-label hosts, also with a trailing root dot. The origin check cannot see a cross-origin URL
that redirects back to the app (the resolver must not mint redirecting URLs for untrusted media) or
a different origin sharing the app's cookie scope (an attacker-influenced sibling subdomain): serve
untrusted media from a registrable domain of its own. A public DNS name that RESOLVES to a private
address (nip.io style) is invisible here: preventing that is the resolver's job (resolve and pin the
address, or only mint URLs on hosts you control).

**Accepting an upload is the host's check.** A `MEDIA_ATTACH` action is CLIENT INPUT: the widget's
type/size checks and `origin: "user"` run in a browser the user controls. Call
`acceptMediaAttach(action, { issued, principal, current, isMediaInput?, accept?, maxBytes? })` on
the host: it checks the widget is an upload control (`isMediaInput`), re-parses the ref (strict
`File` contract), requires `issued(address, principal)` to return the STORED `{ mediaType, size? }`
of an address this host's upload handler issued to THIS principal (otherwise a client could attach
any address it has seen or guessed, or another user's), then REPLACES the client's `mediaType` and
`size` with the stored ones (enforcing `accept` / `maxBytes` on them), requires the action to be
`fresh` against `current`, and returns the ref re-stamped `origin: "user"`, or a typed refusal
(`not-an-attach` / `not-media-input` / `bad-ref` / `stale` / `not-issued`). The resolver's
`Content-Type` must come from that stored record too, never from a ref a client sent.

**Names.** `checkFileName(name, mediaType)` flags a name whose executable/scriptable final extension
disagrees with its type (`invoice.pdf.exe` as `application/pdf`): the surface shows the type next to
the name and the download name drops the misleading extension. Text props that EMBED a URL or
address (`containsEmbeddedRef`: schemes, `www.`, `host/path`, `algo:hex`, CIDs; NFKC-normalised) are
`media-embedded-ref` errors on media nodes and `embedded-ref` warnings elsewhere. The scan is linear
and bounded (`MAX_EMBEDDED_SCAN`, 4096 characters: longer media text is `media-prop-too-long`,
longer text elsewhere a `text-too-long-to-scan` warning). Known false positives: a dotted name
before a slash (`Node.js/React`) reads as `host.tld/path`. That scan is a hint for review, NOT a
security boundary: the boundary is that a reference only comes from a binding and the host's
resolver.

**Content references as tool arguments (U9b).** The one door U9 left open: a capability whose INPUT
is a content reference (`describe_image({ image })`). The grammar of an argument value
(`MCPToolNode.arguments`, JSON) is exactly: (1) a *literal*, written by whoever composed the step;
(2) a relative-time token (`$now`, `$now-7d`; units `smhdw`); (3) a *step reference*, a WHOLE string
`{{steps.<id>.output[.<path>]}}` (`<id>` is `[A-Za-z0-9_-]+`) naming a step of the same graph in an
earlier wave (a template embedded in a longer string is not substituted: it is a literal); (4) a
*param*: a top-level key listed in the step's `overridable`, replaced per load by the host's
`setParams` / `defaultParams` (or a split client's params). A content-reference position may hold
ONLY: a step reference whose REFERENCED output the producing tool *declares* to be a content
reference (its `outputSchema` carries the marker at that path, the root included; a tool that merely
echoes or concatenates text proves nothing, and a reference to it is `media-arg-unproven-ref`, as is
one to a dangling step or the step itself); a param the HOST accepted (`acceptContentRefParam`,
below); or nothing (absent or JSON `null`; `null` is stripped before the call). Everything else
there, a literal address or URL, a time token, a number, an object, is FORBIDDEN, because it is the
model naming an address. What this does not prove: that a declared producer's output is trustworthy
(an untrusted tool can return a hostile address; the host's invoker still authorises the call as the
viewer).

*The marker* is a JSON Schema extension keyword on the capability's input (or output) schema,
`"x-content-ref": true`, at any depth (object properties, array items, `additionalProperties`,
`allOf` / `anyOf` / `oneOf`, `dependencies`, local `$ref`). It is `x-` rather than `format` because
it annotates any value (an object shaped like a `MediaRef` as well as a string), does not collide
with `format`'s assertion semantics, and names the concept, not a consumer. Nothing is needed from
loom: the host adds the keyword to the schema it already hands the planner
(`CapabilityRef.inputSchema` / `outputSchema`). `contentRefPaths(schema)` reads the marked paths
(`ArgPath`: string = key, `null` = any index / key) with a bounded, cycle-safe walk
(`MAX_SCHEMA_NODES` 5000, depth 24, 256 paths; only local `$ref`s resolve) and is total. It is
`unknown` (never "no marked arguments") for a schema it cannot read (not an object, an external or
dangling `$ref`, a malformed marker, over a budget, recursive AND carrying the marker, a
`$dynamicRef` / `$recursiveRef` AND carrying the marker), and a BACKSTOP counts the `x-content-ref:
true` objects in the raw schema against those the walk reached: any marker the walk did not reach
(under `propertyNames`, `contentSchema`, a keyword added tomorrow) makes the whole schema `unknown`.
The count is over schema DATA too: an `x-content-ref: true` object inside a `default` / `enum` /
`examples` value, or a marker nested somewhere the walk does not read, is also `unknown`, which is a
`media-arg-schema-unknown` composition error: such a schema fails closed and is unbindable until it
is cleaned.

*The table.* `ContentRefTable = { args, produces? }` (plain JSON; persist it with the capability set
and re-read it with `parseContentRefTable`, which returns `undefined` for anything that is not
exactly a table). `args[toolKey]` is the marked input paths, or `"unknown"` (the schema MENTIONS the
marker but cannot be fully read: strict) or `"unreadable"` (unreadable, no marker mentioned).
`produces[toolKey]` is the declared output paths. The planner derives it:
`contentRefArgsFrom(capabilities)`.

*The guard.* `validateExperience(exp, catalog, surface, { contentRefArgs })`: a literal at a marked
path is `media-arg-literal` (error, so `ok` is false; at most 8 are listed per step, then "and N
more"); an unproven reference is `media-arg-unproven-ref` (error). `"unknown"` is
`media-arg-schema-unknown` as an ERROR (the binding is refused), and at run time every string that
is not a step reference or a time token is refused and every replaced param is gated. `"unreadable"`
is the same code as a warning, and any wholly URL / address-shaped string is `media-arg-literal`.
Independent of the table, a string that looks like an address or embeds one (`containsEmbeddedRef`)
is `media-arg-suspect` (warn): a hint, never a boundary. Checks are linear (one pass, a trie of the
marked paths, a 100,000-value and 64-level budget past which the arguments are refused, a 256 KiB
budget for the suspect scan). Findings are value-free: they name the path, never the value.

*Residuals.* A declared producer is trusted as a whole, including what it does with its own unmarked
inputs (an address-shaped literal in a producer's own arguments is only a `media-arg-suspect` hint);
the invoker authorises each call as the viewer. A schema without the marker is not guarded (the host
must mark it; the suspect hint is the net). A top-level `additionalProperties` marker (path
`[null]`) names no key, so a gated param can never fill it: fail closed. The argument hook runs
after the check and is trusted host code. Strings over 4096 characters are not scanned for the
suspect hint.

**Trust.** Media is untrusted unless the host vouches (`MediaResolution.trusted`); `origin` on the
ref never grants it, and `origin: "user"` is never trusted. Surfaces mark untrusted media
(`data-untrusted` on the web, `[untrusted]` in the terminal) or, under `untrusted: "block"`, draw a
placeholder.

`cleanMediaText` / `safeFileName` sanitise name and alt text (controls, bidi overrides, path
separators); `formatBytes` / `describeMedia` are the one description both surfaces use;
`MEDIA_ATTACH_ACTION` (`"MEDIA_ATTACH"`, payload `{ ref }`) is what an upload emits.

### Chat and inputs (U8, `@loom-ui/core/chat`)

A conversation is four kinds. **`Chat`** is a transcript, bound like any data widget;
**`TextInput`** and **`FormInput`** collect input and are static (props only; a value reaching one is a
defect, as for a `Note`). **`SelectInput`** is static too, with one optional exception: its node may
carry a binding whose value is the CURRENT choice (a string; the host already holds it). The widget
shows it only if it is one of the declared `options` (anything else shows the placeholder and is never
echoed), follows it when it changes, and keeps a choice being submitted over a stale re-read. It is
display only: the user's change still emits `SELECT` and the host still re-validates. Which handles a composer may bind is the host's authorization job, as for any bound widget. File upload in a conversation is the existing
`MediaInput`. Core names no loom type: the transcript contract below is what loom's conversation
layer (`@loom/conversation`, ADR 0122) emits once a client has folded it, but any source that can
say this much can feed the widget. `chatCatalogEntries()` returns the four semantic entries
(`@1.1.0`) to splice into a catalogue; a catalogue without them cannot compose a chat node, so a
planner is offered chat only if the host chose to.

**The transcript value (`ChatValue`).** Strict, bounded, and checked by `checkKindValue` like every
kind (one function backs the zod and the zod-free checker; its messages never echo the value):

```ts
{ entries: ChatEntry[],            // oldest first, at most 500
  viewer?: { actor, tenant?, onBehalfOf? },   // "me": own turns are marked and are the only ones that can be edited
  older?: "0.12",                  // the cursor that loads the turns before the window (absent = start reached)
  state?: "open" | "closed", running?: boolean }
// ChatEntry
{ id: "t3.assistant",              // stable for the turn's slot: the streaming entry and its durable successor share it
  turn: 3, role: "user" | "assistant" | "system",
  status: "complete" | "streaming" | "interrupted" | "failed" | "rejected" | "restricted",
  parts?: ({ type: "text", text } | { type: "media", ref: MediaRef })[],
  asker?: Actor, cursor?: string, at?: number,
  reason?: "model-error",          // a short TOKEN; the renderer owns the words (`chatReasonText`)
  errorId?: string,                // a correlation id, shown as "ref ..." and never as an explanation
  editOf?: number,                 // this turn is a NEW turn that revises an earlier one
  tools?: { name, status }[],      // optional one-line tool activity
  reasoning?: { text, kind: "text" | "summary" | "redacted", streaming: boolean,
                truncated?: boolean,   // only part is here
                status?: "ok" | "erased" | "digest-mismatch" | "unloaded" | "loading" | "unavailable" } }
```

`reasoning` (loom ADR 0133) is the model's reasoning for an ASSISTANT reply and exists only when the
host turned it on (see "Reasoning" below); a value without it is exactly what it was. It is model output
derived from untrusted input, so it is drawn as TEXT, cleaned like reply text, and the contract refuses
text on `redacted`, `erased`, `digest-mismatch` and not-yet-loaded reasoning, and the field on a user or
restricted entry.

`mode` says what the source KNOWS about whose turns these are: `owner` (an owner-only conversation:
a user turn with no `asker` is the viewer's own, drawn "You" and editable), `shared`, or absent
(unknown: a turn with no `asker` is neutral "User", never "You", never editable). A person is always
introduced as `User "name"` so a name cannot pass itself off as `Assistant`, `Notice` or `You`.
`ChatFeed` keys a user entry by its log position (`cursor`; or the source's record id `ord` when it
has one) and never by turn number: loom records a REJECTED envelope under the next turn number
without consuming it, so several rejected entries and the accepted turn can share a number. A reply
keeps the `t<turn>.assistant` slot.

A **restricted** entry is a bare placeholder: `parts`, `tools`, `reason`, `errorId` and `editOf` are
refused on it by the CONTRACT, so a value that leaks content through a placeholder never reaches a
store. A field outside the list (loom's `classes`, `turnExecutionId`...) is refused too.

**Untrusted text.** Everything in a turn (a person's words, a model's, a tool's) is text to DRAW,
never to interpret. No renderer here turns chat text into markup or auto-links. By default a text
part is drawn exactly as typed. A source MAY opt in to markdown for ASSISTANT text only (`format:
"markdown"` on the part, or `new ChatFeed({ markdown: true })`; see "Markdown" below). `sanitizeChatText` removes what changes what a reader SEES or what a terminal
DOES (C0/C1 controls incl. ESC, bidi overrides and isolates, zero-width marks, Unicode TAG
characters), keeps ZWJ/ZWNJ (emoji, Indic scripts), normalises line breaks and collapses
vertical-space bombs. Linear time; the input is cut before it is scanned (100 KB adversarial tests
with absolute bounds).

**Markdown, opt-in.** A text part with `format: "markdown"` (assistant entries only; the contract refuses it
on a person's turn, and refuses any other format value) is read as a CLOSED subset of CommonMark/GFM:
paragraphs, ATX headings, emphasis and strong, inline code, fenced code, bullet and ordered lists,
blockquotes, rules, tables, `[label](url)` links and the `[[id]]` reference markers. Raw html and entities
are shown as the characters; images, autolinks, reference links and footnotes do not exist (a markdown image
is an address fetched on render, the classic exfiltration channel). A link is kept only for `http:`,
`https:` and `mailto:` (no whitespace, controls or userinfo, at most 2048 characters); otherwise its label
stays as text. The parser (`parseChatMarkdown`, hand-written, no dependency) is a pure, total, linear
function of the cleaned text into a bounded tree (2000 nodes, block depth 6, inline depth 4, tables 12 x 100). Rendering is bounded too: `chatMarkdownLines` visits at most 10000 nodes and emits at most 400k characters (200 lines of 2000), the `lu-chat` drawer draws at most 4000 nodes and 16 levels of nesting (`MAX_DEPTH`, block and inline levels combined; a parsed document is at most 6 + 4 deep, so it is always drawn in full), and a transcript caps a markdown part at 4 x `maxText` characters; a cut ends in `…`;
the tree is NEVER part of a value, so every renderer parses the text itself and a source cannot forge a
node. `resolveMdMarkers` applies the reference-marker rules (listed ids numbered, unlisted removed, all
hidden while streaming); markers never act inside code or a link label. Streaming needs no special case:
the text so far is parsed each time, an unclosed fence is code to the end, an unmatched `*` is literal, a
half-written `[label](ur` shows its label only. Renderers: `lu-chat` builds elements from the tree (links
a web link opens in a new context; all carry `rel="noopener noreferrer nofollow"`); everything without a DOM reads it as plain
lines through `chatMarkdownLines` (no ANSI). `docs/snippets/src/chatMarkdown.test.ts` is the reference
example.

**Reasoning (loom ADR 0133 D6), opt-in.** `new ChatFeed({ reasoning: true })` folds the SSE `reasoning`
and `reasoning-partial` events into the in-progress reply's `reasoning` (`streaming: true`, a separate
channel: it can never land in the reply text); `reset` / `closed` clear it, a `reasoning-partial` REPLACES
(a reconnect cannot duplicate it), and the durable `message` keeps the live text as that reply's reasoning.
Off by default: with it off the events are ignored (no finding) and no entry ever carries the field. The
server sends reasoning only to the viewers allowed to see it (in a shared conversation the turn's asker AND
the owner), the client never decides the audience (it renders every reasoning event it receives, restricted
turns excepted), and the
conversation server must opt in (`reasoning` on `@loom/plugin-conversation-sse`); the client renders what
it gets and never assumes any. The live events do not say whether the text is the model's own reasoning or
a provider summary, so the live label defaults to `summary` (never present a summary as the full chain of
thought); `reasoning: { liveKind: "text" }` is for a provider that streams the raw reasoning.
`reasoning: { durable: true }` also marks each finished reply `unloaded` (whoever asked: a viewer outside the
audience gets the server's 404, which settles as `unavailable` with no retry), and the host fetches ONE reply's stored reasoning lazily: `beginReasoning(cursor)` (`changed:
true` = go; the entry reads `loading`), then `applyReasoning(cursor, body)` with the
`GET .../reasoning?cursor=` body, or `reasoningFailed` / `reasoningUnavailable`. `chatReasoningFromDurable`
folds that body (only the recorded attempt of each step, texts joined, a `summary` among them makes the
whole a `summary`, hidden parts are `redacted`, erased / unverifiable parts never carry text; bounded).
The widget asks for it with `LOAD_REASONING { cursor }` on first expand (a read like `LOAD_OLDER`: no key,
refused with `browser-side` if routed to a `conversationTarget`). The terminal prints
`[reasoning: ...]` / `[reasoning summary: ...]` / a marker (`chatReasoningLine`).

**Folding loom's API: `ChatFeed`.** Pure (no network, timers or DOM). `applyHistory(page, "backward"
| "forward")` folds a history page, `applyEvent(name, data)` folds an SSE event (`status`,
`partial`, `delta`, `reset`, `message`, `closed`, `reconnect`, `error`); `value()` is the
`ChatValue` to publish, `resumeCursor()` is what the stream reopens after, `olderCursor()` what
"load earlier" asks for. The rules, each pinned by a test: **append-only** (a visible durable entry
is never changed by a later event; only a placeholder may be upgraded), **idempotent** (a re-read
after a reconnect is one entry), a restricted/rejected entry carries no text whatever the wire said,
an unknown status fails closed to a placeholder, **live text is not history** (a delta never touches
a durable entry; the durable reply replaces the live text under the same id), deltas for a
restricted turn, or for another asker when the viewer is known, are not rendered (the server already
sends them to the asker alone; this is the second line), the live reply is bounded like any stream
(`appendChunk`, 64 K), the window is bounded (default and ceiling 500; a full window offers no "load
earlier" that could not fit), the server's `error` event text is never read. The browser transport
is `connectConversation` in `@loom-ui/hydration/client`. On the SERVER, `chatValueFromHistory(page,
{ viewer })` is the same fold over one history page (fetch it with `GET
.../history?direction=backward`, the newest page: loom's route defaults to `forward` when
`direction` is omitted, and `direction` here must match how the page was fetched): a host effect
that wraps `Conversations.history` (loom has already filtered it for the viewer) returns it, a
`loom-effect` provider binds it to the `Chat` widget with `outputCheck: "contract"` for the first
paint or a split-hydration payload, and `connectConversation` takes over in the browser.

**Input actions and the write-back model.** Each input emits ONE action, stamped by the renderer
with `viewedVersion` (U5):

| widget | action `type` | payload |
|---|---|---|
| TextInput | `SUBMIT_TEXT` | `{ text, key }` |
| FormInput | `SUBMIT_FORM` | `{ values, key }` |
| SelectInput | `SELECT` | `{ value, key }` |
| Chat (edit a turn) | `EDIT_TURN` | `{ turn, text, key }` |
| Chat (load earlier) | `LOAD_OLDER` | `{ cursor }` (a read: no key) |
| Chat (open a reference) | `CHAT_REF_OPEN` | `{ entryId, refId, n }` (a read: no key). Untrusted: `acceptChatSubmit` matches `entryId`/`refId` against `hasRef(entryId, refId, principal, { widgetId })`, your record of what you served (per viewer, like `canEdit`); without `hasRef` it refuses (`ref-not-allowed`) |
| MediaInput | `MEDIA_ATTACH` | `{ ref }` (U9; `acceptMediaAttach`) |
| Table (row action) | `TABLE_ROW_ACTION` | `{ action, rowKey }` (the host decides what it means; no key). The payload is untrusted: match `rowKey` and `action` against the value you served |

`key` is an idempotency key the widget minted when the draft began (`newSubmitKey`). The widget
keeps the draft until the host answers `ok: true` (an `onAction` handler may return `{ ok, reason?
}` or a promise of it; none = success), so a failed send leaves the text and the key in place and
the user's retry carries the SAME key. Everything a widget checked was checked in a browser the user
controls, so the HOST re-validates, and the authority checks run on the SERVER, never in the page:

```ts
// BROWSER: forward the stamped action to your server and hand its answer back. Nothing here decides anything.
renderBlueprintDom(host, blueprint, {
  registry: createChatLitRegistry({ media }),
  onAction: (action) => {
    if (action.type === "LOAD_OLDER") return void connection.loadOlder();   // a READ the page makes itself
    return fetch("/api/ui-action", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(action) })
      .then((r) => (r.ok ? r.json() : { ok: false, reason: "failed" }));   // -> an ActionOutcome
  },
});

// SERVER: the principal comes from ITS session, `current` from ITS own head; the body is only the action.
const specs = inputSpecsOf(experience, catalog, "web");       // widget id -> spec, from the host's OWN experience
const writeBack = createWriteBack({
  specOf: (id) => specs.get(id),
  ledger: new SubmitLedger(),                                  // at-most-once per (principal, widget, key); bounded in size and time
  canEdit: (turn, principal, { widgetId }) => ownsTurn(principal, widgetId, turn),   // required for EDIT_TURN; absent = every edit refused
  routes: {
    composer: conversationTarget((text, { messageId }) => conversations.sendTurn(id, text, { principal, messageId })),
    rollbackForm: resumeTarget((payload, { idempotencyKey }) => runtime.resume(execId, "rollback", payload, { idempotencyKey })),
    regionPicker: paramsTarget((p) => controller.setParams(p), "region"),
  },
});
app.post("/api/ui-action", async (req, res) => {
  const session = await authenticate(req);                      // 401 without one
  res.json(await writeBack.handle(req.body, { principal: principalKey(session), current: headOf(experienceId) }));
});
```

**Calling `acceptChatSubmit` directly.** `createWriteBack` does the bookkeeping for you; if you call
`acceptChatSubmit` yourself you MUST call `commit()` when the write succeeds and `release()` when it
fails, or every retry of that key answers `in-flight` until the ledger's TTL. The same holds for a
route that never settles: a hung write keeps its key pending until the TTL (time-box your routes).
The ledger is in-memory: a restart forgets its keys. That is safe for a conversation because
`conversationTarget` sends the key as the turn's `messageId` and loom's R17 dedupes durably on
(sender, messageId); a `resumeTarget` / `paramsTarget` host should give the key to its own durable
dedupe the same way (`idempotencyKey` is passed on for exactly that).

**`mode` is the host's claim.** `ChatFeed({ mode: "owner" })` makes every turn with no `asker` "You"
and editable. Configure a feed over a SHARED conversation as owner-only and every participant's
unattributed turn is mislabelled as the viewer's own: set `mode` from what the conversation actually
is (`"shared"` there), or leave it unset (neutral "User").

`LOAD_OLDER` is not a write: the widget emits it so the page can call `connection.loadOlder()` (the
cursor is the feed's own). Routed to a `conversationTarget` anyway it is refused with the reason
`browser-side`.

**Reference markers.** A source that cites (retrieval answers, support replies that point at tickets) writes
`[[id]]` inside an assistant text part and lists the ids the entry may cite in `refs` (`[{ id }]`, at most 64,
unique, assistant entries only, refused on a restricted entry). Only when the value says `refMarkers: true` (set by
`ChatFeed({ refMarkers: true })`, which also folds a wire `refs: string[]` into `refs`) does the widget process
markers; otherwise text is drawn exactly as sent. `splitRefMarkers(text, known, { hideAll })` (zod-free, in
`@loom-ui/core/chat-ui`) turns a listed marker into a `ref` segment numbered by first appearance of the id, removes
every other marker with the one space before it, and with `hideAll` (a streaming reply) removes every marker and a
half-written `[[...`. The widget draws each `ref` segment as a button it builds itself (chat stays text-only) and
emits `CHAT_REF_OPEN { entryId, refId, n }`. It is a read: it carries no key, and routed to a `conversationTarget`
it is refused with `browser-side`.

`acceptChatSubmit` (what `handle` runs first) is total and returns a typed refusal: `not-a-submit`,
`not-an-input`, `wrong-input`, `bad-key`, `invalid` (with fixed per-field codes), `stale` (not
`fresh` against the head, U5; do NOT pass `bindingSeq` for a chat or input widget: a transcript
moves by design, it is the COMPOSITION that must not have), `duplicate`, `in-flight`,
`edit-not-allowed`. Text is sanitised and bounded; a form's values are rebuilt from DECLARED fields
only; a select value must be a declared option; the idempotency key is claimed last so a refusal
never burns one, and `release()` gives it back when the write fails (so the retry is accepted) and
`commit()` marks it landed. A repeat while the first write is still IN FLIGHT is `in-flight` (it may
yet fail, so it is never told it landed); `createWriteBack` answers it `{ ok: false, reason:
"pending" }`, and a repeat of a committed one `{ ok: true, reason: "duplicate" }` (the first one
counts), a failed write `{ ok: false, reason: "failed" }` with NO error text, and a widget with no
route `no-route`. The three targets are structural (core imports nothing from loom): a
conversation's `sendTurn`, a flow's resume gate (typed gates still parse the payload, ADR 0077),
`setParams`.

**Edit-previous-turn is a new turn.** `EDIT_TURN` carries the revised text; the conversation target
sends it as a NEW turn (`messageId` = the key), or hands it to the host's own `edit` handler to fork
/ branch / re-ask. History is never rewritten and the widget never changes what it draws: the new
turn arrives from the log, and `ChatFeed.annotate(turn, { editOf })` (the host knows which edit it
sent) makes it draw as "edit of turn N". The feed never infers an edit: loom's message record has no
such field today (see the PR's loom-impact note).

**What a planner can do.** Node props are allow-listed by the FRAMEWORK, whatever the catalogue
declares: `Chat` `emptyText`, `editable`; `TextInput` `label`, `placeholder`, `multiline`,
`maxChars`, `submitLabel`; `FormInput` `label`, `fields`, `submitLabel`; `SelectInput` `label`,
`options`, `placeholder`, `size` (`default` or `compact`: fit the content so it can sit beside other controls; also the `select` `::part`). Anything else (`entries`, `messages`, `text`, `value`, `defaultValue`, a
prefill) is `chat-prop-forbidden`; a field spec is closed (name, label, type
`text|textarea|number|boolean|select`, `required`, `maxLength`, `min`, `max`, `options`; no regular
expressions, no defaults) and a bad one is `chat-prop-shape`; an unbound `Chat` is `chat-unbound`. A
planner shapes WHERE a conversation goes and what its inputs are called, never what is said in one
or what a person "entered".

**Entries.** `@loom-ui/core/chat` is the host/folding surface; `@loom-ui/core/chat-ui` is the narrow
part a browser WIDGET needs (contract, text cleaner, validators, action vocabulary, shared words),
because core is CommonJS and a bundler cannot drop an unused module behind a barrel.
`chatTranscriptLines(value)` is the one-line-per-turn text both the terminal and a screen-reader
summary use.

### Browser entry (`@loom-ui/core/browser`)

The zod-free slice a browser renderer needs (the media CONTRACT rides in `checkKindValue`; the rest
of the media surface is the separate `@loom-ui/core/media` subpath, so a page that draws no media
does not carry it): number formatting (`formatSemanticNumber`, `effectiveFormat`, `unitSuffix`,
`deltaDirection`, `DELTA_FORMAT`), `checkKindValue` (a hand-written twin of the main entry's, same
verdict and same finding message — pinned by a differential test against the zod contracts),
`FRAMEWORK_KINDS`, `tableColumnLabel`/`tableColumnFormat`, `isLocalizedText`, the
`hydrationPath`/`hydrationStatusPath` spellings, and the value types. The main entry's zod schemas
cannot be tree-shaken (~60 kB minified in a page), so a bundle that imports the main entry pays for
them; `@loom-ui/renderer-lit` imports this subpath and a bundle test holds it zod-free.

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

`describeChange(prev, next, { viewer, ops?, summary?, summaryClass?, projections?, classify?,
maxEntries? })` is pure, deterministic and bounded: nodes added / removed / moved / rebound /
reclassified / edited, provider and intent changes, an identity report over the VISIBLE nodes, an
`attention` level (`none | info | attention | urgent`, default classifier or the host's) and the
author's summary as `UntrustedText` when the viewer may see the strictest class of everything either
version holds (`experienceClassFloor`) and of what the planner read (`summaryClass`). Projections
follow `compile`: pass the same `ProjectionCatalog` as `projections`; none, an unknown id, or a
drifted version pin HIDES the node (fail-closed). Fail-closed for the viewer: anything it may not
see, in either version, collapses into one bare `{ kind: "restricted-changed" }` (no id, type or
count); no viewer = no clearance. `boundSummary` bounds and strips model text. `HeadChange` /
`HeadSignal` are the types of a "this experience has a new head" signal (implementations:
`@loom-ui/changes`). See [`@loom-ui/changes`](../changes/README.md).

### Provenance and "why is this here" (U12)

Every recorded op already says who made it; `foldProvenance(base, steps)` turns a lineage's ops into
a per-node **ledger** (which op created each node, which last changed it, how many changes, and the
last op to bind/remap/declassify each provider handle or projection), keyed by id and handle only:
it holds no node content, prop or value, is derived from the log, and is never part of the artifact
or its content address. `Provenance.decisionId` (optional; the planner's `PlanReport.decisionId`)
links an op to the loom decision that recorded the model call. `explainNode(experience, nodeId, {
viewer, ledger, notes, projections })` answers for ONE viewer: the node's type, what it is fed from
(a provider handle and the tool NAMES it calls, or a projection id/version, never an argument), who
created and last changed it, and (as `UntrustedText`) the author's summary of the version that
created it and the request that prompted the op. FAIL-CLOSED: an unknown node, a node this viewer
may not see and an unreadable input all answer the same bare `{ available: false }` (no oracle); the
words are shown only when the viewer may see the strictest class of everything the version holds, of
what the planner read (`summaryClass`) and of `extraFloor`; no viewer is the most restrictive
viewer. `inspectExperience` (shared with `describeChange`) is the one reading of "what may this
viewer see".

### What a viewer saw (U12)

`snapshotSeen(experience, { viewer, read })` captures the values a viewer was actually shown: one
entry per data source (a handle, or a projection id+path), each with the class it was captured
under, a delivery state (`seen`, `absent`, `oversize`, `over-budget`, `unreadable`) and, when it fit
(16 KiB a value, 512 KiB and 256 sources a snapshot), a detached JSON copy of the value. `read` is
never called for a source the viewer may not see; the snapshot says only that something was
`restricted`. `redactSeen(entries, experience, { viewer })` is the read side: it re-derives each
class from the artifact the record names, takes the stricter of that and the stamp, restamps, and
withholds a missing or unknown stamp (no artifact = everything withheld). `seenToState` rebuilds the
`values.<handle>` / `status.<handle>` store shape so a surface can be replayed as it was shown.
Persistence is `@loom-ui/lineage`'s `SeenLog`: refs are sealed under a per-viewer key (erase a
viewer by destroying it), blobs are reclaimed by a mark-and-sweep collector, and old views roll off
by retention.

### Ordering

- `orderKeyBetween(a, b, { salt? })` — a fractional order key strictly between `a` and `b` (either
  `null` for ±∞); `orderKeyAfterAll(siblings, { salt? })` — the key that sorts after every sibling,
  for an append. Guarantees: always strictly between the bounds; WITHOUT a salt the key is a pure
  function of the bounds (two authors minting for one gap get the SAME key — the legacy behaviour);
  WITH a salt (an author/replica id, hashed to a 3-char suffix) authors with different salts get
  different keys for one gap — the suffix space is 62·62·61 ≈ 235k, so a salt-hash collision is
  possible and the render order is also totalled by id. A salt identifies an AUTHOR, not an insert:
  the same author inserting twice into one gap mints the same key (a tie, resolved at render by id).
  Keys are minted when an op is authored and recorded in the op (`node.order`, `newOrder`);
  `apply`/`replay` never mint one. The planner takes the salt as `ReferencePlannerOptions.orderSalt`
  (concurrent planners should each pass a distinct author id; omitted = unsalted legacy keys, output
  byte-identical). Two orderings, by design: everything HASHED or FOLDED (`normalize` in
  `experienceArtifact`, `apply`/`replay`) sorts by `order` only with a stable sort, so tied keys
  keep insertion order and NO stored experience's content address moves — ties included. Only the
  render/compile boundary (`compile`) uses the total order (`order`, then node id), so a render
  never depends on insertion order. There is no key below `"0"` or between `k` and `k + "0"`; salted
  keys never end in `"0"` for that reason.

### Opaque ids on restricted placeholders (U10c)

Node ids are lexical (the reference planner mints `payroll_salary_by_employee`), so the id of a node
a viewer may not see says what it is about. `compile` therefore emits a restricted placeholder, and
a policy-A collapsed container, under an ALIAS: `r_` + 16 base64url characters of
`HMAC-SHA256(placeholderKey, experienceId, nodeId)` (`placeholderAlias` is the exported derivation).
Stable across versions and compiles with the same key (keyed reconciliation in both renderers keeps
the element, zero remounts; the layout cell is unchanged), different per experience, and neither
recoverable nor confirmable by a dictionary of likely ids without the key. Unrestricted nodes keep
their own ids (a refine addresses a node by `data-widget-id`).

- **`CompileOptions.placeholderKey`**: a secret the HOST holds, at least `MIN_ALIAS_KEY_BYTES` (16).
  Keep it in your secret store, the same on every replica, and rotate it only when a one-time
  remount of placeholders is acceptable. **Fail-closed:** a key that is ABSENT falls back to a
  random per-process key and one `placeholder-alias-key-not-supplied` warn (only when something was
  aliased): nothing confidential is lost, but aliases and `result.fingerprint` differ across
  replicas and restarts, so actions stamped before are refused as stale. A key that is SUPPLIED but
  under 16 bytes (or not a string/bytes) throws `PlaceholderKeyError` (`code:
  "placeholder-key-weak"`) and is never silently replaced. It is never an unkeyed hash, which a
  dictionary of lexical ids would break.
- **Production setting: `requirePlaceholderKey: true`.** With no key, a compile that needs an alias
  throws `PlaceholderKeyError` (`code: "placeholder-key-required"`) instead of using the random key.
  Zero-config dev works without it.
- **Collisions are handled, not assumed away**: an alias that equals a real node id or another alias
  is re-derived (the alias is 96 bits of HMAC, so this is a guard, not an expected path). The hash
  input is UTF-16 code units, so even malformed ids (lone surrogates) stay distinct.
- **Sibling order.** Ties on `order` are broken on the id a node is EMITTED under (a restricted
  node's alias), so a hidden node's real id never decides where it sits among tied siblings. Hashed
  paths keep their order.
- **Known limits.** (1) The alias is stable across versions by design (keyed reconciliation), so a
  viewer can tell that the same hidden node persisted. (2) A hidden node's span and grid cell are
  emitted by design (no reflow). (3) The `r_` prefix is not reserved: do not identify placeholders
  by prefix; use the `Note` kind and the restricted label. (4) Pre-existing: `versionHash` is an
  unkeyed sha256 over the whole Experience including hidden content, so a party able to guess an
  entire Experience could confirm it (high entropy in practice); a keyed content address is a
  follow-up.
- **Leak model.** Viewer-facing, and covered by the `opaqueIds` property test (random experiences x
  sensitivities x viewers; no hidden node's id or handle anywhere): the Blueprint (widget ids,
  container ids, cells), `CompileResult.fingerprint`, `describeChange` / the `@loom-ui/changes` feed
  (a restricted change is a bare `restricted-changed`; `identity` lists visible nodes only),
  `explainNode` / `Lineage.explain` (a hidden node is `{ available: false }`), `snapshotSeen` /
  `SeenLog` (`nodeIds` of viewable nodes only), the hydration findings and handle inventory (raised
  only for handles the viewer may read), both renderers' output (they draw the Blueprint).
  **Server-side only; never serialise to a viewer:** `CompileResult.findings` (`node-restricted`,
  validation findings: real ids and messages), `restrictedProjectionNodes`, `restrictedHandles`, and
  `inspectExperience` (an unviewered reader of every node). Also not covered: a node id written into
  free text a viewer can read (a visible node's label or a model summary the class floor lets
  through).

### Action provenance

`StampedAction`, `ViewedVersion`, `viewedVersionOf(blueprintId, binding?, compile?)`,
`parseBlueprintId`, `compileFingerprint({ clearance, locale, ...result.fingerprint })`,
`actionFreshness(action, head): "fresh" | "stale" | "data-moved" | "unstamped" | "unverifiable"` and
the fail-closed `isStaleAction(action, head)` — renderers stamp every action with the version the
user saw; a host compares it with the head before acting. `CurrentHead` is
`{ experienceId, versionHash, bindingSeq?(widgetId), compile? }`: with `bindingSeq` a bound
widget's stamped seq must equal the current one (else `data-moved`; unknown is `unverifiable`), with
`compile` the view fingerprint must match. The renderer's `handle.head()` fills all of it. Also on
`@loom-ui/core/browser` (no zod). See the renderer-lit README for the flow.

## Interaction signals (U11)

`@loom-ui/core/signals` (opt-in subpath, no zod, no DOM) is the client half of the learning loop: a
`SignalCollector` that turns what a viewer did with a surface into bounded, content-free
`InteractionSignal`s, and `validateSignalBatch`, the shared total validator a host runs on untrusted
batches. Four facts only: `exposure` (a node was rendered and visible), `engagement` (a click/expand
**count**, capped at 255, or a **dwell bucket** 0-3 at 1 s / 5 s / 30 s — raw timing never leaves
the client, and a node's dwell is sent ONCE per view, when the view is sealed: `flush({ final: true
})`, a new version, or a page hide; unchanged state is never re-sent), `feedback` (a 1-5 rating, on
a node or the surface) and `outcome` (a token and a boolean). Every string is bounded and
control-free (a node id is the Blueprint's own id, <= 128 chars; an outcome name and a batch id are
strict `[A-Za-z0-9_.:-]` tokens); there is no text field. A node drawn as a restricted placeholder
is reported `restricted: true` under the alias it already has
(`CompileResult.fingerprint.placeholderNodes`, new in U11 — the aliases of the placeholders that
survived into the Blueprint). The collector is bounded (512 tracked nodes per view, 64 signals per
batch, 16 queued batches; a bound drops and counts) and re-sends a failed batch under the same
`batchId`. See `@loom-ui/learning` for the host half and `@loom-ui/renderer-lit/signals` for the DOM
driver.

`Provenance.policyDecisionId` (U11, optional, outside the content address) names the *learnable*
loom decision behind an op — the planner variant choice — so a reward attributes to it; `decisionId`
still names the model call.

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

- **Sensitivity is enforced (at the output boundaries), fail-closed.** A binding's `sensitivity` is
  checked against a `Viewer` in two places: `compile` (here) and hydration (`@loom-ui/hydration`). A
  viewer's `clearance` is the strictest class it may see; one with none sees only unclassified
  bindings, and **no viewer at all is a viewer with no clearance**. Unclassified bindings are never
  affected, so an experience that classifies nothing compiles byte-identically. A handle carries one
  value for every node that binds it, so its class is the strictest of those nodes' (and a node is
  redacted when ITS handle is). **A handle's class is sticky**: `Experience.handleClasses`
  (optional) records the strictest class any node ever bound it with, folded in by `insertNode` /
  `removeNode` / `bindProvider` and never lowered by them: removing, renaming or rebinding the
  classified node does not declassify its handle, whatever the op order or the planner drafts. **A
  tool's class is sticky too (tool-level, fail-closed).** A handle id hashes its tool, args and
  path, so a changed argument mints a NEW handle; `Experience.toolClasses` (keyed by `toolName`
  alone, so a version bump does not shed it, and over-classifying two servers' same-named tools
  rather than under-classifying) records the strictest class any handle on that tool ever carried,
  and `remapProvider` gives every new handle on such a tool that class (the planner adds a
  `sensitivity-inherited` warn). The class is applied at READ time to every handle
  (`experienceHandles`, the one choke point `compile` and hydration share): a handle's effective
  class is the strictest of its live nodes, its sticky `handleClasses` entry and the class of every
  tool its provider calls, so a sibling bound BEFORE its tool was classified is gated as soon as the
  tool is. **A tool's class can also be DECLARED up front** — it is not inferred only from nodes
  that already carry one. The host passes `declaredToolClasses` (`Record<toolKey, DataClass>`, the
  same `sensitivity` a planner's `CapabilityRef` declares) to every read path and it floors each
  handle whose provider calls that tool, whatever the stored nodes say: `compile`,
  `experienceHandles`, `inspectExperience` / `experienceClassFloor`, `describeChange` (and
  `LineageChangeFeed`), `explainNode` (and `Lineage.explain`), `snapshotSeen` / `redactSeen` (and
  `SeenLog.record` / `read`), and hydration (`HydrationController`, `handleInventory`,
  `serveHandle(s)`). It is a table the host passes, not stored state: it only ever RAISES a read, it
  is not part of the content address, and omitting it from a call means that call reads only the
  experience's own classes — so pass the same table everywhere. Where two tables meet (a
  constructor-level one and a per-call one, e.g. `LineageChangeFeed`), `mergeDeclaredToolClasses`
  joins them key by key, strictest wins: a per-call table can only ADD, never lower — `{}` or
  `undefined` leaves the bound floor intact. **Bind the policy ONCE.** The free read functions above
  take the table per call, so a host that forgets it on one call leaks on that path; they are the
  LOW-LEVEL API. Prefer the BOUND surfaces, which take a `ReadPolicy` (`{ declaredToolClasses?,
  projections?, hydrationProjectionId?, undeclared? }`) at construction and apply it to every read
  without per-call options: `new Lineage({ readPolicy })` (`explain`; a `SeenLog` or
  `LineageChangeFeed` built over it inherits it), `new SeenLog({ readPolicy })`, `new
  LineageChangeFeed({ readPolicy })`, and `createServeSurface(policy)` in hydration. A per-call
  value may only ADD (`mergeReadPolicy(bound, perCall)`: tables join strictest-wins, `"deny"`
  sticks, a bound `projections` catalogue is not replaced; when NO `projections` /
  `hydrationProjectionId` is bound, a per-call one may still supply it (the original behaviour) —
  bind it to prevent that). Build the table from the SAME `CapabilityRef`s the planner uses, so host
  and planner cannot disagree: `declaredToolClassesFrom(capabilities)` (`@loom-ui/planner`).
  **`undeclared: "allow" | "deny"`** (default `"allow"`): with `"deny"`, a handle whose provider
  calls any tool the table (when one is present) does NOT list reads as a class no clearance ranks
  (`UNDECLARED_TOOL_CLASS`), on every read path — a new tool fails closed until it is declared.
  `"deny"` also CLOSES the table's key set (a later or per-call table may raise a listed tool but
  never list a new one, so a per-call table cannot open a tool the host left undeclared), and
  `"deny"` with NO table means an empty one: every tool-bound handle is unreadable. **The declared
  table wins over `declassifyHandle`**: declassifying a handle lowers its stored class, but a tool
  the host declares keeps flooring every handle that calls it, so `declassifyHandle` has no
  read-time effect on a declared tool (lower the declaration to lower the read; covered by a test).
  `CompileResult.restrictedHandles` lists the handles redacted for the viewer (SERVER-SIDE: real
  handle names); feed `CompileResult.fingerprint` (the same lists as opaque aliases) to
  `compileFingerprint` so a RAISED declaration changes freshness without handing the viewer a
  confirmable hash of a handle name (see "Opaque ids" below). **A container is classified by what it
  would show**: when it has at least one child compile drew or tried to draw, and EVERY such child
  is a bare placeholder (a restricted node, a projection the host does not offer or at another
  version, or itself a collapsed container — the rule runs bottom-up) the container is emitted as
  the SAME bare placeholder, its id only: no title, no role, no child count, no per-child
  placeholders; `node-restricted` is reported against it alone, never against the children it hides.
  Only a child whose projection binding was REFUSED does not count (compile omits it, like a
  reported defect). Any child omitted for another reason (an unresolvable type, a kind with no
  contract) keeps the container as authored. One visible descendant keeps the container, title and
  role as authored. A container with nothing counted (empty, or only refused children) stays as
  authored; a root that collapses is a plain column holding the one placeholder. The collapse is a
  function of the restricted handles and projection nodes, so a raised class that causes one already
  changes `compileFingerprint`; whether a child is dropped for another reason depends on the
  catalogue and the surface, which are compile inputs the host already keys on (the surface-agnostic
  readers count such a child as visible, and compile keeps the container too). **The readers agree,
  by the same rule**: `inspectExperience` classifies a projection-bound node with compile's own
  derivation (one class per projection: the strictest of every node binding it, the sticky
  `projectionClasses` and the catalogue), counts every non-refused child, and gives a container the
  weakest class among its non-blocked counted children; when all its counted children are blocked
  (hidden from every viewer) the container is `blocked` itself. So `describeChange` reports a hidden
  container's addition, removal or edit as a bare `restricted-changed`, and `explainNode` /
  `Lineage.explain` answer `{ available: false }` for it. A seeded property test
  (`containerAgreement.test.ts`) asserts that compile's collapsed containers and the readers' hidden
  ones are the same set over randomised trees and viewers. The reference planner also applies a
  capability's class to the nodes it writes (see `@loom-ui/planner`), so this floor is the backstop
  for nodes it did not write (an older planner, a raw op). Limits: a class follows MCP tool NAMES
  only — a provider whose execution graph calls no tool takes no tool class (it fetches nothing),
  and a different name for the same data (an alias, a renamed tool, a different server's tool name)
  is not caught. **Lowering** is `declassifyHandle { handle, to?, tool? }`, the only op that does
  it: it lowers the handle, and with `tool: true` also its tools; lowering the handle alone is
  undone the next time a handle is remapped onto a still-classified tool, and a still-classified
  sibling handle keeps its tool classified, so lower both when both are set. **Authority:** `apply`
  / `applyAt` / `replay` refuse `declassifyHandle` (`declassify-not-allowed`, experience unchanged)
  unless the CALLER passes `{ allowDeclassify: true }`. It is an argument of the call, never a field
  of the op, so a producer that controls only op data (a planner's `PlanResult.ops`, a client
  request) cannot mint it; the host applies untrusted ops without it and passes it only for ops it
  authored, or when replaying a log of its own already-authorised ops — passing it to `replay` over
  a log an untrusted party supplied gives that log full declassify power; prefer `apply`/`applyAt`
  for a single trusted op. A `prompt` op carrying a declassify is refused even with it, and the
  reference planner never emits one. **When a hash changes:** only the part of the class maps that
  live nodes do NOT already imply is hashed, so an experience whose classified nodes are all still
  present hashes exactly as it did before classes were stored; the content address moves only when a
  class outlives the node that carried it (removed or rebound) or is inherited by tool, which is new
  information. An unrecognised class ranks strictest (`strictestClass` is monotone, fail-closed). In
  `compile` a restricted node becomes a static `Note` placeholder: an OPAQUE ALIAS id (see "Opaque
  ids" below), the same grid cell (no reflow), neutral "Restricted" title/text (`restrictedLabel`),
  and no binding, props, label, type or handle of the node it replaced; a `node-restricted` warn
  (SERVER-SIDE) names the real node id. The classified-but-no-viewer case adds one
  `viewer-not-supplied` warn. The default Blueprint title (`intent.objective`) is withheld (`""`,
  `title-restricted` warn) when `intent.sensitivity` is above the viewer; an explicit `opts.title`
  is the app's own text and always wins. The `Experience` artifact itself is NOT redacted — compile
  for a restricted viewer on the trusted side and send only the Blueprint. Pass `viewer: {
  clearance: "secret" }` for full access. Enforcement is the output boundary's job, not a
  renderer's: a renderer draws what it is given. **Scope limits:** only bindings and
  `Intent.sensitivity` are classified. Container titles and static-node props/labels are author text
  and are never gated, and the ids of nodes the viewer CAN see are author text too, so do not put
  classified text there. Planner inputs (`ReviseInput.observed`, a capability's `sampleOutput`,
  drift context) and outputs (summary, labels) are not viewer-filtered: `observed` taken from the
  same controller excludes restricted handles, but host-supplied material is unchecked.

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
  silently dropped. `row`/`rowSpan` are unbounded in the IR, but past `GRID_LINE_WARN_ABOVE`
  (1000) `validateExperience` warns `grid-line-extreme`; nothing is rejected.
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
