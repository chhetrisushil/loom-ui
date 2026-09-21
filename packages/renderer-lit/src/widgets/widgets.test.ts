import { MetricCard, StatusBadge, type WidgetAction, customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import "./index";

const mount = async <T extends HTMLElement>(
  tag: string,
  props: Record<string, unknown>
): Promise<T> => {
  const el = document.createElement(tag) as T & { updateComplete: Promise<unknown> };
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};
const text = (el: HTMLElement) => (el.shadowRoot?.textContent ?? "").replace(/\s+/g, " ").trim();
const b = { projectionId: "hydration", path: "values.h" };

describe("kind widgets", () => {
  it("lu-metric-card renders value + unit, loading, stale and error states", async () => {
    const widget = MetricCard({ id: "m", title: "p99", binding: b, unit: "ms" });
    const el = await mount<HTMLElement>("lu-metric-card", { widget, value: 412 });
    expect(text(el)).toContain("412");
    expect(text(el)).toContain("ms");
    Object.assign(el, { value: undefined, status: { state: "pending", seq: 1 } });
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(el.shadowRoot?.querySelector("[data-state='loading']")).not.toBeNull();
    Object.assign(el, {
      value: 412,
      status: {
        state: "stale",
        seq: 2,
        finding: { code: "output-shape-drift", severity: "error", message: "m" },
      },
    });
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(el.shadowRoot?.querySelector("[data-state='stale']")).not.toBeNull();
    expect(text(el)).toContain("412");
    Object.assign(el, { value: "oops", status: undefined });
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(el.shadowRoot?.querySelector("[data-state='error']")).not.toBeNull();
    expect(text(el)).not.toContain("NaN");
    // The contract check outranks a stale status: a value that fails `checkKindValue` renders
    // as an error even when the accompanying status says "stale".
    Object.assign(el, {
      value: "oops",
      status: {
        state: "stale",
        seq: 3,
        finding: { code: "output-shape-drift", severity: "error", message: "n" },
      },
    });
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(el.shadowRoot?.querySelector("[data-state='error']")).not.toBeNull();
  });
  it("lu-status-badge shows the status string; lu-data-table uses props.columns or derives them", async () => {
    const badge = await mount<HTMLElement>("lu-status-badge", {
      widget: StatusBadge({ id: "s", title: "Phase", binding: b }),
      value: "triaging",
    });
    expect(text(badge)).toContain("triaging");
    const table = await mount<HTMLElement>("lu-data-table", {
      widget: customWidget$({
        kind: "DataTable",
        id: "t",
        title: "Top",
        binding: b,
        props: { columns: ["db"] },
      }),
      value: [{ db: "orders", p99: 1 }],
    });
    expect(table.shadowRoot?.querySelectorAll("th").length).toBe(1);
    expect(text(table)).toContain("orders");
    const derived = await mount<HTMLElement>("lu-data-table", {
      widget: customWidget$({ kind: "DataTable", id: "t2", title: "Top", binding: b }),
      value: [{ db: "orders", p99: 1 }],
    });
    expect(derived.shadowRoot?.querySelectorAll("th").length).toBe(2);
  });
  it("lu-timeseries draws one path per series and never emits NaN into the SVG; lu-bar-chart one bar per entry", async () => {
    const ts = await mount<HTMLElement>("lu-timeseries", {
      widget: customWidget$({ kind: "TimeSeries", id: "ts", title: "Latency", binding: b }),
      value: {
        series: [
          {
            label: "p99",
            points: [
              { timestamp: "2026-01-01T00:00:00Z", value: 1 },
              { timestamp: "2026-01-02T00:00:00Z", value: 2 },
            ],
          },
          { label: "p50", points: [{ timestamp: "2026-01-01T00:00:00Z", value: 0.5 }] },
        ],
      },
    });
    expect(ts.shadowRoot?.querySelectorAll("path.series").length).toBe(2);
    expect(ts.shadowRoot?.innerHTML).not.toContain("NaN");
    const single = await mount<HTMLElement>("lu-timeseries", {
      widget: customWidget$({ kind: "TimeSeries", id: "ts1", title: "One", binding: b }),
      value: {
        series: [{ label: "x", points: [{ timestamp: "2026-01-01T00:00:00Z", value: 5 }] }],
      },
    });
    expect(single.shadowRoot?.innerHTML).not.toContain("NaN");
    const bars = await mount<HTMLElement>("lu-bar-chart", {
      widget: customWidget$({ kind: "BarChart", id: "bc", title: "Bars", binding: b }),
      value: {
        bars: [
          { label: "a", value: 1 },
          { label: "b", value: 3 },
        ],
      },
    });
    expect(bars.shadowRoot?.querySelectorAll("rect.bar").length).toBe(2);
  });
  it("lu-progress never puts a non-finite value on the <progress> element or into the DOM", async () => {
    const el = await mount<HTMLElement>("lu-progress", {
      widget: customWidget$({ kind: "ProgressBar", id: "pb", title: "Load", binding: b }),
      value: Number.POSITIVE_INFINITY,
    });
    const progress = el.shadowRoot?.querySelector("progress");
    expect(progress?.hasAttribute("value")).toBe(false);
    expect(el.shadowRoot?.innerHTML).not.toContain("Infinity");
  });
  it("lu-approval dispatches loom's APPROVE/REJECT action shape and gates on a pending value", async () => {
    const calls: WidgetAction[] = [];
    const widget = customWidget$({ kind: "ApprovalCard", id: "ap", title: "Deploy", binding: b });
    const el = await mount<HTMLElement>("lu-approval", {
      widget,
      value: true,
      onAction: (a: WidgetAction) => calls.push(a),
    });
    const buttons = el.shadowRoot?.querySelectorAll("button");
    expect(buttons?.length).toBe(2);
    (buttons?.[0] as HTMLButtonElement).click();
    expect(calls).toEqual([{ type: "APPROVE", widgetId: "ap", payload: { approved: true } }]);
    (buttons?.[1] as HTMLButtonElement).click();
    expect(calls).toEqual([
      { type: "APPROVE", widgetId: "ap", payload: { approved: true } },
      { type: "REJECT", widgetId: "ap", payload: { approved: false } },
    ]);

    const idle = await mount<HTMLElement>("lu-approval", {
      widget: customWidget$({ kind: "ApprovalCard", id: "ap2", title: "Deploy", binding: b }),
      value: false,
    });
    expect(idle.shadowRoot?.querySelectorAll("button").length).toBe(0);
    expect(text(idle)).toContain("No pending approval");
  });
  it("every element exposes an accessible name via aria-label", async () => {
    const el = await mount<HTMLElement>("lu-metric-card", {
      widget: MetricCard({ id: "m", title: "p99", binding: b }),
      value: 7,
    });
    expect(el.shadowRoot?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe("p99: 7");
  });
});
