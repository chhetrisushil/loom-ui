import { type BindingStatus, MetricCard } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import "../register";

// ── The status matrix, Lit side ───────────────────────────────────────────────
// The SAME ten rows are asserted against the terminal surface in
// `@loom-ui/renderer-terminal`'s `src/statusMatrix.test.ts`. The two tables are the contract
// that the two surfaces render one decision table; edit neither alone.

interface MatrixRow {
  readonly name: string;
  readonly status: BindingStatus | undefined;
  readonly value: unknown;
  /** The `data-state` the widget's root carries. */
  readonly state: "loading" | "pending" | "stale" | "error" | "empty" | "ready";
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
const empty: BindingStatus = {
  state: "empty",
  seq: 5,
  finding: { code: "upstream-empty", message: "no data for this view" },
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
  // loom ADR 0100: "no data", ranked right after error. A value beside it is ignored.
  {
    name: "empty + value",
    status: empty,
    value: 412,
    state: "empty",
    marker: null,
    showsValue: false,
  },
  {
    name: "empty + no value",
    status: empty,
    value: undefined,
    state: "empty",
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
    const el = await mount(MATRIX[5] as MatrixRow);
    expect(text(el)).toContain("drifted");
    expect(text(el)).toContain("no value");
  });

  it("a status error never runs the value renderer, even over a valid value", async () => {
    const el = await mount(MATRIX[0] as MatrixRow);
    expect(text(el)).toContain("tool down");
    expect(text(el)).not.toContain("412");
  });

  it("empty draws 'No data' as a polite live region (role=status, as loom's React marker), never an alert", async () => {
    for (const row of [MATRIX[2], MATRIX[3]] as MatrixRow[]) {
      const el = await mount(row);
      const root = el.shadowRoot?.querySelector("[data-state]");
      expect(root?.getAttribute("role")).toBe("status");
      expect(root?.getAttribute("aria-label")).toBe("p99: No data");
      expect(root?.getAttribute("title")).toBe("no data for this view");
      expect(text(el)).toBe("p99: No data");
      expect(el.shadowRoot?.querySelector('[role="alert"]')).toBeNull();
    }
  });

  // Intended difference from the terminal (README, "Empty upstream"): the Lit base always SAYS
  // "No data" and keeps the finding's message in `title`; the terminal prints the message itself
  // as the row text (loom ADR 0100 D1/D2). In-process the message is the full hydration one; split,
  // the public "no data for this view".
  it("empty with an in-process finding message: still 'No data', the message only in title", async () => {
    const message =
      'step "detail" references "top" at path "rows[0].sku": the upstream has no such row';
    const el = await mount({
      name: "empty (in-process message)",
      status: { state: "empty", seq: 6, finding: { code: "upstream-empty", message } },
      value: undefined,
      state: "empty",
      marker: null,
      showsValue: false,
    });
    const root = el.shadowRoot?.querySelector("[data-state]");
    expect(root?.getAttribute("data-state")).toBe("empty");
    expect(text(el)).toBe("p99: No data");
    expect(root?.getAttribute("title")).toBe(message);
    expect(root?.getAttribute("aria-label")).toBe("p99: No data");
  });

  it("empty is checked before the value contract: a value that would fail it is ignored", async () => {
    const el = await mount({
      name: "empty + bad value",
      status: empty,
      value: "oops",
      state: "empty",
      marker: null,
      showsValue: false,
    });
    expect(el.shadowRoot?.querySelector("[data-state]")?.getAttribute("data-state")).toBe("empty");
    expect(text(el)).not.toContain("contract");
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
    const p = await mount(MATRIX[6] as MatrixRow);
    expect(p.shadowRoot?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
      "p99: loading"
    );
    const s = await mount(MATRIX[4] as MatrixRow);
    expect(s.shadowRoot?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
      "p99: stale"
    );
  });
});
