import { InMemoryProjectionRuntime } from "@loomwork/projection-runtime";
import { useDiagramContracts, useMediaContracts } from "@loomwork/ui-core/browser";
import { describe, expect, it } from "vitest";
import { HydrationStore } from "./projection";
import { SplitHydrationController } from "./split/client";

// core's zod-free checker DEFERS the chat, media and diagram contracts (loaded by
// useChatContracts / useMediaContracts / useDiagramContracts). The split controller's
// publishValue checks through it, so a value of such a kind is refused until its contract is
// loaded, and checked normally after. This file must not load them before the first test.

const IMAGE = { address: "sha256:ab", mediaType: "image/png" };
const DIAGRAM = { layout: "flow", nodes: [{ id: "a", label: "A" }], edges: [] };

function controller(): { ctl: SplitHydrationController; store: HydrationStore } {
  const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
  const ctl = new SplitHydrationController({
    store,
    loader: { load: async () => ({ state: "pending" }) as never, loadMany: async () => [] },
  });
  ctl.load({
    experienceId: "exp-1",
    versionHash: "sha256:v1",
    handles: [{ handle: "h", priority: "P2", params: [], revision: "r1" }],
  });
  return { ctl, store };
}

describe("split publishValue and deferred contracts", () => {
  it("refuses a deferred kind whose contract is not loaded, and writes nothing", () => {
    const { ctl, store } = controller();
    for (const [kind, value] of [
      ["Image", IMAGE],
      ["Diagram", DIAGRAM],
    ] as const) {
      const r = ctl.publishValue("h", value, { kind });
      expect(r.ok, kind).toBe(false);
      if (!r.ok) expect(r.finding.message).toMatch(/contract is not loaded/);
    }
    expect(store.value("h")).toBeUndefined();
  });

  it("publishes it once loaded, and still refuses a bad value", () => {
    useMediaContracts();
    useDiagramContracts();
    const { ctl, store } = controller();
    expect(ctl.publishValue("h", IMAGE, { kind: "Image" })).toEqual({ ok: true });
    expect(store.value("h")).toEqual(IMAGE);
    expect(ctl.publishValue("h", DIAGRAM, { kind: "Diagram" })).toEqual({ ok: true });
    expect(ctl.publishValue("h", { address: 1 }, { kind: "Image" }).ok).toBe(false);
  });
});
