# Writing a renderer and passing the conformance kit

**Purpose.** Draw loom-ui blueprints on a surface loom-ui does not ship (React Native, a voice
interface, a PDF, a different web framework) and prove it honours the same contract as the Lit and
terminal renderers.

**Prerequisites.** [Rendering](rendering.md). `@loom-ui/renderer-conformance` is ESM, like
`@loom-ui/renderer-lit`: its consumer is a bundler or vitest, not a plain Node `import()`. Snippets
are mirrored from
[`renderer.test.ts`](../snippets/src/renderer.test.ts).

## What a renderer is

Anything that takes a loom `Blueprint` plus the values bound to it and shows them. You do not need
loom-ui internals, only three things:

1. **Read the Blueprint.** It is loom's IR (`@loom/blueprint-runtime`): a `layout` tree of `grid`,
   `flex` and `stack` containers (a grid child is a `GridCell { node }`) and `Widget`s with a `kind`,
   `title`, `props` and an optional `binding`. Walk it and look each widget's `kind` up in your own
   table. Refuse, visibly, any kind you do not draw.
2. **Honour the status matrix and the value contract.** A bound widget's value and status live in
   the projection state at `binding.path` (`values.<handle>`) and `binding.status.path`
   (`status.<handle>`). Validate a value with `checkKindValue(kind, value)` from `@loom-ui/core`
   (and its `browser` subpath, which has no zod) and show a visible error rather than a blank. The
   states are loading (no value), ready, stale (keeps the last value), error (the finding, no value)
   and empty.
3. **Emit `WidgetAction`s** in the shapes the `actions` check pins (`{ type, widgetId, payload }`), and
   wait for the host's answer before clearing what a viewer typed.

Use the shared helpers so your words and numbers agree with the other surfaces:
`createSay(i18n)` for every fixed word (never hard-code English), `chatTranscriptLines`,
`describeMedia`, `formatSemanticNumber`, and `stripUnsafeChars` / the `validate*Value` helpers from
`@loom-ui/core/chat-ui`.

## The adapter

The kit drives your renderer through a small `RendererAdapter`. Nothing in it names a framework.

<!-- snippet: imports -->

```ts
import { HydrationStore } from "@loom-ui/hydration/client";
import {
  type HandleEntry,
  type RendererAdapter,
  checkRendererConformance,
} from "@loom-ui/renderer-conformance";
import { describeRendererConformance } from "@loom-ui/renderer-conformance/vitest";
import { renderExperience } from "@loom-ui/renderer-terminal";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
```

<!-- snippet: adapter -->

```ts
/** A renderer is anything that shows a Blueprint plus its bound values. This one wraps a function. */
const adapter: RendererAdapter = {
  name: "my-renderer",
  surface: "terminal", // the catalogue surface you draw
  // The Blueprint kinds you DRAW. Any other kind must be refused where a viewer can see it.
  kinds: [
    "MetricCard",
    "StatusBadge",
    "Kpi",
    "Table",
    "StatusCard",
    "BarChart",
    "TimeSeries",
    "Note",
  ],
  capabilities: { update: true, interpretsControlCharacters: true },
  mount(initial, { values }) {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "kit" });
    let blueprint = initial;
    let frozen: string | undefined;
    const put = (handle: string, e: HandleEntry): void => {
      const status = {
        state: e.state ?? "ready",
        ...(e.message === undefined
          ? {}
          : { finding: { code: "kit", severity: "error" as const, message: e.message } }),
      };
      if (e.value === undefined && e.state === undefined) store.remove(handle);
      else if (e.value === undefined) store.setStatus(handle, status);
      else store.setValue(handle, e.value, status);
    };
    for (const [handle, entry] of Object.entries(values)) put(handle, entry);
    return {
      // Everything a viewer can READ, settled, in reading order.
      text: () => frozen ?? renderExperience(blueprint, store),
      set: (handle, entry) => put(handle, entry), // the hydration store's job
      update: (next) => {
        blueprint = next;
      },
      // After dispose the view must stop following the data.
      dispose: () => {
        frozen = renderExperience(blueprint, store);
      },
    };
  },
};
```

What each member means:

