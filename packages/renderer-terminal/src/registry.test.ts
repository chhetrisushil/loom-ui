import { builtinCatalog, catalogCoverage, customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { loomUiTerminalRegistry, terminalRegistry } from "./registry";

const b = { projectionId: "p", path: "v" };
describe("terminal registry", () => {
  it("adds TimeSeries and BarChart over loom's default registry, which still covers the built-ins", () => {
    const reg = terminalRegistry();
    expect(catalogCoverage(builtinCatalog, reg).ok).toBe(true);
    expect(loomUiTerminalRegistry.kinds().sort()).toEqual(["BarChart", "TimeSeries"]);
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
});
