# Composing and revising an experience

**Purpose.** Build an experience from operations, change it later without losing the identity of
the nodes users are looking at, detect a stale author, and merge two lines of edits.

**Prerequisites.** You have done the [getting-started](../getting-started.md) walkthrough. Imports
come from `@loom-ui/core` (pure and isomorphic) and, for sealing, `@loom-ui/core/log`.

The snippets here are mirrored from
[`composing.test.ts`](../snippets/src/composing.test.ts) and start from the sealed
one-metric `base` experience built in the walkthrough.

<!-- snippet: imports -->

```ts
import {
  type Experience,
  type Operation,
  apply,
  applyAt,
  experienceNodeIds,
  keyConflicts,
  mergeExperiences,
  preservesNodes,
  replay,
  validateExperience,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
```

## The model in one paragraph

An experience is data: `{ experienceId, versionHash, parents, intent, root, providers,
vocabularyFloor, meta }`. You never mutate it. You apply **operations** (`insertNode`,
`removeNode`, `moveNode`, `setProps`, `setLabel`, `setTitle`, `setRole`, `setPlacement`,
`bindProvider`, `unbindProvider`, `remapProvider`, `removeProvider`, `declassifyHandle`, `prompt`)
and get a new experience. `apply` and `replay` are deterministic, so a list of operations is the
authoritative record of how a screen came to be, and replaying it reproduces the same content
address. Operations are not part of that address; [lineage](lineage-and-changes.md) is what checks
that a recorded list still reproduces the artifact it claims to.

## Operations never throw

A malformed or illegal operation returns a `Finding` with a stable code. Branch on the code, never
on the message.

<!-- snippet: refusal -->

```ts
const r = apply(base, { type: "removeNode", nodeId: "root" });
if (!r.ok) console.log(r.finding.code); // "root-immutable"
```

The codes you meet most often:

| Code | Meaning |
| --- | --- |
| `invalid-operation` | the operation fails the `Operation` schema |
| `duplicate-node-id`, `missing-node`, `missing-parent` | an id that already exists, or does not |
| `not-a-container` | the parent of an `insertNode` / `moveNode` is a semantic node |
| `not-container` | `setTitle` / `setRole` applied to a semantic node |
| `root-immutable` | the root cannot be removed, moved or re-placed |
| `cyclic-move` | a node cannot move into its own subtree |
| `placement-outside-grid`, `placement-out-of-range` | `row` / `column` need a `grid` parent and fit its 12 columns |
| `missing-provider`, `provider-still-bound`, `not-bound` | provider and binding bookkeeping |
| `tree-too-deep` | the tree would nest past `MAX_TREE_DEPTH` |
| `stale-base-version` | `applyAt` only: your declared base is not the artifact |

The complete list per operation is in the [composition reference](../reference/composition.md).

## Revise without losing identity

Identity is the node `id`. A widget that keeps its id and kind keeps its element, its subscription
and the user's typed text, scroll and focus when the renderer next updates. So a revision should be
operations that edit the nodes in place (`setProps`, `setLabel`, `setPlacement`, `moveNode`), not a
remove-and-reinsert that mints new ids.

<!-- snippet: revise -->

```ts
const ops: Operation[] = [
  { type: "setProps", nodeId: "p99", patch: { unit: "s" } },
  { type: "setLabel", nodeId: "p99", label: { key: "latency.p99", fallback: "p99, seconds" } },
  { type: "setPlacement", nodeId: "p99", span: 12 },
];
const revised = replay(base, ops);
if (!revised.ok) throw new Error(revised.finding.message);

// Same ids before and after: the widget keeps its element, focus and subscriptions.
const identity = preservesNodes(experienceNodeIds(base), experienceNodeIds(revised.value));
// identity.ok === true, identity.added === []
```

`preservesNodes` is the check to run in a test or in an agent loop: every id present before must
be present after (`dropped-node-id` otherwise), and `added` lists the new ones. A planner returns
exactly this kind of operation list; see the [planner guide](planners-and-learning.md).

Grid placement has rules worth knowing before you trip them. The default root is a 12-column
`grid`, and a node's `span` becomes its cell only under a `grid` parent; under a `row` or `column`
parent a span is silently dropped. `row`, `rowSpan` and `column` are 1-based grid lines and are
refused (not dropped) off a grid or past column 12. Set them with `setPlacement`, where an absent
field is unchanged and `null` clears it.

