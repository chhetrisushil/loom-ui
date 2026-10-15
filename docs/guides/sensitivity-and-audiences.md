# Sensitivity, viewers and audiences

**Purpose.** Keep classified data off screens that must not show it: classify bindings, compile one
experience for different viewers, draw a shared wallboard safely, and make the data boundary agree
with the screen.

**Prerequisites.** [Composing](composing.md) and [hydration](hydration.md). Snippets are mirrored
from [`sensitivity.test.ts`](../snippets/src/sensitivity.test.ts).

<!-- snippet: imports -->

```ts
import {
  type Experience,
  type ProviderSpec,
  compile,
  compileFingerprint,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  handleInventory,
} from "@loom-ui/hydration";
```

## The model

- A binding may carry a `sensitivity`: `internal`, `sensitive` or `secret` (loom's classes, ordered
  `secret > sensitive > internal`). Nothing below `internal` exists but "no class".
- A **viewer** has a `clearance`: the strictest class they may see. **No viewer is a viewer with no
  clearance**, which sees only unclassified bindings. Unclassified bindings are never affected, so
  an experience that classifies nothing compiles byte for byte as before.
- A **handle carries one value for every node that binds it**, so its class is the strictest of those
  nodes. Classes are **sticky**: removing, renaming or rebinding the classified node does not
  declassify its handle, and a tool's class sticks to every handle on that tool. Only
  `declassifyHandle`, an operation a *trusted caller* must opt into (`{ allowDeclassify: true }`),
  lowers one. A planner can never emit it.
- The **audience** says who the surface is for: `"viewer"` (default; the requesting viewer's
  clearance decides) or `"broadcast"` (a wall, a shared screen, a recording).

Enforcement happens at output boundaries and is **fail closed**: an unknown class, or an `audience`
other than `"viewer"`, is treated as the most restrictive reading.

## Classify a binding

<!-- snippet: classified -->

```ts
// The board from the walkthrough, plus a node whose data is classified "sensitive".
const build = (base: Experience): Experience => {
  const r = replay(base, [
    { type: "remapProvider", handle: "payroll", spec: spec("payroll") },
    {
      type: "insertNode",
      parentId: "root",
      node: {
        id: "payroll-total",
        order: "W",
        kind: "semantic",
        type: "Metric",
        typeVersion: "1.0.0",
        span: 6,
        props: { unit: "USD" },
        binding: { handle: "payroll", priority: "P1", sensitivity: "sensitive" },
      },
    },
  ]);
  if (!r.ok) throw new Error(r.finding.message);
  return seal(r.value);
};
```

Who may set `binding.sensitivity` is declared per catalogue entry (`sensitivity: "caller"`, the
default, or `"model-may-set"` for a planner). You can also **declare a tool's class up front**
instead of inferring it from nodes: pass `declaredToolClasses` (`Record<toolKey, DataClass>`, built
with `declaredToolClassesFrom(capabilities)` from `@loom-ui/planner`) to every read path. It is a
floor that only ever raises a read, so a sibling bound before its tool was classified is gated as
soon as the tool is. It is a table you pass, not stored state; set `undeclared: "deny"` to make a
tool the table omits unreadable.

## Compile for a viewer or an audience

<!-- snippet: compile -->

```ts
const options = {
  surface: "web",
  catalog,
  hydrationProjectionId: HYDRATION_PROJECTION_ID,
  hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
  placeholderKey,
} as const;

// No clearance: the classified node is a "Restricted" placeholder under an opaque id.
const anyone = compile(experience, { ...options, viewer: {} });
// A cleared viewer sees everything they may.
const analyst = compile(experience, { ...options, viewer: { clearance: "sensitive" } });
// A wallboard: whoever is logged in, the broadcast ceiling applies (unclassified only).
const wall = compile(experience, {
  ...options,
  viewer: { clearance: "secret" },
  audience: "broadcast",
});

// SERVER-SIDE ONLY: findings name real node ids and handles.
anyone.findings.map((f) => f.code); // ["node-restricted"]
wall.findings.map((f) => f.code); // ["audience-withheld"]
```

What each result contains:

| Compile | The classified node becomes | Server-side finding |
| --- | --- | --- |
| viewer with no clearance | a `Note` reading "Restricted", same grid cell, opaque `r_` id | `node-restricted` (warn) |
| viewer with clearance | drawn normally | none |
| `audience: "broadcast"` | loom's redacted widget (`source.redacted`), same cell, **nothing else** | `audience-withheld` (warn) |

- On a broadcast surface the effective clearance is the **stricter** of the viewer's and the
  broadcast ceiling (unclassified only), whoever is logged in. A node the viewer could not see
  anyway and a node only the audience excludes compile to the **same** widget, so the artifact does
  not reveal which reason applied; the finding does.
