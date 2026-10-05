# @loom-ui/renderer-terminal

String renderers for every framework kind, merged over loom's own kind-aware terminal registry,
plus `renderExperience` and `watch` — the terminal rendering surface for the `Blueprint`
`@loom-ui/core` compiles and the projection state `@loom-ui/hydration` publishes. Where
`@loom-ui/renderer-lit` mounts DOM elements, this package renders one plain-text frame; status
(loading/empty/stale/error) comes entirely from loom's own Blueprint traversal — this package
contributes only the per-kind value check.

## Install / import

```
pnpm add @loom-ui/renderer-terminal
```

```ts
import { renderExperience, watch, terminalRegistry } from "@loom-ui/renderer-terminal";
```

## Key concepts

- **The status matrix is loom's.** Since Blueprint IR 2.0.0 each binding declares its status
  channel (`status.<handle>`, beside `values.<handle>` in the same projection state), and loom's
  own `renderBlueprintToString` applies the eight-row decision table (loading, ready, empty,
  stale, error, …). This package contributes exactly one thing to it: what a bound VALUE must look
  like, through the `check` seam loom leaves open — `kindValueCheck`.
- **One registry, merged over loom's.** `terminalRegistry()` returns loom's
  `defaultTerminalRegistry` merged with this package's own renderers for the framework kinds
  (`TimeSeries`, `BarChart`, `Kpi`, `Table`, `StatusCard`, `Note`, `A2UIView`, `SandboxView`) — a
  fresh registry each call, since loom's default registries are shared singletons that must never
  be mutated in place.
- **`renderExperience` reads one well-known projection.** A `HydrationStore` always publishes
  under `HYDRATION_PROJECTION_ID`; `renderExperience` maps every OTHER projection id the Blueprint
  declares to `undefined` state, so a binding under a different id renders as its honest loading
  row rather than an error.
- **Numeric parity with the web.** Every framework-kind renderer here formats a number exactly as
  `@loom-ui/renderer-lit`'s `measure()` would for the same value, format and unit — same rounding,
  grouping, currency symbol and unit suffix — via `@loom-ui/core`'s `formatSemanticNumber` and
  `effectiveFormat`, at one fixed locale (`en-US`) so the terminal output does not vary with the
  host's own locale.

## API

- `renderExperience(blueprint, store: HydrationStore, opts?: RenderExperienceOptions): string` —
  render one frame: loom's status matrix over `store.state()`, this package's registry and value
  check by default. `opts.registry` overrides the registry.
- `watch(blueprint, store, onFrame: (frame: string) => void, opts?): () => void` — call `onFrame`
  now and on every change to the store's projection (via `store.runtimeSubscribe`); returns an
  unsubscribe function.
- `terminalRegistry(): RendererRegistry<TerminalWidgetRenderer>` — loom's built-in terminal
  registry merged with `loomUiTerminalRegistry`. Call it fresh each time you need one.
  `terminalRegistry({ chrome: "host" })` (also on `renderExperience` and
  `createLoomUiTerminalRegistry`) is for an app that draws its own title bar or frame: the
  framework kinds print no `Title:` prefix — ready, error (`✗ msg`) or loading (`—`) — and a Kpi's
  caption trails the figure, and multi-line bodies (Table, TimeSeries, BarChart) print with no
  4-space hanging indent — that indent only sits rows under the `Title:` lead, which host chrome
  does not have (so a narrow cell keeps its columns). Default `"widget"` is unchanged. loom's own traversal rows (status
  lines) and its eight built-in kinds are loom's output and keep their titles. Only a non-empty
  string is a title: `""` or a non-string (`0`, `5`) is none — the kind stands in, a Note prints no
  title — exactly as in the lit renderer. `renderExperience` throws if given both `chrome` and
  `registry` (chrome would be silently ignored); use `terminalRegistry({ chrome })` for yours.
- `loomUiTerminalRegistry` — just the framework kinds' renderers, unmerged, for a caller building
  its own composed registry.
