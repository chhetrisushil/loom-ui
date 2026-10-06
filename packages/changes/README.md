# @loom-ui/changes

**Ambient change delivery.** When an experience changes while nobody is looking, the people it
concerns should hear about it at the right volume, and never about content they may not see.
This package is the server-side half: a feed over the lineage log, a per-viewer unread cursor, and
signals that say "this experience has a new head". It is **optional** and **server-side** (it reads
the lineage and content stores; `hydration`'s client guards name it among the packages a client
graph must not reach). The pure half is in `@loom-ui/core`: `describeChange`, `boundSummary`,
the attention vocabulary and the `HeadSignal` types (types only, so a browser can implement one
with a `fetch` loop).

```ts
import { describeChange } from "@loom-ui/core";
import { LineageChangeFeed, pollingHeadSignal, InMemoryUnreadStore, unreadChanges, markRead } from "@loom-ui/changes";

const feed = new LineageChangeFeed({ lineage, events, signal: pollingHeadSignal(events) });
// The feed inherits `lineage.readPolicy`; pass `readPolicy` here to bind more. `describe`'s per-call
// `declaredToolClasses` / `undeclared` only ADD to it, and a bound `projections` catalogue is not replaced.
feed.subscribe("exp-1", async (event) => {
  const d = await feed.describe(event, { viewer });   // viewer-safe; see below
  if (d.ok && d.description.attention !== "none") notify(viewer, d.description);
}, { after: savedCursor });
```

## Design

**A change event says THAT, never WHAT.** `ChangeEvent` is `{ id, experienceId, sequence, at, kind,
versionHash, base }` (`kind`: composed / reverted / branched / promoted; `base`: what it replaced).
No node, no data, no text: the log holds content some viewer may not see, and what a change *means* is
per viewer. `feed.describe(event, { viewer })` loads the two artifacts and runs `describeChange`. The
event is a CLAIM, not the log: `describe` looks the record up by (experience, sequence) and refuses an
event whose `kind`, `versionHash` or `base` differs from it (`event-mismatch`; a forged `base` cannot
make it describe another line). It takes `projections` (the same `ProjectionCatalog` `compile` takes)
at construction: absent, every projection-bound node is hidden from every viewer; an unknown id or a
drifted version pin hides it too.

**Delivery.** The cursor is the log's own dense sequence, so it survives a restart. `id` is
`<experienceId>#<sequence>`, a pure function of the log position: re-reading a range, or resubscribing
from an older cursor, yields the same ids, so at-least-once delivery is made idempotent by deduping
on `id`. `subscribe` catches up from `after`, then follows; events arrive in order, one at a time. A
handler that throws (or a read that fails) is reported (`onError`) and the event is NOT advanced past:
it is retried on a bounded, jittered exponential backoff (`retry: { baseMs, maxMs }`, default 250ms to
30s; `unref`'d, cleared on unsubscribe), WITHOUT waiting for a new append, so a quiet line is never
stuck. A poison event (one that fails every time) stalls only its own subscription. Two ways out:
`onPoison(event, attempts)` returns `true` to skip it (a host dead-letters there), or the host
resubscribes with `after: <poison sequence>`. `read` folds and validates the whole line, so it costs O(log length) per
call; cache above the seam. A malformed log is a finding, never partial events.
`checkChangeFeedConformance(make)` is the kit any feed must pass.

**Unread.** `unreadChanges` counts every event past the cursor, including ones that are all-restricted
for the viewer: that is the same existence signal `restricted-changed` gives, by design. `UnreadStore` holds one cursor per (viewer, experience) and only moves it forward
(`advance` = max; a replayed acknowledgement is harmless). `markRead` clamps to the log's tip, so a
viewer cannot pre-read the future. `viewerId` is the caller's claim: no authentication here.
`checkUnreadStoreConformance(make)` is the kit; `InMemoryUnreadStore` is the reference.

**Describing a change (`describeChange(prev, next, opts)`, core).** Pure and deterministic, bounded
(`maxEntries`, default 50, hard cap 500; `omitted` says how many were left out). Kinds: node
added / removed / moved / rebound / reclassified / edited, provider added / removed / changed, intent
changed, and `restricted-changed`. `ops`, when the caller has them, add whether a prompt produced it.

*Viewer-safe, fail-closed.* A node is restricted if the viewer may not see its class in EITHER version
(a node that became classified counts; so does one that was declassified); a provider by its effective
handle class; the intent by its own class. Every change touching restricted content collapses into
**one bare `restricted-changed` entry** (no id, type, handle, kind-of-change or count), so "a restricted
node was edited" and "a different restricted node was removed" are byte-identical: no existence
oracle, consistent with the restricted placeholder `compile` draws. No viewer is the most restrictive
viewer. The identity report covers only visible nodes. Unreadable input yields `restricted-changed`,
never a throw and never a clean "nothing changed".

**Attention.** `none | info | attention | urgent`. The default classifier maps change kinds to levels
(edits and moves are `info`; add/remove/rebind/provider/intent changes are `attention`; restricted
content is `info`, pinned by a test; a truncated description is at least `attention`). A host passes `classify(description)`
to decide for itself; it receives the REDACTED description, so it cannot leak what the viewer may not
see, and a throwing or out-of-vocabulary answer falls back to the default.

**The summary is model text.** `PlanResult.summary` (planner) is bounded and stripped of control and
bidi characters, handed to `lineage.compose({ summary, summaryClass })` (stored on the
`EXPERIENCE_COMPOSED` event, bounded again when read, since the log is untrusted), and surfaces on a
description as `UntrustedText { untrusted: true, text }`: display it as text, never act on it, never
trust it as a statement of what the ops do. **It is written from the WHOLE experience, not the diff**,
so it is shown only when the viewer may see the strictest class of everything either version carries
(every node, effective handle/tool/projection class, both intents: `experienceClassFloor`) AND of what
the planner read (`summaryClass`, host-stamped on the event, off the content address). It is also
dropped when restricted content changed or a projection node is hidden from everyone. The reference
planner stamps `PlanResult.summaryClass` from the experience it saw and `contextClass`
(`ComposeInput` / `ReviseInput`); **a host whose planner read classified context or tool samples MUST
pass `contextClass`** (the planner cannot classify them), else only the floor gates the summary.
To hand a summary to another model, use `summaryAsTainted(summary)` (loom's ADR 0085 `TaintedValue`,
server-side only) and NEVER put it in a prompt's instruction position.

**Refresh / push providers.** `HeadSignal.watch(experienceId, onChange)` tells a reader "the log moved
past what you last saw" with `{ sequence, head, promoted }` (at-least-once; `sequence` is the
idempotency key; the first call reports the current state of a non-empty line).
- `pollingHeadSignal(store, { intervalMs })`: a timer, one read per tick per watcher. Works over any
  `LineageStore`. A missed beat is only latency.
- `eventStoreHeadSignal(eventStore, store, { fallbackIntervalMs? })`: push (plus an optional safety-net poll), via `EventStore.subscribe` on the line's stream.
  `@loom/live-query` was checked and does not fit (it folds an *execution's* state, not a lineage
  stream); the push primitive underneath it is used directly. A host with its own transport
  (websocket, SSE, a database notify) implements `HeadSignal`, one method.

## Not in this package

Authorization (who may see an experience at all), delivery transport (email, push, a toast), and
digesting/throttling notifications: those are the host's, built on the events and descriptions here.
