import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import "../register";

// G17: a chart's accessible description names its kind, not just its series.
const b = { projectionId: "h", path: "values.h" };
type Mounted = HTMLElement & { updateComplete: Promise<unknown> };
const mount = async (tag: string, props: Record<string, unknown>): Promise<Mounted> => {
  const el = document.createElement(tag) as Mounted;
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};
const name = (el: HTMLElement, sel: string) =>
  el.shadowRoot?.querySelector(sel)?.getAttribute("aria-label");
const pts = [
  { timestamp: "2024-01-01T00:00:00Z", value: 1 },
  { timestamp: "2024-01-02T00:00:00Z", value: 2 },
];

describe("chart descriptions name the kind", () => {
  it("lu-timeseries: the plot's name says it is a line chart, with the series", async () => {
    const el = await mount("lu-timeseries", {
      widget: customWidget$({
        kind: "TimeSeries",
        id: "ts",
        title: "Revenue & Orders",
        binding: b,
      }),
      value: {
        series: [
          { label: "Revenue", points: pts },
          { label: "Orders", points: pts },
        ],
      },
    });
    expect(name(el, "svg")).toBe("Revenue & Orders: line chart, Revenue 2, Orders 2");
  });
  it("lu-bar-chart: the plot's name says it is a bar chart", async () => {
    const el = await mount("lu-bar-chart", {
      widget: customWidget$({ kind: "BarChart", id: "bc", title: "Bars", binding: b }),
      value: { bars: [{ label: "a", value: 1 }] },
    });
    expect(name(el, "svg")).toBe("Bars: bar chart, a 1");
  });
  it("the non-ready states stay as they were (no kind to name without data)", async () => {
    const el = await mount("lu-timeseries", {
      widget: customWidget$({ kind: "TimeSeries", id: "ts2", title: "Load", binding: b }),
    });
    expect(name(el, "[aria-label]")).toBe("Load: loading");
  });
  it("lu-table and lu-data-table caption their <table> with the same pattern", async () => {
    const t = await mount("lu-table", {
      widget: customWidget$({ kind: "Table", id: "t", title: "Top", binding: b }),
      value: { columns: ["db"], rows: [["orders"]] },
    });
    const d = await mount("lu-data-table", {
      widget: customWidget$({ kind: "DataTable", id: "d", title: "Top", binding: b }),
      value: [{ db: "orders" }],
    });
    for (const el of [t, d])
      expect(el.shadowRoot?.querySelector("caption")?.textContent?.trim()).toBe(
        "Top: table with 1 row"
      );
  });
});
