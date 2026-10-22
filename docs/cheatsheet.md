# Cheatsheet — loom-ui

> One card. The Experience Model, what `compile` does with it, the packages around it, and the
> handful of things that reliably bite. Every name in an **Export** table's first column is checked
> against the built packages by `docs/snippets/src/cheatsheet.test.ts`; follow the links for the
> why. Not started yet? [Getting started](getting-started.md) first; the long form is the
> [user guide](user-guide.md).
>
> **9** packages · compiles to Blueprint IR **2.5.0** · surfaces: `web` · `terminal` · any name you
> register

## The shape of it

```text
 intent + catalogue + capabilities
        │  planner (or your code)                    Operation[]
        ▼                                                │
   replay / apply ──▶ Experience ──seal──▶ versionHash (content address)
                          │
        compile({ surface, catalog, viewer, audience })
                          ▼
 providers ─hydrate─▶ values.<handle> + status.<handle> ─▶ Blueprint ─▶ renderer
```

| Package | Side | Gives you |
|---|---|---|
| `@loom-ui/core` | both | the model, operations, catalogue, `compile`, merge, provenance, seen snapshots |
| `@loom-ui/hydration` | server (`/client` for the browser) | resolve handles into one projection, in-process or split |
| `@loom-ui/planner` | server | `Planner` SPI, `ReferencePlanner`, drift repair, `interpretAction`, conformance |
| `@loom-ui/lineage` | server, optional | head by compare-and-set, revert / undo / branch, `SeenLog` |
| `@loom-ui/changes` | server, optional | `ChangeFeed`, unread cursors, head signals |
| `@loom-ui/learning` | server, optional | signals to votes to rewards, variant comparison |
| `@loom-ui/renderer-lit` | browser (ESM only) | DOM adapter, `lu-*` elements, container renderers |
| `@loom-ui/renderer-terminal` | any | string renderers, `watch`, interactive session |
| `@loom-ui/renderer-conformance` | tests | one set of renderer contract checks |

Guides: [composing](guides/composing.md) · [hydration](guides/hydration.md) ·
[rendering](guides/rendering.md) · [sensitivity](guides/sensitivity-and-audiences.md) ·
[lineage and changes](guides/lineage-and-changes.md) · [planners and learning](guides/planners-and-learning.md) ·
[writing a renderer](guides/writing-a-renderer.md) · [troubleshooting](guides/troubleshooting.md).
Examples are in the sibling `loom-examples` repo (`examples/<name>`).

## The model — `@loom-ui/core`

An **Experience** is `{ experienceId, versionHash, parents, intent, root, providers,
vocabularyFloor, meta }`. Never mutated: every change is a new one. A **container** has
`direction` (`row` · `column` · `grid`), optional `title` and `role`, and `children`; a **semantic
node** names a catalogue entry (`type`, `typeVersion`), carries `props`, `label`, and may bind a
`handle` (or a loom projection, never both). Every node has `span` and optional `row` / `rowSpan` /
`column`.

| Export | What |
|---|---|
| `genesis` | start a line: an empty 12-column `grid` root |
| `apply` | one `Operation` → `{ ok, value }` or `{ ok: false, finding }`. Never throws |
| `applyAt` | `apply` against a declared base; a stale base is `stale-base-version` |
| `replay` | fold an op list; stops at the FIRST refusal |
| `seal` | mint `versionHash` — from `@loom-ui/core/log` (Node-only) |
| `defineSemanticCatalog` | the closed vocabulary: entries, props, per-surface kind |
| `validateExperience` | check an experience against a catalogue; reports, never repairs |
| `findNode` · `walk` · `isContainer` | tree helpers |
| `orderKeyBetween` · `orderKeyAfterAll` | fractional `order` keys — never indices |
| `preservesNodes` | did a revision keep every node id? |
| `GRID_COLUMNS` · `MAX_TREE_DEPTH` | 12 · the depth cap |

