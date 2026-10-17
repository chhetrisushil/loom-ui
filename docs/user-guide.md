# loom-ui user guide

loom-ui is a generic UI framework on top of loom (the sibling repository it compiles to). You
describe a screen as an **experience**, a tree of semantic nodes with stable ids bound to data by
handle, and loom-ui **compiles** it, per surface, to a loom `Blueprint` that loom's renderers draw.
Composition is recorded as a content-addressed artifact plus the operations that produced it, so a
view can be replayed, revised without losing node identity, and rendered with no model in the path.

New here? Do [getting started](getting-started.md) first (about ten minutes, every snippet runs). This
page then gives you the concepts, and a guide per task.

## Contents

- [Concepts](#concepts)
- [Guides by task](#guides-by-task)
- [Which package do I import from?](#which-package-do-i-import-from)
- [Reading order](#reading-order)
- [How the code in these docs is kept honest](#how-the-code-in-these-docs-is-kept-honest)

## Concepts

```text
 intent + catalogue + capabilities
              │   planner (or your code)                 operations
              ▼                                              │
        Operation[] ──replay──▶ Experience ──seal──▶ versionHash (content address)
                                    │
              compile(surface, catalogue, viewer, audience)
                                    ▼
   providers ──hydrate──▶ values/status ──▶ Blueprint ──▶ renderer ──▶ pixels, text, speech
```

### Experience

The composed artifact:
`{ experienceId, versionHash, parents, intent, root, providers, vocabularyFloor, meta }`. `root` is a
tree, `providers` declares how each handle's data is fetched, `parents` links versions into a line,
and `intent` (`objective`, `source`) says what it was composed to satisfy. You never mutate one;
every change produces a new experience.

### Node

Every node has a stable `id` (minted once, never reused) and a fractional `order` key between which you
can always insert. A **container** has a `direction` (`row`, `column` or `grid`), an optional `title`,
an optional `role` and `children`. A **semantic node** names a catalogue entry (`type`,
`typeVersion`), carries `props` and an optional `label`, and may bind data. Both carry `span` and
optional grid placement (`row`, `rowSpan`, `column`). The default root is a 12-column grid so a
child's `span` lands in a cell.

### Binding and handle

A semantic node's `binding` is `{ handle, priority, sensitivity? }`. The **handle** names a provider
in `experience.providers`; many nodes may share one. `priority` (`P0`, `P1`, `P2`) schedules the load.
A node may instead bind another loom projection (`projection`), but never both. The compiled
blueprint reads the handle's value and status at `values.<handle>` and `status.<handle>`.

### Operations and deterministic replay

An `Operation` is one of `insertNode`, `removeNode`, `moveNode`, `setProps`, `setLabel`, `setTitle`,
`setRole`, `setPlacement`, `bindProvider`, `unbindProvider`, `remapProvider`, `removeProvider`,
`declassifyHandle` or `prompt`. `apply` and `replay` are deterministic and total: a refusal is a typed
`Finding`, not a throw. A model call is *not* an operation; a planner turns a model reply into
operations and records the call as a loom decision, so replay never calls the model again.
→ [Composing and revising](guides/composing.md).

### Sealing and the content address

`seal` mints `versionHash`, a sha256 over the canonical, parsed artifact. The same operations always
give the same address; any change gives a different one. Operations themselves are not part of the
address, which is why [lineage](guides/lineage-and-changes.md) re-checks that recorded operations
reproduce it.

<!-- snippet: imports -->

```ts
import { type Operation, compile, genesis, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration/client";
```

<!-- snippet: address -->

```ts
const ops: Operation[] = [
  {
    type: "insertNode",
    parentId: "root",
    node: {
      id: "note",
      order: "V",
      kind: "semantic",
      type: "Metric",
      typeVersion: "1.0.0",
      span: 6,
      props: { unit: "ms" },
      binding: { handle: "latency", priority: "P0" },
    },
  },
];
const start = () =>
  genesis({ experienceId: "demo", intent: { objective: "Demo", source: "user" }, meta });

const a = replay(start(), ops);
const b = replay(start(), ops);
if (!a.ok || !b.ok) throw new Error("replay refused");

// Same operations, same content address, on any machine, in any order of construction.
seal(a.value).versionHash === seal(b.value).versionHash; // true

// A compile never throws on a bad experience: the problems are findings. Here the binding
// names a handle with no provider.
const { findings, ok } = compile(seal(a.value), {
  surface: "web",
  catalog,
  hydrationProjectionId: HYDRATION_PROJECTION_ID,
  hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
});
findings.map((f) => `${f.severity} ${f.code} ${f.nodeId}`); // ["warn unknown-handle note"]
```

### Catalogue, kinds and surfaces

A **semantic catalogue** is the closed vocabulary an experience may use: each entry has a `name`,
`version`, allowed `props`, a `binding` rule (`required`, `optional`, `none`) and, per **surface**, a
resolution: the loom widget **kind** that draws it there (with its contract), or a `degradeTo`
another entry. A surface is an open string: `web` and `terminal` have first-party renderers; any
other name is the host's own modality. A planner may only name catalogue entries. The framework's
own kinds (`TimeSeries`, `BarChart`, `Kpi`, `Table`, `StatusCard`, `Note`, `A2UIView`, `SandboxView`,
plus media, chat and input kinds) have value contracts declared once, in `@loom-ui/core`.

### Compile and findings

`compile(experience, options)` resolves every node through the catalogue and returns
`{ blueprint, findings, ok }`. It is pure, never throws on a bad experience, and omits what it cannot
resolve. Findings carry a stable `code`, a `severity` and often a `nodeId`; some are **server-side
only** because they name real ids. → [Troubleshooting](guides/troubleshooting.md#compile-findings).

### Sensitivity, viewers and audiences

A binding may be classified (`internal`, `sensitive`, `secret`). `compile` draws a node a viewer may
not see as a placeholder, a broadcast audience as a redacted widget, and the data boundary must agree.
→ [Sensitivity, viewers and audiences](guides/sensitivity-and-audiences.md).

## Guides by task

| I want to... | Guide | Reference | Example (`loom-examples`) |
| --- | --- | --- | --- |
| compose, revise without losing identity, detect a stale author, merge two forks | [Composing](guides/composing.md) | [composition](reference/composition.md) | `experience-merge`, `experience-recompose`, `experience-layout` |
| load data, split client and server, pass a time range, handle drift | [Hydration](guides/hydration.md) | [hydration](reference/hydration.md) | `split-hydration` |
| draw in a terminal, with Lit, with React; tabs and steppers; theme | [Rendering](guides/rendering.md) | [rendering](reference/rendering.md), [theming](reference/theming.md) | `experience-kinds`, `experience-stepped`, `experience-layout` |
| hide classified data, build a wallboard, keep the boundary in step | [Sensitivity and audiences](guides/sensitivity-and-audiences.md) | [audience](reference/audience.md) | `experience-broadcast`, `media-gallery` |
| keep a head, undo, branch, notify people of changes | [Lineage and the change feed](guides/lineage-and-changes.md) | | `provenance-explain` |
| let a model compose, repair drift, learn which layout works | [Planners and learning](guides/planners-and-learning.md) | [planning](reference/planning.md) | `experience-tabs-planner`, `planner-decide-scope`, `planner-learning` |
| draw on a new surface and pass the conformance kit | [Writing a renderer](guides/writing-a-renderer.md) | [rendering](reference/rendering.md) | `incident-shared-chat`, `media-gallery` |
| work out what an error or finding means | [Troubleshooting and FAQ](guides/troubleshooting.md) | | |

## Which package do I import from?

| Need | Import |
| --- | --- |
| Build, edit, replay, compile (Node or browser) | `@loom-ui/core` (zod-free browser slice: `@loom-ui/core/browser`) |
| Seal, store and read artifacts (Node: touches hashing) | `@loom-ui/core/log` |
| Media, chat, signals, i18n words | `@loom-ui/core/media`, `/chat`, `/chat-ui`, `/signals`, `/messages` |
| Run providers (server) | `@loom-ui/hydration` |
| Load handles from a browser | `@loom-ui/hydration/client` |
| Terminal rendering | `@loom-ui/renderer-terminal` |
| Web rendering (bundler only) | `@loom-ui/renderer-lit/dom`, `/register`, `/containers`, `/media`, `/chat` |
| Compose with a model | `@loom-ui/planner` (server) |
| Head, versions, undo, seen log | `@loom-ui/lineage` (server) |
| Change feed, unread counts | `@loom-ui/changes` (server) |
| Interaction signals to rewards | `@loom-ui/learning` (server) |
| Prove a renderer | `@loom-ui/renderer-conformance`, `/vitest` |

Per-package detail is in each [package README](../packages). loom-ui consumes the unpublished loom
checkout beside it; see [getting started](getting-started.md#prerequisites).

## Reading order

A one-page reference card is [the cheatsheet](cheatsheet.md).

1. [Getting started](getting-started.md) and the concepts above.
2. [Composing](guides/composing.md), then [Hydration](guides/hydration.md) and
   [Rendering](guides/rendering.md): the minimum for a working screen.
3. [Sensitivity and audiences](guides/sensitivity-and-audiences.md) before you show anything to a
   second person.
4. [Planners and learning](guides/planners-and-learning.md) and
   [Lineage and the change feed](guides/lineage-and-changes.md) when a model or several authors
   are involved.
5. [Writing a renderer](guides/writing-a-renderer.md) for new surfaces.

## How the code in these docs is kept honest

Every ` ```ts ` block here and in the guides is either mirrored from a test under
[`docs/snippets`](snippets) (it type-checks under `pnpm typecheck:tests` and
runs under `pnpm test`, and a test fails if the doc and the code differ) or carries an
`<!-- illustrative: reason -->` marker saying why it is not compiled. Imports are checked against the
built `.d.ts` of the entry point they name, including subpaths such as `@loom-ui/core/log` and
`@loom-ui/hydration/client`.
