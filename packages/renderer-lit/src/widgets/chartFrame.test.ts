import { customWidget$ } from "@loom/blueprint-runtime";
import type { CSSResultGroup } from "lit";
import { describe, expect, it } from "vitest";
import { chartHostStyles } from "../charts/frame";
import "./index";
import { LuBarChart } from "./lu-bar-chart";
import { LuTimeseries } from "./lu-timeseries";

// G15: a chart measures its host and draws an SVG of that size. In an AUTO-height container the
// host's height is its content's, so an in-flow SVG feeds back into its own measurement and the
// chart grows on every ResizeObserver tick. happy-dom has no layout, so this pins the two CSS
// rules that end the loop (checked against a real browser when the fix was made) plus the
// observable consequence for the resize handler.

/** Flatten a Lit `styles` value to its CSS text. */
function cssText(styles: CSSResultGroup | undefined): string {
  if (styles === undefined) return "";
  if (Array.isArray(styles)) return styles.map((s) => cssText(s as CSSResultGroup)).join("\n");
  // Comments out, whitespace runs collapsed: formatting (a reformat, a changed indent) is no change.
  return ((styles as { cssText?: string }).cssText ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ");
}
/** A declaration value with every whitespace run dropped — `var(--a, 16 / 9)` === `var(--a,16/9)`. */
const squash = (v: string | undefined): string => (v ?? "").replace(/\s+/g, "");

/** The declarations of the FIRST rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const m = new RegExp(
    `(?:^|})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*{([^}]*)}`
  ).exec(css);
  expect(m, `rule ${selector}`).not.toBeNull();
  return Object.fromEntries(
    (m?.[1] ?? "")
      .split(";")
      .map((d) => d.split(/:(.+)/).map((x) => x?.trim() ?? ""))
      .filter(([k]) => k)
      .map(([k, v]) => [k, squash(v)])
  ) as Record<string, string>;
}

describe("chart host: a block size of its own when the container gives none", () => {
  it("the shared frame sets aspect-ratio and a min-height behind host-tunable custom properties", () => {
    const host = rule(cssText(chartHostStyles), ":host");
    expect(host.height).toBe("100%"); // a definite-height cell still wins
    expect(host.width).toBe("100%"); // no intrinsic width once the plot is out of flow
    // border-box, so `width: 100%` plus a host's padding/border never overflows its container
    expect(host["box-sizing"]).toBe("border-box");
    expect(host["aspect-ratio"]).toBe(squash("var(--lu-chart-aspect, 16 / 9)"));
    expect(host["min-height"]).toBe(squash("var(--lu-chart-min-height, 120px)"));
    expect(host.display).toBe("block");
    expect(host.position).toBe("relative"); // the absolutely-placed plot anchors here
  });
  for (const [name, ctor] of [
    ["lu-timeseries", LuTimeseries],
    ["lu-bar-chart", LuBarChart],
  ] as const) {
    it(`${name} uses the frame and no longer zeroes min-height`, () => {
      const css = cssText(ctor.styles);
      const host = rule(css, ":host");
      expect(host["min-height"]).toContain("--lu-chart-min-height");
      expect(host["aspect-ratio"]).toContain("--lu-chart-aspect");
      expect(host["min-height"]).not.toBe("0"); // the old `:host { min-height: 0 }`
    });
  }
  it("both charts inherit border-box from the shared frame (no per-chart override)", () => {
    for (const ctor of [LuTimeseries, LuBarChart]) {
      const host = rule(cssText(ctor.styles), ":host");
      expect(host["box-sizing"]).toBe("border-box");
    }
  });
  it("the plot is out of flow in both charts, so what it draws cannot change what it measures", () => {
    expect(rule(cssText(LuBarChart.styles), "svg").position).toBe("absolute");
    expect(rule(cssText(LuTimeseries.styles), ".chart svg").position).toBe("absolute");
    // The timeseries frame (legend + plot) fills the host rather than sizing it.
    const wrap = rule(cssText(LuTimeseries.styles), ".wrap");
    expect(wrap.position).toBe("absolute");
    expect(wrap.inset).toBe("0");
  });
});

describe("the resize handler never feeds the plot back into its own measurement", () => {
  const b = { projectionId: "h", path: "values.h" };
  const tick = async (el: HTMLElement) =>
    (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  type RO = { cb: ResizeObserverCallback };
  async function mountWithRO(tag: string, widget: unknown, value: unknown) {
    const observers: RO[] = [];
    const Orig = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        observers.push({ cb });
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const el = document.createElement(tag) as HTMLElement & Record<string, unknown>;
    el.widget = widget;
    el.value = value;
    document.body.appendChild(el);
    await tick(el);
    globalThis.ResizeObserver = Orig;
    const report = async (width: number, height: number) => {
      for (const o of observers)
        o.cb([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
      await tick(el);
    };
    const svgSize = () => {
      const s = el.shadowRoot?.querySelector("svg");
      return [Number(s?.getAttribute("width")), Number(s?.getAttribute("height"))] as const;
    };
    return { el, report, svgSize };
  }

  it("lu-bar-chart: the plot is exactly the measured box — a stable box is a fixed point", async () => {
    const widget = customWidget$({ kind: "BarChart", id: "bc", title: "B", binding: b });
    const { report, svgSize } = await mountWithRO("lu-bar-chart", widget, {
      bars: [{ label: "a", value: 1 }],
    });
    await report(400, 200);
    expect(svgSize()).toEqual([400, 200]);
    // The browser reports the same box again (nothing in the plot is in flow): nothing moves.
    await report(400, 200);
    expect(svgSize()).toEqual([400, 200]);
  });
  it("lu-timeseries: the plot is the measured box minus the legend allowance, and idempotent", async () => {
    const pts = [
      { timestamp: "2024-01-01T00:00:00Z", value: 1 },
      { timestamp: "2024-01-02T00:00:00Z", value: 2 },
    ];
    const widget = customWidget$({ kind: "TimeSeries", id: "ts", title: "T", binding: b });
    const { report, svgSize } = await mountWithRO("lu-timeseries", widget, {
      series: [
        { label: "a", points: pts },
        { label: "b", points: pts },
      ],
    });
    await report(480, 270);
    const first = svgSize();
    expect(first).toEqual([480, 248]);
    await report(480, 270);
    expect(svgSize()).toEqual(first);
  });
});
