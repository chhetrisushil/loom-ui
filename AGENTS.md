# loom-ui — notes for agents and contributors

loom-ui is a semantic UI framework for [loom](../loom). Its Experience Model **compiles to loom's
`Blueprint`**, so loom's renderers draw what this framework composes. Design:
`../loom/docs/requirements/2026-09-21-loom-ui-design.md`. The Blueprint contract it targets is
versioned: `BLUEPRINT_IR_VERSION` in `@loom/blueprint-runtime`, today 2.4.0 (loom ADRs 0096, 0097, 0098, 0099, 0100, 0101).

## How loom is consumed

loom is an unpublished pnpm monorepo. Every `@loom/*` dependency here is redirected by
`pnpm.overrides` in `./package.json` to `link:../loom/{packages,plugins}/<name>`. So:

- **`../loom` must be checked out next to this repo, installed and built** (`pnpm install && pnpm build`
  there), or nothing resolves.
- Packages declare `"@loom/x": "*"`; the override wins. Never `workspace:*` — there is no loom
  package in this workspace.
- Using a new `@loom/*` package? Add its `link:` line to `pnpm.overrides` **and** the `link:` lines of
  any `@loom/*` packages it depends on (pnpm resolves transitive deps through the same map).
- Third-party versions live in `pnpm-workspace.yaml`'s `catalog:`; reference them as `"catalog:"`.
- Package `tsconfig.json`s extend `../../tsconfig.base.json` and carry **no** TypeScript project
  `references` into `../loom` — types resolve from `node_modules`.
- CI pins loom to `LOOM_REF` in `.github/workflows/ci.yml`. Bump it in the same PR that adapts to
  a loom change, after checking `../loom` out at that commit, rebuilding it, and running
  `pnpm typecheck && pnpm test` here.

## Rules

- Tests resolve loom from its **built `dist`**. Edit loom → rebuild loom → then test here.
- `pnpm typecheck` runs against loom's built `.d.ts`; it is the guard that catches a rotted import
  vitest would miss. CI runs it. It covers `src` only — the package `tsconfig.json`s exclude
  `*.test.ts` / `*.test-support.ts` because they must not be emitted into `dist`.
- Test files are typechecked by `pnpm typecheck:tests` (CI-gated); a test that does not typecheck
  is a defect. It runs each package's `tsconfig.test.json` (the same options, `noEmit`, nothing
  excluded), so a fixture that only compiles because vitest never typechecks it fails the build.
- Package `clean` scripts remove `dist` **and** `tsconfig.tsbuildinfo`; `rm -rf dist` alone lets
  `tsc --build` skip emit.
- `@loom-ui/core` is pure and isomorphic. Anything needing Node (crypto, fs) lives behind the
  `@loom-ui/core/log` subpath.
- `@loom-ui/hydration` has two entries. The root entry is server-side: it imports loom's sandbox
  (QuickJS WASM) and MCP plugin. `@loom-ui/hydration/client` (`src/client.ts`) is the browser entry
  for split hydration: the split controller, the loader contract, the store and param checks. Nothing it
  imports may reach `@loom/plugin-sandbox`, `@loom/plugin-mcp`, `@loom/effect-runtime`, a node builtin
  or a server module (`split/server.ts`, `provider.ts`, `controller.ts`, `invokers.ts`, `reshape.ts`,
  `cache.ts`, `repair.ts`). Code both halves share goes in `split/shared.ts`. `clientEntry.test.ts`
  walks the BUILT graph and fails on a violation.
- The catalogue is closed at runtime: a planner may only name entries; a gap is a finding.
- Never `.register()` on a loom default registry (`defaultTerminalRegistry`, React `defaultRegistry`,
  `litRegistry`); build your own and `.merge()` — the defaults are shared singletons.
