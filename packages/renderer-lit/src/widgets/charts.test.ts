import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { setLocale } from "../i18n";
import "../register";

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

describe("unit beside a non-symbol format", () => {
  const unitFmt = { semanticType: "decimal" } as const;
  it("lu-bar-chart's hover label keeps the unit under a decimal format; currency/percent never double", async () => {
    setLocale("en-US");
    const hoverLabel = async (id: string, value: Record<string, unknown>) => {
      const el = await mount("lu-bar-chart", {
        widget: customWidget$({ kind: "BarChart", id, title: "Lat", binding: b }),
        value,
      });
      el.shadowRoot?.querySelector("rect.bar")?.dispatchEvent(new Event("pointerenter"));
      await (el as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
      return el.shadowRoot?.querySelector("text.val")?.textContent ?? "";
    };
    expect(
      await hoverLabel("u1", { unit: "ms", format: unitFmt, bars: [{ label: "a", value: 7 }] })
    ).toBe("7 ms");
    expect(
      await hoverLabel("u2", {
        unit: "USD",
        format: { semanticType: "currency", currency: "USD" },
        bars: [{ label: "a", value: 12 }],
      })
    ).toBe("$12.00");
    expect(
      await hoverLabel("u3", {
        unit: "%",
        format: { semanticType: "percentage" },
        bars: [{ label: "a", value: 0.25 }],
      })
    ).toBe("25%");
  });
  it("lu-timeseries' tooltip keeps the unit under a decimal format, and falls back to props.unit", async () => {
    setLocale("en-US");
    const tooltipFor = async (id: string, value: unknown, props: Record<string, unknown> = {}) => {
      const el = await mount("lu-timeseries", {
        widget: customWidget$({ kind: "TimeSeries", id, title: "Lat", binding: b, props }),
        value,
      });
      el.shadowRoot
        ?.querySelector("svg")
        ?.dispatchEvent(new MouseEvent("pointermove", { clientX: 0, clientY: 0 }));
      const tip = document.querySelector("[data-lu-tooltip]");
      return (tip?.textContent ?? "").replace(/\s+/g, " ");
    };
    expect(
      await tooltipFor("t1", {
        series: [{ label: "p99", unit: "ms", format: unitFmt, points: pts([7, 8]) }],
      })
    ).toContain("p99: 7 ms");
    // The widget's own unit is the fallback, exactly as the spoken form and the terminal read it.
    expect(
      await tooltipFor("t2", { series: [{ label: "p99", points: pts([7, 8]) }] }, { unit: "ms" })
    ).toContain("p99: 7 ms");
    const cur = await tooltipFor("t3", {
      series: [
        {
          label: "rev",
          unit: "USD",
          format: { semanticType: "currency", currency: "USD" },
          points: pts([12, 13]),
        },
      ],
    });
    expect(cur).toContain("rev: $12.00");
    expect(cur).not.toContain("USD");
  });
  it("lu-metric-card keeps props.unit under a decimal props.format", async () => {
    setLocale("en-US");
    const el = await mount("lu-metric-card", {
      widget: customWidget$({
        kind: "MetricCard",
        id: "m1",
        title: "p99",
        binding: b,
        props: { unit: "ms", format: unitFmt },
      }),
      value: 7,
    });
    expect(el.shadowRoot?.querySelector(".unit")?.textContent).toBe("ms");
  });
});