- `sparkline(values: readonly number[]): string` — an eight-level Unicode sparkline (`▁▂▃▄▅▆▇█`)
  over a series of numbers, used by the `TimeSeries` renderer and available standalone.
- `kindValueCheck: WidgetValueCheck` — the framework's per-kind value contract, plugged into
  loom's `check` seam; exported so a caller assembling its own `renderBlueprintToString` call can
  reuse it.
- `RenderExperienceOptions` — `{ registry?, chrome?, projectionState?, projectionSubscribe? }`.
  `projectionState(id)` supplies the state of any NON-hydration projection the blueprint declares
  (a node bound through core's `SemanticNode.projection`), e.g.
  `(id) => runtime.getState(id, store.executionId)`; absent or throwing, its widgets render as
  loading. `projectionSubscribe(onChange)` lets `watch` re-render when such a projection changes.

## Examples

Rendering once, and re-rendering on every change (illustrative — not a compiling snippet):

```ts
import { renderExperience, watch } from "@loom-ui/renderer-terminal";

// One frame, right now:
process.stdout.write(renderExperience(blueprint, store));

// Live: re-render on every hydration update, clearing the screen each time.
const stop = watch(blueprint, store, (frame) => process.stdout.write(`\x1Bc${frame}`));
// later: stop();
```

Composing your own registry (illustrative):

```ts
import { loomUiTerminalRegistry } from "@loom-ui/renderer-terminal";
import { defaultTerminalRegistry } from "@loom/plugin-renderer-terminal";

const myRegistry = defaultTerminalRegistry.merge(loomUiTerminalRegistry).merge(myOwnKinds);
```

## Notable behaviours and guarantees

- **A restricted node prints as a `Note`.** `compile({ viewer })` replaces a node the viewer may
  not see with a static, unbound `Note`, printed as `Restricted: Restricted` (or `Restricted` under
  `chrome: "host"`); it is bound to nothing, so a value the store happens to hold is never read.
  Enforcement is `compile`'s and hydration's, not the renderer's.

- **A declared channel with no value yet prints loom's loading row** (`⋯ <title>`); an `empty`
  status prints `○ <title>: <message>` — both are loom's own rows, not this package's.
- **A value that fails its kind's contract shows a visible error**, never a silent blank: every
  framework-kind renderer here checks the bound value with `checkKindValue` (via `kindValueCheck`)
  before drawing it.
- **Unbound widgets read props, not a channel.** `Note` is never bound: loom calls its renderer
  with `value === undefined`, and its text comes from `props.text` — a compiled `LocalizedText`
  always resolves to its fallback text at compile time, so the terminal never shows a message key.
- **Web-only kinds say so, honestly.** `A2UIView` and `SandboxView` cannot render their real
  content in a terminal (an A2UI interpreter and sandboxed script execution are web surfaces this
  CommonJS package does not import); their terminal renderers print
  `[A2UI view — rendered on the web]` / `[sandboxed component — rendered on the web]` rather than
  faking a render.
- **Never mutate a shared registry.** `terminalRegistry()` and `loom-ui`'s framework registry are
  built fresh; never call `.register()` on loom's own `defaultTerminalRegistry` — it is a shared
  singleton other code may depend on being unmodified.
- **Deterministic, bounded output.** A long series or table never spreads its full length into a
  single-pass min/max (avoiding V8's argument-count ceiling); `Table` prints at most 20 rows before
  an `"… N more rows"` line, and every numeric column is width-capped so one long cell cannot push
  the rest of a row off-screen.

## See also

- [../core/README.md](../core/README.md) — the framework kinds and number semantics this package
  renders, and `checkKindValue`.
- [../hydration/README.md](../hydration/README.md) — the `HydrationStore` and projection state
  `renderExperience`/`watch` read.
- [../renderer-lit/README.md](../renderer-lit/README.md) — the DOM counterpart surface, with the
  same numeric formatting.
- [../../README.md](../../README.md) — root overview.