- The Blueprint has no `audience` field: it records the result. A broadcast and a viewer compile are
  different artifacts and never share a memo entry.
- A classified `intent` is not the default Blueprint title for a viewer who may not see it
  (`title-restricted`); an explicit `title` option is your own text and is never gated.
- An **unclassified principal-scoped tool** (such as "my queue") stays visible on a broadcast surface.
  Classify it, or set `undeclared: "deny"` with a `declaredToolClasses` table, for a strict wallboard.

### Opaque ids and the key

Node ids are lexical (`payroll_salary_by_employee` says what it is), so a restricted node and a
collapsed container are emitted under an alias: `r_` plus an HMAC of `(experienceId, nodeId)` under
your `placeholderKey`. The key is a secret you hold, at least 16 bytes, the same on every replica;
rotate it only when a one-time remount of placeholders is acceptable. With no key a random
per-process key is used and one `placeholder-alias-key-not-supplied` warning is raised; actions
stamped before a restart are then refused as stale. A supplied key under 16 bytes throws
`PlaceholderKeyError`. In production set `requirePlaceholderKey: true` so a missing key throws instead
of falling back. Do not identify placeholders by their `r_` prefix; use the kind and the label.

**Never serialise to a viewer:** `CompileResult.findings`, `restrictedProjectionNodes`,
`restrictedHandles`, and `inspectExperience`. They carry real ids. Use `result.fingerprint`, the
opaque form, when you need something viewer-facing.

## Make the data boundary agree

A hidden widget with its data still flowing is not hidden. Give `HydrationController`,
`handleInventory` and `serveHandles` the **same** `viewer` and `audience` you compiled with:

<!-- snippet: boundary -->

```ts
// The data boundary must agree with the screen: same viewer, same audience.
const revisionOf = (handle: string, fingerprint: string) => `${handle}:${fingerprint.length}`; // demo only: use an HMAC
const forWall = handleInventory(experience, {
  revisionOf,
  viewer: { clearance: "secret" },
  audience: "broadcast",
});
forWall.inventory.handles.map((h) => h.handle); // ["latency-p99"]: "payroll" is not even listed
```

A handle the viewer or audience may not read is omitted from the inventory, never loaded or cached,
and a client that names it anyway is refused as `unknown-handle`, the same answer as for a handle that
does not exist, so there is no oracle for which handles are restricted. A broadcast store is its own
projection state, so a wallboard bind can never erase or read a personal surface's values;
mismatched audiences throw `HydrationAudienceMismatchError`.

## Stamp what was shown

Actions carry the version the user saw. When compile inputs vary per viewer, stamp with the
**result's** clearance and opaque fingerprint, so an approval cannot be replayed against a view with
different redactions:

<!-- snippet: stamp -->

```ts
// Stamp what the viewer was shown. Feed the RESULT's clearance and opaque fingerprint, not the
// asker's, so a broadcast stamp is the same whoever asked.
const stamp = compileFingerprint({
  clearance: wall.clearance,
  locale: "en-US",
  ...wall.fingerprint,
});
```

Pass the stamp to the renderer (`DomRenderOptions.compile`) and check it with `isStaleAction` where
the action is applied ([rendering](rendering.md#actions-and-stale-views)).

## Everything else takes the same viewer

`describeChange`, `snapshotSeen`, `explainNode`, `Lineage.explain`, `SeenLog` reads and the learning
`SignalIngestor` all accept `viewer` and `audience` and fail closed. A change touching restricted
content collapses into one bare `restricted-changed` entry with no id, type or count, so "a
restricted node was edited" and "another was removed" look identical. See
[lineage and changes](lineage-and-changes.md).

## Gotchas

- `viewer: {}` and a missing `viewer` both mean no clearance; a missing one also raises
  `viewer-not-supplied`. Pass a viewer deliberately.
- Reverting or branching never lowers a class: both carry the newest sticky classes forward.
- A merge re-folds classes strictest-first, so a one-sided `declassifyHandle` does not survive it
  (`declassify/merge`); re-apply it after.
- Classification is not authorization. loom-ui decides what a viewer sees; who the viewer is, and
  who may author or declassify, is your host's responsibility.
- `versionHash` is an unkeyed hash of the whole experience including hidden content; do not expose it
  where a party could guess an entire experience.

## See also

- Reference: [audience](../reference/audience.md), [composition](../reference/composition.md).
- Package: [`@loom-ui/core`](../../packages/core/README.md) (sections "Opaque ids" and "Notable
  behaviours").
- Examples (in `loom-examples`): `experience-broadcast` (one experience on a personal screen and a
  lobby wallboard), `provenance-explain` (per-viewer "why is this here"), `media-gallery`.
