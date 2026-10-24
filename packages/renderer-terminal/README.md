# @loom-ui/renderer-terminal

String renderers for every framework kind, merged over loom's own kind-aware terminal registry,
plus `renderExperience` and `watch` — the terminal rendering surface for the `Blueprint`
`@loom-ui/core` compiles and the projection state `@loom-ui/hydration` publishes. Where
`@loom-ui/renderer-lit` mounts DOM elements, this package renders one plain-text frame; status
(loading/empty/stale/error) comes entirely from loom's own Blueprint traversal — this package
contributes only the per-kind value check.

## Install / import

```jsonc
// package.json of a consumer checked out beside this repo (the packages are not published)
"@loom-ui/renderer-terminal": "link:../loom-ui/packages/renderer-terminal"
```

```ts
import { renderExperience, watch, terminalRegistry } from "@loom-ui/renderer-terminal";
```

## Key concepts

- **The status matrix is loom's.** Since Blueprint IR 2.0.0 each binding declares its status channel
  (`status.<handle>`, beside `values.<handle>` in the same projection state), and loom's own
  `renderBlueprintToString` applies the eight-row decision table (loading, ready, empty, stale,
  error, …). This package contributes exactly one thing to it: what a bound VALUE must look like,
  through the `check` seam loom leaves open — `kindValueCheck`.
- **One registry, merged over loom's.** `terminalRegistry()` returns loom's
  `defaultTerminalRegistry` merged with this package's own renderers for the framework kinds
  (`TimeSeries`, `BarChart`, `Kpi`, `Table`, `StatusCard`, `Note`, `A2UIView`, `SandboxView`) — a
  fresh registry each call, since loom's default registries are shared singletons that must never be
  mutated in place.
- **`renderExperience` reads one well-known projection.** A `HydrationStore` always publishes under
  `HYDRATION_PROJECTION_ID`; `renderExperience` maps every OTHER projection id the Blueprint
  declares to `undefined` state, so a binding under a different id renders as its honest loading row
  rather than an error.
- **Numeric parity with the web.** Every framework-kind renderer here formats a number exactly as
  `@loom-ui/renderer-lit`'s `measure()` would for the same value, format and unit — same rounding,
  grouping, currency symbol and unit suffix — via `@loom-ui/core`'s `formatSemanticNumber` and
  `effectiveFormat`, at one fixed locale (`en-US` by default) so the terminal output does not vary
  with the host's own locale; a host opts into another with `i18n.locale` (see "Localising the
  renderer").

## API

- `renderExperience(blueprint, store: HydrationStore, opts?: RenderExperienceOptions): string` —
  render one frame: loom's status matrix over `store.state()`, this package's registry and value
  check by default. `opts.registry` overrides the registry.
- `watch(blueprint, store, onFrame: (frame: string) => void, opts?): () => void` — call `onFrame`
  now and on every change to the store's projection (via `store.runtimeSubscribe`); returns an
  unsubscribe function.
- `terminalRegistry(): RendererRegistry<TerminalWidgetRenderer>` — loom's built-in terminal registry
  merged with `loomUiTerminalRegistry`. Call it fresh each time you need one. `terminalRegistry({
  chrome: "host" })` (also on `renderExperience` and `createLoomUiTerminalRegistry`) is for an app
  that draws its own title bar or frame: the framework kinds print no `Title:` prefix — ready, error
  (`✗ msg`) or loading (`—`) — and a Kpi's caption trails the figure, and multi-line bodies (Table,
  TimeSeries, BarChart) print with no 4-space hanging indent — that indent only sits rows under the
  `Title:` lead, which host chrome does not have (so a narrow cell keeps its columns). Default
  `"widget"` is unchanged. loom's own traversal rows (status lines) and its eight built-in kinds are
  loom's output and keep their titles. Only a non-empty string is a title: `""` or a non-string
  (`0`, `5`) is none — the kind stands in, a Note prints no title — exactly as in the lit renderer.
  `renderExperience` throws if given both `chrome` and `registry` (chrome would be silently
  ignored); use `terminalRegistry({ chrome })` for yours.
