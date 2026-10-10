import { describe, expect, it, vi } from "vitest";
import { describeValue } from "./a11y";
import * as i18n from "./i18n";
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
    ).toBe("Latency: line chart, p99 3 ms");
    expect(describeValue("BarChart", { bars: [{ label: "a", value: 1 }] }, "Bars")).toBe(
      "Bars: bar chart, a 1"
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
    ).toBe("Share: bar chart, a 50%");
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
  it("speaks a Kpi's props.unit/props.format fallback the same way lu-kpi displays it", () => {
    setLocale("en-US");
    // Same shape as lu-kpi's renderReady: value carries neither unit nor format, so both come
    // from the widget's props — the spoken text must match what the element shows, not a bare
    // number.
    expect(describeValue("Kpi", { value: 1234.5 }, "Revenue", { unit: "USD" })).toBe(
      "Revenue: $1,234.50"
    );
    expect(
      describeValue("Kpi", { value: 0.5 }, "Share", { format: { semanticType: "percentage" } })
    ).toBe("Share: 50%");
    // The value's own unit/format still win over the widget's props.
    expect(describeValue("Kpi", { value: 7, unit: "ms" }, "p99", { unit: "USD" })).toBe(
      "p99: 7 ms"
    );
  });
  it("keeps a unit beside a format that draws no symbol of its own, and never doubles one that does", () => {
    setLocale("en-US");
    const dec = { semanticType: "decimal" } as const;
    expect(describeValue("Kpi", { value: 7, unit: "ms", format: dec }, "p99")).toBe("p99: 7 ms");
    expect(describeValue("MetricCard", 7, "p99", { unit: "ms", format: dec })).toBe("p99: 7 ms");
    expect(
      describeValue(
        "TimeSeries",
        {
          series: [
            { label: "p99", unit: "ms", format: dec, points: [{ timestamp: "t", value: 7 }] },
          ],
        },
        "Lat"
      )
    ).toBe("Lat: line chart, p99 7 ms");
    expect(
      describeValue(
        "BarChart",
        { unit: "ms", format: dec, bars: [{ label: "a", value: 7 }] },
        "Lat"
      )
    ).toBe("Lat: bar chart, a 7 ms");
    expect(
      describeValue(
        "Kpi",
        { value: 12, unit: "USD", format: { semanticType: "currency", currency: "USD" } },
        "Rev"
      )
    ).toBe("Rev: $12.00");
    expect(
      describeValue(
        "Kpi",
        { value: 0.25, unit: "%", format: { semanticType: "percentage" } },
        "Share"
      )
    ).toBe("Share: 25%");
  });
  it("a zero delta is spoken 'unchanged', through t()", () => {
    setLocale("en-US");
    const spy = vi.spyOn(i18n, "t");
    expect(describeValue("Kpi", { value: 3, deltaPct: 0 }, "Errors")).toBe("Errors: 3, unchanged");
    expect(spy.mock.calls.map(([k]) => k)).toContain("lu.a11y.unchanged");
    spy.mockRestore();
  });
  it("a non-finite delta is spoken as no direction — neither up/down nor 'unchanged'", () => {
    setLocale("en-US");
    const spoken = describeValue("Kpi", { value: 3, deltaPct: Number.NEGATIVE_INFINITY }, "Growth");
    expect(spoken).toBe("Growth: 3");
  });
  it("speaks a Kpi's label as a caption after the title", () => {
    setLocale("en-US");
    expect(
      describeValue(
        "Kpi",
        { value: 1234.5, unit: "USD", deltaPct: 0.12, label: "vs last week" },
        "Revenue"
      )
    ).toBe("Revenue, vs last week: $1,234.50, up 12%");
  });
  it("names the chart kind, through t(), so a screen-reader reader knows what the figure is", () => {
    setLocale("en-US");
    const spy = vi.spyOn(i18n, "t");
    const ts = { series: [{ label: "Revenue", points: [{ timestamp: "t", value: 3 }] }] };
    expect(describeValue("TimeSeries", ts, "Sales")).toBe("Sales: line chart, Revenue 3");
    expect(describeValue("BarChart", { bars: [{ label: "a", value: 1 }] }, "Bars")).toBe(
      "Bars: bar chart, a 1"
    );
    expect(spy.mock.calls.map(([k]) => k)).toEqual(
      expect.arrayContaining(["lu.a11y.lineChart", "lu.a11y.barChart"])
    );
    // The phrase is a t() key, not a literal: whatever `t` returns is what is spoken. (`t` is the
    // package's identity seam today — there is no host override yet — so this mocks it.)
    spy.mockImplementation((k) => (k === "lu.a11y.lineChart" ? "Liniendiagramm" : k));
    expect(describeValue("TimeSeries", ts, "Sales")).toBe("Sales: Liniendiagramm, Revenue 3");
    spy.mockRestore();
  });
  it("the table descriptions share one pattern ('<title>: table with N rows') and agree on the singular", () => {
    setLocale("en-US");
    const table = { columns: ["a"], rows: [["x"]] };
    expect(describeValue("Table", table, "Top")).toBe("Top: table with 1 row");
    expect(describeValue("DataTable", [{ a: 1 }], "Top")).toBe("Top: table with 1 row");
    expect(describeValue("Table", { columns: ["a"], rows: [["x"], ["y"]] }, "Top")).toBe(
      "Top: table with 2 rows"
    );
    expect(describeValue("Table", { columns: ["a"], rows: [] }, "Top")).toBe(
      "Top: table with 0 rows"
    );
    expect(describeValue("Timeline", [{}], "Log")).toBe("Log: 1 entry");
    expect(describeValue("Timeline", [{}, {}], "Log")).toBe("Log: 2 entries");
  });

  describe("count phrases pick their plural category from the active locale (Intl.PluralRules)", () => {
    // `t` is identity (no host override exists), so a mock stands in for a translation catalogue:
    // it returns a marker for every plural KEY and the English fallback otherwise.
    const keys = (n: number, locale: string): string[] => {
      setLocale(locale);
      const seen: string[] = [];
      const spy = vi.spyOn(i18n, "t").mockImplementation((k: string, fb?: string) => {
        seen.push(k);
        return fb ?? k;
      });
      describeValue("Table", { columns: ["a"], rows: Array.from({ length: n }, () => ["x"]) }, "T");
      spy.mockRestore();
      setLocale("en-US");
      // The FIRST plural key asked is the locale's own category; with no translation tPlural then
      // asks once more for the English-rule category (see plural.ts), which is not under test here.
      return seen.filter((k) => k.startsWith("lu.plural.row.")).slice(0, 1);
    };
    it("English: one / other", () => {
      expect(keys(1, "en")).toEqual(["lu.plural.row.one"]);
      expect(keys(0, "en")).toEqual(["lu.plural.row.other"]);
      expect(keys(2, "en")).toEqual(["lu.plural.row.other"]);
    });
    it("Russian: one / few / many by the locale's own rules", () => {
      expect(keys(1, "ru")).toEqual(["lu.plural.row.one"]);
      expect(keys(21, "ru")).toEqual(["lu.plural.row.one"]);
      expect(keys(3, "ru")).toEqual(["lu.plural.row.few"]);
      expect(keys(5, "ru")).toEqual(["lu.plural.row.many"]);
    });
    it("French: zero is singular (a rule an n === 1 ternary cannot express)", () => {
      expect(keys(0, "fr")).toEqual(["lu.plural.row.one"]);
      expect(keys(1, "fr")).toEqual(["lu.plural.row.one"]);
      expect(keys(2, "fr")).toEqual(["lu.plural.row.other"]);
    });
    it("a category the English text has no form for falls back to 'other'; a host's catalogue wins", () => {
      setLocale("ru");
      expect(describeValue("Table", { columns: ["a"], rows: [["x"], ["y"], ["z"]] }, "T")).toBe(
        "T: table with 3 rows"
      );
      const spy = vi
        .spyOn(i18n, "t")
        .mockImplementation((k: string, fb?: string) =>
          k === "lu.plural.row.few"
            ? "строки"
            : k === "lu.a11y.tableWith"
              ? "таблица из {rows} {noun}"
              : (fb ?? k)
        );
      expect(describeValue("Table", { columns: ["a"], rows: [["x"], ["y"], ["z"]] }, "T")).toBe(
        "T: таблица из 3 строки"
      );
      spy.mockRestore();
      setLocale("en-US");
    });
    it("Timeline entries use the same helper", () => {
      expect(describeValue("Timeline", [{}], "Log")).toBe("Log: 1 entry");
      expect(describeValue("Timeline", [{}, {}], "Log")).toBe("Log: 2 entries");
    });
  });
});
