import { customWidget$ } from "@loomwork/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { createLoomUiTerminalRegistry, loomUiTerminalRegistry } from "./registry";

const b = { projectionId: "p", path: "v" };
const BASE: Readonly<Record<string, Record<string, unknown>>> = {
  Kpi: { value: 4.5 },
  BarChart: { bars: [{ label: "alpha", value: 3 }] },
  TimeSeries: { series: [{ label: "p99", points: [{ timestamp: "a", value: 1 }] }] },
  Table: { columns: ["a"], rows: [["x"]] },
  StatusCard: { level: "ok", headline: "All good" },
  Diagram: { layout: "network", nodes: [{ id: "a", label: "Alpha" }], edges: [] },
};
const draw = (kind: string, refs: unknown, host = false): string => {
  const reg = host ? createLoomUiTerminalRegistry({ chrome: "host" }) : loomUiTerminalRegistry;
  const w = customWidget$({ kind, id: "w", title: "Probe", binding: b });
  return reg.get(kind)?.(w, { ...BASE[kind], ...(refs === undefined ? {} : { refs }) }) ?? "";
};

describe("terminal source footnotes", () => {
  for (const kind of Object.keys(BASE)) {
    describe(kind, () => {
      it("prints '[n] label' lines under the widget, '[n]' alone without a label", () => {
        const out = draw(kind, [
          { id: "a", label: "Quarterly report" },
          { id: "b" },
          { id: "c", label: "Ledger" },
        ]);
        const lines = out.split("\n");
        expect(lines.slice(-3)).toEqual(["    [1] Quarterly report", "    [2]", "    [3] Ledger"]);
        // Everything above the footnotes is exactly what the widget prints without refs.
        expect(lines.slice(0, -3).join("\n")).toBe(draw(kind, undefined));
      });
      it("hangs no indent under host chrome, and draws nothing for no refs", () => {
        expect(
          draw(kind, [{ id: "a", label: "L" }], true)
            .split("\n")
            .at(-1)
        ).toBe("[1] L");
        expect(draw(kind, [])).toBe(draw(kind, undefined));
        expect(draw(kind, undefined)).not.toMatch(/\[1\]/);
      });
      it("cleans a hostile label to one line", () => {
        const out = draw(kind, [{ id: "a", label: "two\nlines\u001b[31m red‮" }]);
        const note = out.split("\n").at(-1) as string;
        expect(note.startsWith("    [1] two lines")).toBe(true);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no control character survives
        expect(note).not.toMatch(/[\u001b‮]/);
      });
      it("refuses 17 refs as the error line, with no footnote", () => {
        const out = draw(
          kind,
          Array.from({ length: 17 }, (_, i) => ({ id: `r${i}`, label: "zq" }))
        );
        expect(out.startsWith("✗ Probe:")).toBe(true);
        expect(out).not.toContain("zq");
      });
    });
  }
});
