# Getting started with loom-ui

This page takes you from a fresh checkout to a drawn dashboard: you will compose an experience,
compile it for a surface, hydrate it with data and render it in a terminal, then see the same
blueprint drawn on the web. Every code block below is real code. It is mirrored from a test that
type-checks and runs under `pnpm typecheck:tests` and `pnpm test`, so it cannot drift from the API
(see [How the snippets stay honest](#how-the-snippets-stay-honest)).

When you finish, the [user guide](user-guide.md) is the index for everything else.

## What you are building

loom-ui describes a screen as an **experience**: a tree of semantic nodes (`Metric`, `Trend`,
`Collection`, ...) with stable ids, each optionally bound to data by a **handle**. You do not draw
it. You **compile** the experience, per surface, to a loom `Blueprint`, and one of loom's renderers
draws that. Hydration fills the handles with data on the way.

```text
 operations ──apply/replay──▶ Experience ──seal──▶ content address
                                  │
                       compile(surface, catalogue, viewer)
                                  ▼
 providers ──hydrate──▶ HydrationStore ──▶ Blueprint ──▶ renderer (terminal, Lit, React)
```

## Prerequisites

| You need | Version | Why |
| --- | --- | --- |
| Node.js | 22 (CI uses 22; loom declares `>=20`) | runs the build and the tests |
| pnpm | 9.14.4 (pinned by `packageManager`; use `corepack enable`) | the workspace manager |
| A sibling `loom` checkout | any commit that builds; CI pins `LOOM_REF` in `.github/workflows/ci.yml` | loom-ui compiles to loom's `Blueprint` and imports its `@loom/*` packages |

loom is **unpublished**, so loom-ui does not install it from a registry. Every `@loom/*` dependency
is redirected by `pnpm.overrides` in the root `package.json` to `link:../loom/...`. That makes the
two repositories siblings:

```text
workspace/
├── loom/       # pnpm install && pnpm build   (do this first)
└── loom-ui/    # this repo
```

If `../loom` is missing, or is not built, nothing resolves: the first symptom is
`Cannot find module '@loom/...'` from an install or a build. loom-ui's tests read loom's **built
`dist`**, so after you change loom, rebuild it before re-running anything here.

## Install and build

```sh
# once, in the loom checkout beside this one
(cd ../loom && pnpm install && pnpm build)

pnpm install
pnpm build           # every package, in dependency order
pnpm test            # unit tests, including the snippets on this page
pnpm typecheck       # src of every package, against loom's built .d.ts
pnpm typecheck:tests # tests included - this is what compiles the snippets
pnpm lint            # biome
```

Packages are workspace-private (`@loom-ui/*` is not published yet): you use them from inside this
workspace, or from a sibling repository that links them the way
[`loom-examples`](https://github.com/chhetrisushil/loom-examples) does (a `link:` override, as for
loom itself).

## 1. Compose an experience

Everything below runs in the `@loom-ui/docs-snippets` package. Start with the imports every later
step uses.

<!-- snippet: imports -->

```ts
import {
  type SemanticCatalog,
  apply,
  compile,
  defineSemanticCatalog,
  genesis,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationController,
  HydrationStore,
  type TransientInvoker,
  defineReshapers,
} from "@loom-ui/hydration";
import { renderExperience, watch } from "@loom-ui/renderer-terminal";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
```

A **catalogue** is the closed vocabulary an experience may use. Each entry says what props a node
type takes, whether it binds data, and how it resolves on each **surface**: which loom widget kind
draws it there. `Metric` here is drawn as a `Kpi` on the web and in the terminal.

<!-- snippet: catalogue -->

```ts
const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.quickstart.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: {
        web: { kind: "Kpi", props: ["unit", "format"], binding: "required" },
        terminal: { kind: "Kpi", props: ["unit", "format"], binding: "required" },
      },
    },
  ],
});
```

`genesis` starts a lineage with an empty 12-column grid as its root. `apply` adds one **operation**
to it. Operations never throw on bad input: `apply` returns `{ ok: true, value }` or
`{ ok: false, finding }`, so a refusal is data you can show or log.

<!-- snippet: compose -->

```ts
const start = genesis({
  experienceId: "checkout-latency",
  intent: { objective: "Watch checkout latency", source: "user" },
  meta: { author: "docs", createdAt: "2026-01-01T00:00:00Z", sourceKind: "example" },
});

const inserted = apply(start, {
  type: "insertNode",
  parentId: "root",
  node: {
    id: "p99",
    order: "V",
    kind: "semantic",
    type: "Metric",
    typeVersion: "1.0.0",
    span: 6,
    label: { key: "latency.p99", fallback: "p99 latency" },
    props: { unit: "ms" },
  },
});
if (!inserted.ok) throw new Error(inserted.finding.message);
```

The node needs data. A **provider** says how to get it (the tool to call, its schema pin, how to
reshape the answer) and is declared once per **handle**; a node then binds the handle. Both are
operations, so the whole composition stays a replayable log. `replay` folds a list of operations
and `seal` mints the content address (`versionHash`) over the result.

<!-- snippet: bind -->

```ts
const bound = replay(inserted.value, [
  {
    type: "remapProvider",
    handle: "latency-p99",
    spec: {
      handle: "latency-p99",
      executionGraph: [
        {
          stepId: "read",
          toolName: "metrics.query",
          toolVersion: "1.0.0",
          toolSchemaHash: "sha256:metrics-query-v1",
          arguments: { metric: "checkout.latency.p99" },
          dependsOn: [],
          idempotent: true,
        },
      ],
      reshaping: { engine: "Named", scriptRef: "to-kpi" },
      outputShapeHash: "",
      outputCheck: "contract",
      cachePolicy: { ttlSeconds: 30, scope: "global" },
    },
  },
  { type: "bindProvider", nodeId: "p99", handle: "latency-p99", priority: "P0" },
]);
if (!bound.ok) throw new Error(bound.finding.message);
const experience = seal(bound.value);
```

Three ideas are already in play, each covered in the [user guide](user-guide.md#concepts):

- the `id` (`p99`) is minted once and never reused, so a later revision can change the node
  without losing its identity;
- `order` is a fractional key, not an index, so two authors can insert at the same time;
- the sealed `versionHash` is a content address: the same operations always give the same hash.

## 2. Compile for a surface

`compile` turns the experience into a loom `Blueprint` for one surface. It never throws on a bad
experience: problems come back as `findings`, and `ok` is false only when one is an error.

<!-- snippet: compile -->

```ts
const { blueprint, findings, ok } = compile(experience, {
  surface: "terminal",
  catalog,
  hydrationProjectionId: HYDRATION_PROJECTION_ID,
  hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
});
if (!ok) throw new Error(findings.map((f) => `${f.code}: ${f.message}`).join("\n"));
```

`blueprint` is plain data. Its widgets declare where they read their value and status from in the
hydration projection (`values.latency-p99`, `status.latency-p99`), which is what lets any renderer
draw them with no loom-ui-specific code. See the
[composition reference](reference/composition.md) for every compile option.

## 3. Hydrate it

Hydration resolves the handles. In-process it needs a `HydrationStore` (the loom projection a
renderer reads), an invoker (anything with `invokeTransient`, such as a loom `EffectRuntime`) and a
`HydrationController`. Reshapers turn a tool's raw answer into the value the widget's kind expects;
`outputKinds` lets the controller check that value against the bound widget's contract.

<!-- snippet: hydrate -->

```ts
// Stands in for your loom EffectRuntime: hydration only ever calls `invokeTransient`.
const invoker: TransientInvoker = {
  async invokeTransient<TIn, TOut>(_toolId: string, _input: TIn): Promise<TOut> {
    return { p99Ms: 412.4 } as TOut;
  },
};

const store = new HydrationStore(new InMemoryProjectionRuntime(), {
  experienceId: experience.experienceId,
});
const controller = new HydrationController({
  invoker,
  store,
  contentRefArgs: "none",
  outputKinds: { catalog, surface: "terminal" },
  reshapers: defineReshapers({
    "to-kpi": (raw) => ({ value: (raw as { p99Ms: number }).p99Ms, unit: "ms" }),
  }),
});
controller.load(experience);
```

`controller.load` schedules by priority: `P0` handles load at once, `P1` after a short batching
window, `P2` when you call `controller.markVisible(handle)`. `contentRefArgs: "none"` is required
and says the experience binds no media tools. Hydration only ever reads: it never writes to the
event log. For the browser/server split and parameters see the
[hydration guide](guides/hydration.md) and the [hydration reference](reference/hydration.md).

## 4. Render in a terminal

The terminal renderer is the quickest way to see a result: it is a function from a blueprint and a
store to a string.

<!-- snippet: render -->

```ts
const frames: string[] = [];
const stop = watch(blueprint, store, (frame: string) => frames.push(frame));
// `frames` now holds the loading frame; the P0 handle lands a moment later.
```

`watch` calls you once now, with the loading frame (`⋯ p99 latency`), and again on every change of
the store. When the P0 handle lands, the next frame is:

```text
════════════════════════
  Watch checkout latency
════════════════════════
p99 latency: 412.4 ms
```

For a single frame, `renderExperience` is the same call without the subscription:

<!-- snippet: once -->

```ts
console.log(renderExperience(blueprint, store));
```

## 5. Render on the web

The same blueprint is drawn by loom's React renderer, or by loom-ui's Lit adapter. This is the Lit
version; it needs a DOM and a bundler (Vite, webpack, ...), because `@loom-ui/renderer-lit` is
ESM-only and not importable from plain Node.

<!-- snippet: lit in gettingStartedWeb.test.ts -->

```ts
import { litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import "@loom-ui/renderer-lit/register"; // defines the <lu-*> elements; nothing registers on import
```

Compile for the `web` surface (this page compiled for `terminal`; the catalogue resolves both),
then mount:

<!-- snippet: litRender in gettingStartedWeb.test.ts -->

```ts
const handle = renderBlueprintDom(host, blueprint, {
  projectionRuntime: runtime,
  executionId: store.executionId,
  registry: litRegistry,
});
```

Mounting returns a handle. Call `handle.update(nextBlueprint)` after a recompose and the adapter
patches the live DOM by node id, keeping focus, scroll and typed text. With React, hand the same
blueprint to loom's renderer instead; this is the only block on this page not compiled, because
this repository does not depend on React:

<!-- illustrative: React is not a dependency of this repo; the call is loom's BlueprintRenderer -->

```tsx
import { BlueprintRenderer, defaultRegistry } from "@loom/plugin-renderer-react";

<BlueprintRenderer
  blueprint={blueprint}
  projectionRuntime={runtime}
  executionId={store.executionId}
  registry={defaultRegistry}
/>;
```

loom-ui's framework kinds (`TimeSeries`, `BarChart`, `Table`, ...) are drawn by the Lit and
terminal renderers only; loom's React renderer shows `[No renderer for ...]` for them. See the
[rendering guide](guides/rendering.md).

## How the snippets stay honest

The code above lives in
[`docs/snippets/src/gettingStarted.test.ts`](snippets/src/gettingStarted.test.ts)
and
[`gettingStartedWeb.test.ts`](snippets/src/gettingStartedWeb.test.ts). Each block
is preceded by an HTML comment naming its `// #region`; a test compares the block to the region
byte for byte, and fails if a fenced `ts` block has no marker. Change the code in the test, run
`pnpm --filter @loom-ui/docs-snippets test`, and copy the region back. The test also runs the
walkthrough and asserts the terminal frame contains the metric.

## Where next

- [User guide](user-guide.md) - concepts, then a guide per task.
- Reference: [composition](reference/composition.md), [hydration](reference/hydration.md),
  [rendering](reference/rendering.md).
- Worked, runnable apps live in the sibling
  [`loom-examples`](https://github.com/chhetrisushil/loom-examples) repository, in `examples/`:
  `experience-layout` (placement and titles), `experience-recompose` (revise in place),
  `split-hydration` (the browser/server split) and `experience-kinds` (every framework kind).