- `loomUiTerminalRegistry` — just the framework kinds' renderers, unmerged, for a caller building
  its own composed registry.
- `sparkline(values: readonly number[]): string` — an eight-level Unicode sparkline (`▁▂▃▄▅▆▇█`)
  over a series of numbers, used by the `TimeSeries` renderer and available standalone.
- `kindValueCheck: WidgetValueCheck` — the framework's per-kind value contract, plugged into loom's
  `check` seam; exported so a caller assembling its own `renderBlueprintToString` call can reuse it.
- `RenderExperienceOptions` — `{ registry?, chrome?, projectionState?, projectionSubscribe? }`.
  `projectionState(id)` supplies the state of any NON-hydration projection the blueprint declares (a
  node bound through core's `SemanticNode.projection`), e.g. `(id) => runtime.getState(id,
  store.executionId)`; absent or throwing, its widgets render as loading.
  `projectionSubscribe(onChange)` lets `watch` re-render when such a projection changes.

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

- **Chat and inputs (U8).** `Chat` prints under its title as the SAME lines the web speaks
  (`chatTranscriptLines`): `You: ...`, `Assistant (interrupted): ...`, `You (edit of turn 1): ...`,
  a failure as its fixed sentence plus `(ref <id>)`, a restricted entry as `[restricted assistant
  turn]`, media described without an address, then `(the assistant is replying...)` / `(conversation
  closed)` / `... earlier messages are available`. Each turn is one bounded line of cleaned text: an
  escape sequence, a bidi override or a newline in a turn cannot reach the screen or forge a
  `Assistant:` line. `TextInput` / `FormInput` / `SelectInput` / `MultiSelectInput` print a prompt that says what they
  ask (fields, numbered options, the current choice listed with `(current)`, and a count of the other options) and that the answer goes through an interactive surface (the
  registry draws, it does not read a line): a terminal host that collects answers sends them through
  the same `createWriteBack` as the web.
- **Media prints a line, never loads (U9).** `Image`/`Audio`/`Video`/`File` print the same one-line
  description the web speaks (`describeMedia`: `image chart.png (image/png, 2 KiB)`), `[untrusted]`
  unless `media.trusted(ref)` says the host vouches (never for `origin: "user"`), and either a
  re-checked `media.link(ref)` (`checkMediaUrl`) or a NON-REVERSIBLE tag `ref#1a2b3c4d` (first 8 hex
  of the SHA-256 of the address; never any part of the address itself), which is a capability and
  terminal output is copied and logged. A declared size over `media.policy.maxBytes` prints "too
  large to open" with no link. Name and alt are stripped of control and bidi characters. Untrusted
  active types print "blocked (active content type)" with no link; a same-origin link is refused for
  untrusted media. `MediaInput` prints that it is a web control. A restricted media node is a
  `Note`, as for any kind.


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

## Localising the renderer

Every fixed word the terminal prints is a key in the catalogue `LU_MESSAGES` (and the typed key list
`LU_MESSAGE_KEYS`) exported by `@loom-ui/core`; English is the default. Pass a host override as
`i18n` to `terminalRegistry`, `createLoomUiTerminalRegistry` or `renderExperience`:

```ts
import { renderExperience } from "@loom-ui/renderer-terminal";

renderExperience(blueprint, store, {
  i18n: {
    locale: "de-DE", // numbers and plural categories; default "en-US" (DEFAULT_TERMINAL_LOCALE)
    messages: { "lu.terminal.chat.empty": "(keine Nachrichten)" },
    translate: (key, english) => undefined, // optional; undefined keeps English
  },
});
```

- **The default locale stays `en-US`**, not the process's locale: terminal output is logged, diffed
  and snapshotted, so the same value must print the same bytes on every machine. A host that wants
  another opts in with `i18n.locale`.
- Lookup order is `messages`, then `translate(key, english)`, then English; a throwing `translate`
  is English. `{name}` placeholders must be kept. A counted noun is `<base>.<category>`
  (`lu.plural.row.one` / `.other`, `.few`, ...); the locale's category applies only to a translated
  form.
