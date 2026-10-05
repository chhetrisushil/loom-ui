# E — loom-ui genericity and optionality audit (2026-10-05)

Scope: loom-ui main 0b58739 (5 packages), loom main 2309ca3. Read-only; every claim below was checked in non-test source unless flagged. Docs/ADRs/READMEs were used only as pointers and are cited only where the code backs or contradicts them.

## Verdicts

- **Genericity: MOSTLY.** No consumer names, no vendor/LLM/CSS-framework lock, no domain nouns in logic. But the *data plane* is hard-wired to MCP tools, the *widget vocabulary* is dashboard-shaped, the Experience can only bind to loom-ui's own hydration projection, `Surface` is a closed enum, the i18n seam is identity (English baked in), and there is no input/form/state model.
- **Optionality: YES, fully.** Nothing in loom's non-test code imports or depends on `@loom-ui/*`. A loom app has a complete (if minimal) UI path without it. Loom has however grown generic IR features (IR 2.1–2.4) at loom-ui's request; they are harmless to non-users, but loom's React renderer deliberately ignores part of them (roles), so the two UI paths are diverging in capability.
- **Adoption by a 3P: NOT READY.** All packages are `private: true`, 0.0.x, `@loom/*` deps are `"*"` resolved only through a sibling-checkout `link:` override, no `files`/`sideEffects`/peerDeps, no runnable quickstart (README marks its snippets "illustrative — not a compiling snippet").

## 1. Packages

| Package | Purpose (from code) | Key exports | Verdict |
|---|---|---|---|
| `@loom-ui/core` (CJS, ~3.0k LOC src; `.`, `./browser`, `./log`) | Experience tree (`node.ts`), content-addressed artifact (`experience.ts`), replayable ops (`operations.ts`), semantic catalogue + per-surface resolution (`catalog.ts`), `compile` Experience->loom Blueprint (`compile.ts`), kind value contracts (`values.ts`, `kindValues.ts`) | `genesis`, `apply`, `replay`, `compile`, `defineSemanticCatalog`, `Experience`, `FRAMEWORK_KINDS`, `checkKindValue` | MOSTLY GENERIC. Tree/ops/catalogue are domain-free; `ProviderSpec` hard-codes MCP; `Surface` closed; kind-contract registry closed; 6 of 8 framework kinds are dashboard-flavoured |
| `@loom-ui/hydration` (CJS, ~3.9k; `.`, `./client`) | Resolves a handle's `ProviderSpec` by walking an MCP-tool graph through loom `invokeTransient`, reshaping (JSONPath / QuickJS sandbox / Named), drift-pinning, caching, publishing one projection (`HydrationStore`) | `HydrationController`, `SplitHydrationController`, `executeProvider`, `hydrationProjection`, `serveHandles` | MCP-SPECIFIC (generic mechanism, one transport). Hardcodes `MCP_INVOKE_TOOL_ID` as the only data source |
| `@loom-ui/planner` (CJS, ~3.1k) | Planner SPI: intent + catalogue + capabilities -> ops through `ctx.decide`; `ReferencePlanner`, `interpretAction`, conformance kit, declared reach | `ReferencePlanner`, `PlannerModel`, `CapabilityRef`, `checkPlannerConformance`, `interpretAction` | MOSTLY GENERIC. LLM-agnostic (structural `PlannerModel`, `spi.ts:62`), but capabilities are MCP tools and the plan contract is a *flat* node list on a 12-col grid |
| `@loom-ui/renderer-lit` (ESM, ~4.9k; `.`, `./dom`) | Generic Blueprint->DOM adapter (keyed reconcile, roled containers) + Lit widgets under loom kinds, a11y, RTL, plural, sandbox/A2UI embeds | `renderBlueprintDom`, `createLitRegistry`, `elementRenderer`, `Lu*` widgets | GENERIC adapter / MOSTLY widgets (English strings, dashboard widgets). Its `dom` half has nothing loom-ui-specific except kind contracts |
| `@loom-ui/renderer-terminal` (CJS, ~0.4k) | Terminal renderers for the framework kinds merged over loom's terminal registry; `renderExperience`, `watch` | `createLoomUiTerminalRegistry`, `renderExperience`, `watch` | GENERIC, but hard-codes locale `en-US` (`registry.ts:42`) |

