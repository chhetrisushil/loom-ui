import { describe, expect, it } from "vitest";
import * as widgets from "./index";

// G16: `lu-kpi .caption` used to apply `opacity: .8` over the dim text token, so a host could not
// make the caption meet WCAG AA by overriding tokens without lifting ALL dim text — and at the
// defaults the stacked colour fell below 4.5:1. Text colour must be a TOKEN, never an opacity.

const css = (ctor: unknown): string => {
  const s = (ctor as { styles?: unknown }).styles;
  const flat = (x: unknown): string =>
    Array.isArray(x) ? x.map(flat).join("\n") : ((x as { cssText?: string })?.cssText ?? "");
  return flat(s).replace(/\/\*[\s\S]*?\*\//g, "");
};
const rules = (text: string): Array<{ selector: string; body: string }> =>
  [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? "").trim(),
    body: m[2] ?? "",
  }));

const luWidgets = Object.entries(widgets).filter(([name]) => /^Lu[A-Z]/.test(name));

/** WCAG 2.x contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("caption contrast", () => {
  it("lu-kpi .caption takes its own token, falling back to dim text, with no opacity", () => {
    const caption = rules(css(widgets.LuKpi)).find((r) => r.selector === ".caption");
    expect(caption).toBeDefined();
    expect(caption?.body).not.toMatch(/opacity/);
    expect(caption?.body).toContain("color: var(--lu-text-caption, var(--lu-text-dim, #8b949e))");
  });

  it("the default caption colour meets WCAG AA (4.5:1) on the default panel", () => {
    expect(contrast("#8b949e", "#161b22")).toBeGreaterThanOrEqual(4.5);
    // ...and the old stacked value did not: .8 opacity of dim over the panel.
    const blend = (fg: number, bg: number): number => Math.round(fg * 0.8 + bg * 0.2);
    const stacked = `#${[
      [0x8b, 0x16],
      [0x94, 0x1b],
      [0x9e, 0x22],
    ]
      .map(([f, b]) =>
        blend(f as number, b as number)
          .toString(16)
          .padStart(2, "0")
      )
      .join("")}`;
    expect(contrast(stacked, "#161b22")).toBeLessThan(4.5);
  });

  it("no widget stacks an opacity over text: only a disabled control may", () => {
    const withOpacity = luWidgets.flatMap(([name, ctor]) =>
      rules(css(ctor))
        .filter((r) => /(^|[;\s])opacity\s*:/.test(r.body))
        .map((r) => `${name} ${r.selector}`)
    );
    // `select:disabled` is inactive UI, exempt from WCAG 1.4.3 and deliberately dimmed.
    expect(withOpacity).toEqual(["LuLocalePicker select:disabled"]);
    expect(luWidgets.length).toBeGreaterThan(10);
  });
});
