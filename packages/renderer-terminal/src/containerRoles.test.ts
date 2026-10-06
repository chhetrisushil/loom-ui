import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { MetricCard, blueprint$, flex, stack } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { renderExperience } from "./status";

// U15: the terminal has no container-renderer seam, so a role (`tabs`, `stepper`) is simply not
// drawn — the container is the plain titled stack and EVERY child shows, in order. The IR's rule
// ("a role no renderer knows is the plain container"), exercised on the roles the planner composes.
const metric = (id: string) =>
  MetricCard({
    id,
    title: id,
    unit: "ms",
    binding: {
      projectionId: HYDRATION_PROJECTION_ID,
      path: hydrationPath(`h-${id}`),
      status: { path: hydrationStatusPath(`h-${id}`) },
    },
  });

describe("terminal: layout roles degrade to the plain container", () => {
  for (const role of ["tabs", "stepper"]) {
    it(`a "${role}" container shows every panel, titled, in order`, () => {
      const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
      for (const h of ["a", "b"]) store.setValue(`h-${h}`, 7, { state: "ready" });
      const bp = blueprint$({
        id: "e@v",
        title: "Board",
        projections: [HYDRATION_PROJECTION_ID],
        layout: flex({
          direction: "column",
          role,
          children: [
            stack({ title: "First panel", children: [metric("a")] }),
            stack({ title: "Second panel", children: [metric("b")] }),
          ],
        }),
      });
      const out = renderExperience(bp, store);
      expect(out).toContain("First panel");
      expect(out).toContain("Second panel");
      expect(out.indexOf("First panel")).toBeLessThan(out.indexOf("Second panel"));
      expect(out.match(/7/g)?.length).toBe(2);
    });
  }
});
