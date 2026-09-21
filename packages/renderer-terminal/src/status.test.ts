import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { MetricCard, blueprint$, stack } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { renderExperience } from "./status";

const bp = blueprint$({
  id: "e@v",
  title: "Dash",
  layout: stack({
    children: [
      MetricCard({
        id: "a",
        title: "A",
        binding: { projectionId: HYDRATION_PROJECTION_ID, path: "values.ha" },
        unit: "ms",
      }),
      MetricCard({
        id: "b",
        title: "B",
        binding: { projectionId: HYDRATION_PROJECTION_ID, path: "values.hb" },
      }),
      MetricCard({
        id: "c",
        title: "C",
        binding: { projectionId: HYDRATION_PROJECTION_ID, path: "values.hc" },
      }),
      MetricCard({
        id: "d",
        title: "D",
        binding: { projectionId: HYDRATION_PROJECTION_ID, path: "values.hd" },
      }),
    ],
  }),
  projections: [HYDRATION_PROJECTION_ID],
});

describe("renderExperience", () => {
  it("decorates each widget with its hydration status", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    store.setValue("ha", 412, { state: "ready" });
    store.setStatus("hb", { state: "pending" });
    store.setValue("hc", 7, {
      state: "stale",
      finding: { code: "output-shape-drift", severity: "error", message: "drifted" },
    });
    store.setStatus("hd", {
      state: "error",
      finding: { code: "provider-failed", severity: "error", message: "tool down" },
    });
    const out = renderExperience(bp, store);
    expect(out).toContain("A: 412 ms");
    expect(out).toContain("⋯ B");
    expect(out).toContain("~ C: 7");
    expect(out).toContain("✗ D: tool down");
  });
  it("a contract violation is visible in text too", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    store.setValue("ha", "not-a-number", { state: "ready" });
    expect(renderExperience(bp, store)).toMatch(/✗ A: .*contract/);
  });
  it("a status error outranks a contract violation on the same handle's stale value, like the Lit base widget", () => {
    const errBp = blueprint$({
      id: "e2@v",
      title: "Dash2",
      layout: stack({
        children: [
          MetricCard({
            id: "e",
            title: "E",
            binding: { projectionId: HYDRATION_PROJECTION_ID, path: "values.h-e" },
          }),
        ],
      }),
      projections: [HYDRATION_PROJECTION_ID],
    });
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e2" });
    store.setValue("h-e", "not-a-number", {
      state: "error",
      finding: { code: "provider-failed", severity: "error", message: "tool down" },
    });
    const out = renderExperience(errBp, store);
    expect(out).toContain("✗ E: tool down");
    expect(out).not.toMatch(/contract/);
  });
});
