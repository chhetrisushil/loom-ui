# Troubleshooting and FAQ

Symptoms first, causes second. Findings are listed by `code`; branch on the code, never on the
message. Server-side findings name real node ids and handles, so do not send them to a viewer.

## Build, install and test

| Symptom | Cause and fix |
| --- | --- |
| `Cannot find module '@loom/...'` on install, build or test | `../loom` is missing, not installed or not built. Every `@loom/*` dependency is a `link:../loom/...` override. Run `pnpm install && pnpm build` in loom first. |
| A new `@loom/*` import does not resolve | Add its `link:` line to `pnpm.overrides` in the root `package.json`, and the lines of any `@loom/*` packages it depends on. Packages declare `"@loom/x": "*"`, never `workspace:*`. |
| A test fails after you edited loom, with a stack trace pointing at the wrong line | Tests read loom's **built `dist`**; the source maps point at pre-edit `src`. Rebuild loom, then re-run. |
| `pnpm typecheck` is green but a test file does not compile | `pnpm typecheck` covers `src` only. Run `pnpm typecheck:tests`. CI runs both. |
| `tsc --build` skips emit after `rm -rf dist` | Use the package's `clean` script, which also removes `tsconfig.tsbuildinfo`. |
| The docs snippet test says a block "drifted" | Edit the code in `docs/snippets/src/*.test.ts` and copy the `// #region` text back into the doc block, or the reverse. Every ` ```ts ` block needs a `<!-- snippet: ... -->` or `<!-- illustrative: why -->` marker. |

## Imports: browser versus server

| Symptom | Cause and fix |
| --- | --- |
| `node -e "import('@loom-ui/renderer-lit/dom')"` fails with a module-not-found error | Expected. `@loom-ui/renderer-lit` is ESM-only and browser code. No other package declares it as a dependency, so pnpm never links it for bare-specifier resolution, and its build emits extensionless relative specifiers (`./litRegistry`) that only a bundler completes. Use Vite, webpack or esbuild, or test under happy-dom. |
| A browser bundle is megabytes larger than expected, or the bundler complains about `node:crypto`, `node:http` or worker threads | You imported `@loom-ui/hydration` (the root entry) in the browser. It executes providers and reaches loom's sandbox (QuickJS WASM) and MCP plugin. Import `@loom-ui/hydration/client`. |
| The same, but about lineage, changes or learning | Those three packages are server-side and must never enter a client graph. Keep them behind your API. |
| A browser bundle carries tens of kB of zod | You imported `@loom-ui/core` (the main entry). Use `@loom-ui/core/browser` for the zod-free slice a renderer needs (`checkKindValue`, number formatting, hydration path spellings). |
| Custom elements are undefined; widgets draw as inert boxes with one console warning | Importing `@loom-ui/renderer-lit` defines nothing. Add `import "@loom-ui/renderer-lit/register"`, or the per-element entries. |
| `[No renderer for Kpi]` (or `TimeSeries`, `Table`, ...) in React | Framework kinds have no React widget in loom's renderer. Use the Lit or terminal renderer, or register widgets for them. |

## Compile findings

`compile` never throws on a bad experience. It returns `{ blueprint, findings, ok }`, and `ok` is
false only if a finding is an error; a node it cannot resolve is omitted, never faked.

| Code | Severity | What it means |
| --- | --- | --- |
| `unknown-type` | error | the node's `type@typeVersion` is not in the catalogue |
| `unresolvable-on-surface` | error | the entry has no resolution on this surface (add `surfaces.<surface>` or a `degradeTo`) |
| `degrade-cycle` | error | a `degradeTo` chain loops |
| `kind-without-contract` | error | the resolved kind has no contract in the derived catalogue; declare `kind`, `props` and `binding` on the surface resolution |
| `undeclared-prop` | error | a node prop the entry does not list |
| `prop-not-rendered` | warn | a degrade landed on a kind that cannot render a prop the node's own type declares |
| `missing-binding` / `unexpected-binding` / `binding-conflict` | error | binding does not match the entry's `binding` rule, or a node binds both a handle and a projection |
| `unknown-handle` | warn | a node binds a handle the experience has no provider for |
| `duplicate-node-id` | error | an id appears twice |
| `role-invalid` | warn | a container `role` that is not a valid layout role; it is not compiled |
| `placement-outside-grid`, `placement-out-of-range` | error | `row`/`column` outside a grid parent or past column 12 |
| `renderer-coverage` | error | with `registry` supplied, a kind has no renderer |
| `node-restricted` | warn | the viewer may not see a node (server-side; the viewer sees a "Restricted" note) |
| `audience-withheld` | warn | a broadcast surface withheld a node the viewer could see |
| `title-restricted` | warn | the default title (the intent objective) is classified above the viewer |
| `viewer-not-supplied` | warn | no `viewer` was passed, so every classified binding is redacted |
| `placeholder-alias-key-not-supplied` | warn | an alias was needed and no `placeholderKey` was given; a random per-process key was used |

Constructor errors you may hit: `PlaceholderKeyError` (`placeholder-key-weak` for a key under 16
bytes, `placeholder-key-required` with `requirePlaceholderKey`), `HydrationAudienceMismatchError`
(a controller and its store disagree on audience), `ContentRefConfigError` (hydration's
`contentRefArgs` missing or malformed: pass a table or `"none"`), and a `TypeError` from
`handleInventory` without a keyed `revisionOf`.

## Operations refused

`apply` and `replay` return a `Finding` and never throw. The commonest: `root-immutable`,
`missing-node`, `duplicate-node-id`, `not-a-container` (an `insertNode` / `moveNode` parent that is a
semantic node) versus `not-container` (`setTitle` / `setRole` on a semantic node),
`placement-outside-grid`, `placement-out-of-range`, `cyclic-move`, `missing-provider` (declare it
with `remapProvider` first), `provider-still-bound`, `declassify-not-allowed` (needs the host's
`{ allowDeclassify: true }`), `stale-base-version`, `tree-too-deep`. A recorded log from before a
refusal existed can fail to replay: that is the refusal doing its job, not data loss. The complete
per-operation list is in the [composition reference](../reference/composition.md).

## Hydration

| Symptom | Cause and fix |
| --- | --- |
| A widget sits in a loading row forever | Its handle never loaded: a `P2` handle waits for `markVisible(handle)`; a split client waits for `load(inventory)`; or the store/controller are for a different experience, principal or audience. |
| Widgets show `stale` and the console shows drift | A tool's schema pin moved (input drift) or the output no longer fits its pin or contract (output drift). See [hydration](hydration.md#drift). |
| A `Table` shows an error instead of rows | The reshaped value fails the kind's contract (`checkKindValue`). Fix the reshaper, or set `outputCheck: "contract"` so an empty list is healthy. |
| An `empty` status with `upstream-empty` | A dependent step's `{{steps...}}` path indexed past the end of a real upstream array. The upstream answered with no such row; this is not an error. |
| The client gets `unknown-handle` for a handle it just compiled | The viewer or audience passed to `serveHandles` differs from `compile`'s, so the handle is classified above the viewer, or the version is stale. |
| `invalid-time-token` | Only `$now` and `$now±<n><s|m|h|d|w>` are tokens. Anything else beginning `$now` is refused rather than sent to a tool. |
| A repair loops forever | loom-ui never bounds repairs. Dedupe on `(versionHash, handle)` and cap attempts. |

## Lineage, changes and planners

| Symptom | Cause and fix |
| --- | --- |
| `head-moved` | Another author won the race. Re-read the head, re-author or merge, retry with the new `expectedHead`. |
| `ops-artifact-mismatch` | The recorded operations, replayed from the parent, do not reproduce the artifact's content address. Record the operations you actually applied. |
| `lineage-event-invalid` | The log holds a malformed record; the fold stays total. Investigate who has append access. |
| A change feed handler runs again for an event | Delivery is at-least-once. Dedupe on the event `id`. |
| `summary-withheld` from a planner | A capability carries a `sampleOutput` but no `sensitivity`, and no `contextClass` was declared. Declare one. |
| `prompt-replay-mismatch` from the conformance kit | A planner's `prompt` op does not replay to the artifact its materialised primitives produce. |
| A replay calls the model again | The decision inputs are unstable (a clock, a random id, an unordered collection). Compare `planDecisionId` between runs. |
| `capability-unsampled` | The planner may not bind a tool that has no `sampleOutput`; supply one. |

## Renderers

| Symptom | Cause and fix |
| --- | --- |
| Restricted data appears in a test of a custom renderer | The kit's `restricted` and `audience` checks name the clause. A redacted widget draws only the constant marker. |
| A conformance check is "skipped" | The adapter declares no matching capability. `forbidSkips: true` turns a skip into a failure. |
| Typed text is wiped by an update | The renderer overwrote an input although the *bound value* did not change. |
| A tab or stepper container draws as a plain list | No container renderer is registered for its role; pass `containers: referenceContainers()` (Lit). The terminal always draws the plain container. |

## FAQ

**Why does `compile` take a catalogue and a surface?** The catalogue is the closed vocabulary; the
surface says which loom widget kind draws each entry there. One experience compiles for `web` and
`terminal` (or any surface name you define).

**Can I change an experience's intent?** No. `intent` is inside the content hash and no operation
changes it.

**Is a content address secret?** No. It is an unkeyed sha256 over the whole experience, including
hidden content. Do not expose it where someone could guess an entire experience.

**Where do examples live?** In the sibling `loom-examples` repository, `examples/`. Each guide's "See
also" names the one that demonstrates it.
