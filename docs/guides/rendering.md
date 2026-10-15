# Rendering

**Purpose.** Draw a compiled blueprint in a terminal, in the browser with the Lit adapter, or with
loom's React renderer; use container roles for tabs and steppers; theme the result.

**Prerequisites.** A compiled `Blueprint` and, for bound widgets, a hydrated `HydrationStore`
([getting started](../getting-started.md)). Snippets are mirrored from
[`rendering.test.ts`](../snippets/src/rendering.test.ts).

## The one idea

loom-ui does not draw anything. `compile` produces a loom `Blueprint`: a layout of widgets, each
naming the **kind** that draws it and where it reads its value and status
(`values.<handle>`, `status.<handle>`). Any loom renderer draws any blueprint. loom-ui adds two
renderers for its own framework kinds (`TimeSeries`, `BarChart`, `Kpi`, `Table`, `StatusCard`,
`Note`, `A2UIView`, `SandboxView`, ...) and the media, chat and input kinds.

| Renderer | Package | Use it for | Framework kinds |
| --- | --- | --- | --- |
| Terminal | `@loom-ui/renderer-terminal` | CLIs, TUIs, logs, tests | all (web-only kinds print an honest marker) |
| Lit / DOM | `@loom-ui/renderer-lit` | web apps without React | all |
| React | loom's `@loom/plugin-renderer-react` | React apps | none: draws `[No renderer for ...]` |

The status of a widget (loading, empty, stale, error) is a **Blueprint** concern
(`binding.status.path`), decided by loom's traversal, so all renderers agree. What a renderer adds
is the per-kind drawing and a visible error when a bound value fails its kind's contract.

<!-- snippet: imports -->

```ts
import {
  type Experience,
  type Operation,
  type ProviderSpec,
  type SemanticNode,
  compile,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration/client";
import { referenceContainers } from "@loom-ui/renderer-lit/containers";
import { litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import "@loom-ui/renderer-lit/register";
import { renderExperience, terminalRegistry } from "@loom-ui/renderer-terminal";
```

## Terminal

`renderExperience(blueprint, store, opts?)` returns one frame as a string; `watch` calls you on every
store change. Status rows come from loom's own traversal; the package only contributes the value
check per kind. Numbers are formatted exactly as the web does, at a fixed `en-US` locale by default so
the bytes are deterministic.

<!-- snippet: terminal -->

```ts
// No terminal counterpart for container roles: a role prints the plain titled container.
console.log(renderExperience(terminal.blueprint, store));

// The host draws its own title bar? Drop the framework kinds' "Title:" prefix.
console.log(renderExperience(terminal.blueprint, store, { chrome: "host" }));

// Merge into a registry of your own; never `.register()` on a shared default.
const mine = terminalRegistry({ chrome: "host" });
```

A container's `role` has no terminal counterpart: it prints as the plain titled container, children
intact. Siblings print in `order` key order, which is why `Median` precedes `Tail` here.

Other things worth knowing: a restricted node prints as a `Note` (`Restricted`); a value that fails its
kind's contract prints an error instead of a blank; `Table` prints at most 20 rows; every fixed
word comes from the `LU_MESSAGES` catalogue and is overridable with the `i18n` option
(`terminalRegistry({ i18n })`).

## Web with the Lit adapter

`@loom-ui/renderer-lit` is **ESM-only and meant for a bundler** (Vite, webpack, esbuild). It is not
importable from plain Node: no other package here depends on it, and its build leaves
extensionless relative specifiers that only a bundler resolves. The symptom of
`node -e "import('@loom-ui/renderer-lit/dom')"` is a module-not-found error; that is expected, not
a bug in your setup. Tests run it under happy-dom.

Two import rules:

- **Registration is explicit.** Importing the package defines no custom element. Add
  `import "@loom-ui/renderer-lit/register"` (every `lu-*` element) or import only the elements you
  draw, e.g. `@loom-ui/renderer-lit/elements/lu-kpi`, so your bundle carries just those. A registry
  that mounts an undefined tag logs one warning naming the fix and draws an inert element.
- **Never `.register()` on a default registry** (`litRegistry`, `defaultTerminalRegistry`, React's
  `defaultRegistry`); they are shared singletons. Build your own registry and `.merge()`.

<!-- snippet: dom -->

```ts
const handle = renderBlueprintDom(host, web.blueprint, {
  projectionRuntime: runtime,
  executionId: store.executionId,
  registry: litRegistry,
  containers: referenceContainers(), // tabs and stepper; the app can add its own roles
  title: "none", // the host page already has a heading
});
```

The handle's `update(nextBlueprint)` **patches the live tree in place**, keyed by widget id and, since
IR 2.4.0, by container layout id. A widget that keeps its id and kind keeps its element, its
subscription and the user's typed text, caret, scroll and focus. This is why revising with in-place
operations ([composing](composing.md)) matters:

<!-- snippet: recompose -->

```ts
const revised = replay(experience, [{ type: "setProps", nodeId: "p99", patch: { unit: "s" } }]);
if (!revised.ok) throw new Error(revised.finding.message);
const next = compile(seal(revised.value), { ...opts, surface: "web" });
const report = handle.update(next.blueprint); // patched in place, by node id
```

`update` returns a `RecomposeReport` of what it could not carry over. A renderer never overwrites an
input's value unless the **bound value** changed.

