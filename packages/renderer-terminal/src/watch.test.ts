import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { MetricCard, blueprint$, stack } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { watch } from "./watch";

describe("watch", () => {
  it("emits a frame now and on every projection change, and stops after unsubscribe", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "e" });
    const bp = blueprint$({
      id: "e@v",
      title: "Dash",
      layout: stack({
        children: [
          MetricCard({
            id: "a",
            title: "A",
            binding: { projectionId: HYDRATION_PROJECTION_ID, path: "values.ha" },
          }),
        ],
      }),
      projections: [HYDRATION_PROJECTION_ID],
    });
    const frames: string[] = [];
    const stop = watch(bp, store, (f) => frames.push(f));
    expect(frames).toHaveLength(1);
    store.setValue("ha", 1, { state: "ready" });
    await Promise.resolve();
    expect(frames).toHaveLength(2);
    expect(frames[1]).toContain("A: 1");
    stop();
    store.setValue("ha", 2, { state: "ready" });
    await Promise.resolve();
    expect(frames).toHaveLength(2);
  });
});
