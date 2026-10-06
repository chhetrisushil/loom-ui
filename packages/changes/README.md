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
feed.subscribe("exp-1", async (event) => {
  const d = await feed.describe(event, { viewer });   // viewer-safe; see below
  if (d.ok && d.description.attention !== "none") notify(viewer, d.description);
}, { after: savedCursor });
```

## Design

**A change event says THAT, never WHAT.** `ChangeEvent` is `{ id, experienceId, sequence, at, kind,
versionHash, base }` (`kind`: composed / reverted / branched / promoted; `base`: what it replaced).
No node, no data, no text: the log holds content some viewer may not see, and what a change *means* is
per viewer. `feed.describe(event, { viewer })` loads the two artifacts and runs `describeChange`.

**Delivery.** The cursor is the log's own dense sequence, so it survives a restart. `id` is
`<experienceId>#<sequence>`, a pure function of the log position: re-reading a range, or resubscribing
from an older cursor, yields the same ids, so at-least-once delivery is made idempotent by deduping
on `id`. `subscribe` catches up from `after`, then follows; events arrive in order, one at a time. A
handler that throws is reported (`onError`) and the event is NOT advanced past: it comes again at
the next wake. (A poison event is retried at each wake; a consumer that wants a dead-letter keeps
its own attempt count.) `read` folds and validates the whole line, so it costs O(log length) per
call; cache above the seam. A malformed log is a finding, never partial events.
`checkChangeFeedConformance(make)` is the kit any feed must pass.

**Unread.** `UnreadStore` holds one cursor per (viewer, experience) and only moves it forward
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
content is `info`; a truncated description is at least `attention`). A host passes `classify(description)`
to decide for itself; it receives the REDACTED description, so it cannot leak what the viewer may not
see, and a throwing or out-of-vocabulary answer falls back to the default.

**The summary is model text.** `PlanResult.summary` (planner) is bounded and stripped of control and
bidi characters, handed to `lineage.compose({ summary })` (stored on the `EXPERIENCE_COMPOSED` event,
bounded again when read, since the log is untrusted), and surfaces on a description as
`UntrustedText { untrusted: true, text }`: display it as text, never act on it, never trust it as a
statement of what the ops do. It is DROPPED whenever restricted content changed (it was written for the
composer, who may be cleared for more than this viewer). Residual: a summary of an otherwise visible
change may still say more than the visible entries; a host that cannot accept that omits it.

**Refresh / push providers.** `HeadSignal.watch(experienceId, onChange)` tells a reader "the log moved
past what you last saw" with `{ sequence, head, promoted }` (at-least-once; `sequence` is the
idempotency key; the first call reports the current state of a non-empty line).
- `pollingHeadSignal(store, { intervalMs })`: a timer, one read per tick per watcher. Works over any
  `LineageStore`. A missed beat is only latency.
- `eventStoreHeadSignal(eventStore, store)`: push, via `EventStore.subscribe` on the line's stream.
  `@loom/live-query` was checked and does not fit (it folds an *execution's* state, not a lineage
  stream); the push primitive underneath it is used directly. A host with its own transport
  (websocket, SSE, a database notify) implements `HeadSignal`, one method.

## Not in this package

Authorization (who may see an experience at all), delivery transport (email, push, a toast), and
digesting/throttling notifications: those are the host's, built on the events and descriptions here.
