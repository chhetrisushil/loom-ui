import { BLUEPRINT_IR_VERSION } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";

// compile.ts emits a loom `Blueprint` field by field. loom's ADR 0096 makes that shape a
// versioned IR precisely so an external framework compiling to it is not silently broken by a
// field added, renamed or flipped between required and optional — but the version only protects
// a consumer that reads it. Nothing else in this repo does, so this is the read: a pin that turns
// an upstream IR bump into a red test here instead of a subtly wrong blueprint in production.
//
// 2.1.0 (loom ADR 0098) added optional `GridCell` placement (`row`, `rowSpan`, `column`) and an
// optional `title` on every `Layout`; compile.ts emits both from the Experience's node placement
// and container titles. 2.2.0 (loom ADR 0099) added an optional `role` on every `Layout` — the
// open, app-defined key a container renderer is registered under; compile.ts emits it from a
// container node's `role`. 2.3.0 (loom ADR 0100) added `empty` to `BindingState` — a status, not
// a Blueprint field, so compile.ts emits nothing new; hydration publishes it for a dependent
// binding over an empty upstream (`upstream-empty`) and the Lit base draws it. 2.4.0 (loom ADR
// 0101) added an optional `id` on every `Layout`, in the one node-id namespace widget ids share;
// compile.ts emits each container node's `id` on its layout, the root included, so a renderer can
// keep a container across a recompose. 2.5.0 (loom ADR 0097 amendment, 2026-10-11) added an
// optional `WidgetSource.redacted: true`: the compiler's mark that it WITHHELD a widget's content
// for the surface's audience (no binding, title, props or degrade chain; the generic source
// `redacted`/`1`; the renderers draw only a constant marker; `validateBlueprint` enforces it as
// `redacted-invalid`). compile.ts now EMITS it: `CompileOptions.audience: "broadcast"` compiles
// every withheld node to that widget (kind `Note`, an `r_` alias id, the same cell), and the Lit
// renderer draws loom's marker for it. A `"viewer"` surface is byte-identical to 2.4.0 output. A further bump means reading the next ADR and deciding again.
describe("the loom Blueprint IR this compiler targets", () => {
  it("is the version compile.ts was written against", () => {
    expect(
      BLUEPRINT_IR_VERSION,
      "loom's Blueprint IR changed — review compile.ts and bump deliberately"
    ).toBe("2.5.0");
  });
});
