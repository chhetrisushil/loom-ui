# Lineage and the change feed

**Purpose.** Remember which version of an experience is current, refuse a stale author, go back
(revert, undo, branch), verify that recorded operations reproduce the artifact, and tell people about
changes at the right volume without leaking content they may not see.

**Prerequisites.** [Composing](composing.md). Both packages are **server-side and optional**: an app
using only `@loom-ui/core` keeps working, and neither may enter a browser bundle
(`@loom-ui/lineage`, `@loom-ui/changes` are on the client-graph deny list). Snippets are mirrored
from [`lineage.test.ts`](../snippets/src/lineage.test.ts).

<!-- snippet: imports -->

```ts
import {
  InMemoryUnreadStore,
  LineageChangeFeed,
  markRead,
  pollingHeadSignal,
  unreadChanges,
} from "@loom-ui/changes";
import type { Provenance } from "@loom-ui/core";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { InMemoryContentStore } from "@loom/plugin-content";
```

## What lineage adds

`@loom-ui/core` can fold operations onto an artifact and hash it. It cannot say which artifact is the
head, refuse a stale author, undo, or notice that a stored operation list disagrees with the artifact
it claims to produce (operations are not part of the content address). `Lineage` is that memory:

- a **head** per `experienceId`, advanced by compare-and-set;
- an append-only **version history** (`versions`, `get`, `state`);
- **revert, undo and branch** as *new* versions; nothing is ever rewritten;
- **verification**: every write is refused unless replaying its recorded operations from the parent
  reproduces its content address (`ops-artifact-mismatch`), and `verify` rebuilds a whole line.

Storage is two loom seams: artifact bytes in a `ContentStore`, version events in a `LineageStore`
(an append-only per-line log with compare-and-set on its tip). `eventStoreLineageStore` adapts
loom's `EventStore`; `InMemoryLineageStore` is the reference for tests. A backend you write must pass
`checkLineageStoreConformance(make)`.

## Start a line, compose, and lose a race

<!-- snippet: setup -->

```ts
const events = new InMemoryLineageStore(); // production: eventStoreLineageStore(loomEventStore)
const lineage = new Lineage({ events, content: new InMemoryContentStore() });
const by: Provenance = { source: "user" };

const started = await lineage.start(boardExperience(), by);
if (!started.ok) throw new Error(started.refusal.kind);
const v1 = started.value.version.versionHash;
```

`start` refuses a genesis that has parents or a line that already exists. Every write names the
head it was authored against (`expectedHead`; `null` means the line must be empty).

<!-- snippet: compose -->

```ts
const edit = (unit: string) => ({
  op: { type: "setProps" as const, nodeId: "p99", patch: { unit } },
  by,
  at: new Date().toISOString(),
});

const second = await lineage.compose({
  experienceId: "checkout-latency",
  expectedHead: v1, // the head this author composed against
  ops: [edit("s")],
  by,
  summary: "Show seconds", // untrusted model or author text: bounded, never an instruction
});
if (!second.ok) throw new Error(second.refusal.kind);
const v2 = second.value.version.versionHash;

// A second author who still holds v1 loses the race, with a typed result, not an overwrite.
const late = await lineage.compose({
  experienceId: "checkout-latency",
  expectedHead: v1,
  ops: [edit("us")],
  by,
});
if (!late.ok && late.refusal.kind === "head-moved") {
  late.refusal.actualHead; // v2: re-read, re-author, try again
}
```

`compose` applies the first operation with `applyAt`, so an operation declaring a `baseVersion` other
than the head is refused (`stale-base-version`) rather than landing on a surface its author never
saw. A lost race is always a typed result: `head-moved` (carrying the winner), `promoted-moved`, or
`refused` (carrying a `Finding`). Branch on `refusal.kind`.

## Revert, undo, branch, verify

<!-- snippet: revert -->

```ts
// Nothing is rewritten: each of these appends a NEW version.
const reverted = await lineage.revert({
  experienceId: "checkout-latency",
  expectedHead: v2,
  to: v1,
  by,
});
if (!reverted.ok) throw new Error(reverted.refusal.kind);

const undone = await lineage.undo({
  experienceId: "checkout-latency",
  expectedHead: reverted.value.version.versionHash, // undoing a revert is a redo
  by,
});

const fork = await lineage.branch({
  from: { experienceId: "checkout-latency", versionHash: v2 },
  experienceId: "checkout-latency-experiment",
  by,
});

// Rebuild every line from its log and compare addresses. [] means consistent.
const problems = await lineage.verify("checkout-latency");
```

- `revert` restores an older artifact's content as a new version whose parent is the head. It can
  itself be reverted, which is redo; `undo` is a revert to the head's parent.
- `branch` forks a version into a **new** line; its first version's parent is the source version in
  another line.
- Revert and branch **carry the newest sticky classes forward** (never lower), so a restored or
  forked version can be stricter than it was, never laxer than the line knew.
- `promote` moves a separate pointer: the version the app *shows*, with its own compare-and-set
  (`expectedPromoted`).

## Trust and operations

- **Lineage performs no authorization.** `by` is an unverified claim and `start` accepts any
  genesis. Your host decides who may `start`, `advance`, `branch` and `promote`, and what artifacts
  it passes. `allowDeclassify` is a per-call argument; pass it only from code that authored the
  operations itself.
- **The log is untrusted input.** The fold is total: a malformed record is a
  `lineage-event-invalid` finding, never a throw out of every read of the line.
