# @loom-ui/lineage

The Experience **lineage runtime**: what remembers which artifact of an experience is current, who
won a race to change it, and how to go back. `@loom-ui/core` can fold ops onto an artifact and hash
it; it cannot say which artifact is the head, refuse a stale author, undo, or notice that a stored
`ops` list disagrees with the artifact it claims to produce (ops are not in the content address).
This package is that memory. It is **optional** (an app using only core keeps working) and
**server-side** (an event log plus a content store: never import it from a client bundle;
`hydration/clientEntry.test.ts` names it among the packages a client graph must not reach).

```ts
import { Lineage, InMemoryLineageStore, eventStoreLineageStore } from "@loom-ui/lineage";

const lineage = new Lineage({
  events: eventStoreLineageStore(loomEventStore), // or new InMemoryLineageStore()
  content: loomContentStore,                       // the ContentStore putExperience already uses
});
const v1 = await lineage.start(genesis(...), by);                      // first version
const v2 = await lineage.compose({ experienceId, expectedHead, ops, by });
const r  = await lineage.revert({ experienceId, expectedHead, to, by }); // a NEW version
const f  = await lineage.branch({ from: { experienceId, versionHash }, experienceId: "fork", by });
await lineage.verify(experienceId);                                      // Finding[]; [] = consistent
```

**Bind the host's read policy once.** `new Lineage({ ..., readPolicy })` takes a core `ReadPolicy`
(`{ declaredToolClasses, projections, hydrationProjectionId, undeclared }`); `explain` applies it with
no per-call options (a per-call value may only ADD, never lower), and a `SeenLog` or
`LineageChangeFeed` built over the lineage inherits it (`lineage.readPolicy`). Build the table with
`declaredToolClassesFrom(capabilities)` from `@loom-ui/planner`, the same `CapabilityRef`s the
planner reads:

```ts
const lineage = new Lineage({ events, content, readPolicy: {
  declaredToolClasses: declaredToolClassesFrom(capabilities),
  undeclared: "deny", // optional: a tool the table omits is unreadable until declared
} });
```

## Design

**Storage is two loom seams.** Artifact bytes go in a `ContentStore` (`putExperience`, unchanged).
Version and promotion events go in a `LineageStore`: an append-only, per-line, sequenced log whose
`append(line, expectedSequence, record)` is a compare-and-set on the tip. That is exactly what loom's
`EventStore` already guarantees (`(executionId, sequence)` uniqueness), so `eventStoreLineageStore`
adapts it (one reserved stream `__loom_ui_lineage__:<experienceId>` per line; fencing, tenancy and
sharding decorators wrap the store as usual). `InMemoryLineageStore` is the reference, and
`checkLineageStoreConformance(make)` is the kit any backend must pass (returns findings, never throws).

**Head and compare-and-set.** A line's head is the latest version. Every write names the head it was
authored against (`expectedHead`; `null` = the line must be empty). A lost race is a *typed result*
(`{ kind: "head-moved", expectedHead, actualHead }`), never an overwrite or a throw; the caller
re-reads and re-authors. `compose` applies its first op with core's `applyAt`, so an op that declares
a `baseVersion` other than the head is refused (`stale-base-version`). A blob is written before its
event and is content-addressed, so a lost race leaves an unreferenced blob, never an event without bytes.

**Events.** `EXPERIENCE_COMPOSED { ref, parents, ops }` (core's convention, now with a producer, a
consumer and a validator; plus `experienceId`, `versionHash`, `by`), `EXPERIENCE_REVERTED`,
`EXPERIENCE_BRANCHED`, and `EXPERIENCE_PROMOTED` (the version the app *shows*; its own CAS pointer,
`expectedPromoted`). `foldLineage` is pure and total and checks structure: dense sequences, one
version per address, every version's `parents` naming the head it was appended on.