Entries: `@loom-ui/core` (everything above), `/log` (seal, Node), `/browser`, `/media`, `/chat`,
`/chat-ui`, `/signals`. → [composition reference](reference/composition.md#compose-seal-log-compile),
[composing guide](guides/composing.md).

### Widgets and kinds

A catalogue entry resolves a semantic `type` to a loom widget **kind** per surface. Beside loom's
own, `FRAMEWORK_KINDS` declares loom-ui's, each with a value contract in `kindValueContracts`.

| Kind | Bound value | Notes |
|---|---|---|
| `Kpi` | `KpiValue` `{ value, unit?, format?, label?, deltaPct? }` | `deltaPct` is a fraction |
| `Table` | `TableValue` `{ columns, rows }` | column = string or `{ label, format? }` |
| `StatusCard` | `StatusCardValue` `{ level, headline, detail? }` | level: `ok` · `warning` · `critical` |
| `Note` | none — static `text` prop | also what a redacted node becomes |
| `TimeSeries` | `TimeSeriesValue` | series may sit on a `left` / `right` axis |
| `BarChart` | `BarChartValue` | |
| `A2UIView` · `SandboxView` | the bound value as data | mount `lu-a2ui-view` / `lu-sandbox` |
| `Image` · `Audio` · `Video` · `File` | `MediaRef` — an ADDRESS, never bytes | host supplies a `MediaResolver` |
| `MediaInput` | static upload control | |
| `Chat` | `ChatValue` | text is UNTRUSTED, drawn as text only; a reply's model reasoning is OFF unless `ChatFeed({ reasoning })` (a collapsed "Reasoning" disclosure; a `summary` is labelled a summary) |
| `TextInput` · `FormInput` · `SelectInput` | static (a `SelectInput` may bind its current choice) | emit `SUBMIT_TEXT` / `SUBMIT_FORM` / `SELECT` |
| `MultiSelectInput` | `MultiSelectValue` (`{ options, selected, note? }`) | emits `SELECT_MANY` with the whole new choice |

| Export | What |
|---|---|
| `FRAMEWORK_KINDS` | the list; assert members are present, never its length |
| `kindValueContracts` | one zod contract per kind, declared once |
| `checkKindValue` | validate a value against its kind (renderers show a visible error) |
| `frameworkKindContracts` | the entry a catalogue copies into `surfaces.web` — from `@loom-ui/renderer-lit` |

→ [framework kinds](reference/composition.md#framework-kinds). Examples: `experience-kinds`,
`media-gallery`, `incident-shared-chat`.

### Layout, containers, roles, placement

- `direction: "grid"` is the only parent where `span` and `row` / `rowSpan` / `column` mean
  anything. Under `row` / `column` a `span` is dropped silently; a placement is
  `placement-outside-grid`; off the 12 columns it is `placement-out-of-range`.
- A container `title` is a `LocalizedText`; a titled container draws as `<section><h2>` + layout.
- A container `role` is an open, app-named key a container renderer registers under — not an ARIA
  role, never localised. The roles `renderer-lit` ships renderers for are `REFERENCE_CONTAINER_ROLES`:
  `tabs` (2–8 titled panels) and `stepper` (2–12 titled steps). Well-formed means `LayoutRole`.
- The terminal has no container seam: a role prints the plain container.

| Export | What |
|---|---|
| `REFERENCE_CONTAINER_ROLES` | `tabs` · `stepper`, with child-count rules |
| `TABS_ROLE` · `STEPPER_ROLE` | the two role names |
| `placementOf` · `isPlaced` · `placementProblems` | read and check a node's placement |
| `LayoutRole` | the one rule for a role; never re-spell the regex |

→ [placement](reference/composition.md#placement-and-section-titles),
[container roles](reference/composition.md#container-roles). Examples: `experience-layout`,
`experience-stepped`, `experience-tabs-planner`.

## Operations

`insertNode` · `removeNode` · `moveNode` · `setProps` · `setLabel` · `setTitle` · `setRole` ·
`setPlacement` · `bindProvider` · `unbindProvider` · `bindProjection` · `declassifyHandle` ·
`declassifyProjection` · `remapProvider` · `removeProvider` · `prompt`

| Op | Gist |
|---|---|
| `setPlacement` | `{ nodeId, span?, row?, rowSpan?, column? }`; absent = unchanged, `null` clears |
| `setRole` · `setTitle` | `null` clears; a semantic node is `not-container` |
| `removeProvider` | refused (`provider-still-bound`) while any node binds the handle |
| `remapProvider` | change a handle's spec; do it before `bindProvider` in the same list |
| `declassifyHandle` | lowers a sticky class; trusted caller only (`{ allowDeclassify: true }`) |
| `prompt` | a planner's op, carries `materialized` ops; never interactive |

Widget clicks come in as `experience.op` actions. `interpretAction` (from `@loom-ui/planner`)
returns `experience` · `business` · `refused`; it admits `setPlacement` and `setTitle` on non-root
nodes and refuses both provider ops, `setRole`, `prompt` and root edits.

| Export | What |
|---|---|
| `interpretAction` | classify a `WidgetAction`: `experience` / `business` / `refused` |
| `EXPERIENCE_OP_ACTION` | the action type that carries an op |
| `Operation` | the zod schema; `Operation.safeParse` any payload |

Refusal codes by op: [the complete list](reference/composition.md#op-refusal-codes). Two near
twins: `not-container` (`setTitle` / `setRole` on a semantic node) vs `not-a-container` (an insert
or move parent). Examples: `experience-board-edit`, `experience-recompose`.

## Compile

<!-- illustrative: a reference card; the same call is compiled in getting-started's "compile" snippet -->

```ts
const { blueprint, findings, ok } = compile(experience, {
  surface: "web",
  catalog,
  hydrationProjectionId: HYDRATION_PROJECTION_ID,
  hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
  viewer: { clearance: "sensitive" }, // who is asking
  audience: "viewer", //                  or "broadcast"
  placeholderKey, //                      16+ bytes; keeps restricted ids opaque
});
```

`compile` never throws: problems are `findings`; `ok` is false only for an error. Its result also
carries `fingerprint`, `viewer` and `clearance` (the EFFECTIVE ones) for stale-action checks.

| Export | What |
|---|---|
| `compile` | experience + options → `{ blueprint, findings, ok, … }` |
| `createCompileMemo` | opt-in memo; `audience` is part of its key |
| `compileFingerprint` | what a stamped action was drawn from (use `result.fingerprint`) |
| `hydrationPath` · `hydrationStatusPath` | the `values.<handle>` / `status.<handle>` paths |
| `placeholderAlias` | the keyed alias a restricted node compiles under |

Options you will reach for: `surface`, `catalog`, `viewer`, `audience`, `title`, `resolveLabel`,
`placeholderKey` / `requirePlaceholderKey`, `restrictedLabel`, `memo`. → [rendering reference: what
compile targets](reference/rendering.md#what-compile-targets). Example: `blueprint-status`.

## Hydration — `@loom-ui/hydration`

Resolves each handle through loom's TRANSIENT effects and publishes one projection
(`HYDRATION_PROJECTION_ID`). **Read-only and log-free**: drift is reported (`onDrift`), repaired by
your durable execution. A handle is `pending` · `ready` · `stale` · `error` · `empty`; priority
`P0` loads at once, `P1` after a batching window, `P2` on `markVisible`.

| Export | What |
|---|---|
| `HydrationStore` | the projection a renderer reads; per (experience, principal, audience) |
| `HydrationController` | in-process: `load` · `recompose` · `setViewer` · `setParams` · `markVisible` · `invalidate` |
| `SplitHydrationController` | the browser half of split hydration; the same verbs over a `HandleLoader` |
| `handleInventory` | SERVER: the handles + kinds, no provider detail |
| `serveHandles` · `serveHandle` | SERVER: answer a load request for the handles in the inventory |
| `defineReshapers` | name → function from a tool's raw output to the kind's value |
| `outputShapeHashOf` | the ONLY way to pin `outputShapeHash` |
| `remapOperation` | the op that repairs input drift (you apply it, durably) |
| `defineDataProviders` | register a non-MCP step `kind` (`loomEffectProvider`, `mcpProvider`) |

```text
 browser: SplitHydrationController ── HandleLoader.loadMany ──▶ server: serveHandles
          (imports /client only)                                (imports the root entry)
```

Examples: `split-hydration`, `order-lines` (the `empty` state). → [hydration guide](guides/hydration.md),
[reference](reference/hydration.md#which-entry).

## Planner — `@loom-ui/planner`

A planner returns OPERATIONS, never an Experience, and every model call runs inside `ctx.decide`, so
a replay serves the recorded decision and calls no model.

| Export | What |
|---|---|
| `ReferencePlanner` | the shipped planner; `compose` / `revise` into the closed catalogue |
| `scopeInvoker` | run hydration's tool calls THROUGH loom's decide scope (identity, delegation, budget) |
| `checkPlannerConformance` | prove a custom planner: replay no-call, denial propagates, stream parity |
| `reviseForDrift` | re-author after drift, from `observedSamples` |
| `plannerProvenance` | stamp the planner decision on ops (feeds `explain`) |
| `declaredToolClassesFrom` | a tool's declared data class → a `ReadPolicy` |
| `materialize` · `buildProviderSpec` | draft → ops with provider specs |
| `stableBucketPolicy` · `epsilonGreedyPolicy` · `ucbPolicy` | shipped variant policies |

`ReferencePlanner` options: `model` (an object, or `(scope) => model` to keep identity and budget),
`modelId`, `maxAttempts`, `reach`, `variants`. `variants` is `{ variants, policy }` (one fixed
policy) **or** `{ variants, rollout }` (a registry through `decideWithRollout`) — exactly one.

Examples: `experience-tabs-planner`, `planner-decide-scope`, `planner-learning`. →
[planners and learning](guides/planners-and-learning.md),
[planning reference](reference/planning.md#compose-and-revise).

## Lineage, explain, seen log — `@loom-ui/lineage`

| Export | What |
|---|---|
| `Lineage` | `start` · `compose` · `advance` · `revert` · `undo` · `branch` · `promote` · `verify` · `head` · `walk` · `explain` |
| `InMemoryLineageStore` · `eventStoreLineageStore` | the store seam |
| `SeenLog` | per (experience, viewer) manifests of what was SHOWN; `record` · `read` · `eraseViewer` |
| `InMemorySeenKeyStore` | per-viewer sealing keys; destroying one is erasure |
| `collectSeenGarbage` | mark-and-sweep of seen blobs (dry run first) |
| `foldLineage` | the pure fold behind the head |
| `retainedVersions` | what a `RetentionPolicy` keeps |

- `advance` takes the head you read as `expectedHead`; losing the race is a typed `head-moved`,
  never an overwrite. Revert and branch are NEW versions and never lower a class.
- `by` is an unverified claim and lineage authorizes nothing; authz is your host's.
- `Lineage.explain` / core `explainNode` are fail-closed: unknown, restricted and unreadable all
  answer `{ available: false }`. What a viewer SAW is `snapshotSeen` (core, pure) persisted by
  `SeenLog`.

→ [lineage guide](guides/lineage-and-changes.md#provenance-why-is-this-here-what-did-they-see).
Example: `provenance-explain`, `saved-views`.

## Changes and merge

| Export | What |
|---|---|
| `mergeExperiences` | three-way merge of two forks of one sealed base; pure; never throws |
| `keyConflicts` | the `message/message` check alone |
| `describeChange` | prev + next + viewer → a description; anything unseen collapses to ONE `restricted-changed` |
| `LineageChangeFeed` | at-least-once feed over lineage events (`read` · `subscribe` · `describe`) |
| `unreadChanges` · `markRead` | per-viewer unread cursor (`InMemoryUnreadStore`) |
| `pollingHeadSignal` · `eventStoreHeadSignal` | "the head moved" without a client importing the feed |

Merge conflict kinds: `move/move` · `remove/edit` · `edit/edit` · `add/add` · `orphan` ·
`provider/provider` · `message/message` · `intent/intent` (and `depth`, `declassify/merge`). Ours
wins; the result is **unsealed with no parents** — you pick parents (normally both heads) and `seal`.

→ [merge two forks](guides/composing.md#merge-two-forks),
[the change feed](guides/lineage-and-changes.md#the-change-feed-loom-uichanges). Example: `experience-merge`.

## Learning — `@loom-ui/learning`

Signals are UNTRUSTED client input: four content-free facts, dwell once per sealed view, restricted
nodes flagged under their alias. A viewer reduces to ONE bounded vote per decision.

| Export | What |
|---|---|
| `SignalIngestor` | accept signals; refuses unless `exposure` proves the viewer saw the node |
| `seenLogExposure` | the authoritative exposure check, over a `SeenLog` |
| `VoteLedger` | append-only per-decision `VoteLog` folded to one vote per viewer |
| `settleRewards` | close a decision and record ONE pooled reward through `recordOutcome` |
| `evaluateVariants` | compare planner variants over the pipeline's own outcomes |
| `linkFromLedger` | resolve a vote back to its planner decision |
| `unitAlias` | the server-derived HMAC alias for a planner `unit` — never client-supplied |

The loop: the planner picks a variant (`plan-variant:*`, propensity logged) → viewers vote on what
the server recorded showing them → one late reward per decision → shadow, canary, promote or roll
back through loom's registry. Answer signal posts with a bare 204. Example: `planner-learning`. →
[learning in the guide](guides/planners-and-learning.md#learning-choose-observe-reward-compare).

## Sensitivity, audience, redaction

A binding's `sensitivity` is `secret` · `sensitive` · `internal` (or none); the order is fixed.
`compile` redacts anything above the viewer's clearance into a placeholder and the hydration side
enforces the same boundary, so give BOTH the same `viewer` and `audience`.

| `audience` | Clearance used | A withheld node becomes |
|---|---|---|
| `"viewer"` (default) | the viewer's own | a `Note` reading "Restricted" |
| `"broadcast"` | the STRICTER of the viewer's and "unclassified only" | loom's redacted widget (IR 2.5.0), drawn `⊘ redacted` |

- Fail closed: an unknown class or audience value is withheld / broadcast.
- Findings `node-restricted` and `audience-withheld` are SERVER-side (real ids). The viewer's
  `compileFingerprint` is built from `result.fingerprint`, which holds only aliases.
- Classes ratchet up: revert, branch and merge never lower one.

| Export | What |
|---|---|
| `mayView` · `strictestClass` | the class order |
| `effectiveViewer` · `isBroadcast` | the viewer a surface is really drawn for |
| `carryClasses` · `inheritedClass` | sticky class folding |
| `snapshotSeen` · `redactSeen` | what a viewer saw, pure |
| `explainNode` | viewer-safe "why is this here" |

→ [sensitivity guide](guides/sensitivity-and-audiences.md), [audience reference](reference/audience.md).
Examples: `experience-broadcast`, `provenance-explain`.

## Renderers

| Export | What |
|---|---|
| `renderBlueprintDom` | DOM adapter (`/dom`): returns a handle; `handle.update(next)` patches by node id |
| `litRegistry` · `createLitRegistry` | the default / your own Lit registry (build your own, `.merge()`) |
| `referenceContainers` | `tabs` and `stepper` container renderers (`/containers`) |
| `renderExperience` | terminal: one inert frame; `watch` for live frames |
| `watch` | terminal: subscribe to a store |
| `interactiveTerminal` | the opt-in live terminal session |
| `loomUiTerminalRegistry` | the terminal registry for every framework kind |
| `configureI18n` | override fixed words (Lit); the terminal takes `i18n` |

<!-- illustrative: DomRenderOptions.containers, keyed by role; the adapter keeps mount, focus and reconcile -->

```ts
renderBlueprintDom(host, blueprint, {
  projectionRuntime, executionId, registry: litRegistry,
  containers: referenceContainers(), // or { tabbed: myRenderer } — keyed by role
});
```

- A container renderer owns CHROME and child visibility only; `update` is required and an identical
  Blueprint is zero mutations. A throwing renderer falls back to the plain container.
- Web: `import "@loom-ui/renderer-lit/register"` defines the `<lu-*>` elements — nothing registers
  on import. loom's React renderer shows `[No renderer for …]` for framework kinds.
- Opt-in entries: `/media`, `/chat`, `/signals`.

### Writing a renderer, and the conformance kit

Implement `RendererAdapter` (`name`, `surface`, `kinds`, `capabilities?`, `mount`) and hand it to
the kit; unlisted kinds must be refused VISIBLY, not dropped.

| Export | What |
|---|---|
| `checkRendererConformance` | run every check, get a `ConformanceReport` |
| `describeRendererConformance` | the vitest wrapper (`/vitest`); pass `forbidSkips` |
| `CHECKS` | the checks: kinds, status matrix, restricted, untrusted text, media, chat, i18n, actions, audience |
| `KIND_FIXTURES` | one fixture per kind |

→ [rendering guide](guides/rendering.md), [writing a renderer](guides/writing-a-renderer.md),
[rendering reference](reference/rendering.md#container-renderers-on-the-web). Examples:
`experience-stepped`, `experience-recompose`.

## Theming

Only `--lu-*` custom properties; never a consumer's prefix.

| Group | Tokens |
|---|---|
| Colour, shape | `--lu-text` · `--lu-text-dim` · `--lu-text-caption` · `--lu-border` · `--lu-panel` · `--lu-panel-2` · `--lu-grid` · `--lu-accent` · `--lu-radius` |
| Deltas | `--lu-delta-up` · `--lu-delta-up-bg` · `--lu-delta-down` · `--lu-delta-down-bg` · `--lu-delta-flat` · `--lu-delta-flat-bg` |
| Status | `--lu-status-ok` · `--lu-status-warning` · `--lu-status-critical` |
| Sizing | `--lu-chart-aspect` · `--lu-chart-min-height` · `--lu-entry-h` (`--lu-row-h` is set by the table, not a hook) |

→ [theming reference](reference/theming.md).

## Things that bite

- **Edit loom, rebuild loom, then test here.** Tests and `typecheck` read loom's BUILT `dist`; a
  stale build reads as a mystery with sourcemaps at pre-edit lines.
- **`typecheck` does not see tests.** `pnpm typecheck:tests` does; a fixture that compiles only
  because vitest never typechecks it fails there.
- **Never `.register()` on a default registry** (`litRegistry`, `defaultTerminalRegistry`, React's
  `defaultRegistry`): they are shared singletons. Build your own and `.merge()`.
- **A `span` outside a `grid` parent vanishes without a finding.** A `row` / `column` does not: it
  is an error.
- **`replay` stops at the first refusal**; it does not skip. `intent` is inside the content hash and
  no operation changes it.
- **Ids are lexical and chosen by you.** Reuse one for different content and identity is lost. Keep
  `order` as a fractional key.
- **Forgetting `register` is the commonest "nothing renders" on the web.** Importing a renderer no
  longer defines its elements.
- **`contentRefArgs` is required** on `HydrationController` and `serveHandles`; pass `"none"` if no
  tool takes a content reference.
- **Same `viewer` and `audience` everywhere:** `compile`, `handleInventory`, `serveHandles`. A store
  is per audience; a mismatched controller throws `HydrationAudienceMismatchError`.
- **`viewer: {}` and no `viewer` both mean no clearance**; a missing one also raises
  `viewer-not-supplied`. Pass it deliberately.
- **Classification is not authorization.** loom-ui decides what a viewer sees; who the viewer is, and
  who may declassify, is your host's job.
- **`/client` entries must not reach the server:** the browser entry imports no sandbox, MCP or
  node builtin; lineage, changes and learning never enter a client graph.
- **If `deciderCalls` rises on replay, your decision key is unstable** (a clock, a random id, an
  unsorted collection).
- **With a `scopeInvoker`, do not also configure `principal`** on hydration — the scope carries it.
- **Tool-authored text shown to a model is tainted data**, fenced in a user message, never `system`.
- **`versionHash` is an unkeyed hash of the whole experience**, hidden content included — don't
  expose it where a party could guess an entire experience.
- **The catalogue is closed at runtime.** A planner may only name entries; a gap is a finding.
- **Display text goes through the entry's `textProps`.** A renderer never looks a message key up.

## Examples (in `loom-examples`)

| Example | Teaches |
|---|---|
| `experience-kinds` | the framework kinds, compiled for web and terminal |
| `experience-layout` | placement, section titles, a restyle without a remount |
| `experience-stepped` | an app-registered container renderer for a role |
| `experience-recompose` | a revision landing while the user types |
| `experience-board-edit` | `setPlacement` resize, `removeProvider`, `interpretAction` |
| `experience-merge` | three-way merge of two forks |
| `experience-broadcast` | one Experience for a viewer and for a wallboard |
| `experience-tabs-planner` | nested `tabs` composed by the reference planner |
| `split-hydration` | server holds the inventory, client loads values |
| `order-lines` | the `empty` binding state |
| `planner-decide-scope` | a planner deciding through loom's decide scope |
| `planner-learning` | vote, reward, shadow, canary, promote or roll back |
| `provenance-explain` | explain, seen log, erasure, GC |
| `saved-views` | a composed surface as a logged artifact |
| `media-gallery` | media by address, viewer-scoped links |
| `incident-shared-chat` | `Chat` and inputs in a shared conversation |
| `blueprint-status` | a plain loom app on Blueprint IR 2 |
