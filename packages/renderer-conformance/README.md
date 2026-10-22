# @loom-ui/renderer-conformance

One set of contract checks that **any** loom-ui renderer runs: `@loom-ui/renderer-lit`,
`@loom-ui/renderer-terminal`, and a third party's React / native / voice surface. A renderer is
anything that takes loom's `Blueprint` plus the values bound to it and shows them. This kit is how
you prove yours honours the contract without forking loom-ui.

ESM, like `@loom-ui/renderer-lit`; its consumer is a bundler or vitest, not a plain Node `import()`.

## Install / import

```jsonc
// package.json of a consumer checked out beside this repo (the packages are not published)
"@loom-ui/renderer-conformance": "link:../loom-ui/packages/renderer-conformance"
```

Entry points: `@loom-ui/renderer-conformance` (the checks and report) and
`@loom-ui/renderer-conformance/vitest` (a vitest harness).

## Run it

```ts
// my-renderer/src/conformance.test.ts
import { describeRendererConformance } from "@loom-ui/renderer-conformance/vitest";
import { myAdapter } from "./myAdapter";

describeRendererConformance(myAdapter, { forbidSkips: true }); // one `it` per check
```

No vitest? `checkRendererConformance(adapter)` returns a plain report
(`{ ok, results, failed, skipped }`) for any runner. A check the adapter has no capability for is a
**skip**, never a silent pass; `forbidSkips: true` makes a skip a failure, which is what a renderer
that claims the capability should use.

## The adapter

The kit drives your renderer through `RendererAdapter` (see `src/adapter.ts`). Nothing in it names a
framework.

```ts
interface RendererAdapter {
  name: string;
  surface: string;               // the catalogue surface you draw: "web", "terminal", "voice"...
  kinds: readonly string[];      // the Blueprint kinds you DRAW; any other must be refused visibly
  capabilities?: {
    update?: boolean;            // update(next) is incremental
    invoke?: boolean;            // invoke() drives approvals / selects / multi-selects / text inputs
    i18n?: boolean;              // mount() honours the host's words and locale
    interpretsControlCharacters?: boolean; // your surface reads ESC sequences / markup (terminal, speech)
  };
  mount(blueprint, { values, onAction, i18n }): MountedRenderer;
}
interface MountedRenderer {
  text(): string | Promise<string>;   // everything a viewer can READ, settled, in reading order
  set(handle, { value, state, message }): void | Promise<void>; // the hydration store's job
  update?(next: Blueprint): void | Promise<void>;
  invoke?(widgetId, intent): void | Promise<void>; // approve | reject | select | text
  dispose(): void;
}
```

`values` is keyed by hydration handle; a widget's `binding.path` is `values.<handle>`
(`hydrationPath`) and its status path is `status.<handle>` (`hydrationStatusPath`). `text()` must
settle first (await your scheduler) so the kit never sleeps.

## What it checks

| id | clause |
| --- | --- |
| `kinds` | every kind is drawn (value and title on the surface), or, if not in `adapter.kinds`, refused where a viewer can see it; never `[object Object]` / `undefined` / `NaN` |
| `unknown-kind` | a kind nobody registered is marked, never silently dropped |
| `status-matrix` | loading shows no value; ready shows it; stale keeps it; error shows the finding and no value; empty shows no value; recovery works |
| `live-update` | a delivered change replaces what is shown; `dispose` stops following the data |
| `incremental-update` | `update(next)` lands a revised Blueprint, keeps live data, drops removed widgets |
| `audience` | a widget withheld for a broadcast audience (and a forged `source.redacted` widget that still carries a title, props and a binding) shows only the constant `⊘ redacted` marker: none of its label, value, kind, type or handle on the surface, attributes included |
| `restricted` | a node compiled for a viewer who may not see it shows a bare placeholder and none of its label, value or id, even though the store holds the value (with a cleared-viewer positive control) |
| `container-roles` | an unknown container role (`tabs`, `stepper`, app-defined) is the plain titled container: every panel reachable, in order |
| `empty-states` | an empty table / chart / transcript still says what it is |
| `untrusted-text` | markup in a text is shown literally; on a surface that interprets control characters, none reach it |
| `media-refs` | a media reference is described and its address (or any prefix) is never shown |
| `chat` | complete turns in order; a restricted turn only as a placeholder; a field outside the `ChatValue` contract is not drawn |
| `i18n` | the host's messages replace fixed words (`LU_MESSAGES` keys) and its locale formats numbers |
| `actions` | controls emit the shared `WidgetAction` shapes (`APPROVE`/`REJECT` with `payload.approved`; `SELECT` / `SELECT_MANY` (`payload.values`, in the order driven) / `SUBMIT_TEXT` with a well-formed idempotency `key`) |
| `multi-select-current-value` | a bound `MultiSelectInput` reads differently for each chosen set and draws what is chosen |

The kit tests itself: `src/speech.test.ts` breaks one clause at a time in a conforming renderer and
requires the kit to name that clause.

## Writing a third-party renderer

You need three things, none of them loom-ui internals:

1. **Read the Blueprint.** It is loom's own IR (`@loom/blueprint-runtime`): a `layout` tree of
   `grid` / `flex` / `stack` containers (a grid child is a `GridCell { node }`) and `Widget`s with a
   `kind`, `title`, `props` and an optional `binding`. Walk it; look the widget's kind up in your
   own table.
2. **Honour the status matrix and the contract.** A bound widget's value and status live in the
   projection state at `binding.path` / `binding.status.path`. Use `@loom-ui/core`'s
   `checkKindValue(kind, value)` to validate a value against the kind's contract, `createSay(i18n)`
   for every fixed word (never hard-code English), and `chatTranscriptLines`, `describeMedia`,
   `formatSemanticNumber` and the `validate*Value` helpers so your words and numbers agree with the
   other surfaces. Refuse (visibly) any kind you do not draw.
3. **Emit `WidgetAction`s.** `{ type, widgetId, payload }`, in the shapes the `actions` check pins.
   Wait for the host's answer (`ActionOutcome`) before clearing what a viewer typed.

Then write the adapter and run the kit. `src/speech.test-support.ts` is a complete, working
"voice" renderer in about 100 lines that speaks a Blueprint as sentences and passes every check,
with nothing skipped; copy it as a starting point. `@loom-ui/renderer-lit/src/conformance.test.ts`
and `@loom-ui/renderer-terminal/src/conformance.test.ts` show the same kit against a DOM and a
terminal renderer. The lit adapter must `import "@loom-ui/renderer-lit/register"` (inside that
package, `./register`) first: importing the renderer no longer defines its custom elements.

Container roles: a role your renderer does not know is the plain container (loom ADR 0099). If you
draw one (`tabs`), the kit still requires every panel to be reachable from `text()`.

## See also

- [../renderer-lit/README.md](../renderer-lit/README.md) and
  [../renderer-terminal/README.md](../renderer-terminal/README.md) — the shipped renderers that run
  this kit.
- [../../docs/reference/rendering.md](../../docs/reference/rendering.md) — what a renderer draws.
- [../../README.md](../../README.md) — root overview.