Also on `DomRenderOptions`: `onAction` (see below), `compile` (the compile fingerprint string),
`title` (`"heading"` default, or `"none"` when the host page has a heading) and `onVisible`
(report a widget scrolled into view; map it to `controller.markVisible` for `P2` handles). Two more
scale options are opt-in: `coalesceUpdates(handle)` wraps a handle so many updates in a frame
render once, and `createLitRegistry({ virtualize: true })` windows long tables.

### Actions and stale views

Every action a widget emits reaches `onAction` stamped with the view it came from
(`viewedVersion`: version hash, the status of its binding, the compile fingerprint). Run
`isStaleAction(action, handle.head())` on the **server** that applies it and refuse unless it is
`fresh`; a viewer who approved a redacted view must not be able to approve a different one. See the
[renderer-lit README](../../packages/renderer-lit/README.md) for the verdicts.

## Containers, roles and placement

A container may carry a `role`: an open, app-defined key (never an ARIA role, never display text,
never localised) under which a **container renderer** is registered. loom-ui ships two reference
roles, `tabs` and `stepper`, and the renderers for them in `@loom-ui/renderer-lit/containers`
(`referenceContainers()`, or `tabsContainer()` / `stepperContainer()` singly). Each child of a
`tabs` or `stepper` container is a **titled** container; its title is the tab or step label. The
specs are `REFERENCE_CONTAINER_ROLES` in `@loom-ui/core`, which also run as findings on a built tree.

<!-- snippet: tabs -->

```ts
// A container's `role` is the app-defined key a container renderer is registered under.
// Each panel is a titled container; the tabs renderer labels a tab from its panel's title.
const panel = (id: string, title: string): Operation => ({
  type: "insertNode",
  parentId: "views",
  node: {
    id,
    order: id,
    kind: "container",
    direction: "column",
    span: 12,
    title: { key: `views.${id}`, fallback: title },
    children: [],
  },
});
const ops: Operation[] = [
  {
    type: "insertNode",
    parentId: "root",
    node: {
      id: "views",
      order: "G",
      kind: "container",
      direction: "column",
      span: 12,
      role: "tabs",
      children: [],
    },
  },
  panel("tail", "Tail"),
  panel("median", "Median"),
  { type: "moveNode", nodeId: "p99", newParentId: "tail", newOrder: "G" },
  { type: "insertNode", parentId: "median", node: metric("p50", "G", "latency-p50") },
];
```

A container renderer owns only its chrome and the *visibility* of its children; the adapter owns
mounting, reconciliation, reordering, placement, subscriptions and focus. An identical blueprint
causes zero DOM mutations, a role change is a reported remount, and a throwing container renderer
falls back to the plain container with a finding, children never lost. Write your own with
`DomRenderOptions.containers`: a `RendererRegistry<DomContainerRenderer>` keyed by role (there is
no default registry); its `dispose` must undo every attribute it set on children.

Placement reminders: a node's `span` applies only under a `grid` parent; `row`, `rowSpan` and
`column` are 1-based grid lines. Web renderers and the terminal agree on reading order only when a
grid's cells are all placed or all unplaced. A container `title` is a `LocalizedText` resolved at
compile and renders as `<section aria-label><h2>`.

## React

Hand the same blueprint to loom's renderer. loom-ui's framework kinds have no React widget, so
a React app draws only loom's built-in kinds, or registers its own widgets for the framework kinds.

<!-- illustrative: React is not a dependency of this repo; the call is loom's BlueprintRenderer -->

```tsx
<BlueprintRenderer
  blueprint={blueprint}
  projectionRuntime={runtime}
  executionId={store.executionId}
  registry={defaultRegistry}
/>
```

## Theming

Every `lu-*` element reads `--lu-*` CSS custom properties; set them on any ancestor. The full token
list, with defaults, is in the [theming reference](../reference/theming.md).

```css
.dashboard {
  --lu-accent: #6d28d9;
  --lu-panel: #14161c;
  --lu-text: #e8eaf0;
  --lu-radius: 10px;
}
```

## Gotchas

- Forgetting the `register` import is the commonest "nothing renders" cause on the web.
- A `[No renderer for ...]` placeholder in React means the kind is a framework kind; use the Lit
  renderer or register a widget for it.
- `chrome: "host"` (terminal `terminalRegistry`, Lit `createLitRegistry`) drops the widget title
  for an app that draws its own frame; the accessible name keeps it.
- Media, chat and input widgets are opt-in entries (`@loom-ui/renderer-lit/media`, `/chat`); the
  default registry draws a fixed "not loaded" placeholder for media kinds.
- Fixed words are never inline literals; override with `configureI18n` (Lit) or `i18n` (terminal).
- To check a renderer of your own, see [writing a renderer](writing-a-renderer.md).

## See also

- Reference: [rendering](../reference/rendering.md), [theming](../reference/theming.md).
- Packages: [`@loom-ui/renderer-lit`](../../packages/renderer-lit/README.md),
  [`@loom-ui/renderer-terminal`](../../packages/renderer-terminal/README.md).
- Examples (in `loom-examples`): `experience-layout`, `experience-stepped`, `experience-kinds`,
  `experience-tabs-planner` (tabs composed by the reference planner), `media-gallery`.