- A widget's status is a Blueprint concern (`binding.status.path`), never a projection read in an
  adapter; spans are grid cells, never props; `source` says what a widget stands for and is never in
  `props`. A span therefore applies ONLY under a `grid` parent (it becomes that cell's span); under a
  `row`/`column` parent — a flex layout with no columns — it is not applicable and is dropped without
  a finding (loom ADR 0097 D5). That is why `genesis`' default root — the one the reference planner
  composes into — is a 12-column `grid`: the span the compose prompt asks the model for lands as a cell.
- A node's `row` / `rowSpan` / `column` (1-based grid lines, loom ADR 0098) are, like `span`, a position
  in its PARENT grid and compile into that `GridCell`. Unlike `span` they are never silently inapplicable:
  under a `row`/`column` parent, or on the root, they are a `placement-outside-grid` error, and off the
  12 columns a `placement-out-of-range` error. `validateExperience` reports such state in pre-existing
  data (the cell then compiles unplaced); every op refuses creating it — `setPlacement`, `insertNode`
  and `moveNode` raise both codes, so a log recorded before these refusals that inserted a placed node
  off a grid or overflowing it no longer replays. `moveNode` of a placed node out of a grid is refused:
  clear it first with `setPlacement { row: null, column: null, rowSpan: null }`. A resize that makes a
  placed node overflow is refused (the interactive path never clamps); only the reference planner, on a
  widening revision, clamps `column` to `GRID_COLUMNS − span + 1` (every op-level refusal code is
  listed in the next bullet). A container's `title`
  is a `LocalizedText`, resolved at compile like a label. `renderBlueprintDom` draws both the way loom's
  React renderer does (ADR 0098 D4): a cell's grid lines land on the child's OWN element — no wrapper —
  and a titled container renders as `<section aria-label><h2>` + the layout element, so the SECTION is
  the grid item, never the heading. The web renderers (React, Lit) and the terminal agree on reading
  order only when a grid's cells are all placed or all unplaced; a partially placed grid falls to CSS
  grid auto-placement on the web and to row-then-column order in the terminal (loom's
  `renderBlueprintToString`, which `@loom-ui/renderer-terminal` reaches by delegation; loom ADR 0098
  D4/D6).
- A container's `role` (Blueprint IR 2.2.0, loom ADR 0099) is the open, app-defined key a container
  renderer is registered under — never an ARIA role, never display text, never localised. Its one
  rule is loom's `isLayoutRole` (`LayoutRole` in core); never re-spell the regex or loosen it to
  `min(1)`. A malformed role in stored data is `role-invalid` (warn) and is not compiled. loom-ui
  ships NO role vocabulary here (built-in roles are a later slice); an example names its own.
  `setRole` is refused from widget actions (`role-op-not-interactive`); a widget's `insertNode` may
  still insert an already-roled container — harmless, a new container has no chrome state to lose.
- Container renderers (`DomRenderOptions.containers`, keyed by role): the adapter owns `body`, every
  child's mount / keyed reconcile / reorder / placement / subscription, the focus pin and the section
  wrap; the app owns only chrome and child VISIBILITY (`hidden`/`inert`/`aria-*`/`role`/`id`/`class`
  on the elements it is handed). `update` is required and fires only when the layout's own fields,
  its child element list/order, or a child's own fields changed — an identical Blueprint is zero
  mutations (MutationObserver tests in `containers.test.ts`). A role change is a reported remount; a
  throwing container renderer falls back to the plain container in place with a finding, children
  never lost. The adapter restores only visibility on a throw; a renderer's `dispose` MUST undo
  every other attribute it set on children (`role`, `aria-labelledby`, `id`, `class`). The terminal has no counterpart seam: a role prints the plain container.
- Op refusal codes — the complete list `apply` (and so `replay`) can return, by op; a new
  `refuse("…")` in `operations.ts` fails `refusalCodesDocs.test.ts` until it is listed here and in the
  README. Every op: `invalid-operation` (the op fails the `Operation` schema) and `tree-too-deep` (the
  base, or the tree an `insertNode` would produce, nests past `MAX_TREE_DEPTH`). `insertNode`:
  `duplicate-node-id`, `missing-parent`, `not-a-container` (the parent), and `placement-outside-grid`
  / `placement-out-of-range` for any placed node in the inserted subtree. `removeNode`:
  `root-immutable`, `missing-node`. `moveNode`: `root-immutable`, `missing-node`, `not-a-container`
  (the destination is absent or not a container), `cyclic-move`, `placement-outside-grid` /
  `placement-out-of-range`. `setPlacement`: `root-immutable`, `missing-node`, `empty-placement` (names
  no field), `placement-outside-grid`, `invalid-operation` (the placed node fails the node schema),
  `placement-out-of-range`. `setTitle`: `missing-node`, `not-container`. `setRole`: `missing-node`,
  `not-container`, `invalid-operation` (a role that is not `isLayoutRole`). `setProps` / `setLabel` /
  `bindProvider`: `missing-node`, `not-semantic`. `remapProvider`: `handle-mismatch` (`spec.handle` ≠
  `handle`). `removeProvider`: `missing-provider`, `provider-still-bound`. `prompt`: whatever its
  `materialized` ops return. Note `not-container` (`setTitle` / `setRole` on a semantic node) is a different code
  from `not-a-container` (an `insertNode` / `moveNode` parent that is not a container). `bindProvider`
  does not check that the handle is declared; `validateExperience` reports a binder with no provider
  as `unknown-handle`.
- A kind's value shape is declared ONCE in `@loom-ui/core` (`kindValueContracts`). Renderers validate
  with `checkKindValue` and render a visible error state; the planner pins `outputShapeHash` to values
  that pass.
- A framework kind is added in all of these places in one change: its zod contract in `kindValueContracts` and its name in `FRAMEWORK_KINDS` (`@loom-ui/core`), its `lu-*` element, its `litRegistry` entry and its `frameworkKindContracts` entry (`@loom-ui/renderer-lit`), and its `loomUiTerminalRegistry` renderer (`@loom-ui/renderer-terminal`). The parity tests in `litRegistry.test.ts` and `registry.test.ts` fail when one is missing. loom's built-in contracts (`MetricCard`, `DataTable`, `StatusBadge`, …) are never widened: a different shape is a new framework kind.
- Display text in a prop goes through the catalogue entry's `textProps`: a `LocalizedText` there resolves at compile via `resolveLabel`, like `label`. A renderer never looks a message key up.
- `@loom-ui/renderer-lit` is ESM (Lit is ESM-only) and tests under happy-dom; the other packages are
  CommonJS.
- Hydration is READ-ONLY and log-free: `@loom-ui/hydration` only ever calls `invokeTransient`. Drift is
  reported (`onDrift`), never repaired here; the app's durable execution applies `remapOperation`'s op and
  emits `SCHEMA_REPAIRED` (`inputDrift: "report-and-proceed"` still reports; it only lets a read-only
  viewer publish). Drift kinds: `input` (a step's schema pin moved — `remapOperation` repairs it) and
  `output` (the reshaping no longer works for the output: a failed shape pin, a failed value contract
  (`contractKind`), or the reshaping itself failing on it (`reshapeFailure`) — only a planner repairs
  it). A `reshapeFailure` record keeps the handle `error`, not `stale`, and the public finding unchanged;
  it carries the raw output's shape and sample only, never a reshaped one. Pin `outputShapeHash` with `outputShapeHashOf` — nothing else — or declare
  `outputCheck: "contract"`, whose kinds come from the bound nodes at execution time (`handleKinds`), never
  from the spec. A provider never reaches a browser: split hydration ships `handleInventory` and answers with
  `serveHandle`. Every new `ProviderSpec`/`MCPToolNode` field is optional with no default, so sealed
  Experiences keep their hashes (`experience.test.ts` guards it).
- A handle's status is `pending` | `ready` | `stale` | `error` | `empty` (`HandleState`). `empty` (loom
  ADR 0100) is ONLY a dependent step whose `{{steps.…}}` path indexes past the end of a real upstream
  array (`walkPath`'s `out-of-range`) — finding `upstream-empty`, a warn. Every other path miss stays
  `unresolved-step-reference` (an error), and a bad path anywhere in the step wins. `empty` carries no
  value (the projection fold drops it — `HYDRATION_PROJECTION_VERSION` 1.1.0), is never cached, never
  drift and never repaired; `outcomeResult` maps it for both the controller and `serveHandle`, and
  `upstream-empty` is in the split server's public code vocabulary (`FIXED_CODES` + `publicText`). A new
  hydration finding code a client may see goes into BOTH, or it is served as `load-failed`/`load-warning`.
- A planner returns OPERATIONS, never an Experience, and every model call runs inside `ctx.decide` so
  replay never re-calls a model. `@loom-ui/planner` imports no invoker, effect runtime, projection
  runtime or LLM provider (`noLookups.test.ts`); capabilities and context arrive resolved from the caller.
- Anything tool-authored that will be shown to a model (samples, observed drift values) is wrapped with
  `@loom/classify`'s `tainted` at the producer and fenced as DATA in a user message — never in `system`.
- An observed sample belongs to a HANDLE (one call: tool + arguments), never to a tool@version. Drift
  samples reach a planner on `ReviseInput.observed` (keyed by handle, built by `observedSamples`, never
  rendered into a prompt), and a rebuilt provider is pinned only against its own call's sample — with no
  such sample it is kept, dropped with a warn, or reported (`sample-not-observed` / `drift-sample-missing`), never pinned from
  another handle's output. `CapabilityRef.sampleOutput` (one per tool) is only the fallback
  (`driftCapabilities`) when a tool's drift is a single observation.
- `reviseForDrift<R extends PlanResult>(planner: DriftReviser<R>, …): Promise<R>` resolves to the
  planner's OWN revise result: a planner whose `revise` returns more than a `PlanResult` gets every
  extra field back (only `findings` may grow). A planner reproducing it by hand composes the exported
  helpers: `driftRequest`, `driftContext`, `observedSamples`, `driftCapabilities`, `unsampledDrift`.
- A widget that keeps its id and kind WITHIN ITS CONTAINER is never re-created: `renderBlueprintDom`'s `update` patches it in place, and the subtree holding the focused element never leaves the DOM. Containers are keyed by layout id (Blueprint IR 2.4.0, loom ADR 0101 — `compile` emits every container's node id, root included) plus type plus role, so inserting or reordering containers keeps every widget inside them; a layout WITHOUT an id (hand-built) falls back to its ordinal among its id-less siblings, and an id'd container never matches an id-less one (no positional fallback on an id miss). A widget that moves to another container, or whose container's id, type or role changes (or, id-less, whose ordinal shifts), IS re-created — and, like a renderer without `DomWidgetHandle.patch`, it is REPORTED in `RecomposeReport.remounted`, never silently.
- User-entered state is DOM state. A renderer overwrites an input's value only when the BOUND value changed — never on `patch`, never on a re-render that the value did not cause (a Lit property binding such as `<input .value=${…}>` satisfies this — Lit dirty-checks property parts against the last value it set; an imperative `el.value = …` in `render()`/`updated()` that runs on every render does not).
- loom-ui is a generic UI framework on top of loom, for ANY app; any consumer is never the design centre. No consumer names or prefixes anywhere in the repo (theme tokens are `--lu-*`, elements `lu-*`) — `packages/core/src/genericity.test.ts` enforces it; README's `## Consumers` section is the one place a consumer is named. State every capability as a consumer-neutral need; a contract describes the widget, not a consumer's payload (a consumer with an idiosyncratic shape adapts at its own boundary). Every capability ships with a reference example in loom-examples that is not a specific consumer's app. Review question for every change: would an unrelated app use this as-is?
