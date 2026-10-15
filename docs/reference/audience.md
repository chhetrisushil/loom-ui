# Audience reference

`compile` decides what a surface shows from a node's `sensitivity` and WHO the surface is for.
`audience` says who. See also the [composition reference](composition.md),
[hydration reference](hydration.md) and [`@loom-ui/core`](../../packages/core/README.md).

## Choosing an audience

```ts
// The requesting viewer's own surface (the default): their clearance decides.
compile(exp, { ...opts, viewer: { clearance: "sensitive" } });

// A wallboard, a shared screen, a recording: whoever is asking, the broadcast ceiling applies.
compile(exp, { ...opts, viewer: { clearance: "secret" }, audience: "broadcast" });
```

## Rules

- **`"viewer"`** (default, or absent) is exactly the behaviour before audiences existed, byte for
  byte.
- **`"broadcast"`** takes the STRICTER of the viewer's clearance and the broadcast ceiling. The
  ceiling is the lowest class: only UNCLASSIFIED bindings are shown, so every classified one is
  withheld whatever the viewer's clearance (loom-ui's class order is `secret > sensitive >
  internal`, with nothing below `internal` but "no class", and it has no configurable order, so the
  ceiling is not configurable either). FAIL-CLOSED: a class loom-ui does not recognise is withheld;
  an `audience` value other than `"viewer"` is read as `"broadcast"`; no `viewer` is needed and no
  `viewer-not-supplied` is raised. A classified `intent` is not the default Blueprint title on a
  broadcast surface; an explicit `title` override is the app's own text and is never gated.
- **One shape for what is withheld on a broadcast surface**: loom's Blueprint IR 2.5.0 redacted
  widget, kind `Note`, `source: { type: "redacted", version: "1", redacted: true }`, an opaque `r_`
  alias id (the `placeholderKey` HMAC), the node's own grid cell, and no binding, title, props,
  degrade chain or original type. A container of nothing but withheld nodes collapses to one such
  widget. A node the requesting viewer could not see anyway and a node only the audience excludes
  compile to the SAME widget, so the artifact does not reveal which reason applied; the server-side
  finding does. On a `"viewer"` surface the restricted placeholder is unchanged (a `Note` reading
  "Restricted"): loom-ui changes no existing compiled output, and `redacted` appears only where an
  audience asked.
- **The Blueprint has no `audience` field** (loom ADR 0097 D5): it records the RESULT. A broadcast
  and a viewer compile of one experience are different artifacts (different content address) and
  never share an entry in the compile memo (`audience` is part of the key).
- **The data boundary must agree.** Give `HydrationController`, `handleInventory` and `serveHandles`
  the same `audience`: a handle `compile` withheld is never loaded, cached or listed, and a client
  that names it anyway is refused as `unknown-handle` even when the `viewer` is fully cleared. The
  controller snapshots the audience at construction (mutating the options object later cannot lift
  the ceiling).
- **Hydration isolation is by (experience, principal, audience).** `HydrationScope` carries
  `audience`, and a broadcast scope is a different projection state from the same principal's
  personal one, so a wallboard bind (which removes the handles it withholds) can never erase, or
  read, the personal surface's values. A `HydrationController` whose `audience` disagrees with its
  store's scope throws `HydrationAudienceMismatchError`.
- **Every per-viewer output takes the same `audience`.** `describeChange`, `snapshotSeen`,
  `redactSeen`, `explainNode`, `Lineage.explain`, `SeenLog.record` / `read` and the learning
  `SignalIngestor.ingest` / `seenLogExposure` accept `audience`; `"broadcast"` judges as a viewer
  with no clearance, whoever `viewer` is, so a broadcast surface never describes, explains or
  records a classified node as seen by the principal. `CompileResult.viewer` / `.clearance` carry
  the effective viewer for callers that would rather pass it on directly. Stamp actions with the
  RESULT's clearance (`compileFingerprint({ clearance: result.clearance, locale,
  ...result.fingerprint })`) so a broadcast stamp is the same whoever asked.
- **Unclassified stays visible on a broadcast surface**, which is exactly what a viewer with no
  clearance sees. That includes an unclassified principal-scoped tool ("my queue"): it is loaded
  under the requesting principal's authority and shown on the wall. Classify such tools, or set
  `undeclared: "deny"` (with a `declaredToolClasses` table) on the read policy for a strict
  wallboard.
- **Renderers** (`renderer-lit`, and loom's terminal traversal under `renderer-terminal`) draw only
  loom's constant `⊘ redacted` marker for a `source.redacted` widget: no renderer runs, nothing
  subscribes, and no kind, title, value or source attribute reaches the output, even for an
  unvalidated widget that still carries them. The renderer-conformance kit's `audience` check enforces this for any renderer.

## Findings

| Finding | Severity | Meaning (server-side: names real ids) |
| --- | --- | --- |
| `audience-withheld` | warn | a node the requesting viewer may see was withheld because the surface is a broadcast |
| `node-restricted` | warn | a node the requesting viewer may not see (unchanged; on a broadcast surface it is also a redacted widget) |
| `title-restricted` | warn | the default title (the intent objective) is classified above the effective viewer |

## Example

Example: `examples/experience-broadcast` in `loom-examples` renders one experience as a personal
viewer surface and as a broadcast wallboard.
