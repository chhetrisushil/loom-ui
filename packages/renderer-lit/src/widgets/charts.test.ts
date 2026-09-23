import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import "./index";

const b = { projectionId: "hydration", path: "values.h" };
const mount = async (tag: string, props: Record<string, unknown>): Promise<HTMLElement> => {
  const el = document.createElement(tag) as HTMLElement & { updateComplete: Promise<unknown> };
  Object.assign(el, props);
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};
const pts = (values: number[]) =>
  values.map((value, i) => ({ timestamp: `2026-01-0${i + 1}T00:00:00Z`, value }));
const ticks = (el: HTMLElement, anchor: "start" | "end") =>
  [...(el.shadowRoot?.querySelectorAll(`.axis text[text-anchor='${anchor}']`) ?? [])].map(
    (t) => t.textContent ?? ""
  );
// lu-bar-chart draws its y ticks straight under <svg>, not inside a `.axis` group.
const barTicks = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll("svg > text[text-anchor='end']") ?? [])].map(
    (t) => t.textContent ?? ""
  );

describe("lu-timeseries: dual axis and value-level format", () => {
  it("a series on axis 'right' gets its own scale and right-hand ticks", async () => {
    setLocale("en-US");
    const el = await mount("lu-timeseries", {
      widget: customWidget$({ kind: "TimeSeries", id: "ts", title: "Load", binding: b }),
      value: {
        series: [
          { label: "rps", points: pts([1, 2]) },
          { label: "bytes", axis: "right", points: pts([1000, 2000]) },
        ],
      },
    });
    expect(ticks(el, "start").length).toBeGreaterThan(0);
    // Each side is scaled to its own domain, so proportional series draw the same line.
    const paths = [...(el.shadowRoot?.querySelectorAll("path.series") ?? [])];
    expect(paths).toHaveLength(2);
    expect(paths[0]?.getAttribute("d")).toBe(paths[1]?.getAttribute("d"));
    expect(el.shadowRoot?.textContent).toContain("bytes (R)");
    expect(el.shadowRoot?.innerHTML).not.toContain("NaN");
  });
  it("when every series declares axis 'right', they share one left-axis scale instead of a meaningless 0-1 right domain", async () => {
    setLocale("en-US");
    const el = await mount("lu-timeseries", {
      widget: customWidget$({ kind: "TimeSeries", id: "ts4", title: "Load", binding: b }),
      value: {
        series: [
          { label: "rps", axis: "right", points: pts([100, 200]) },
          { label: "errors", axis: "right", points: pts([300, 400]) },
        ],
      },
    });
    // No second axis is drawn: no right-hand ("start"-anchored) ticks at all.
    expect(ticks(el, "start")).toEqual([]);
    // The left axis reflects the data (100-400), not the empty-extent default of [0, 1].
    const leftTicks = ticks(el, "end").map(Number);
    expect(leftTicks.some((n) => n > 1)).toBe(true);
    expect(el.shadowRoot?.textContent).not.toContain("(R)");
    const paths = [...(el.shadowRoot?.querySelectorAll("path.series") ?? [])];
    expect(paths[0]?.getAttribute("d")).not.toBe(paths[1]?.getAttribute("d"));
  });
  it("without a right-axis series there are no right-hand ticks and one shared scale", async () => {
    const el = await mount("lu-timeseries", {
      widget: customWidget$({ kind: "TimeSeries", id: "ts2", title: "Load", binding: b }),
      value: {
        series: [
          { label: "rps", points: pts([1, 2]) },
          { label: "bytes", points: pts([1000, 2000]) },
        ],
      },
    });
    expect(ticks(el, "start")).toEqual([]);
    const paths = [...(el.shadowRoot?.querySelectorAll("path.series") ?? [])];
    expect(paths[0]?.getAttribute("d")).not.toBe(paths[1]?.getAttribute("d"));
  });
  it("ticks follow the series' own format, then props.format, then its unit", async () => {
    setLocale("en-US");
    const byValue = await mount("lu-timeseries", {
      widget: customWidget$({ kind: "TimeSeries", id: "f1", title: "Rev", binding: b }),
      value: {
        series: [
          {
            label: "rev",
            format: { semanticType: "currency", currency: "EUR" },
            points: pts([100, 200]),
          },
        ],
      },
    });
    expect(ticks(byValue, "end").join(" ")).toContain("€");
    const byProps = await mount("lu-timeseries", {
      widget: customWidget$({
        kind: "TimeSeries",
        id: "f2",
        title: "Rev",
        binding: b,
        props: { format: { semanticType: "currency", currency: "USD" } },
      }),
      value: { series: [{ label: "rev", points: pts([100, 200]) }] },
    });
    expect(ticks(byProps, "end").join(" ")).toContain("$");
    const byIsoUnit = await mount("lu-timeseries", {
      widget: customWidget$({ kind: "TimeSeries", id: "f3", title: "Rev", binding: b }),
      value: { series: [{ label: "rev", unit: "JPY", points: pts([100, 200]) }] },
    });
    expect(ticks(byIsoUnit, "end").join(" ")).toContain("¥");
  });
});

describe("lu-bar-chart: value-level format", () => {
  it("honours the value's format, then props.format", async () => {
    setLocale("en-US");
    const byValue = await mount("lu-bar-chart", {
      widget: customWidget$({ kind: "BarChart", id: "b1", title: "Share", binding: b }),
      value: { format: { semanticType: "percentage" }, bars: [{ label: "a", value: 0.5 }] },
    });
    expect(barTicks(byValue).join(" ")).toContain("%");
    const byProps = await mount("lu-bar-chart", {
      widget: customWidget$({
        kind: "BarChart",
        id: "b2",
        title: "Spend",
        binding: b,
        props: { format: { semanticType: "currency", currency: "EUR" } },
      }),
      value: { bars: [{ label: "a", value: 50 }] },
    });
    expect(barTicks(byProps).join(" ")).toContain("€");
  });
});