No package is INERT; all five are imported by `loom-examples` (experience-*, split-hydration, planner-decide-scope, blueprint-status, order-lines).

## 2. Genericity leaks (by severity)

### P1 — structural

**G1. Data plane is MCP-only, baked into the core artifact schema.** `core/src/experience.ts:21-35` defines `MCPToolNode` (`toolName`, `toolSchemaHash`) and `ProviderSpec.executionGraph: MCPToolNode[]` (`:36-77`). `hydration/src/provider.ts:314` invokes only `MCP_INVOKE_TOOL_ID`; `invokers.ts:290` passes anything else through. `planner/src/spi.ts:14-29` `CapabilityRef` is an MCP tool. Consequence: a loom app whose data comes from a loom tool, a read-model, an A2A peer, `live-query`, or `agent-surface` cannot be bound without wrapping it as an MCP server. Reshaping is also tied to `@loom/plugin-sandbox` (`reshape.ts:4`). Fix: make `ProviderSpec.executionGraph` step type an open `{ toolId, ... }` (keep MCP as one step kind), have hydration dispatch on the step's tool id, take a `ProviderSpec` step-kind registry. Placement: **loom-ui** (core + hydration). Note this changes the content-hash schema -> needs an artifact version.

**G2. A node can only bind to loom-ui's own hydration projection.** `compile.ts:133-140` always emits `projectionId: opts.hydrationProjectionId` with path `values.<handle>`. There is no way to bind a node to an existing loom projection (agent status, approval queue, execution timeline, `agent-surface` state). This is the single biggest expressiveness gap for "agent-status views / approval queues / chat transcripts" - the things a loom app most wants to show are loom projections, not MCP reads. Fix: let `binding` optionally carry `{ projectionId, path }` (the Blueprint IR already supports it: `DataBinding.projectionId/path`) and have `compile` emit it and list the projection in `blueprint.projections`/`projectionVersions`. Placement: **loom-ui core** (loom IR needs no change).

**G3. `Surface` is a closed union.** `core/src/catalog.ts:22` `"web" | "terminal" | "chat"`; `compile` and `validateExperience` take it. A voice, native, A2UI or MCP-App surface requires a fork. Also `"chat"` compiles but no renderer anywhere draws it (grep: only the type). Fix: `Surface = string` (with `"web"|"terminal"` as documented well-knowns) or a generic parameter; drop or implement `chat`. Placement: **loom-ui core**.

**G4. i18n is identity, so English is baked into the web renderer.** `renderer-lit/src/i18n.ts` `t(key, fallback)` returns `fallback ?? key` with no host override ("There is no host override" - the file says so). 14 modules call it; the a11y strings (`"line chart"`, `"No data"`, `"loading"`, `"error"`, `"stale"`, `"table with"` - `a11y.ts:57-113`) and plural fallbacks are English. The doc comment says user-visible strings are "the app's to localize" - the code gives the app no way to. Terminal fixes `LOCALE = "en-US"` (`renderer-terminal/src/registry.ts:42`) and plurals likewise. Fix: `setMessages(catalog)` / `configure({ t })` on renderer-lit, a `locale` option on the terminal registry. Placement: **loom-ui renderers**.

**G5. No input / form / local-state model.** `ExperienceNode` has `props` + one read-only `binding` (`node.ts:84-99`); `compile` emits no actions. User-entered values have no path back except a bare `WidgetAction` handled by the app (`interaction.ts` `interpretAction`: only `experience.op` is interpreted, everything else is "business"). There are no input widgets (no text field, select, checkbox, date) in `litRegistry.ts:63-79` or in `FRAMEWORK_KINDS`. Forms and wizards are therefore app-side; "wizard" is partially served by container `role` (stepped example). Not a leak, an expressiveness gap to state honestly. Placement: **loom-ui** (input kinds + a `writeBack` binding) or **app/3P** (own kinds via the open registries, see below).

### P2 — vocabulary / defaults

