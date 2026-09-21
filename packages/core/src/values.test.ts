import { describe, expect, it } from "vitest";
import { FRAMEWORK_KINDS, checkKindValue, kindValueContract, kindValueContracts } from "./values";

describe("kindValueContracts", () => {
  it("declares every loom built-in kind and the framework kinds", () => {
    expect(Object.keys(kindValueContracts).sort()).toEqual(
      [
        "AlertCard",
        "ApprovalCard",
        "BarChart",
        "DataTable",
        "MetricCard",
        "ProgressBar",
        "StatusBadge",
        "StreamingText",
        "TimeSeries",
        "Timeline",
      ].sort()
    );
    expect(FRAMEWORK_KINDS).toEqual(["TimeSeries", "BarChart"]);
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