**Verification closes the ops-vs-artifact gap.** `advance`/`compose` refuse (writing nothing) any
version whose recorded ops, replayed from the parent, do not reproduce the artifact's content address
(`ops-artifact-mismatch`), whose ops are refused by `apply` (a recorded `declassify*` needs the host's
per-call `allowDeclassify`), whose `baseVersion` is not the parent, or that records no ops after the first
version. `verify(experienceId)` is the consumer: it REBUILDS the whole line from the log (never from
the blobs: a composed version by replay on the rebuilt parent, a revert or branch recomputed from the
rebuilt artifacts it names) and compares addresses and stored blobs. The genesis is attested by its
address alone. A branch is only as sound as its source, so `verify` also verifies the source line up
to the version the fork carried classes from (recursively, bounded) and reports its findings on the
branch; `carriedFrom` must be the forked version or a descendant of it. `verify` replays with
`declassify*` allowed: it checks that addresses reproduce, and the write path is the gate.

**Revert, undo, branch are new versions.** Nothing is rewritten. `revert` restores an older artifact's
content as a version whose parent is the head (and can itself be reverted: that is redo). `undo` is a
revert to the head's parent. `branch` forks a version into a NEW line (its first version's parent is
the source version, in another line). Revert and branch are deterministic functions of two artifacts,
which is what lets `verify` recompute them.

**Sticky classes are carried forward (fail-closed).** A revert or branch adopts an artifact older than
the line, and the line has learned more since. Both fold the classes of the artifact the line had
reached (the head, or the source head at the fork) into the adopted one with core's `carryClasses`:
`strictest`, never lower, and including classes only that artifact's *live* nodes carried (they would
vanish with the nodes). So a restored or forked version can be stricter than it was, never laxer than
the line knew; handle, tool and projection classes are all carried. A trusted `declassify*` is an
ordinary composed version; reverting past it re-raises the class (the safe direction).

**Concurrent authors.** Two authors composing against the same head: one wins, the other gets
`head-moved` with the winner's hash. A promotion slipping between a writer's read and append retries at
the new tip (bounded) because the head did not move.

## Trust and operations

**The log is untrusted input.** Anyone with append access to a stream wrote what `foldLineage` reads,
so the fold is total: a record that is null, throws when read, records more than `MAX_OPS_PER_VERSION`
ops, or nests an op's node (or `prompt` ops) past the caps is a `lineage-event-invalid` finding, never
a stack overflow or an exception out of every read of that line.

**Lineage performs NO authorization.** `by` (on a version and on each recorded operation) is an
unverified caller claim; nothing here checks that the caller may act as that principal or touch that
line. `start` accepts ANY genesis, so a host that lets callers supply artifacts can have classes
laundered by copying an artifact with its sticky class maps stripped into a new line. The host must
gate who may `start`/`advance`/`branch`/`promote` and what artifacts it passes. `allowDeclassify` is a
per-call argument of `advance`/`compose` (there is no instance-level default): pass it only from code
that authored the ops itself. Stored `meta` is derived from `by` and the clock (as a revert's is), not
taken from the artifact argument.

**Branching.** `branch` reads the source line and then writes the new one (no lock across the two): a
source that advances in between is fine, because the fork records the head it carried classes from
(`carriedFrom`). Classes the source learns AFTER the fork do not reach the branch, which is a
different line from then on.

**Reserved stream namespace.** `eventStoreLineageStore` writes `__loom_ui_lineage__:<experienceId>`,
inside loom's `RESERVED_STREAM_PREFIX` (`__loom_`), so enumerators of real executions skip lineage
streams (a prefix outside it would be mistaken for an execution). Consequences: loom's `shredSubject`
throws for `__loom_*` ids, so a lineage stream CANNOT be crypto-shred tombstoned, yet events carry `by`
provenance and op payloads (props, labels). Hosts must not put personal data in props, labels or `by`;
if one did, the only erasure is to delete the line's events and blobs in the store itself (a content
address does not protect a blob from deletion). Streams are never compacted, so a long-lived line
grows without bound. loom will register the prefix as a sanctioned extension stream (a follow-up in
loom, not part of this package).

Genericity: nothing here names a consumer.

## Change delivery

`compose({ ..., summary })` records what the author said about a change (a planner's
`PlanResult.summary`) on the `EXPERIENCE_COMPOSED` event: untrusted model text, bounded and stripped
(`boundSummary`) on the way in and again when the fold reads it. It is not part of the content
address. `VersionRecord.summary` carries it. The feed, the unread cursor and the head signals that
consume the log live in [`@loom-ui/changes`](../changes/README.md).