**G6. Widget vocabulary is dashboard-shaped.** `FRAMEWORK_KINDS` (`core/src/kindValues.ts:18-27`) = TimeSeries, BarChart, Kpi, Table, StatusCard, Note, A2UIView, SandboxView. `StatusLevel` = ok/warning/critical (`values.ts:130`), `KpiValue.deltaPct`, `lu-time-range-picker` ("A dashboard-level time-range control", `:12`), `DEFAULT_TIME_RANGE = {from:"$now-24h", to:"$now"}` (`hydration/src/params.ts:17`), relative-time tokens `$now-7d`. Not wrong, but the *only* shipped catalogue content is observability-flavoured; there is no shipped default `SemanticCatalog` at all (only test catalogues: `core/src/testCatalog.test-support.ts`, `planner/src/testing.test-support.ts`) - every adopter writes the catalogue from scratch. No map/canvas/media/transcript widgets. Fix: ship a neutral reference catalogue + 3-4 generic kinds (text/markdown, list/feed, key-value, form-field) or label the 8 kinds "the metrics pack" and move them. Placement: **loom-ui** (a `-pack` split) or **3P**.

**G7. Kind value contracts are a closed registry; custom kinds pass silently.** `kindValues.ts:404` `CONTRACTS[kind]` (const) and `values.ts:150-152` `kindValueContracts` (a `Readonly` const). `checkKindValue` returns `ok` for an unknown kind (`values.ts:158-160`), so an app's own kind gets *no* contract check, including under `outputCheck: "contract"` - the vacuous-check shape. There is no `registerKindContract`. Fix: accept a contracts map in `ExecuteOptions`/`checkKindValue` (a `ContractRegistry` arg), refuse "contract" mode for a kind with no contract. Placement: **loom-ui**.

**G8. Planner contract is a flat node list on a 12-col grid.** `planner/src/prompt.ts:19` ("a flat list of semantic nodes under one root ... a 12-column row"); containers/roles are never produced by the reference planner. So tabbed/stepped/section layouts are authorable by an app via ops but not by the model. Placement: **loom-ui planner** (documented limitation; extend `PlanDraft` if wanted).

**G9. renderer-terminal pulls the server hydration entry for a constant.** `renderer-terminal/src/status.ts:2` `import { HYDRATION_PROJECTION_ID, type HydrationStore } from "@loom-ui/hydration"` (root entry = sandbox + MCP plugin, per `hydration/src/index.ts`); `package.json` lists hydration as a hard dependency. `./client` exports the same constant and type (`hydration/src/client.ts`). Fix: import from `/client`. Placement: **loom-ui**.

**G10. Planner hard-depends on hydration (and so on sandbox + MCP).** `planner/src/prompt.ts:7` `import { terminalSteps } from "@loom-ui/hydration"`; `package.json` deps. An app that wants only composition/planning loads QuickJS WASM. `terminalSteps`/`topoWaves` are pure graph helpers (`hydration/src/plan.ts`). Fix: move to core (or a `graph` subpath). Placement: **loom-ui**.

### P3 — comments / hygiene

- **G11.** Consumer vocabulary leaks as the word "studio" in comments: `renderer-lit/src/widgets/lu-time-range-picker.ts:14`, `lu-sandbox.ts:18`, `lu-locale-picker.ts:6`, `lu-a2ui-view.ts:19`. The `genericity.test.ts` consumer-name pattern covers only one consumer's name and prefixes; it passes while the studio coupling remains. Placement: **loom-ui** (reword; widen the fitness regex).
- **G12.** `lu-locale-picker` default `["en-US"]` (`:20`) and `i18n.ts:12` fallback locale `"en-US"` are English defaults, acceptable if G4 is fixed.
- **G13.** `Intent.source` enum, `Priority` P0/P1/P2, `Sensitivity` (loom `DataClass` subset, `node.ts:34`) are generic; checked, no finding.

Swept clean (code, non-test): consumer names/prefixes (the patterns `genericity.test.ts` enforces), LLM vendors (`PlannerModel` is structural), CSS frameworks (`--lu-*` tokens only), domain nouns (database/SQL/incident/release/replica - only hits are the English verb "release" in `invokers.ts` and "materialised"), hard-coded tool ids other than `mcp.invoke`/sandbox.

### Expressiveness of the model

