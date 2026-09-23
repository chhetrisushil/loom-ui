import { describe, expect, it } from "vitest";
import { describeValue } from "./a11y";
import { setLocale } from "./i18n";

describe("describeValue", () => {
  it("speaks each kind, and distinguishes loading from a contract error", () => {
    setLocale("en-US");
    expect(describeValue("MetricCard", 412, "p99")).toBe("p99: 412");
    expect(describeValue("StatusBadge", "ok", "Phase")).toBe("Phase: ok");
    expect(describeValue("DataTable", [{ a: 1 }, { a: 2 }], "Top")).toBe("Top: table with 2 rows");
    expect(
      describeValue(
        "TimeSeries",
        { series: [{ label: "p99", unit: "ms", points: [{ timestamp: "t", value: 3 }] }] },
        "Latency"
      )
    ).toBe("Latency: p99 3 ms");
    expect(describeValue("BarChart", { bars: [{ label: "a", value: 1 }] }, "Bars")).toBe(
      "Bars: a 1"
    );
    expect(describeValue("MetricCard", undefined, "p99")).toBe("p99: loading");
    expect(describeValue("MetricCard", "not a number", "p99")).toBe("p99: error");
  });
  it("speaks a widget's props.format/props.unit when the value carries none, same as the display falls back to them", () => {
    setLocale("en-US");
    expect(
      describeValue("MetricCard", 412, "Price", {
        format: { semanticType: "currency", currency: "EUR" },
      })
    ).toContain("€412.00");
    expect(describeValue("MetricCard", 412, "Speed", { unit: "mph" })).toBe("Speed: 412 mph");
    expect(
      describeValue(
        "TimeSeries",
        { series: [{ label: "rev", points: [{ timestamp: "t", value: 100 }] }] },
        "Revenue",
        { format: { semanticType: "currency", currency: "USD" } }
      )
    ).toContain("$100.00");
    expect(
      describeValue("BarChart", { bars: [{ label: "a", value: 0.5 }] }, "Share", {
        format: { semanticType: "percentage" },
      })
    ).toBe("Share: a 50%");
    // A series' own format still wins over the widget's props.
    expect(
      describeValue(
        "TimeSeries",
        {
          series: [
            {
              label: "rev",
              format: { semanticType: "currency", currency: "EUR" },
              points: [{ timestamp: "t", value: 100 }],
            },
          ],
        },
        "Revenue",
        { format: { semanticType: "currency", currency: "USD" } }
      )
    ).toContain("€100.00");
  });
  it("speaks the framework kinds", () => {
    setLocale("en-US");
    expect(describeValue("Kpi", { value: 1234.5, unit: "USD", deltaPct: 0.12 }, "Revenue")).toBe(
      "Revenue: $1,234.50, up 12%"
    );
    expect(describeValue("Kpi", { value: 7, unit: "ms", deltaPct: -0.034 }, "p99")).toBe(
      "p99: 7 ms, down 3.4%"
    );
    expect(describeValue("Table", { columns: ["a"], rows: [["x"], ["y"]] }, "Top")).toBe(
      "Top: table with 2 rows"
    );
    expect(
      describeValue("StatusCard", { level: "warning", headline: "Lag", detail: "12s" }, "DB")
    ).toBe("DB: warning, Lag. 12s");
  });
});