## Provenance and what a viewer saw (U12)

`lineage.provenance(experienceId, versionHash?)` is the per-node ledger of a version (see core's
`foldProvenance`), derived from the recorded ops alone: no artifact is read and nothing is stored. A
revert has the ledger of the version it restores; a branch starts from its source version's (depth
bounded; beyond it the origin is unknown and the ledger says it was truncated). `lineage.explain(
experienceId, nodeId, { viewer, versionHash?, projections? })` is core's `explainNode` over that
ledger, plus the notes the line holds: the creating version's `summary` / `summaryClass`, with the
creating version's own class floor added (a class can be lowered between versions; a version that
cannot be read counts as `secret`). Stamp the planner's decision on the ops with
`@loom-ui/planner`'s `plannerProvenance(result)` so a node links back to the recorded model call.

Every `by` a write records (the write's own and each op's) is checked against core's `Provenance`
before the append and refused `provenance-invalid` (any other payload the fold would refuse is
`event-payload-invalid`): the fold stays strict, and the log has no delete, so the refusal is on the
write side. `plannerProvenance` omits a decision id outside 1-256 characters rather than stamp one.
`explain` resolves the creating version across lines (a branch's ledger starts from its source's,
bounded), and a writer it cannot find counts as `secret`; it asks the viewer-safe question first, so a
hidden node and an unknown id cost the same reads. `source.lastChanged` names the latest op that bound,
remapped or declassified a provider, so a viewer cleared for the node can learn that a declassify
happened (not what the class was): accepted, it is the audit trail.

**`SeenLog` records what a viewer was shown.** (`new SeenLog({ ..., readPolicy })` binds a read policy for `record` and `read`, joined with the lineage's.) `record({ experienceId, viewerId, snapshot, viewer })`
takes a core `snapshotSeen` snapshot, does not trust it (the version must be on the line; entries are
re-validated, restamped against that version's artifact, dropped when the recording viewer may not see
them, and re-capped), writes the value bytes to the `ContentStore` (content-addressed) and appends a
manifest (`VIEW_RECORDED`: the version, per source a class stamp, state, status and a SEALED content
ref) to a per-(experience, viewer) stream. `read({ ..., reader })` returns the views newest first (`until` = as
of a time), redacted for the READER before any blob is fetched. An identical consecutive view is not
re-recorded.

*Why a separate log, and not the lineage stream or the hydration store.* A lineage line is the shared
history of an experience with one compare-and-set tip that every writer contends for and every reader
(the change feed, fanned out to every viewer) folds; a view is per-viewer, frequent and carries data,
so recording it there would put every open of a surface in a race with every writer, mix one viewer's
classified values into a log all readers fold, and change what `verify` of the line must explain. The
hydration store is a latest-value cache for the surface being drawn (evicts, projected to a client,
no history): it cannot say what a viewer saw on Tuesday.

*Erasure is crypto-shredding.* A plain SHA-256 in an append-only log confirms any low-entropy value
("did this viewer see `42`?" is one hash away) and the log has no delete, so each entry's content ref is
stored ENCRYPTED (AES-256-GCM, node:crypto) under a per-(experience, viewer) data key, and the manifest
digest is an HMAC under that key, not a hash. The value bytes stay in the `ContentStore` under their
plain content address (identical values dedupe across viewers and with the lineage). The key lives in a
host-supplied `SeenKeyStore` (`getOrCreate` / `get` / `destroy`; `InMemorySeenKeyStore` is the
non-durable reference, `checkSeenKeyStoreConformance` the kit; a loom `@loom/plugin-crypto` `KeyStore`
satisfies it structurally, so a KMS-backed one can be passed as is). `eraseViewer({ experienceId,
viewerId })` destroys the key and then appends a `VIEWER_ERASED` tombstone (idempotent; a rerun
completes a half-done erasure): afterwards `read` returns `{ erased: true, views: [] }`, `record`
refuses (`seen-viewer-erased`), and nothing left in the stream is decryptable. The ciphertext is bound
as associated data to (experience, viewer, record sequence, entry index), so a ref cannot be moved
between records, entries or viewers (even under one shared key); a ref that fails to open (tampered,
transplanted, wrong key) is withheld (`restricted`), never read as plaintext. A missing or failing key
store refuses a `record` and a `read` (`seen-key-unavailable`): fail closed. Why the key lives here and
not in `shredSubject`: loom's shredder refuses the reserved `__loom_*` streams (a logged loom
follow-up), and a seen log has to live in one; `encryptValue` has no associated data, which this needs,
so the primitive is local (the `KeyStore` SHAPE is reused). The sealed payload is `{ref, bytes}`
padded to a constant length, so a `seen` entry's value size is hidden too (neither a field nor the
ciphertext length separates `true` from `false` from a short enum). What an erased stream STILL
reveals: that the viewer opened the experience; the sources each view named (handles / projection ids
and paths), node ids, class stamps, delivery statuses, the version hash and record times; and, for an
`oversize` / `over-budget` entry only, a power-of-two size class of its measured size (never the exact byte count: there the size class IS the recorded
fact). It reveals no value, no address and no size of a recorded value. A value blob stays readable in
the `ContentStore` until the collector below reclaims it. `SeenKeyStore` contract: after `destroy`
NO layer (including a warm cache) may serve the key; create-if-absent is atomic (concurrent
`getOrCreate` of one subject return one key); `record` re-reads the key just before it appends and
refuses (`seen-viewer-erased`) if it is gone. `eraseViewer` performs no authorization (erasing a pair
that never existed writes a tombstone), so the host decides who may erase what.
`eraseViewerEverywhere({ viewerId })` is the per-data-subject form: it enumerates the seen streams
(`listStreams`; refused with `seen-enumeration-unavailable` without it) and erases that viewer in
every experience, returning per-experience results (`complete` only when all succeeded; idempotent
and resumable). Coverage is the streams that exist when enumeration runs: a stream created afterwards (a new view during the erase) is not covered, so the host serializes erasure against new views for that subject or reruns; an orphan key with no stream (crash between `getOrCreate` and the first append) is not destroyed, and holds no data.