| UI | Verdict | Why |
|---|---|---|
| Dashboard / metrics | native | all of FRAMEWORK_KINDS |
| Sections / tabs / stepped wizard layout | yes (app-authored) | container `role` + `DomContainerRegistry` (`renderer-lit/src/dom/registry.ts`, `ContainerNode.role` `node.ts:62`) |
| Forms | no | G5, no input kinds, no write-back |
| Chat transcript | partial | `StreamingText`/`Timeline` kinds are loom's, bound to ONE value; `"chat"` surface unimplemented (G3) |
| Timeline / feed | partial | `Timeline` (`lu-list`) |
| Approval queue | partial | `ApprovalCard` emits APPROVE/REJECT actions (`lu-simple.ts:184`); data must come via MCP (G1/G2) |
| Agent-status view | blocked on G2 | loom state cannot be a binding source |
| Canvas / map / media | via custom kind | allowed (below) but no contract registry (G7) and no shipped kind |

### Is the widget catalogue open?

Yes at build time, no at several seams.
- Semantic catalogue: `defineSemanticCatalog` takes any entries (`catalog.ts:58`); a new type resolves to any loom kind per surface; a non-builtin kind must declare `props` + `binding` (`loomCatalog.ts:41-47`). "CLOSED at runtime" is by design.
- Renderers: `RendererRegistry` is loom's; `createLitRegistry(...).register("MyKind", renderer)` works, `elementRenderer(tag)` wraps any custom element (`litRegistry.ts:9-35`). Container chrome is open by role (`DomContainerRegistry`).
- Closed: `Surface` (G3), kind value contracts (G7), `reshaping.engine` enum `JSONPath|QuickJS|Named` (`experience.ts:57`, though `Named` is the escape hatch), provider step type (G1).

## 3. Optionality and dependency direction

### 3a. Does loom depend on loom-ui? NO.
- No `@loom-ui` / `loom-ui` in any loom `package.json`, tsconfig or workflow (grep over the repo excluding docs/ADRs/node_modules returned none).
- Non-test source mentions are comments only: `plugins/renderer-terminal/src/renderBlueprint.ts:130`, `packages/verify/src/reach.ts:66`. `plugins/renderer-react/src/renderContainer.test.tsx:299`, `packages/blueprint-runtime/src/irVersion.test.ts`, `packages/workflow-runtime/src/namedCancellationErrors.test.ts` are tests.
- Docs: ADRs 0086, 0088, 0096-0101, `docs/requirements/*`, `docs/examples.md:166`, `AGENTS.md:53`, CHANGELOG describe loom-ui as a consumer/sibling. None claims loom *requires* it. The only mention in `AGENTS.md`/`docs/examples.md` is the `planner-decide-scope` example row, which lives in `loom-examples`.
- Reverse structural contracts are done well: loom-ui's planner declares reach under `Symbol.for("loom.verify.reach")` with an explicit "No dependency on @loom/verify" (`planner/src/reach.ts:1-6`); loom's `verify/src/reach.ts` reads it structurally.
- Scaffold/CLI/compiler/create-loom-app reference nothing from loom-ui. `loom-starter` and `db-command-center` in loom-examples do not depend on it (only 9 experience-ish examples do).

### 3b. Can a loom app build a UI without loom-ui? YES.
What loom provides (all non-test, all with commits since July):
- `@loom/blueprint-runtime` (2.2k LOC): `blueprint$`, `grid/flex/stack`, 8 builtin widgets, `customWidget$`, `validateBlueprint`, catalogue, IR version `2.4.0` (`irVersion.ts`), `RendererRegistry`, pin checks. Last commit 2026-09-23.
- `@loom/projection-runtime`, `@loom/live-query`, `@loom/agent-surface` (patch-based surface + provenance).
- `@loom/plugin-renderer-react` (1.3k LOC): 8 widget renderers, container/grid placement, last touched 2026-09-23.
- `@loom/plugin-renderer-terminal`, `@loom/plugin-a2ui` (1.3k), `@loom/plugin-mcp-app` (0.7k, last 2026-09-30), A2A.
Gaps vs loom-ui: React has no charts/KPI/table-with-formats, no roled containers (`renderContainer.tsx:52-54` ignores `Layout.role` on purpose; terminal likewise `renderBlueprint.ts:142`), no i18n/RTL/a11y layer, no keyed live recompose, no Experience/planner/hydration. But nothing is degraded or removed: the extension mechanism (`customWidget$` + registry) is identical, and the React renderer kept pace with IR 2.x (grid cell keys by layout id, 2026-09-23). Evidence of *capability migration*, not abandonment: the new UI features (layout roles, hydration status `empty`, placement) landed in loom's IR but their only full renderer is loom-ui's Lit adapter, so a React-only app gets the data model without the chrome. Verdict: loom's own path is a real but minimal alternative; it is not stale.

