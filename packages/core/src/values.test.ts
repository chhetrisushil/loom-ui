import { describe, expect, it } from "vitest";
import {
  ChartAxis,
  FRAMEWORK_KINDS,
  SemanticFormat,
  checkKindValue,
  kindValueContract,
  kindValueContracts,
  tableColumnFormat,
  tableColumnLabel,
} from "./values";

describe("kindValueContracts", () => {
  it("declares every loom built-in kind and the framework kinds", () => {
    expect(Object.keys(kindValueContracts).sort()).toEqual(
      [
        "A2UIView",
        "AlertCard",
        "ApprovalCard",
        "BarChart",
        "DataTable",
        "Kpi",
        "MetricCard",
        "Note",
        "ProgressBar",
        "SandboxView",
        "StatusBadge",
        "StatusCard",
        "StreamingText",
        "Table",
        "TimeSeries",
        "Timeline",
      ].sort()
    );
    expect(FRAMEWORK_KINDS).toEqual([
      "TimeSeries",
      "BarChart",
      "Kpi",
      "Table",
      "StatusCard",
      "Note",
      "A2UIView",
      "SandboxView",
    ]);
    expect(kindValueContract("Nope")).toBeUndefined();
  });
  it("pins loom's implicit contracts: scalar metric, string badge, object rows", () => {
    expect(checkKindValue("MetricCard", 412)).toEqual({ ok: true });
    expect(checkKindValue("MetricCard", { value: 412 })).toMatchObject({
      ok: false,
      finding: { code: "value-contract", severity: "error" },
    });
    expect(checkKindValue("StatusBadge", "triaging")).toEqual({ ok: true });
    expect(checkKindValue("DataTable", [{ db: "orders", p99: 1 }])).toEqual({ ok: true });
    expect(checkKindValue("DataTable", [1, 2])).toMatchObject({ ok: false });
    expect(checkKindValue("ProgressBar", "50%")).toMatchObject({ ok: false });
  });
  it("TimeSeries and BarChart shapes", () => {
    expect(
      checkKindValue("TimeSeries", {
        series: [
          { label: "p99", unit: "ms", points: [{ timestamp: "2026-01-01T00:00:00Z", value: 1 }] },
        ],
      })
    ).toEqual({ ok: true });
    expect(
      checkKindValue("TimeSeries", {
        series: [{ label: "p99", points: [{ timestamp: 5, value: 1 }] }],
      })
    ).toMatchObject({ ok: false });
    expect(checkKindValue("BarChart", { bars: [{ label: "a", value: 1 }] })).toEqual({ ok: true });
    expect(checkKindValue("BarChart", { bars: [{ label: "a" }] })).toMatchObject({ ok: false });
  });
  it("undefined is 'not hydrated yet', and an unknown kind has nothing to check", () => {
    expect(checkKindValue("MetricCard", undefined)).toEqual({ ok: true });
    expect(checkKindValue("Nope", { anything: 1 })).toEqual({ ok: true });
  });
  it("a finding names the kind and the first issue path", () => {
    const r = checkKindValue("TimeSeries", {
      series: [{ label: "x", points: [{ timestamp: "t", value: "1" }] }],
    });
    expect(!r.ok && r.finding.message).toMatch(/TimeSeries.*series\.0\.points\.0\.value/);
  });
});