- Streams live in loom's reserved `__loom_` namespace, so they cannot be crypto-shredded. Do not put
  personal data in props, labels or `by`.
- **Retention.** Every version stores its whole artifact. Use `lineage.pins(policy)` and, with
  several lineages or a `SeenLog` sharing a store, `rootsFor({ lineages, seenLogs })` as the `roots`
  of loom's `sweepUnpinnedContent`. Never hand-compose roots: a missing source erases other
  readers' artifacts.
- Bind your read policy once: `new Lineage({ ..., readPolicy })`. Feeds and seen logs built over
  the lineage inherit it.

## Provenance: why is this here, what did they see

`lineage.provenance(experienceId)` is the per-node ledger derived from the recorded operations, and
`lineage.explain(experienceId, nodeId, { viewer })` answers "why is this here" fail-closed:
unknown, restricted and unreadable all answer `{ available: false }`. What a viewer actually *saw* is
`snapshotSeen`, persisted per (experience, viewer) by `SeenLog`, with crypto-shredding erasure
(`SeenLog.eraseViewer`) and mark-and-sweep GC (`collectSeenGarbage`). Stamp a planner decision onto
operations with `plannerProvenance(result)` so a node links back to the recorded model call. See the
[lineage README](../../packages/lineage/README.md).

## The change feed (`@loom-ui/changes`)

A change event says **that** something changed, never **what**: `{ id, experienceId, sequence, at,
kind, versionHash, base }`. What a change *means* is per viewer, so it is computed on demand.

<!-- snippet: feed -->

```ts
const feed = new LineageChangeFeed({
  lineage,
  events, // the same store the Lineage writes to
  signal: pollingHeadSignal(events, { intervalMs: 50 }),
});

const seen: string[] = [];
const unsubscribe = feed.subscribe(
  "checkout-latency",
  async (event) => {
    // The event says THAT something changed, never WHAT. Describing is per viewer.
    const d = await feed.describe(event, { viewer: { clearance: "internal" } });
    if (d.ok && d.description.attention !== "none") seen.push(event.id);
  },
  { after: 0 } // a saved cursor: the last sequence you handled
);
```

- **Cursor and ids.** The cursor is the log's dense sequence, so it survives a restart. An event id is
  `<experienceId>#<sequence>`, a pure function of the log position: at-least-once delivery becomes
  idempotent by deduping on `id`.
- **Failures.** A handler that throws is reported to `onError` and the event is *not* advanced past;
  it is retried with jittered exponential backoff (default 250 ms to 30 s) even on a quiet line. A
  poison event stalls only its own subscription; return `true` from `onPoison` to skip it, or
  resubscribe with `after: <poison sequence>`.
- **Wake-ups.** `pollingHeadSignal(store, { intervalMs })` works over any `LineageStore`;
  `eventStoreHeadSignal` pushes through loom's `EventStore.subscribe`. A host with its own transport
  (websocket, SSE) implements `HeadSignal`, one method; the type lives in core so a browser can
  implement it with a `fetch` loop.
- **`describe` is fail-closed.** Anything the viewer may not see, in *either* version (including a
  node that just became classified), collapses into one bare `restricted-changed` entry with no id,
  type or count, and the summary is dropped. The attention classifier (`none | info | attention |
  urgent`; replace it with `classify`) only ever sees the redacted description.
- **A summary is model text.** It is bounded and stripped of control and bidi characters on the way
  in and out and arrives as `UntrustedText`: display it as text, never act on it. It is shown only
  when the viewer may see the strictest class of everything either version carries. A host whose
  planner read classified context must pass `contextClass`.
- Pass the same `viewer`, and `audience` for a wall, as for `compile`
  ([sensitivity](sensitivity-and-audiences.md)).

### Unread counts

<!-- snippet: unread -->

```ts
const unread = new InMemoryUnreadStore();
const before = await unreadChanges(feed, unread, "ana", "checkout-latency");
// before.ok && before.events.length === 2: ids "checkout-latency#1" and "#2"
if (before.ok && before.events.length > 0) {
  const last = before.events[before.events.length - 1];
  if (last) await markRead(feed, unread, "ana", "checkout-latency", last.sequence);
}
```

`UnreadStore` keeps one cursor per (viewer, experience) and only moves it forward; `markRead` clamps
to the log's tip, so a viewer cannot pre-read the future. `unreadChanges` counts every event past
the cursor, including ones that are all-restricted for the viewer; that is the same existence
signal `restricted-changed` gives, by design. `viewerId` is a claim: authenticate before you call.
Back your own store with `checkUnreadStoreConformance(make)`.

## Gotchas

- Always pass the head you read as `expectedHead`; never guess. On `head-moved`, re-read and
  re-author, or [merge](composing.md#merge-two-forks).
- `verify` replays from the genesis, so reclaiming old versions makes it report them.
- `read` folds the whole line each call (O(log length)); cache above the seam.
- `@loom/live-query` does not fit a lineage stream (it folds an execution's state), which is why
  the push signal uses `EventStore.subscribe` directly.

## See also

- Packages: [`@loom-ui/lineage`](../../packages/lineage/README.md),
  [`@loom-ui/changes`](../../packages/changes/README.md).
- Examples (in `loom-examples`): `provenance-explain` (lineage, `explain`, seen log, erasure, GC),
  `experience-merge`, `experience-recompose`.
- Next: [planners and learning](planners-and-learning.md).
