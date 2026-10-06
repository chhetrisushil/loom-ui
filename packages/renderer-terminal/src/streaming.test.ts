import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { blueprint$, customWidget$, stack } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { watch } from "./watch";

describe("terminal: a token stream", () => {
  it("each appended chunk produces a frame showing the text so far, and the final frame has all of it", async () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    const bp = blueprint$({
      id: "e@v",
      title: "Chat",
      layout: stack({
        children: [
          customWidget$({
            kind: "StreamingText",
            id: "t",
            title: "Answer",
            binding: {
              projectionId: HYDRATION_PROJECTION_ID,
              path: hydrationPath("ht"),
              status: { path: hydrationStatusPath("ht") },
            },
          }),
        ],
      }),
      projections: [HYDRATION_PROJECTION_ID],
    });
    const frames: string[] = [];
    const stop = watch(bp, store, (f) => frames.push(f));
    store.append("ht", { seq: 0, text: "Hel" });
    await Promise.resolve();
    store.append("ht", { seq: 1, text: "lo", done: true });
    await Promise.resolve();
    stop();
    expect(frames.some((f) => f.includes("Hel") && !f.includes("Hello"))).toBe(true);
    expect(frames[frames.length - 1]).toContain("Hello");
  });
});
