import { hydrationPath, hydrationStatusPath } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { MetricCard, blueprint$, stack } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { renderExperience } from "./status";

// ── The status matrix, terminal side ──────────────────────────────────────────
// The SAME ten rows are asserted against the Lit surface in `@loom-ui/renderer-lit`'s
// `src/widgets/statusMatrix.test.ts`. The two tables are the contract that the two surfaces
// render one decision table; edit neither alone. Since IR 2.0.0 that decision table is LOOM's
// (ADR 0097 D2) on both surfaces — these rows pin that the framework still gets it, through a
// declared status channel per binding plus its own value contract in loom's `check` seam.

type State = "error" | "empty" | "stale" | "pending" | "ready";

interface MatrixRow {
  readonly name: string;
  readonly state: State;
  readonly value: number | undefined;
  /** The whole rendered line for the widget. */
  readonly line: string;
}

const FINDINGS: Partial<
  Record<State, { code: string; severity: "error" | "warn"; message: string }>
> = {
  error: { code: "provider-failed", severity: "error", message: "tool down" },
  empty: { code: "upstream-empty", severity: "warn", message: "no data for this view" },
  stale: { code: "output-shape-drift", severity: "error", message: "drifted" },
};

const MATRIX: readonly MatrixRow[] = [
  { name: "error + value", state: "error", value: 412, line: "✗ p99: tool down" },
  { name: "error + no value", state: "error", value: undefined, line: "✗ p99: tool down" },
  // loom ADR 0100: `empty` is "no data", ranked right after error — never the value renderer (the
  // store's fold drops a value published beside it anyway), never the error glyph.
  { name: "empty + value", state: "empty", value: 412, line: "○ p99: no data for this view" },
  {
    name: "empty + no value",
    state: "empty",
    value: undefined,
    line: "○ p99: no data for this view",
  },
  { name: "stale + value", state: "stale", value: 412, line: "~ p99: 412" },
  { name: "stale + no value", state: "stale", value: undefined, line: "~ p99: — (drifted)" },
  { name: "pending + value", state: "pending", value: 412, line: "⋯ p99: 412" },
  { name: "pending + no value", state: "pending", value: undefined, line: "⋯ p99" },
  { name: "ready + value", state: "ready", value: 412, line: "p99: 412" },
  // The loading row: a DECLARED channel whose value has not arrived reads "it has not
  // arrived", not "the answer is nothing" — the same line as pending-with-no-value, and the
  // `loading` data-state on the Lit side (ADR 0097 D2).
  { name: "ready + no value", state: "ready", value: undefined, line: "⋯ p99" },
];

const bp = blueprint$({
  id: "e@v",
  title: "Dash",
  layout: stack({
    children: [
      MetricCard({
        id: "m",
        title: "p99",
        binding: {
          projectionId: HYDRATION_PROJECTION_ID,
          path: hydrationPath("h"),
          status: { path: hydrationStatusPath("h") },
        },
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

  it("an empty status with no finding reads loom's own words, 'no data'", () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "e" });
    store.setStatus("h", { state: "empty" });
    const line = renderExperience(bp, store)
      .split("\n")
      .find((l) => l.includes("p99"));
    expect(line?.trim()).toBe("○ p99: no data");
  });

  it("an empty status never reaches the contract check, even over a value that would fail it", () => {
    expect(render({ state: "empty", value: "oops" as unknown as number })).toBe(
      "○ p99: no data for this view"
    );
  });

  it("a contract violation outranks stale and pending", () => {
    for (const state of ["stale", "pending", "ready"] as const)
      expect(render({ state, value: "oops" as unknown as number })).toMatch(/^✗ p99: .*contract/);
  });
});
