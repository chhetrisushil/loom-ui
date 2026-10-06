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