## Detect a stale author

`apply` is last-writer-wins. When an author composed against a particular version, use `applyAt`
with the `baseVersion` they saw; if the artifact is something else, nothing is applied.

<!-- snippet: stale -->

```ts
const moved = replay(base, [{ type: "setProps", nodeId: "p99", patch: { unit: "s" } }]);
if (!moved.ok) throw new Error(moved.finding.message);
const head = seal(moved.value);

// This author composed against `base`, but the line has moved on to `head`.
const stale = applyAt(
  head,
  { type: "setProps", nodeId: "p99", patch: { unit: "ms" } },
  { baseVersion: base.versionHash }
);
if (!stale.ok) console.log(stale.finding.code); // "stale-base-version"
```

This is detection only: loom-ui does not rebase a stale operation. Re-read, re-author, or merge.
[`Lineage.compose`](lineage-and-changes.md) applies the same rule against the stored head.

## Merge two forks

When two authors fork the same sealed `base` and edit separately, `mergeExperiences(base, ours,
theirs)` joins them. It is pure, never throws, and **always** returns a usable result: wherever the
sides disagree, `ours` wins and the disagreement is listed in `conflicts`.

<!-- snippet: merge -->

```ts
const fork = (op: Operation): Experience => {
  const r = apply(base, op);
  if (!r.ok) throw new Error(r.finding.message);
  return seal(r.value);
};
const ana = fork({ type: "setLabel", nodeId: "p99", label: { key: "l", fallback: "p99" } });
const ben = fork({ type: "setLabel", nodeId: "p99", label: { key: "l", fallback: "P99!" } });

const { experience, conflicts } = mergeExperiences(base, ana, ben);
// Ours wins every conflict; the merge is unsealed and has no parents yet.
const merged = seal({ ...experience, parents: [ana.versionHash, ben.versionHash] });

// conflicts: [{ plane: "layout", kind: "edit/edit", ref: "p99", detail: "..." }]
const keys = keyConflicts(ana.root, ben.root, merged.root); // the localization check alone
```

What to know:

- The returned experience is **unsealed** with no parents. You decide the parents (normally both
  heads) and `seal`.
- Layout merges on node ids over three independent dimensions (parent, sibling order, the node's own
  content), so a move on one side and an edit on the other is clean. Conflict kinds:
  `move/move`, `remove/edit`, `edit/edit`, `add/add`, `orphan`, `depth`; providers conflict as
  `provider/provider`, the intent field by field as `intent/intent`.
- `message/message` is the conflict nothing structural sees: two nodes added independently reuse a
  localization key with different wording, so the merge is otherwise clean yet one key now means
  two things. `mergeExperiences` includes it when both sides changed the layout; `keyConflicts`
  runs the same check on its own.
- Sensitivity classes only ratchet up. A one-sided `declassifyHandle` does not survive a merge and
  is reported as `declassify/merge`; re-apply it deliberately afterwards.
- Two inserts at the same gap mint the same order key; the merge re-keys the tie so later inserts
  between them cannot fail.

A conflicted merge is still a usable experience, so an app can show it and ask for a resolution.

## Validate against a catalogue

`validateExperience` is the structural and vocabulary check (duplicate ids, depth, placement, roles,
unresolved or degraded types). `compile` runs it for you and reports through `findings`; call it
directly to gate a merge or a stored artifact.

<!-- snippet: validate -->

```ts
const v = validateExperience(base, catalog, "terminal");
const errors = v.findings.filter((f) => f.severity === "error");
// errors === [], v.nodes === 1
```

`nodes` is the count of semantic nodes visited, so an `ok` over zero nodes is visible.

## Gotchas

- Node ids are lexical and chosen by the author. Re-using an id for different content defeats
  identity; mint stable, meaningful ids once.
- `order` keys are strings between which you can always insert (`orderKeyBetween`). Do not use
  indices.
- `intent` is inside the content hash and no operation changes it.
- `replay` stops at the first refusal and returns that finding; it does not skip.

## See also

- Reference: [composition](../reference/composition.md).
- Package: [`@loom-ui/core`](../../packages/core/README.md).
- Examples (in `loom-examples`): `experience-merge` (the merge conflicts above, with a rota board),
  `experience-recompose` (revise a live board in place), `experience-layout` (placement and titles).
- Next: [hydration](hydration.md), [rendering](rendering.md).
