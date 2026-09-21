import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { MetricCard, blueprint$, stack } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { renderExperience } from "./status";

// ── The status matrix, terminal side ──────────────────────────────────────────
// The SAME eight rows are asserted against the Lit surface in `@loom-ui/renderer-lit`'s
// `src/widgets/statusMatrix.test.ts`. The two tables are the contract that the two surfaces
// render one decision table; edit neither alone.

type State = "error" | "stale" | "pending" | "ready";

interface MatrixRow {
  readonly name: string;
  readonly state: State;
  readonly value: number | undefined;
  /** The whole rendered line for the widget. */
  readonly line: string;
}

const FINDINGS: Partial<Record<State, { code: string; severity: "error"; message: string }>> = {
  error: { code: "provider-failed", severity: "error", message: "tool down" },
  stale: { code: "output-shape-drift", severity: "error", message: "drifted" },
};

const MATRIX: readonly MatrixRow[] = [
  { name: "error + value", state: "error", value: 412, line: "✗ p99: tool down" },
  { name: "error + no value", state: "error", value: undefined, line: "✗ p99: tool down" },
  { name: "stale + value", state: "stale", value: 412, line: "~ p99: 412" },
  { name: "stale + no value", state: "stale", value: undefined, line: "~ p99: — (drifted)" },
  { name: "pending + value", state: "pending", value: 412, line: "⋯ p99: 412" },
  { name: "pending + no value", state: "pending", value: undefined, line: "⋯ p99" },
  { name: "ready + value", state: "ready", value: 412, line: "p99: 412" },
  { name: "ready + no value", state: "ready", value: undefined, line: "p99: —" },
];

const bp = blueprint$({
  id: "e@v",
  title: "Dash",
  layout: stack({
    children: [
      MetricCard({
        id: "m",
        title: "p99",
        binding: { projectionId: HYDRATION_PROJECTION_ID, path: "values.h" },
      }),
    ],
  }),
  projections: [HYDRATION_PROJECTION_ID],
});

const render = (row: { state: State; value: unknown }): string => {
  const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
  const finding = FINDINGS[row.state];
  const status = finding ? { state: row.state, finding } : { state: row.state };
  // A row with no value publishes only a status — which is exactly how the controller reports a
  // handle that never resolved.
  if (row.value === undefined) store.setStatus("h", status);
  else store.setValue("h", row.value, status);
  const out = renderExperience(bp, store);
  return (out.split("\n").find((l) => l.includes("p99")) ?? "").trim();
};

describe("status matrix (terminal)", () => {
  for (const row of MATRIX) {
    it(`${row.name} → "${row.line}"`, () => {
      expect(render(row)).toBe(row.line);
    });
  }

  it("a status error never runs the value renderer, even over a valid value", () => {
    expect(render({ state: "error", value: 412 })).not.toContain("412");
  });

  it("a contract violation outranks stale and pending", () => {
    for (const state of ["stale", "pending", "ready"] as const)
      expect(render({ state, value: "oops" as unknown as number })).toMatch(/^✗ p99: .*contract/);
  });
});