| Member | Contract |
| --- | --- |
| `kinds` | the Blueprint kinds you **draw**; any other kind must be marked where a viewer can see it, never silently dropped |
| `capabilities.update` | `update(next)` lands a revised blueprint incrementally and keeps live data |
| `capabilities.invoke` | `invoke(widgetId, intent)` drives approvals, selects and text inputs |
| `capabilities.i18n` | `mount` honours the host's messages and locale |
| `capabilities.interpretsControlCharacters` | your surface reads escape sequences or markup (terminal, speech), so the kit checks none reach it |
| `mount(blueprint, { values, onAction, i18n })` | start drawing; `values` is keyed by hydration handle |
| `text()` | everything a viewer can **read**, settled, in reading order. Await your scheduler here so the kit never sleeps |
| `set(handle, entry)` | deliver a value or status change (the hydration store's job) |
| `dispose()` | stop following the data |

A capability you do not declare turns its checks into **skips**, never silent passes.

## Run the kit

With vitest, one `it` per check:

<!-- snippet: vitest -->

```ts
// One `it` per check; this adapter has no `invoke` or `i18n` capability, so those checks skip.
// A renderer that claims every capability passes `{ forbidSkips: true }` instead.
describeRendererConformance(adapter);
```

Without vitest, or to inspect results, call `checkRendererConformance` directly:

<!-- snippet: run -->

```ts
const report = await checkRendererConformance(adapter);
// report: { ok, results, failed, skipped }. A check the adapter has no capability for is a
// SKIP, never a silent pass; `forbidSkips: true` (below) makes a skip a failure.
```

A renderer that claims every capability should pass `{ forbidSkips: true }`, which makes a skip a
failure; both shipped renderers do.

## What the kit checks

| id | clause |
| --- | --- |
| `kinds` | every kind is drawn (value and title on the surface), or, if not in `adapter.kinds`, refused where a viewer can see it; never `[object Object]`, `undefined` or `NaN` |
| `unknown-kind` | a kind nobody registered is marked, never silently dropped |
| `status-matrix` | loading shows no value; ready shows it; stale keeps it; error shows the finding and no value; empty shows no value; recovery works |
| `live-update` | a delivered change replaces what is shown; `dispose` stops following the data |
| `incremental-update` | `update(next)` lands a revised blueprint, keeps live data, drops removed widgets |
| `audience` | a widget withheld for a broadcast audience, including a forged redacted widget that still carries a title and a binding, shows only the constant `⊘ redacted` marker |
| `restricted` | a node compiled for a viewer who may not see it shows a bare placeholder and none of its label, value or id, even though the store holds the value |
| `container-roles` | an unknown container role is the plain titled container: every panel reachable, in order |
| `empty-states` | an empty table, chart or transcript still says what it is |
| `untrusted-text` | markup in a text is shown literally; on a surface that interprets control characters, none reach it |
| `media-refs` | a media reference is described and its address, or any prefix of it, is never shown |
| `chat` | complete turns in order; a restricted turn only as a placeholder; a field outside the `ChatValue` contract is not drawn |
| `chat-markdown` | markdown in an assistant part: html literal, no unsafe link target, no image address, a part with no format never parsed, a person's turn never markdown |
| `i18n` | the host's messages replace fixed words (`LU_MESSAGES` keys) and its locale formats numbers |
| `actions` | controls emit the shared `WidgetAction` shapes, with a well-formed idempotency `key` for `SELECT` and `SUBMIT_TEXT` |

## Security rules your renderer owns

- **Text from models, tools, users and peers is untrusted.** Draw it as text; never interpret markup,
  links or control characters. The one exception is an assistant chat part that says `format: "markdown"`:
  parse it with core's `parseChatMarkdown` (or read `chatMarkdownLines`), draw only the tree's nodes, keep a
  link only through core's `mdDestination` (the render-time check: http, https, or a mailto naming exactly one address), never draw an image or an unresolved marker, and never build the parts
  from HTML.
- **An address is a capability.** Never display a media address, a prefix of it, or a URL you built
  yourself; ask the host's resolver for a viewer-scoped URL and re-check it.
- **A redacted widget draws a constant marker and nothing else**: no kind, title, value or attribute
  from the widget, even if it still carries them.
- **Do not overwrite user-entered state** (a typed value, caret, scroll) unless the *bound value*
  changed.

## Where to copy from

- `packages/renderer-conformance/src/speech.test-support.ts`: a complete "voice" renderer in about
  100 lines that speaks a blueprint as sentences, implements the adapter over loom's `Blueprint`
  only, and passes every check with nothing skipped. It is the from-scratch starting point; the
  sample above delegates drawing to `renderExperience` to stay short.
- `packages/renderer-lit/src/conformance.test.ts` and
  `packages/renderer-terminal/src/conformance.test.ts`: the same kit against a DOM and a terminal
  renderer, with `invoke` and `i18n`.
- `docs/guides/rendering.md` and the [rendering reference](../reference/rendering.md) for what the
  shipped renderers do with roles, placement and titles. A role your renderer does not know is the
  plain container (loom ADR 0099); if you draw one, the kit still requires every panel to be
  reachable from `text()`.

## Gotchas

- Importing a renderer package no longer defines its custom elements; a Lit-based adapter must
  `import "@loom-ui/renderer-lit/register"` first.
- `text()` must settle before it returns. A kit that has to sleep means the adapter is wrong.
- `forbidSkips` on a renderer that declares no capabilities proves little; declare what you do.

## See also

- Package: [`@loom-ui/renderer-conformance`](../../packages/renderer-conformance/README.md).
- Reference: [rendering](../reference/rendering.md).
- Examples (in `loom-examples`): `media-gallery`, `incident-shared-chat` (chat and media surfaces
  that exercise the clauses above).
