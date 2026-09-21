# loom-ui

A semantic UI framework for [loom](https://github.com/chhetrisushil/loom). You describe an
**experience** — semantic nodes such as `Metric`, `Trend`, `Collection`, with stable ids, bound to
data by handle — and loom-ui compiles it, per surface, to a loom `Blueprint` that loom's renderers
draw. Composition is recorded as a content-addressed artifact plus the operations that produced
it, so a view can be replayed, revised without losing node identity, and rendered without a model
in the path.

| Package | Job |
|---|---|
| `@loom-ui/core` | Experience Model, operations + deterministic replay, semantic catalogue, compiler to loom `Blueprint`; `./log` subpath for content-addressed persistence |
| `@loom-ui/hydration` | Resolves an Experience's provider handles through loom's transient effects (MCP graph → sandbox/JSONPath reshape → shape check), publishes them as one loom projection (`loom-ui.hydration`), schedules by priority, caches per principal, reports drift for the app's durable repair |
| `@loom-ui/renderer-lit` | A loom DOM renderer adapter (`renderBlueprintDom`, subpath `./dom`) and Lit elements registered under loom kinds (`litRegistry`) — every built-in kind plus `TimeSeries`/`BarChart`; four app-level elements (time-range picker, locale picker, sandbox, A2UI view) |
| `@loom-ui/renderer-terminal` | `TimeSeries`/`BarChart` string renderers merged over loom's terminal registry, hydration-status decoration (`renderExperience`), and `watch` |

Design: `loom/docs/requirements/2026-09-21-loom-ui-design.md`. Contributor notes: `AGENTS.md`.

## Shape of a composition

*Illustrative — not a compiling snippet.* It elides the `meta`, `ctx` and `contentStore` a real
caller supplies, and names a catalogue it does not define.

```ts
import { apply, compile, genesis } from "@loom-ui/core";
import { EXPERIENCE_COMPOSED, putExperience } from "@loom-ui/core/log";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration";

let exp = genesis({ experienceId: "checkout-triage", intent: { objective: "Investigate checkout latency", source: "user" }, meta });
const r = apply(exp, { type: "insertNode", parentId: "root", node: { id: "p99", order: "V", kind: "semantic", type: "Metric", typeVersion: "1.0.0", span: 6, props: { unit: "ms" }, binding: { handle: "latency-p99", priority: "P0" } } });
if (!r.ok) throw new Error(r.finding.message);

// Inside a loom execution: seal, store the bytes, log the reference (a userspace event).
// `putExperience` is total — an experience carrying a value the content address cannot be taken
// over (NaN, a bigint) comes back as an `artifact-unhashable` finding rather than a throw.
const put = await putExperience(contentStore, r.value);
if (!put.ok) throw new Error(put.finding.message);
ctx.emit(EXPERIENCE_COMPOSED, { ref: put.ref, parents: put.experience.parents, ops: [{ op, by: { source: "user" }, at: now }] });

// Anywhere, later, with no model in the path: compile per surface and hand loom the Blueprint.
const { blueprint, findings } = compile(put.experience, { surface: "web", catalog, hydrationProjectionId: HYDRATION_PROJECTION_ID, hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION });
```

## Shape of hydration (illustrative — not a compiling snippet)

```ts
import { HydrationController, HydrationStore, SCHEMA_REPAIRED, remapOperation } from "@loom-ui/hydration";

const store = new HydrationStore(projectionRuntime, { experienceId: experience.experienceId, principalId: viewer.id });
const controller = new HydrationController({
  invoker: effectRuntime,                 // EffectRuntime satisfies TransientInvoker
  store,
  principal: { id: viewer.id, chain: viewer.principalChain },
  onDrift: (report) => durableRepair(report),  // the app's loom execution, not this package
});
controller.load(experience);              // P0 now, P1 in 50 ms, P2 on markVisible
// ...compile(experience, { hydrationProjectionId: HYDRATION_PROJECTION_ID, hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION, ... })

// Inside durableRepair (a loom execution):
const r = remapOperation(report.spec, report.drift);
if (r.ok) { const next = apply(sealedExperience, r.op); /* seal + put + */ ctx.emit(SCHEMA_REPAIRED, { ...report, op: r.op }); }
```

## Rendering (illustrative — not a compiling snippet)

```ts
// Web, React: loom's renderer, unchanged.
<BlueprintRenderer blueprint={blueprint} projectionRuntime={runtime} executionId={store.executionId} registry={defaultRegistry} />

// Web, Lit: the same blueprint through the DOM adapter with the Lit registry.
import { litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
const handle = renderBlueprintDom(document.getElementById("app"), blueprint, { projectionRuntime: runtime, executionId: store.executionId, registry: litRegistry });

// Terminal: loom's registry plus the framework kinds, with hydration status.
import { renderExperience, watch } from "@loom-ui/renderer-terminal";
const stop = watch(blueprint, store, (frame) => process.stdout.write(`\x1Bc${frame}`));
```

`TimeSeries` and `BarChart` are Lit-only on the web (`LIT_ONLY_KINDS`): a React consumer gets loom's `[No renderer for …]` placeholder for them. Value shapes per kind are declared once in `@loom-ui/core` (`kindValueContracts`); a mismatch renders as a visible error state on every surface.

`@loom-ui/renderer-lit` is browser code: `node -e "import('@loom-ui/renderer-lit/dom')"` fails outside
a bundler, on two counts. No other package here declares it as a dependency, so pnpm never links it
into another package's `node_modules` for bare-specifier resolution to find. And even resolved
directly (`node dist/dom/index.js`), its `moduleResolution: "Bundler"` build emits extensionless
relative specifiers (`./litRegistry`, not `./litRegistry.js`) that only a bundler's resolver
completes — plain Node ESM resolution requires the extension. Its consumer is a bundler (Vite,
webpack, …); that is the supported path, not a plain Node `import()`.
