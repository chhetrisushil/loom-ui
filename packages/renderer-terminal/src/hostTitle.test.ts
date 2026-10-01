import { customWidget$ } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { createLoomUiTerminalRegistry, loomUiTerminalRegistry, terminalRegistry } from "./registry";

// G13: `chrome: "host"` — the host draws the title, so no framework kind prints one: not in its
// ready rendering, not in its error rendering, not for a loading (undefined) value.

const b = { projectionId: "p", path: "v" };
const T = "ZZ-Host-Title";
const host = createLoomUiTerminalRegistry({ chrome: "host" });
const pts = [
  { timestamp: "a", value: 1 },
  { timestamp: "b", value: 4 },
];

const CASES: ReadonlyArray<readonly [string, unknown]> = [
  ["TimeSeries", { series: [{ label: "p99", points: pts }] }],
  ["BarChart", { bars: [{ label: "a", value: 1 }] }],
  ["Kpi", { value: 5, label: "vs last week", deltaPct: 0.1 }],
  ["Table", { columns: ["db"], rows: [["orders"]] }],
  ["StatusCard", { level: "ok", headline: "Fine", detail: "all good" }],
  ["A2UIView", { any: 1 }],
  ["SandboxView", { any: 1 }],
];
const w = (kind: string, title: string | undefined = T) =>
  customWidget$({ kind, ...(title === undefined ? {} : { title }), binding: b });

describe("terminal chrome: host", () => {
  for (const [kind, value] of CASES) {
    it(`${kind}: default prints the title, host prints none (ready, error, loading)`, () => {
      const dflt = loomUiTerminalRegistry.get(kind)?.(w(kind), value) ?? "";
      const own = host.get(kind)?.(w(kind), value) ?? "";
      expect(dflt).toContain(T);
      expect(own).not.toContain(T);
      expect(own.length).toBeGreaterThan(0);
      // Error rendering: `✗ Title: msg` vs `✗ msg`.
      // A2UIView / SandboxView accept any bound value, so they have no contract error to show.
      if (kind === "A2UIView" || kind === "SandboxView") return;
      const bad = { nope: 1 };
      const dErr = loomUiTerminalRegistry.get(kind)?.(w(kind), bad) ?? "";
      const hErr = host.get(kind)?.(w(kind), bad) ?? "";
      expect(dErr).toMatch(new RegExp(`^✗ ${T}: `));
      expect(hErr).toMatch(/^✗ [^:]*\S/);
      expect(hErr).not.toContain(T);
      expect(hErr).toBe(dErr.replace(`${T}: `, ""));
      // Loading (value undefined).
      expect(loomUiTerminalRegistry.get(kind)?.(w(kind), undefined)).toBe(`${T}: —`);
      expect(host.get(kind)?.(w(kind), undefined)).toBe("—");
    });
  }
  it("exact shapes under host chrome", () => {
    expect(host.get("StatusCard")?.(w("StatusCard"), { level: "ok", headline: "Fine" })).toBe(
      "[ok] Fine"
    );
    expect(host.get("Kpi")?.(w("Kpi"), { value: 5 })).toBe("5");
    expect(host.get("Kpi")?.(w("Kpi"), { value: 5, label: "vs last week" })).toBe(
      "5  (vs last week)"
    );
    // The default Kpi is untouched.
    expect(loomUiTerminalRegistry.get("Kpi")?.(w("Kpi"), { value: 5, label: "vs" })).toBe(
      `${T} (vs): 5`
    );
    const tbl = host.get("Table")?.(w("Table"), { columns: ["db"], rows: [["orders"]] }) ?? "";
    expect(tbl.split("\n")).toHaveLength(2);
    const ts = host.get("TimeSeries")?.(w("TimeSeries"), {
      series: [{ label: "p99", points: pts }],
    });
    expect(ts).toMatch(/^ {4}p99\s+[▁▂▃▄▅▆▇█]{2}\s+4$/);
  });
  it('Note: host drops the title; a non-string or empty title ("", 0, 5) is none under either chrome', () => {
    const note = (title: unknown) =>
      customWidget$({
        kind: "Note",
        ...(title === undefined ? {} : { title: title as string }),
        props: { text: "hi" },
      });
    expect(loomUiTerminalRegistry.get("Note")?.(note(T), undefined)).toBe(`${T}: hi`);
    expect(host.get("Note")?.(note(T), undefined)).toBe("hi");
    for (const t of ["", 0, 5, undefined]) {
      expect(loomUiTerminalRegistry.get("Note")?.(note(t), undefined)).toBe("hi");
      expect(host.get("Note")?.(note(t), undefined)).toBe("hi");
    }
  });
  it("a non-string or empty title on any other kind falls back to the kind, not `: value`", () => {
    for (const t of ["", 0 as unknown as string, 5 as unknown as string]) {
      expect(
        loomUiTerminalRegistry.get("StatusCard")?.(w("StatusCard", t), {
          level: "ok",
          headline: "H",
        })
      ).toBe("StatusCard: [ok] H");
    }
  });
  it("terminalRegistry({chrome}) applies it to the framework kinds; no options = unchanged", () => {
    expect(
      terminalRegistry({ chrome: "host" }).get("StatusCard")?.(w("StatusCard"), {
        level: "ok",
        headline: "H",
      })
    ).toBe("[ok] H");
    expect(
      terminalRegistry().get("StatusCard")?.(w("StatusCard"), { level: "ok", headline: "H" })
    ).toBe(`${T}: [ok] H`);
    expect(
      terminalRegistry({ chrome: "widget" }).get("StatusCard")?.(w("StatusCard"), {
        level: "ok",
        headline: "H",
      })
    ).toBe(`${T}: [ok] H`);
  });
});
