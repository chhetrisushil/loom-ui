import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { MetricCard, blueprint$, customWidget$, stack } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { renderExperience } from "./status";

// A title, a container heading or a cell can be model- or user-authored, and an ESC begins a terminal
// escape sequence (clear the screen, retitle the window, move the cursor). The whole frame is inert,
// including the rows loom's own traversal writes, which no framework renderer touches.
describe("a frame carries no terminal control sequence", () => {
  it("strips escapes, C0/C1 controls and bidi overrides from every title, but keeps newlines and printable text", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    store.setValue("h", "val\u0007ue", { state: "ready" });
    const bp = blueprint$({
      id: "e@v",
      title: "Bo\x1b]0;pwned\x07ard‮",
      projections: [HYDRATION_PROJECTION_ID],
      layout: stack({
        title: "Sec\x1b[2Jtion",
        children: [
          MetricCard({
            id: "m",
            title: "Ti\x9btle é 日本",
            binding: {
              projectionId: HYDRATION_PROJECTION_ID,
              path: hydrationPath("h"),
              status: { path: hydrationStatusPath("h") },
            },
          }),
        ],
      }),
    });
    const out = renderExperience(bp, store);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting none remain
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮]/);
    expect(out).toContain("Title é 日本");
    expect(out).toContain("Sec[2Jtion"); // the ESC is gone; the rest is inert text
    expect(out.split("\n").length).toBeGreaterThan(4);
  });
});

describe("table columns are measured on the text that is printed", () => {
  it("a cell full of stripped controls does not push its column wider than what is drawn", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    store.setValue(
      "t",
      {
        columns: ["name", "n"],
        rows: [
          ["a\u001b[2J\u001b[2J\u200b\u200b\u200b", "1"],
          ["bb", "2"],
        ],
      },
      { state: "ready" }
    );
    const bp = blueprint$({
      id: "e@v",
      title: "T",
      projections: [HYDRATION_PROJECTION_ID],
      layout: stack({
        children: [
          customWidget$({
            kind: "Table",
            id: "tb",
            title: "Tbl",
            binding: {
              projectionId: HYDRATION_PROJECTION_ID,
              path: hydrationPath("t"),
              status: { path: hydrationStatusPath("t") },
            },
          }),
        ],
      }),
    });
    const rows = renderExperience(bp, store)
      .split("\n")
      .filter((l) => /^\s*(name|a\[2J\[2J|bb)/.test(l));
    expect(rows).toHaveLength(3);
    // the second column starts at the same offset in the header and in every row
    const second = rows.map((l) => l.search(/\s(n|1|2)$/));
    expect(new Set(second).size).toBe(1);
  });
});
