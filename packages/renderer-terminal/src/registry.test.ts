import { FRAMEWORK_KINDS } from "@loom-ui/core";
import { builtinCatalog, catalogCoverage, customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { loomUiTerminalRegistry, terminalRegistry } from "./registry";

const b = { projectionId: "p", path: "v" };
describe("terminal registry", () => {
  it("adds every framework kind over loom's default registry, which still covers the built-ins", () => {
    const reg = terminalRegistry();
    expect(catalogCoverage(builtinCatalog, reg).ok).toBe(true);
    expect(loomUiTerminalRegistry.kinds().sort()).toEqual([...FRAMEWORK_KINDS].sort());
    expect(reg.has("TimeSeries") && reg.has("BarChart")).toBe(true);
  });
  it("TimeSeries renders one sparkline line per series with the last value; BarChart one bar per entry", () => {
    const ts = loomUiTerminalRegistry.get("TimeSeries");
    const out =
      ts?.(customWidget$({ kind: "TimeSeries", title: "Latency", binding: b }), {
        series: [
          {
            label: "p99",
            unit: "ms",
            points: [
              { timestamp: "a", value: 1 },
              { timestamp: "b", value: 4 },
            ],
          },
        ],
      }) ?? "";
    expect(out.split("\n")[0]).toBe("Latency:");
    expect(out).toMatch(/p99\s+[▁▂▃▄▅▆▇█]{2}\s+4 ms/);
    const bc = loomUiTerminalRegistry.get("BarChart");
    const bars =
      bc?.(customWidget$({ kind: "BarChart", title: "Bars", binding: b }), {
        unit: "%",
        bars: [
          { label: "a", value: 50 },
          { label: "b", value: 100 },
        ],
      }) ?? "";
    expect(bars).toMatch(/a\s+█{10}·{10}\s+50%/);
    expect(bars).toMatch(/b\s+█{20}\s+100%/);
  });
  it("a value violating the kind contract renders as a visible error, never a throw", () => {
    const ts = loomUiTerminalRegistry.get("TimeSeries");
    expect(
      ts?.(customWidget$({ kind: "TimeSeries", title: "Latency", binding: b }), { nope: 1 })
    ).toMatch(/^✗ Latency: .*contract/);
  });
  it("Kpi: formatted value, delta arrow and label", () => {
    const r = loomUiTerminalRegistry.get("Kpi");
    expect(
      r?.(customWidget$({ kind: "Kpi", title: "Revenue", binding: b }), {
        value: 1234.5,
        unit: "USD",
        deltaPct: -0.034,
        label: "vs last week",
      })
    ).toBe("Revenue: 1234.5 USD  ▼ 3.4% (vs last week)");
    expect(
      r?.(customWidget$({ kind: "Kpi", title: "Share", binding: b }), {
        value: 0.25,
        format: { semanticType: "percentage" },
      })
    ).toBe("Share: 25%");
    expect(r?.(customWidget$({ kind: "Kpi", title: "K", binding: b }), 5)).toMatch(/^✗ K: /);
  });
  it("Table: aligned heading and rows, — for a missing cell, and a count past 20 rows", () => {
    const r = loomUiTerminalRegistry.get("Table");
    const w = customWidget$({ kind: "Table", title: "Top", binding: b });
    expect(
      r?.(w, {
        columns: ["db", { label: "p99" }],
        rows: [["orders", 12], ["users"]],
      })?.split("\n")
    ).toEqual(["Top:", "    db      p99", "    orders  12", "    users   —"]);
    const many = r?.(w, {
      columns: ["n"],
      rows: Array.from({ length: 25 }, (_, i) => [i]),
    });
    expect(many?.split("\n").at(-1)).toBe("    … 5 more rows");
  });
  it("Table: integer grouping, percentage, currency and a null cell", () => {
    const r = loomUiTerminalRegistry.get("Table");
    const w = customWidget$({ kind: "Table", title: "Metrics", binding: b });
    const out = r?.(w, {
      columns: [
        { label: "count", format: { semanticType: "integer" } },
        { label: "share", format: { semanticType: "percentage" } },
        { label: "price", format: { semanticType: "currency", currency: "EUR" } },
      ],
      rows: [
        [1234.4, 0.256, 12],
        [null, null, null],
      ],
    })?.split("\n");
    // An `integer` column rounds AND groups digits, like the web's own Intl.NumberFormat —
    // "1,234", never the unrounded, ungrouped "1234.4".
    expect(out?.[1]).toBe("    count  share  price");
    expect(out?.[2]).toBe("    1,234  25.6%  12 EUR");
    expect(out?.[3]).toMatch(/^\s+—\s+—\s+—\s*$/);
  });
  it("StatusCard: level, headline and detail", () => {
    const r = loomUiTerminalRegistry.get("StatusCard");
    expect(
      r?.(customWidget$({ kind: "StatusCard", title: "Replication", binding: b }), {
        level: "warning",
        headline: "Replica lag",
        detail: "12s behind",
      })
    ).toBe("Replication: [warning] Replica lag — 12s behind");
  });
  it("Note: static text from props, with no binding and no value", () => {
    const r = loomUiTerminalRegistry.get("Note");
    expect(
      r?.(
        customWidget$({ kind: "Note", title: "About", props: { text: "Plain words" } }),
        undefined
      )
    ).toBe("About: Plain words");
    expect(
      r?.(
        customWidget$({ kind: "Note", props: { text: { key: "k", fallback: "Fallback" } } }),
        undefined
      )
    ).toBe("Fallback");
  });
  it("A2UIView and SandboxView say they render on the web", () => {
    const a = loomUiTerminalRegistry.get("A2UIView");
    const s = loomUiTerminalRegistry.get("SandboxView");
    expect(a?.(customWidget$({ kind: "A2UIView", title: "Form", binding: b }), {})).toBe(
      "Form: [A2UI view — rendered on the web]"
    );
    expect(s?.(customWidget$({ kind: "SandboxView", title: "Custom", binding: b }), {})).toBe(
      "Custom: [sandboxed component — rendered on the web]"
    );
  });
  it("a right-axis series is marked (R)", () => {
    const ts = loomUiTerminalRegistry.get("TimeSeries");
    const out =
      ts?.(customWidget$({ kind: "TimeSeries", title: "Load", binding: b }), {
        series: [{ label: "bytes", axis: "right", points: [{ timestamp: "a", value: 1 }] }],
      }) ?? "";
    expect(out).toContain("bytes (R)");
  });
});
