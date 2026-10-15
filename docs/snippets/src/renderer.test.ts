// The code of docs/guides/writing-a-renderer.md (see mirror.test-support.ts).
import { describe, expect, it } from "vitest";
import { expectDocMirrors } from "./mirror.test-support";
// #region imports
import { HydrationStore } from "@loom-ui/hydration/client";
import {
  type HandleEntry,
  type RendererAdapter,
  checkRendererConformance,
} from "@loom-ui/renderer-conformance";
import { describeRendererConformance } from "@loom-ui/renderer-conformance/vitest";
import { renderExperience } from "@loom-ui/renderer-terminal";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
// #endregion imports

// #region adapter
/** A renderer is anything that shows a Blueprint plus its bound values. This one wraps a function. */
const adapter: RendererAdapter = {
  name: "my-renderer",
  surface: "terminal", // the catalogue surface you draw
  // The Blueprint kinds you DRAW. Any other kind must be refused where a viewer can see it.
  kinds: [
    "MetricCard",
    "StatusBadge",
    "Kpi",
    "Table",
    "StatusCard",
    "BarChart",
    "TimeSeries",
    "Note",
  ],
  capabilities: { update: true, interpretsControlCharacters: true },
  mount(initial, { values }) {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "kit" });
    let blueprint = initial;
    let frozen: string | undefined;
    const put = (handle: string, e: HandleEntry): void => {
      const status = {
        state: e.state ?? "ready",
        ...(e.message === undefined
          ? {}
          : { finding: { code: "kit", severity: "error" as const, message: e.message } }),
      };
      if (e.value === undefined && e.state === undefined) store.remove(handle);
      else if (e.value === undefined) store.setStatus(handle, status);
      else store.setValue(handle, e.value, status);
    };
    for (const [handle, entry] of Object.entries(values)) put(handle, entry);
    return {
      // Everything a viewer can READ, settled, in reading order.
      text: () => frozen ?? renderExperience(blueprint, store),
      set: (handle, entry) => put(handle, entry), // the hydration store's job
      update: (next) => {
        blueprint = next;
      },
      // After dispose the view must stop following the data.
      dispose: () => {
        frozen = renderExperience(blueprint, store);
      },
    };
  },
};
// #endregion adapter

// #region vitest
// One `it` per check; this adapter has no `invoke` or `i18n` capability, so those checks skip.
// A renderer that claims every capability passes `{ forbidSkips: true }` instead.
describeRendererConformance(adapter);
// #endregion vitest

describe("docs/guides/writing-a-renderer.md", () => {
  it("runs the conformance kit against an adapter", async () => {
    // #region run
    const report = await checkRendererConformance(adapter);
    // report: { ok, results, failed, skipped }. A check the adapter has no capability for is a
    // SKIP, never a silent pass; `forbidSkips: true` (below) makes a skip a failure.
    // #endregion run
    expect(report.failed).toEqual([]);
    expect(report.results.length).toBeGreaterThan(5);
  });

  it("keeps docs/guides/writing-a-renderer.md in step with this file", () => {
    expectDocMirrors("docs/guides/writing-a-renderer.md", "renderer.test.ts");
  });
});