describe("Kpi, Table, StatusCard, Note, A2UIView, SandboxView value contracts", () => {
  it("Kpi: a number with optional unit, format, label and a nullable deltaPct", () => {
    expect(checkKindValue("Kpi", { value: 1234.5 })).toEqual({ ok: true });
    expect(
      checkKindValue("Kpi", {
        extra: true, // an unrecognized field is harmless; a non-strict object ignores it
        value: 0.25,
        unit: "USD",
        format: { semanticType: "currency", currency: "USD" },
        label: "vs last week",
        deltaPct: null,
      })
    ).toEqual({ ok: true });
    expect(checkKindValue("Kpi", 412)).toMatchObject({ ok: false });
    expect(checkKindValue("Kpi", { value: "412" })).toMatchObject({ ok: false });
  });
  it("Table: columns are strings or {label, format}; rows are arrays of string | number | null", () => {
    const ok = {
      columns: ["db", { label: "p99", format: { semanticType: "integer" } }],
      rows: [
        ["orders", 12],
        ["users", null],
      ],
    };
    expect(checkKindValue("Table", ok)).toEqual({ ok: true });
    expect(checkKindValue("Table", [{ db: "orders" }])).toMatchObject({ ok: false });
    expect(checkKindValue("Table", { columns: ["a"], rows: [[{ nested: 1 }]] })).toMatchObject({
      ok: false,
    });
    // a row shorter than the columns is NOT a contract failure — the renderer shows "—"
    expect(checkKindValue("Table", { columns: ["a", "b"], rows: [["x"]] })).toEqual({ ok: true });
  });
  it("StatusCard: level is ok | warning | critical, headline required", () => {
    expect(checkKindValue("StatusCard", { level: "warning", headline: "Lag" })).toEqual({
      ok: true,
    });
    expect(
      checkKindValue("StatusCard", { level: "ok", headline: "Fine", detail: "all green" })
    ).toEqual({ ok: true });
    expect(checkKindValue("StatusCard", { level: "meh", headline: "x" })).toMatchObject({
      ok: false,
    });
    expect(checkKindValue("StatusCard", "ok")).toMatchObject({ ok: false });
  });
  it("Note takes no value; A2UIView and SandboxView accept any data", () => {
    expect(checkKindValue("Note", undefined)).toEqual({ ok: true });
    expect(checkKindValue("Note", "text")).toMatchObject({ ok: false });
    expect(checkKindValue("A2UIView", { anything: [1] })).toEqual({ ok: true });
    expect(checkKindValue("SandboxView", 7)).toEqual({ ok: true });
  });
  it("SemanticFormat is the set the renderers honour — five number types — and refuses a malformed currency", () => {
    for (const semanticType of ["number", "integer", "decimal", "percentage", "currency"])
      expect(SemanticFormat.safeParse({ semanticType }).success).toBe(true);
    // A type no renderer honours is refused rather than silently drawn as a plain number: a
    // consumer with richer semantics maps to these five at its own boundary.
    for (const semanticType of ["duration", "datetime", "measurement", "country"])
      expect(SemanticFormat.safeParse({ semanticType }).success).toBe(false);
    expect(SemanticFormat.safeParse({ semanticType: "currency", currency: "usd" }).success).toBe(
      false
    );
    expect(
      SemanticFormat.safeParse({ semanticType: "number", maximumFractionDigits: 101 }).success
    ).toBe(false);
  });
  it("SemanticFormat: min ≤ max fraction digits; unhonoured fields are tolerated and dropped", () => {
    expect(
      SemanticFormat.safeParse({
        semanticType: "decimal",
        minimumFractionDigits: 1,
        maximumFractionDigits: 3,
      }).success
    ).toBe(true);
    expect(
      SemanticFormat.safeParse({
        semanticType: "decimal",
        minimumFractionDigits: 3,
        maximumFractionDigits: 1,
      }).success
    ).toBe(false);
    // A non-strict object: a payload carrying fields the renderers never honoured still passes,
    // and those fields are not part of the parsed format.
    const parsed = SemanticFormat.safeParse({
      semanticType: "decimal",
      unit: "ms",
      dateStyle: "short",
      timeStyle: "short",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ semanticType: "decimal" });
  });
  it("SemanticFormat: an integer with fraction digits is refused, not coerced", () => {
    for (const digits of [{ minimumFractionDigits: 2 }, { maximumFractionDigits: 1 }]) {
      const r = SemanticFormat.safeParse({ semanticType: "integer", ...digits });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0]?.message).toMatch(/integer.*fraction digits/);
    }
    expect(
      SemanticFormat.safeParse({
        semanticType: "integer",
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).success
    ).toBe(true);
  });
  it("tableColumnLabel / tableColumnFormat read either column form", () => {
    expect(tableColumnLabel("db")).toBe("db");
    expect(tableColumnFormat("db")).toBeUndefined();
    const col = { label: "p99", format: { semanticType: "integer" as const } };
    expect(tableColumnLabel(col)).toBe("p99");
    expect(tableColumnFormat(col)).toEqual({ semanticType: "integer" });
  });
});

describe("chart enrichments", () => {
  it("a series may carry a format and an axis; a bar chart a value-level format", () => {
    expect(
      checkKindValue("TimeSeries", {
        series: [
          {
            label: "revenue",
            format: { semanticType: "currency", currency: "EUR" },
            axis: "right",
            points: [{ timestamp: "2026-01-01T00:00:00Z", value: 1 }],
          },
        ],
      })
    ).toEqual({ ok: true });
    expect(
      checkKindValue("TimeSeries", {
        series: [{ label: "x", axis: "top", points: [] }],
      })
    ).toMatchObject({ ok: false });
    expect(
      checkKindValue("BarChart", {
        format: { semanticType: "percentage" },
        bars: [{ label: "a", value: 0.5 }],
      })
    ).toEqual({ ok: true });
    expect(ChartAxis.options).toEqual(["left", "right"]);
  });
});