Placement note: the DOM/web-component Blueprint adapter (`renderer-lit/src/dom/*`) is generic and would be the natural loom-side `plugin-renderer-dom` if loom wants a non-React web path with no loom-ui dependency; today a plain-loom user wanting DOM must take `@loom-ui/renderer-lit` -> `@loom-ui/core`.

### 3c. Coupling from loom-ui into loom (declared vs imported, from `package.json` and src)

| loom-ui pkg | declared `@loom/*` deps | actually used at runtime | proportionate? |
|---|---|---|---|
| core | blueprint-runtime, classify (types), core, plugin-content, zod | blueprint-runtime (`compile.ts`, `node.ts:1` `isLayoutRole`, `loomCatalog.ts`), `@loom/core` + plugin-content ONLY in `log.ts` | `.` entry needs only blueprint-runtime; `core`/`plugin-content` should be optional peers for `./log` |
| hydration | classify, core, effect-runtime, plugin-mcp, plugin-sandbox, projection-runtime | mcp: only `MCP_INVOKE_TOOL_ID`/`MCP_INVOKE_ERRORS`; sandbox: `SANDBOX_TOOL_ID`, `shapeHash`, `shapeOf`, `SANDBOX_ERRORS` (`reshape.ts:4`, `provider.ts:12`, `split/server.ts:12-13`) | server entry: forced by G1. `./client` is clean (no sandbox/MCP, enforced by `clientEntry.test.ts`) |
| planner | core, hydration, blueprint-runtime, classify, plugin-content (type) | `@loom/core` (`TypedFailure`), classify, `terminalSteps` from hydration | forces sandbox+MCP via hydration (G10) |
| renderer-lit | blueprint-runtime, projection-runtime | both; `@loom-ui/hydration` is devDep only | proportionate |
| renderer-terminal | blueprint-runtime, plugin-renderer-terminal, projection-runtime, hydration | hydration runtime import (G9) | hydration dep avoidable |

Internals: no deep imports (`@loom/x/src`, `/dist`, `../loom`) anywhere in loom-ui src (grep clean). All imports are from package roots. Dependencies on loom *plugins* (`plugin-mcp`, `plugin-sandbox`, `plugin-content`) are the semver-sensitive ones: hydration destructures typed error channels (`SANDBOX_ERRORS.scriptError/limitExceeded`, `reshape.ts:62-80`) and `shapeHash`/`shapeOf` from the sandbox plugin; a minor change to those is a loom-ui break. `@loom/classify`'s `DataClass` is re-exposed in `Sensitivity` (`node.ts:34`), so a classify change alters loom-ui's artifact schema.

Proportionality verdict: core + renderer-lit are proportionate. hydration/planner force MCP and the QuickJS sandbox on every consumer even for a non-MCP app (follows from G1). Recommendation: after G1, make `plugin-mcp` an optional peer (separate `@loom-ui/hydration-mcp` or subpath), keep sandbox as optional peer used only for `reshaping.engine: "QuickJS"`; declare `@loom/core`/`plugin-content` as optional peers of `core/log`.

### 3d. Version coupling

- `LOOM_REF` pinned in `.github/workflows/ci.yml` to `3d2056e569ed82dc6dede8e7bc5ad22a99658dd8` (loom is 7 commits ahead at 2309ca3). CI checks out loom at that SHA with a PAT; no matrix over loom versions.
- Every `@loom/*` dep is `"*"`; the root `package.json` `pnpm.overrides` redirect all 12 of them to `link:../loom/...`. loom-ui and loom therefore cannot evolve independently: there is no semver range anywhere, so a published loom-ui would claim compatibility with every loom.
- Compatibility contract exists only in tests: `core/src/blueprintIr.test.ts:23-25` pins `BLUEPRINT_IR_VERSION` to `"2.4.0"` and goes red on a bump. **No runtime check**: loom-ui source never reads `BLUEPRINT_IR_VERSION`/`blueprintIrVersion` (grep non-test: none), and `compile` stamps no IR version on its output. Nor does it check any SPI version. Fix: assert `BLUEPRINT_IR_VERSION` major/minor at `compile` (finding `ir-version-mismatch`) and declare `peerDependencies` ranges once loom publishes. Placement: **loom-ui** (and **loom** to publish).
- Existing good practice: the artifact's structural reach contract (3a) and the zod-free browser entries.

