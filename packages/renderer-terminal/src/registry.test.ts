import { FRAMEWORK_KINDS, type SemanticFormat, formatSemanticNumber } from "@loom-ui/core";
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
    // A "%" unit resolves to `{semanticType:"percentage"}` (`effectiveFormat`, same as the web's
    // `lu-bar-chart.ts`), whose Intl percent style expects a FRACTION — 0.5 prints "50%", not the
    // literal number 50 with a "%" appended. Fixture updated accordingly (review round 2).
    const bars =
      bc?.(customWidget$({ kind: "BarChart", title: "Bars", binding: b }), {
        unit: "%",
        bars: [
          { label: "a", value: 0.5 },
          { label: "b", value: 1 },
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
    // A "USD" unit is an ISO 4217 code, so `effectiveFormat` reads it as currency, the same as
    // the DOM renderer: the web's own symbol ("$1,234.50"), not the brief's original ISO-code
    // suffix ("1234.5 USD") — full numeric parity with the web (review round 1).
    expect(
      r?.(customWidget$({ kind: "Kpi", title: "Revenue", binding: b }), {
        value: 1234.5,
        unit: "USD",
        deltaPct: -0.034,
        label: "vs last week",
      })
    ).toBe("Revenue (vs last week): $1,234.50  ▼ 3.4%");
    expect(
      r?.(customWidget$({ kind: "Kpi", title: "Share", binding: b }), {
        value: 0.25,
        format: { semanticType: "percentage" },
      })
    ).toBe("Share: 25%");
    expect(r?.(customWidget$({ kind: "Kpi", title: "K", binding: b }), 5)).toMatch(/^✗ K: /);
  });
  it("Kpi: delta rounds to one decimal via the shared DELTA_FORMAT, like the web ('3.5%', not '3.46%')", () => {
    const r = loomUiTerminalRegistry.get("Kpi");
    expect(
      r?.(customWidget$({ kind: "Kpi", title: "Errors", binding: b }), {
        value: 1,
        deltaPct: -0.03456,
      })
    ).toBe("Errors: 1  ▼ 3.5%");
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
    // Exactly one past the cap is "1 more row", not "1 more rows".
    const one = r?.(w, { columns: ["n"], rows: Array.from({ length: 21 }, (_, i) => [i]) });
    expect(one?.split("\n").at(-1)).toBe("    … 1 more row");
    const exact = r?.(w, { columns: ["n"], rows: Array.from({ length: 20 }, (_, i) => [i]) });
    expect(exact).not.toContain("more row");
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
    // "1,234", never the unrounded, ungrouped "1234.4". Percentage and currency print exactly
    // what the web's `measure()` would — "26%" (percent style defaults to 0 fraction digits) and
    // "€12.00" (the web's own currency symbol, not an ISO-code suffix) — full numeric parity
    // (review round 1).
    expect(out?.[1]).toBe("    count  share  price");
    expect(out?.[2]).toBe("    1,234  26%    €12.00");
    expect(out?.[3]).toMatch(/^\s+—\s+—\s+—\s*$/);
  });
  it("Table: currency prints the web's own symbol and groups thousands, not an ISO-code suffix", () => {
    const r = loomUiTerminalRegistry.get("Table");
    const w = customWidget$({ kind: "Table", title: "Ledger", binding: b });
    const out = r?.(w, {
      columns: [{ label: "total", format: { semanticType: "currency", currency: "EUR" } }],
      rows: [[1234567.891]],
    })?.split("\n");
    expect(out?.[2]).toBe("    €1,234,567.89");
  });
  it("Table: an unformatted number groups and keeps up to three decimals, like the web", () => {
    const r = loomUiTerminalRegistry.get("Table");
    const w = customWidget$({ kind: "Table", title: "Raw", binding: b });
    const out = r?.(w, {
      columns: ["value"],
      rows: [[1234567.891]],
    })?.split("\n");
    expect(out?.[2]).toBe("    1,234,567.891");
  });
  it("Table cells match @loom-ui/core's formatSemanticNumber exactly, for every SemanticFormat", () => {
    const r = loomUiTerminalRegistry.get("Table");
    const w = customWidget$({ kind: "Table", title: "Mixed", binding: b });
    const cases: ReadonlyArray<{ value: number; format?: SemanticFormat }> = [
      { value: 1234.4, format: { semanticType: "integer" } },
      { value: 0.256, format: { semanticType: "percentage" } },
      { value: 12, format: { semanticType: "currency", currency: "EUR" } },
      { value: 1234567.891 },
    ];
    const out = r?.(w, {
      columns: cases.map((c, i) => ({ label: `c${i}`, ...(c.format ? { format: c.format } : {}) })),
      rows: [cases.map((c) => c.value)],
    })
      ?.split("\n")[2]
      ?.trim()
      .split(/\s+/);
    cases.forEach((c, i) => {
      expect(out?.[i]).toBe(formatSemanticNumber(c.value, c.format, "en-US"));
    });
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
  it("Prose lays a markdown document out as text", () => {
    const r = loomUiTerminalRegistry.get("Prose");
    const out = r?.(customWidget$({ kind: "Prose", id: "p", title: "Doc", binding: b }), {
      format: "markdown",
      text: "# Head\n\n- one\n- two",
    });
    expect(out).toContain("Head");
    expect(out).toContain("one");
  });
  it("Prose: plain and org text, a note and the cut line, nothing from a control byte", () => {
    const r = loomUiTerminalRegistry.get("Prose");
    const w = customWidget$({ kind: "Prose", id: "p", title: "Doc", binding: b });
    expect(r?.(w, { format: "org", text: "* Head\n/it/" })).toContain("Head");
    const out = r?.(w, {
      format: "plain",
      text: "a\u001b[31mred\nb",
      note: "First part",
      truncated: true,
    });
    expect(out).toContain("First part");
    expect(out).toContain("(document cut short)");
    expect(out).not.toContain("\u001b");
    expect(r?.(w, { format: "plain", text: "" })).toContain("(no text)");
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
  it("TimeSeries: a series-level format prints the web's currency symbol with grouping", () => {
    const ts = loomUiTerminalRegistry.get("TimeSeries");
    const out =
      ts?.(customWidget$({ kind: "TimeSeries", title: "Revenue", binding: b }), {
        series: [
          {
            label: "eur",
            format: { semanticType: "currency", currency: "EUR" },
            points: [{ timestamp: "a", value: 1234567.891 }],
          },
        ],
      }) ?? "";
    expect(out).toContain("€1,234,567.89");
  });
  it("TimeSeries: series format beats widget props.format beats unit", () => {
    const ts = loomUiTerminalRegistry.get("TimeSeries");
    const w = customWidget$({
      kind: "TimeSeries",
      title: "Precedence",
      binding: b,
      props: { format: { semanticType: "percentage" }, unit: "ms" },
    });
    const out =
      ts?.(w, {
        series: [
          {
            label: "s",
            format: { semanticType: "currency", currency: "EUR" },
            unit: "ms",
            points: [{ timestamp: "a", value: 12 }],
          },
        ],
      }) ?? "";
    expect(out).toContain("€12.00");
  });
  it("TimeSeries: an unformatted series groups a large last value, like the web", () => {
    const ts = loomUiTerminalRegistry.get("TimeSeries");
    const out =
      ts?.(customWidget$({ kind: "TimeSeries", title: "Raw", binding: b }), {
        series: [{ label: "n", points: [{ timestamp: "a", value: 1234567.891 }] }],
      }) ?? "";
    expect(out).toContain("1,234,567.891");
  });
  it("BarChart: a value-level format prints a percentage, like the web", () => {
    const bc = loomUiTerminalRegistry.get("BarChart");
    const out =
      bc?.(customWidget$({ kind: "BarChart", title: "Share", binding: b }), {
        format: { semanticType: "percentage" },
        bars: [{ label: "a", value: 0.256 }],
      }) ?? "";
    expect(out).toContain("26%");
  });
  it("BarChart: value-level format beats widget props.format beats unit", () => {
    const bc = loomUiTerminalRegistry.get("BarChart");
    const w = customWidget$({
      kind: "BarChart",
      title: "Precedence",
      binding: b,
      props: { format: { semanticType: "percentage" }, unit: "ms" },
    });
    const out =
      bc?.(w, {
        format: { semanticType: "currency", currency: "EUR" },
        unit: "ms",
        bars: [{ label: "a", value: 12 }],
      }) ?? "";
    expect(out).toContain("€12.00");
  });
  it("BarChart: an unformatted large value groups thousands, like the web", () => {
    const bc = loomUiTerminalRegistry.get("BarChart");
    const out =
      bc?.(customWidget$({ kind: "BarChart", title: "Big", binding: b }), {
        bars: [{ label: "a", value: 1234567.891 }],
      }) ?? "";
    expect(out).toContain("1,234,567.891");
  });
  it("a right-axis series is marked (R) only when some series is on the left, like the web", () => {
    const ts = loomUiTerminalRegistry.get("TimeSeries");
    const w = customWidget$({ kind: "TimeSeries", title: "Load", binding: b });
    const mixed =
      ts?.(w, {
        series: [
          { label: "rps", points: [{ timestamp: "a", value: 1 }] },
          { label: "bytes", axis: "right", points: [{ timestamp: "a", value: 1 }] },
        ],
      }) ?? "";
    expect(mixed).toContain("bytes (R)");
    expect(mixed).not.toContain("rps (R)");
    // All on the right: the web falls back to one shared left axis, so there is no "right" to mark.
    const allRight =
      ts?.(w, {
        series: [
          { label: "rps", axis: "right", points: [{ timestamp: "a", value: 1 }] },
          { label: "bytes", axis: "right", points: [{ timestamp: "a", value: 1 }] },
        ],
      }) ?? "";
    expect(allRight).not.toContain("(R)");
  });
  it("the (R) marker survives truncation of a long right-axis label; a long left-axis label is still truncated, and rows stay column-aligned", () => {
    const ts = loomUiTerminalRegistry.get("TimeSeries");
    const w = customWidget$({ kind: "TimeSeries", title: "Perf", binding: b });
    const out =
      ts?.(w, {
        series: [
          { label: "Queue depth over time", points: [{ timestamp: "a", value: 1 }] },
          { label: "Pick latency", axis: "right", points: [{ timestamp: "a", value: 1 }] },
        ],
      }) ?? "";
    const lines = out.split("\n").slice(1);
    const [leftLine, rightLine] = [lines[0] ?? "", lines[1] ?? ""];
    // The marker is semantic information: never truncated away, no matter how long the label is.
    expect(rightLine).toContain("(R)");
    expect(rightLine).toContain(" (R)");
    // A long left-axis label truncates exactly as before (to the 12-char column), unmarked.
    expect(leftLine).not.toContain("(R)");
    expect(leftLine).toContain("Queue depth");
    expect(leftLine).not.toContain("Queue depth over time");
    // Both rows' sparkline column starts at the same offset, marked or not.
    const sparkAt = (line: string) => line.search(/[▁▂▃▄▅▆▇█]/);
    expect(sparkAt(leftLine)).toBe(sparkAt(rightLine));
  });
  it("a unit stays beside a format that draws no symbol; currency and percent never double theirs", () => {
    const dec = { semanticType: "decimal" } as const;
    const kpi = loomUiTerminalRegistry.get("Kpi");
    const k = (value: unknown) =>
      kpi?.(customWidget$({ kind: "Kpi", title: "K", binding: b }), value);
    expect(k({ value: 7, unit: "ms", format: dec })).toBe("K: 7 ms");
    expect(
      k({ value: 12, unit: "USD", format: { semanticType: "currency", currency: "USD" } })
    ).toBe("K: $12.00");
    expect(k({ value: 0.25, unit: "%", format: { semanticType: "percentage" } })).toBe("K: 25%");
    const ts = loomUiTerminalRegistry.get("TimeSeries");
    expect(
      ts?.(customWidget$({ kind: "TimeSeries", title: "Lat", binding: b }), {
        series: [{ label: "p99", unit: "ms", format: dec, points: [{ timestamp: "a", value: 7 }] }],
      })
    ).toMatch(/p99.*7 ms$/);
    const bc = loomUiTerminalRegistry.get("BarChart");
    expect(
      bc?.(customWidget$({ kind: "BarChart", title: "Lat", binding: b }), {
        unit: "ms",
        format: dec,
        bars: [{ label: "a", value: 7 }],
      })
    ).toMatch(/a.*7 ms$/);
  });
  it("Kpi: a non-finite delta prints — with no arrow", () => {
    const r = loomUiTerminalRegistry.get("Kpi");
    expect(
      r?.(customWidget$({ kind: "Kpi", title: "Growth", binding: b }), {
        value: 3,
        deltaPct: Number.POSITIVE_INFINITY,
      })
    ).toBe("Growth: 3  —");
  });
  it("Kpi: a zero delta is flat — no arrow", () => {
    const r = loomUiTerminalRegistry.get("Kpi");
    expect(
      r?.(customWidget$({ kind: "Kpi", title: "Errors", binding: b }), { value: 3, deltaPct: 0 })
    ).toBe("Errors: 3  0%");
  });
});