- Not covered: bound data (titles, labels, cells, chat text), loom's own eight built-in kinds and
  the `✗`/`○`/`~`/`⋯` status lines loom's traversal writes (loom's renderers), and developer
  diagnostics.

The keys the terminal asks for (including the shared chat and media words from `@loom-ui/core`):

| Key | English default |
| --- | --- |
| `lu.plural.row.one` | `row` |
| `lu.plural.row.other` | `rows` |
| `lu.level.ok` | `ok` |
| `lu.level.warning` | `warning` |
| `lu.level.critical` | `critical` |
| `lu.terminal.table.moreRows` | `… {n} more {noun}` |
| `lu.media.kind.image` | `image` |
| `lu.media.kind.audio` | `audio` |
| `lu.media.kind.video` | `video` |
| `lu.media.kind.file` | `file` |
| `lu.chat.who.assistant` | `Assistant` |
| `lu.chat.who.notice` | `Notice` |
| `lu.chat.who.you` | `You` |
| `lu.chat.who.user` | `User` |
| `lu.prose.more` | `Show more` |
| `lu.prose.cut` | `(document cut short)` |
| `lu.prose.empty` | `(no text)` |
| `lu.chat.who.userNamed` | `User "{name}"` |
| `lu.chat.status.replying` | `replying` |
| `lu.chat.status.interrupted` | `interrupted` |
| `lu.chat.status.failed` | `failed` |
| `lu.chat.status.rejected` | `not accepted` |
| `lu.chat.status.editOf` | `edit of turn {turn}` |
| `lu.chat.line.restricted` | `[restricted {role} turn]` |
| `lu.chat.line.restrictedFrom` | `[restricted {role} turn from {by}]` |
| `lu.chat.line.ref` | `(ref {id})` |
| `lu.chat.line.tools` | `[tools: {tools}]` |
| `lu.chat.line.reasoning` | `[reasoning: {text}]` |
| `lu.chat.line.reasoningSummary` | `[reasoning summary: {text}]` |
| `lu.chat.line.reasoningRedacted` | `[reasoning redacted]` |
| `lu.chat.line.reasoningErased` | `[reasoning removed]` |
| `lu.chat.reason.model-error` | `The assistant ran into a problem.` |
| `lu.chat.reason.rate-limited` | `The assistant is busy right now. Try again in a moment.` |
| `lu.chat.reason.quota` | `The assistant's usage limit has been reached.` |
| `lu.chat.reason.tool-error` | `A tool the assistant used failed.` |
| `lu.chat.reason.denied` | `That was not permitted.` |
| `lu.chat.reason.turn-failed` | `The turn could not be completed.` |
| `lu.chat.reason.cancelled` | `The turn was cancelled.` |
| `lu.chat.reason.too-long` | `The message was too long.` |
| `lu.chat.reason.prompt-too-large` | `The message was too large to answer.` |
| `lu.chat.reason.malformed` | `The message was not understood.` |
| `lu.chat.reason.unauthenticated` | `The message could not be verified.` |
| `lu.chat.reason.replayed` | `The message was already received.` |
| `lu.chat.reason.stale` | `The message arrived too late.` |
| `lu.chat.reason.not-a-participant` | `You are not a participant in this conversation.` |
| `lu.chat.reason.edit-invalid` | `That edit could not be applied to the earlier message.` |
| `lu.chat.reason.generic` | `The message was not processed.` |
| `lu.input.message` | `Message` |
| `lu.input.form` | `Form` |
| `lu.input.choose` | `Choose` |
| `lu.terminal.a2ui` | `[A2UI view — rendered on the web]` |
| `lu.terminal.sandbox` | `[sandboxed component — rendered on the web]` |
| `lu.terminal.fileUpload` | `[file upload — available on the web]` |
| `lu.terminal.untrusted` | `[untrusted]` |
| `lu.terminal.media.tooLarge` | `too large to open` |
| `lu.terminal.media.blocked` | `blocked (active content type)` |
| `lu.terminal.chat.earlier` | `… earlier messages are available` |
| `lu.terminal.chat.empty` | `(no messages)` |
| `lu.terminal.chat.replying` | `(the assistant is replying…)` |
| `lu.terminal.chat.closed` | `(conversation closed)` |
| `lu.terminal.multiline` | ` (multi-line)` |
| `lu.terminal.textInput` | `[text input — answer on an interactive surface]` |
| `lu.terminal.formInput` | `[form — answer on an interactive surface]` |
| `lu.terminal.current` | `(current)` |
| `lu.terminal.selectInput` | `[choice — answer on an interactive surface]` |
| `lu.terminal.multiSelectInput` | `[choices — answer on an interactive surface]` |
| `lu.terminal.moreOptions` | `more options` |