*Reclaiming blobs: `collectSeenGarbage(log, { graceMs, ownsContentStore: true })`.* MARK-AND-SWEEP, not
a refcount (there is no transaction across the event log and the `ContentStore`, so a counter drifts and
a crash between "append" and "increment" would delete a live value). MARK: every content address the
lineage cites (any `__loomContent` in any event of any line, via `Lineage.forEachContentRef`) plus every
DECRYPTABLE ref inside every viewer's retention window (`SeenLog.forEachLiveRef`) plus the host's
`extraRoots`. SWEEP: page the store (`listPage`) and delete every unmarked blob with the store's atomic
`deleteIfUntouchedSince(ref, cutoff)`, `cutoff = touchClock() at mark start - graceMs`. A blob touched
at or after the cutoff (written during the pass, or younger than `graceMs`, including a dedup'd re-put)
is never swept: that is what protects a value whose manifest is not appended yet; `graceMs` must exceed
the longest a `record()` can take between putting a blob and appending its manifest. A crash in that
gap leaks the blob until the first pass past grace and never loses a cited value. Erased viewers and
rolled-off views mark nothing, so their unique blobs are swept while a blob another viewer or the
lineage still cites survives. A pass is idempotent and safe to rerun after a crash. It FAILS CLOSED
before deleting anything if the root set cannot be established (a `LineageStore` without
`listStreams`, a key-store failure, ANYTHING UNREADABLE in a live window: a stream key that does not
round-trip, a record that fails to parse (a newer writer's shape during a rolling upgrade), a sealed
ref that fails to open under a PRESENT key: refusal `gc-unreadable-record` with counts, overridden only
by `allowUnreadable: true`, which means "sweep what those cite"; an ABSENT key is an erased viewer,
not unreadable, a `ContentStore` without the SPI 1.3.0 set `listPage` +
`deleteIfUntouchedSince` + `touchClock`, more than `maxMarked` live addresses). Memory: one string per
distinct live blob (`maxMarked`, default 5M, refuses rather than grow), one stream at a time, pages of
`pageSize`. `ownsContentStore: true` is an assertion you make: the sweep deletes what it cannot root, so
the store must hold nothing the lineage, the seen logs and `extraRoots` do not name. No loom or
`ContentStore` SPI change was needed: SPI 1.3.0 already carries the touch time.

*Retention rolls off, it does not refuse.* `retention: { maxViews = 10_000, maxAgeMs?, maxSkewMs = 300_000 }`. Reads apply `maxAgeMs` exactly; the two irreversible age actions (a persisted watermark, the collector) are conservative by `maxSkewMs`, so a writer whose clock runs ahead by up to that much cannot roll off or sweep a view still inside the window by true time. With out-of-order timestamps within `maxSkewMs` at the `maxViews` cap, the conservative window can differ from the exact window's newest-N, in the direction of keeping MORE. A new view
ALWAYS records. The log is append-only, so roll-off is a watermark: each view carries the `floor` in
force when written and a `VIEWS_RETAINED` record raises it (about once per `maxViews/10` roll-offs);
`read` and the collector apply the window themselves (floor, age, newest `maxViews`), so correctness
never depends on a watermark having been written. Records at or below the floor are neither read nor
marked, so their blobs are reclaimed by the collector. Cost: `record` reads the LAST record only (tip,
floor and the last digest all ride on it) plus the window when a watermark is due; `read` and the
collector read `readAfter(floor)`, i.e. the window, never the log's lifetime. That needs the optional
`LineageStore.readTail` / `readAfter` (both reference stores and `eventStoreLineageStore` implement
them; a store without them falls back to a full `read`, O(log) per call). The rolled-off records stay in
the raw log as ciphertext (destroyed with the viewer's key).

Operations: the stream lives in its own reserved namespace (`eventStoreLineageStore(store,
seenStoreOptions)` writes `__loom_ui_seen__:<experience>/<viewer>`), so the notes on reserved streams
above apply (loom's `shredSubject` refuses them, which is why the seen log carries its own key store).
`LineageStore` gained three OPTIONAL methods: `readTail`, `readAfter` and `listStreams` (the
collector's enumeration; `eventStoreLineageStore` implements it over the SPI's `listExecutionsPage` /
`listExecutions`, which DO surface reserved streams, found by prefix). `viewerId` and `viewer` are the
host's claims: this package authorizes nothing.

Reference example (for `loom-examples`, not generic to one app): record views for two viewers who saw
the same value, erase one (`eraseViewer`), show the raw stream holds no readable address, show
`read` says `erased` while the other viewer's identical value still reads, run `collectSeenGarbage`
and show the erased viewer's unique blob is swept while the shared one and the lineage's artifacts
survive, then roll a viewer past `maxViews` and show the oldest views fall out of `read` and the
next sweep reclaims their blobs.

Seen-record details. An entry is judged by what its nodes actually bind: every node it lists must bind
exactly its `source`, an entry with no nodes is withheld, and `record` refuses a snapshot that names
one source twice (`seen-duplicate-source`); a read carries each value ref by the entry's position in
the record, never by source. A read hashes the bytes the content store returns and compares them to the
address in the manifest; a mismatch is state `corrupt` (no value). Trust boundary: a manifest ref points
at whatever the store holds under that address, so write access to the `ContentStore` (or the seen
stream) is write access to what a viewer is later shown, exactly as for the lineage's artifacts; this
package does not prove a blob was written by the stream that names it. `record` refuses a snapshot or
record that a read could not parse (`seen-snapshot-invalid`, `seen-record-invalid`) rather than append
a permanently malformed one. A `read` folds the lineage once for all the versions it touches; `record`
folds it once (O(line length) per write). An identical consecutive view is not re-recorded, so the
kept record carries the FIRST view's `at`. The seen stream's prefix must not overlap the lineage's
(`Lineage.sharesStreamsWith` compares both ways, `a.startsWith(b) || b.startsWith(a)`, and `SeenLog`
throws on a shared store or an overlapping prefix). The vetted store must expose a readable
`streamPrefix` (or be an `InMemoryLineageStore`): a decorator that HIDES it cannot be told apart from a
colliding store, so it is refused; re-expose `streamPrefix` on a legitimate wrapper. If the LINEAGE's own
store is such a wrapper its prefix is assumed to be the default. And `eventStoreLineageStore` throws for a
`streamPrefix` not under `__loom_ui_` or a malformed `workflowId`.
