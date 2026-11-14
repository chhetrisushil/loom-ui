import { checkKindValue } from "@loomwork/ui-core/browser";
import { describe, expect, it } from "vitest";

// core's zod-free checker (what the split hydration client's `publishValue` runs) DEFERS the chat,
// media and diagram contracts. renderer-lit loads them in its `define*`; the terminal draws the same
// kinds, so it must load them too, or a terminal + split-client host fails closed on every publish.
// This file imports the renderer only dynamically, so the "before" state is real (non-vacuity).

const VALUES = [
  ["Chat", { mode: "owner", entries: [] }],
  ["MultiSelectInput", { options: [{ value: "a", label: "A" }], selected: [] }],
  ["Image", { address: "sha256:ab", mediaType: "image/png" }],
  ["Diagram", { layout: "flow", nodes: [{ id: "a", label: "A" }], edges: [] }],
] as const;

describe("the terminal renderer loads the deferred value contracts it draws", () => {
  it("before the renderer is loaded, each deferred kind fails closed", () => {
    for (const [kind, value] of VALUES) expect(checkKindValue(kind, value).ok, kind).toBe(false);
  });

  it("once the renderer is imported, each kind checks (good passes, bad is refused)", async () => {
    await import("./index");
    for (const [kind, value] of VALUES) expect(checkKindValue(kind, value).ok, kind).toBe(true);
    const bad = checkKindValue("Chat", { entries: "nope" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.finding.message).not.toMatch(/not loaded/);
  });
});