## Interactive terminal and incremental render

`renderExperience` stays a snapshot: a string in, a string out, byte for byte what it always was.
`interactiveTerminal(blueprint, { store, ... })` is the opt-in live session over the same renderer.
Its frame is that snapshot followed by a controls footer when the Blueprint has actionable widgets;
with none, the frame IS the snapshot.

```ts
import { interactiveTerminal } from "@loom-ui/renderer-terminal";

const term = interactiveTerminal(blueprint, {
  store,                       // the HydrationStore; changes repaint
  input: process.stdin,         // anything with on("data"); raw mode is set while live
  output: process.stdout,       // anything with write(); omit for a headless frame()
  onAction: (a) => writeBack.handle(a), // WidgetAction + viewedVersion; may return an ActionOutcome
});
term.update(revisedBlueprint); // incremental: only the changed lines are rewritten
term.stop();
```

- **Incremental render.** The first paint clears the screen and writes the frame; afterwards each
  change diffs the new frame against the last (`diffFrames`) and writes only the changed lines as
  cursor-addressed rewrites (`paintPatches`). `onPaint` reports `{ mode: "full" | "patch" | "none",
  changedLines, totalLines }`. A change that leaves the frame as it was writes nothing.
- **Controls.** `ApprovalCard` (only while an approval is pending, like the web), `SelectInput`, `MultiSelectInput`
  and `TextInput`. Tab / Shift-Tab (or the arrows) move focus. Approvals take `y` / `n` only: Enter is
  never consent. A select opens a list (Enter), picks by digit or arrows + Enter, Escape backs out. The list starts on the first option: it does not preselect a bound current choice (the non-interactive prompt does mark it, `(current)`), and the terminal ignores a SelectInput's `size`.
  `MultiSelectInput` opens a checklist (Enter): arrows move, Space ticks or unticks (never past `maxSelected`), Enter sends the whole set, Escape backs out. It starts with the bound choice ticked and shows 10 options around the cursor.
  A text input starts on Enter, edits with Backspace, sends on Enter, Escape cancels.
- **Consent is deliberate.** `y` / `n` and every submit act only when they are the SOLE key of their
  input chunk, on the frame they were pressed on: a key that changes mode or submits ends the chunk
  (the rest is dropped), so a paste can never navigate to an approval and answer it. The session
  turns on bracketed paste (`ESC[?2004h`, off again on `stop`) and a pasted span is TEXT only: it is
  appended to an open draft (newlines kept), otherwise it is nothing. A consent key queued behind an
  in-flight action is refused ("The view changed.") if the blueprint or a control's binding status
  moved since it was pressed, and `viewedVersion` is stamped from that frame, not from whatever is
  current when the key finally runs. After an `APPROVE` / `REJECT` is dispatched for a pending
  approval, further `y` / `n` for it are ignored until the frame moves (the host answered, or a new
  version landed): the HOST must still dedupe by its own key, since another session can answer too.
  `press(...keys)` treats each key as its own arrival; `send(chunk)` and real input are chunks.
