# loom-ui

A semantic UI framework for [loom](https://github.com/chhetrisushil/loom). You describe an
**experience** — semantic nodes such as `Metric`, `Trend`, `Collection`, with stable ids, bound to
data by handle — and loom-ui compiles it, per surface, to a loom `Blueprint` that loom's renderers
draw. Composition is recorded as a content-addressed artifact plus the operations that produced
it, so a view can be replayed, revised without losing node identity, and rendered without a model
in the path.

| Package | Job |
|---|---|
| `@loom-ui/core` | Experience Model, operations + deterministic replay, semantic catalogue, compiler to loom `Blueprint`; `./log` subpath for content-addressed persistence |

Design: `loom/docs/requirements/2026-09-21-loom-ui-design.md`. Contributor notes: `AGENTS.md`.

## Shape of a composition

```ts
import { apply, compile, genesis } from "@loom-ui/core";
import { EXPERIENCE_COMPOSED, putExperience } from "@loom-ui/core/log";

let exp = genesis({ experienceId: "checkout-triage", intent: { objective: "Investigate checkout latency", source: "user" }, meta });
const r = apply(exp, { type: "insertNode", parentId: "root", node: { id: "p99", order: "V", kind: "semantic", type: "Metric", typeVersion: "1.0.0", span: 6, props: { unit: "ms" }, binding: { handle: "latency-p99", priority: "P0" } } });
if (!r.ok) throw new Error(r.finding.message);

// Inside a loom execution: seal, store the bytes, log the reference (a userspace event).
const { experience, ref } = await putExperience(contentStore, r.value);
ctx.emit(EXPERIENCE_COMPOSED, { ref, parents: experience.parents, ops: [{ op, by: { source: "user" }, at: now }] });

// Anywhere, later, with no model in the path: compile per surface and hand loom the Blueprint.
const { blueprint, findings } = compile(experience, { surface: "web", catalog, hydrationProjectionId: "hydration", hydrationProjectionVersion: "1.0.0" });
```
