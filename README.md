# loom-ui

> **Disclaimer:** The idea behind loom-ui is mine (Sushil Chhetri), but the codebase is vibe coded using Claude ([Claude Code](https://claude.com/claude-code)).

loom-ui is a generic UI framework on top of [loom](../loom). You describe an **experience**: semantic
nodes such as `Metric`, `Trend` or `Collection`, with stable ids, bound to data by handle. loom-ui
compiles it, per surface, to a loom `Blueprint` that loom's own renderers draw. Because composition is
recorded as a content-addressed artifact plus the operations that produced it, a view can be replayed,
revised without losing node identity, and rendered with no model in the path.

## Contents

- [Key concepts](#key-concepts)
- [Packages](#packages)
- [Requirements](#requirements)
- [Install, build and test](#install-build-and-test)
- [Where next](#where-next)
- [Consumers](#consumers)

## Key concepts

- **Experience.** The composed artifact: a tree of semantic nodes with stable ids, the providers they
  bind to, and the intent it was composed for. It is sealed under a content address, so identical
  content always has the same hash.
- **Operations and replay.** Every edit is an operation (`insertNode`, `moveNode`, `setProps`, ...).
  `apply` refuses an invalid one with a typed finding, and `replay` folds a recorded list of
  operations back into the same artifact, deterministically.
- **Compile to a Blueprint.** `compile` turns an experience into loom's `Blueprint` for one surface
  and viewer. Nodes the viewer may not see become redacted placeholders; the Blueprint carries
  layout, spans, status bindings and the semantic type each widget stands for.
- **Hydration.** `@loom-ui/hydration` resolves the data handles an experience binds, through loom's
  transient effects, and publishes them as one loom projection, in-process or split across a trust
  boundary. It is read-only: drift is reported, and repair is the app's durable job.
- **Renderers.** The Blueprint is drawn by loom's React renderer, by `@loom-ui/renderer-lit` (a DOM
  adapter and Lit elements) or by `@loom-ui/renderer-terminal`. A shared conformance kit holds every
  renderer to the same contract.
- **Lineage.** `@loom-ui/lineage` keeps a head per experience, advanced by compare-and-set, and
  records revert, undo and branch as new versions, each verified by replay.
- **Planner.** `@loom-ui/planner` turns an intent, a closed catalogue and the available tools into
  operations through loom's `ctx.decide`, so a replay serves the recorded decision with no model call.

## Packages

| Package | What it is | README |
| --- | --- | --- |
| `@loom-ui/core` | Experience Model, operations with deterministic replay, the semantic catalogue, and the compiler to a loom `Blueprint` | [packages/core](packages/core/README.md) |
| `@loom-ui/hydration` | Resolves provider handles through loom's transient effects and publishes them as one projection, in-process or split | [packages/hydration](packages/hydration/README.md) |
| `@loom-ui/planner` | Planner SPI (`compose` / `revise` to operations), a reference planner, drift re-authoring and a conformance kit | [packages/planner](packages/planner/README.md) |
| `@loom-ui/renderer-lit` | A DOM renderer adapter plus Lit elements for loom's kinds and the framework's own | [packages/renderer-lit](packages/renderer-lit/README.md) |
| `@loom-ui/renderer-terminal` | String renderers for every framework kind, merged over loom's terminal registry, with hydration status | [packages/renderer-terminal](packages/renderer-terminal/README.md) |
| `@loom-ui/renderer-conformance` | One set of renderer contract checks, run through a small adapter by any renderer | [packages/renderer-conformance](packages/renderer-conformance/README.md) |
| `@loom-ui/lineage` | Server-side, optional: head pointer with compare-and-set, version walk, revert / undo / branch as new versions, replay verification | [packages/lineage](packages/lineage/README.md) |
| `@loom-ui/changes` | Server-side, optional: a `ChangeFeed` over lineage events, viewer-safe change descriptions, unread cursors, head signals | [packages/changes](packages/changes/README.md) |
| `@loom-ui/learning` | Server-side, optional: untrusted interaction signals folded into one bounded vote per viewer, late rewards, planner-variant comparison | [packages/learning](packages/learning/README.md) |

## Requirements

- **Node.js 22 or newer.** CI runs Node 22.
- **pnpm 9.14.4**, pinned by `packageManager`; enable it with `corepack enable`.
- **A sibling `../loom` checkout, installed and built.** loom is an unpublished monorepo. Every
  `@loom/*` dependency here is redirected by `pnpm.overrides` in [package.json](package.json) to
  `link:../loom/...`, so nothing resolves until `../loom` has had `pnpm install && pnpm build`.
  Tests and typechecks read loom's built `dist`: after editing loom, rebuild it first.
- CI pins loom to the commit in `LOOM_REF` ([.github/workflows/ci.yml](.github/workflows/ci.yml)).
  Bump it in the same change that adapts to a loom change.

The loom-ui packages are not published. A consumer checked out beside this repo depends on them with
`link:` entries such as `"@loom-ui/core": "link:../loom-ui/packages/core"`.

## Install, build and test

```sh
# in ../loom, once and after every loom change
pnpm install && pnpm build

# in this repo
pnpm install
pnpm build
pnpm test
pnpm typecheck         # src, against loom's built declarations
pnpm typecheck:tests   # test files too
pnpm lint              # biome
```

`pnpm clean` removes every package's `dist` and `tsconfig.tsbuildinfo`. Contributor rules (the
client-graph guards, the genericity rule, how to add a framework kind) are in [AGENTS.md](AGENTS.md).

## Where next

- [Codebase guide](docs/codebase-guide.md): architecture of loom and loom-ui, where to start
  reading, and walkthroughs of the data and control flow.
- [Getting started](docs/getting-started.md): install, compose, compile and render a first
  experience.
- [User guide](docs/user-guide.md): task-oriented guides for each capability.
- [Cheatsheet](docs/cheatsheet.md): one reference card for the model, the packages' main exports and
  the things that reliably bite.
- Reference pages, one per topic:
  - [Composition](docs/reference/composition.md): operations, placement, container roles, framework
    kinds, number semantics, refusal codes.
  - [Hydration](docs/reference/hydration.md): options, params, empty upstream, split hydration, which
    entry to import.
  - [Rendering](docs/reference/rendering.md): React, Lit and terminal, recomposing a live tree,
    container renderers.
  - [Audience](docs/reference/audience.md): viewer and broadcast surfaces, redaction, findings.
  - [Planning](docs/reference/planning.md): the reference planner and drift repair.
  - [Theming](docs/reference/theming.md): the `--lu-*` custom properties.
- Package READMEs: [core](packages/core/README.md), [hydration](packages/hydration/README.md),
  [planner](packages/planner/README.md), [renderer-lit](packages/renderer-lit/README.md),
  [renderer-terminal](packages/renderer-terminal/README.md),
  [renderer-conformance](packages/renderer-conformance/README.md),
  [lineage](packages/lineage/README.md), [changes](packages/changes/README.md),
  [learning](packages/learning/README.md).
- [AGENTS.md](AGENTS.md): notes for contributors and coding agents.
- Design: `loom/docs/requirements/2026-09-21-loom-ui-design.md` in the loom repo.

## Consumers

- [genUI](https://github.com/chhetrisushil/genUI): generative dashboards and authoring, the first
  consumer. Its server composes through loom-ui, its web and TUI render the compiled Blueprint, and
  its private view model is deleted (migration phases 6.1-6.3, shipped 2026-10-12; loom
  `docs/requirements/2026-09-23-genui-migration-design.md`).
