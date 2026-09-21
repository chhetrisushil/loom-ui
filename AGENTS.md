# loom-ui — notes for agents and contributors

loom-ui is a semantic UI framework for [loom](../loom). Its Experience Model **compiles to loom's
`Blueprint`**, so loom's renderers draw what this framework composes. Design:
`../loom/docs/requirements/2026-09-21-loom-ui-design.md`. The Blueprint contract it targets is
versioned: `BLUEPRINT_IR_VERSION` in `@loom/blueprint-runtime` (loom ADR 0096).

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
  vitest would miss. CI runs it.
- Package `clean` scripts remove `dist` **and** `tsconfig.tsbuildinfo`; `rm -rf dist` alone lets
  `tsc --build` skip emit.
- `@loom-ui/core` is pure and isomorphic. Anything needing Node (crypto, fs) lives behind the
  `@loom-ui/core/log` subpath.
- The catalogue is closed at runtime: a planner may only name entries; a gap is a finding.
- Never `.register()` on a loom default registry (`defaultTerminalRegistry`, React `defaultRegistry`);
  build your own and `.merge()` — the defaults are shared singletons.
