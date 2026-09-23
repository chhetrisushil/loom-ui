# loom-ui — notes for agents and contributors

loom-ui is a semantic UI framework for [loom](../loom). Its Experience Model **compiles to loom's
`Blueprint`**, so loom's renderers draw what this framework composes. Design:
`../loom/docs/requirements/2026-09-21-loom-ui-design.md`. The Blueprint contract it targets is
versioned: `BLUEPRINT_IR_VERSION` in `@loom/blueprint-runtime`, today 2.0.0 (loom ADRs 0096, 0097).

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
- The catalogue is closed at runtime: a planner may only name entries; a gap is a finding.
- Never `.register()` on a loom default registry (`defaultTerminalRegistry`, React `defaultRegistry`,
  `litRegistry`); build your own and `.merge()` — the defaults are shared singletons.
- A widget's status is a Blueprint concern (`binding.status.path`), never a projection read in an
  adapter; spans are grid cells, never props; `source` says what a widget stands for and is never in
  `props`. A span therefore applies ONLY under a `grid` parent (it becomes that cell's span); under a
  `row`/`column` parent — a flex layout with no columns — it is not applicable and is dropped without
  a finding (loom ADR 0097 D5). That is why `genesis`' default root — the one the reference planner
  composes into — is a 12-column `grid`: the span the compose prompt asks the model for lands as a cell.
- A kind's value shape is declared ONCE in `@loom-ui/core` (`kindValueContracts`). Renderers validate
  with `checkKindValue` and render a visible error state; the planner pins `outputShapeHash` to values
  that pass.
- `@loom-ui/renderer-lit` is ESM (Lit is ESM-only) and tests under happy-dom; the other packages are
  CommonJS.
- Hydration is READ-ONLY and log-free: `@loom-ui/hydration` only ever calls `invokeTransient`. Drift is
  reported (`onDrift`), never repaired here; the app's durable execution applies `remapOperation`'s op and
  emits `SCHEMA_REPAIRED`. Pin `outputShapeHash` with `outputShapeHashOf` — nothing else.
- A planner returns OPERATIONS, never an Experience, and every model call runs inside `ctx.decide` so
  replay never re-calls a model. `@loom-ui/planner` imports no invoker, effect runtime, projection
  runtime or LLM provider (`noLookups.test.ts`); capabilities and context arrive resolved from the caller.
- Anything tool-authored that will be shown to a model (samples, observed drift values) is wrapped with
  `@loom/classify`'s `tainted` at the producer and fenced as DATA in a user message — never in `system`.
- A widget that keeps its id and kind WITHIN ITS CONTAINER is never re-created: `renderBlueprintDom`'s `update` patches it in place, and the subtree holding the focused element never leaves the DOM. Containers are keyed by ordinal-among-container-siblings plus type, so a widget that moves to another container, or whose container's ordinal shifts or type changes, IS re-created — and, like a renderer without `DomWidgetHandle.patch`, it is REPORTED in `RecomposeReport.remounted`, never silently.
- User-entered state is DOM state. A renderer overwrites an input's value only when the BOUND value changed — never on `patch`, never on a re-render that the value did not cause (a Lit property binding such as `<input .value=${…}>` satisfies this — Lit dirty-checks property parts against the last value it set; an imperative `el.value = …` in `render()`/`updated()` that runs on every render does not).
- loom-ui is a generic UI framework on top of loom, for ANY app; a consumer (genUI included) is never the design centre. No consumer names or prefixes anywhere in the repo (theme tokens are `--lu-*`, elements `lu-*`) — `packages/core/src/genericity.test.ts` enforces it; README's `## Consumers` section is the one place a consumer is named. State every capability as a consumer-neutral need; a contract describes the widget, not a consumer's payload (a consumer with an idiosyncratic shape adapts at its own boundary). Every capability ships with a reference example in loom-examples that is not a specific consumer's app. Review question for every change: would an unrelated app use this as-is?
