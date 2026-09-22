import { type BindingStatus, MetricCard } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import "./index";

// ── The status matrix, Lit side ───────────────────────────────────────────────
// The SAME eight rows are asserted against the terminal surface in
// `@loom-ui/renderer-terminal`'s `src/statusMatrix.test.ts`. The two tables are the contract
// that the two surfaces render one decision table; edit neither alone.

interface MatrixRow {
  readonly name: string;
  readonly status: BindingStatus | undefined;
  readonly value: unknown;
  /** The `data-state` the widget's root carries. */
  readonly state: "loading" | "pending" | "stale" | "error" | "ready";
  /** The marker glyph, or null when the state carries none. */
  readonly marker: "~" | "⋯" | null;
  /** Did the value renderer run? */
  readonly showsValue: boolean;
}

const err: BindingStatus = {
  state: "error",
  seq: 1,
  finding: { code: "provider-failed", message: "tool down" },
};
const stale: BindingStatus = {
  state: "stale",
  seq: 2,
  finding: { code: "output-shape-drift", message: "drifted" },
};
const pending: BindingStatus = { state: "pending", seq: 3 };
const ready: BindingStatus = { state: "ready", seq: 4 };

const MATRIX: readonly MatrixRow[] = [
  {
    name: "error + value",
    status: err,
    value: 412,
    state: "error",
    marker: null,
    showsValue: false,
  },
  {
    name: "error + no value",
    status: err,
    value: undefined,
    state: "error",
    marker: null,
    showsValue: false,
  },
  {
    name: "stale + value",
    status: stale,
    value: 412,
    state: "stale",
    marker: "~",
    showsValue: true,
  },
  {
    name: "stale + no value",
    status: stale,
    value: undefined,
    state: "stale",
    marker: "~",
    showsValue: false,
  },
  {
    name: "pending + value",
    status: pending,
    value: 412,
    state: "pending",
    marker: "⋯",
    showsValue: true,
  },
  {
    name: "pending + no value",
    status: pending,
    value: undefined,
    state: "loading",
    marker: null,
    showsValue: false,
  },
  {
    name: "ready + value",
    status: ready,
    value: 412,
    state: "ready",
    marker: null,
    showsValue: true,
  },
  {
    name: "ready + no value",
    status: ready,
    value: undefined,
    state: "loading",
    marker: null,
    showsValue: false,
  },
];

const widget = MetricCard({
  id: "m",
  title: "p99",
  binding: { projectionId: "loom-ui.hydration", path: "values.h" },
});

const mount = async (row: MatrixRow): Promise<HTMLElement> => {
  const el = document.createElement("lu-metric-card") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  Object.assign(el, { widget, value: row.value, status: row.status });
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};
const text = (el: HTMLElement): string =>
  (el.shadowRoot?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("status matrix (Lit)", () => {
  for (const row of MATRIX) {
    it(`${row.name} → data-state="${row.state}"${row.marker ? ` with "${row.marker}"` : ""}`, async () => {
      const el = await mount(row);
      const root = el.shadowRoot?.querySelector("[data-state]");
      expect(root?.getAttribute("data-state")).toBe(row.state);
      const marker = el.shadowRoot?.querySelector(".stale-marker, .pending-marker");
      expect(marker?.textContent?.trim() ?? null).toBe(row.marker);
      // The value renderer runs iff the matrix says so — `renderReady()` is NEVER reached with
      // an undefined value.
      expect(text(el).includes("412")).toBe(row.showsValue);
    });
  }

  it("stale with no value states the reason and says there is no value", async () => {
    const el = await mount(MATRIX[3] as MatrixRow);
    expect(text(el)).toContain("drifted");
    expect(text(el)).toContain("no value");
  });

  it("a status error never runs the value renderer, even over a valid value", async () => {
    const el = await mount(MATRIX[0] as MatrixRow);
    expect(text(el)).toContain("tool down");
    expect(text(el)).not.toContain("412");
  });

  it("a contract violation outranks stale and pending", async () => {
    for (const status of [stale, pending, undefined]) {
      const el = await mount({
        name: "contract",
        status,
        value: "oops",
        state: "error",
        marker: null,
        showsValue: false,
      });
      expect(el.shadowRoot?.querySelector("[data-state]")?.getAttribute("data-state")).toBe(
        "error"
      );
      expect(text(el)).toContain("contract");
    }
  });

  it("pending speaks as loading and stale speaks as stale", async () => {
    const p = await mount(MATRIX[4] as MatrixRow);
    expect(p.shadowRoot?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
      "p99: loading"
    );
    const s = await mount(MATRIX[2] as MatrixRow);
    expect(s.shadowRoot?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
      "p99: stale"
    );
  });
});