## 4. Packaging and adoption

- All five packages: `"private": true`, `version 0.0.1`, no `files`, `repository`, `publishConfig`, `sideEffects`, no `peerDependencies` (every loom dep is a hard `dependencies: "*"`).
- `workspace:*` is used between loom-ui packages (fine for pnpm publish) and `catalog:` for third parties; the loom `link:` override is root-only, so a consumer that installs a published tarball would get unresolvable `@loom/*` `"*"` (loom itself is unpublished: `AGENTS.md`).
- Formats: core, hydration, planner, renderer-terminal are CJS (`tsconfig.base.json` module `CommonJS`, no `"type"`); renderer-lit is ESM (`"type": "module"`). The terminal renderer's own comment says it "cannot import" renderer-lit because it is CommonJS. No dual build, no `.mjs`. `exports` map uses `types` + `default` only (no `import`/`require`/`browser` conditions).
- Browser: good - `@loom-ui/core/browser` and `@loom-ui/hydration/client` are zod-free / sandbox-free and guarded by bundle tests (`browserEntry.test.ts`, `clientEntry.test.ts`, `browserBundle.test.ts`). But the core main entry imports `@loom/blueprint-runtime` at runtime (`node.ts:1`), contradicting "pure and isomorphic" only if blueprint-runtime/`@loom/core` are not browser-safe; unverified.
- Side effects: `renderer-lit/src/widgets/index.ts` registers every custom element by import, `litRegistry.ts:1` imports it, and `litRegistry = createLitRegistry()` is built at module load; with no `sideEffects` field a bundler cannot tree-shake the widgets an app does not use. Also `renderer-lit/src/index.ts` re-exports all widgets.
- Quick-start: none runnable. README "Shape of a composition / hydration / rendering / planning" are explicitly "illustrative - not a compiling snippet" (`README.md:47,67,119,162`). The real quickstarts are the `loom-examples` experience-* examples, which require both sibling checkouts. There is no `create-loom-ui` scaffold and no minimal "hello experience" with an in-memory data source.

## 5. Layering inside loom-ui

```
core  <-  hydration  <-  planner
core  <-  renderer-lit             (hydration = devDep only)
core, hydration <- renderer-terminal
```
- core imports no other loom-ui package. It does not depend on renderers, hydration or planner. PASS.
- renderer-lit depends only on core (`/browser`) at runtime; an app can use core + its own renderer, or core + renderer-lit without hydration (`noHydration.test.ts` exists). PASS.
- renderer-terminal and planner depend on hydration at runtime (G9, G10) - the layering leak to fix; both are avoidable.
- An app can use only core + its own renderer: yes, `compile()` yields a loom `Blueprint` and `renderBlueprintDom`-equivalent is loom's own contract. But because `compile` emits only hydration-projection bindings (G2), the app must also run hydration (or supply the `values.<handle>` projection itself - possible since `HYDRATION_PROJECTION_ID` is just a projection id, but undocumented).

## 6. Top problems ranked (see report summary)

1. G1 data plane MCP-only (loom-ui core+hydration)
2. G2 bindings only to hydration projection; loom state unbindable (loom-ui core)
3. Packaging: private/0.0.x, `*` deps via sibling `link:`, no ranges, no quickstart (loom-ui; loom must publish)
4. No runtime IR/SPI version check; compat pinned only by a test (loom-ui)
5. G4 i18n identity - English baked into renderer-lit and terminal (loom-ui)
6. G3 `Surface` closed; `chat` has no renderer (loom-ui)
7. G10/G9 planner + renderer-terminal force hydration -> sandbox + MCP (loom-ui)
8. G7 kind contract registry closed; custom kinds validate vacuously (loom-ui)
9. G5/G6 no input/form model; vocabulary + only catalogue are dashboard-shaped, no shipped neutral catalogue (loom-ui / 3P)
10. renderer-lit side-effect registration without `sideEffects`; generic DOM adapter lives in loom-ui (loom-ui; consider loom `plugin-renderer-dom`)

Minor: G11 "studio" comments + weak fitness regex; loom's React renderer ignores `Layout.role` so IR 2.2+ features only have a full renderer in loom-ui.