- **Sole means sole.** Every decoded unit of a chunk counts toward "sole", including dropped escape
  sequences (arrows, OSC) and non-printables: `ESC[C` + `y` is two units and cannot approve. Paste
  mode always ends: at the end marker (even split across chunks), at Ctrl-C (paste discarded,
  interrupt delivered), when the paste passes 1 Mi UTF-16 code units (discarded; the rest is
  swallowed to the end marker, never typed), or after `pasteIdleMs` (default 2000, read from an
  injectable `now`) without a byte. An idle-abandoned paste may still be arriving, so the decoder
  then DRAINS: it discards input (nothing is typed) until the end marker or Ctrl-C (delivered as an
  interrupt). A further silence does not end the drain (a slow link can stall twice); a bound plus
  silence does: after 1 Mi UTF-16 code units more with no end marker AND `pasteIdleMs` of silence
  the input is handed back (a still-flowing paste keeps draining), so a lost marker costs at most
  that much typing, never all of it. A drain or an oversize paste that ends inside a chunk yields an
  `ignored` key, so a `y` after it is not sole. During a drain Ctrl-C is delivered as an interrupt
  (by default this stops the session).
- **Known limits, and `confirmConsent`.** A chunk boundary is all a terminal gives us. (1) On a
  terminal WITHOUT bracketed paste, a one-character paste `y` into a focused approval is a one-key
  chunk, taken as a keypress. (2) A host reading byte by byte (slow serial / ssh) makes every key
  sole, so a multi-line non-bracketed paste could reach `\t`, `y`. For raw-byte-stream hosts set
  `confirmConsent: true` (recommended there; default off): the first `y` / `n` only arms the
  approval (the frame shows `y ×2`, or `labels.confirm`), and the same key alone in a LATER chunk on
  the same frame acts; any other key disarms. (3) A paste whose end marker never arrives is drained
  for 1 MiB, after which what follows is decoded as keys (the sole-key rule still blocks consent);
  Ctrl-C leaves the drain at once.
- **Actions** are the shapes the web emits (`APPROVE` / `REJECT` with `payload.approved`, `SELECT`,
  `SUBMIT_TEXT` with an idempotency `key`), stamped with `viewedVersion`. What was typed is kept
  until the host answers `ok`; a refusal or a throw is a fixed sentence from `LU_MESSAGES`, never
  the host's text. No `onAction` = "not available here"; nothing is pretended to be sent.
- **No TTY needed.** `input` / `output` are injected; `send("\t")` and `press({ name: "enter" })`
  feed keys and resolve when the effect, including the action, has settled. `decodeKeys` is the pure
  parser: unknown escape sequences are dropped whole, control characters and bidi overrides are
  never typed text. Ctrl-C calls `onInterrupt` (default `stop`).
- `labels` overrides the footer's key legend and focus marker (symbols by default); every other word
  uses the host's `i18n`. Form inputs are not driven here (use a surface with fields).

`renderExperience` and the interactive frame (controls footer included) strip core's one unsafe set
(`stripUnsafeChars`, the class `sanitizeChatText` removes: C0/C1 controls, ESC, bidi overrides and
isolates, zero-width and invisible marks, soft hyphen, TAG characters) plus tab, CR and U+2028/9
from the whole frame; only newline survives. A title, heading, cell, translated word or typed draft
can be model- or user-authored, and an ESC would otherwise reach the terminal as an escape sequence.
"Inert" means STRIPPED, not parsed: the printable bytes after a removed ESC (such as `]8;;http://…`)
may remain visible. They are harmless text. A typed `Key.char` must be exactly one printable code
point or it is ignored.

The renderer runs the shared conformance kit (`@loom-ui/renderer-conformance`) in
`src/conformance.test.ts`.

## See also

- [../core/README.md](../core/README.md) — the framework kinds and number semantics this package
  renders, and `checkKindValue`.
- [../hydration/README.md](../hydration/README.md) — the `HydrationStore` and projection state
  `renderExperience`/`watch` read.
- [../renderer-lit/README.md](../renderer-lit/README.md) — the DOM counterpart surface, with the
  same numeric formatting.
- [../../README.md](../../README.md) — root overview.
