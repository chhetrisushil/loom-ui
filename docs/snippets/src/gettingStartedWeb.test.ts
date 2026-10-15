// @vitest-environment happy-dom
// The web half of docs/getting-started.md. Its regions are mirrored by the blocks marked
// `<!-- snippet: NAME in gettingStartedWeb.test.ts -->`, which gettingStarted.test.ts checks.
import { describe, expect, it } from "vitest";
import { boardBlueprint, boardStore } from "./fixtures.test-support";
// #region lit
import { litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import "@loom-ui/renderer-lit/register"; // defines the <lu-*> elements; nothing registers on import
// #endregion lit

describe("docs/getting-started.md, web", () => {
  it("draws the blueprint with the Lit DOM adapter", async () => {
    const { blueprint } = boardBlueprint("web");
    const { runtime, store } = boardStore();
    const host = document.createElement("div");
    document.body.append(host);
    // #region litRender
    const handle = renderBlueprintDom(host, blueprint, {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: litRegistry,
    });
    // #endregion litRender
    await new Promise((r) => setTimeout(r, 20));
    expect(host.querySelector("lu-kpi")).not.toBeNull();
    handle.dispose();
  });
});
