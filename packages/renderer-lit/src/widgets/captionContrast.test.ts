import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

/** Every `var(--token, #rrggbb)` fallback in the widgets' stylesheets — the DEFAULT of that token. */
function defaultsOf(token: string): Set<string> {
  const re = new RegExp(`var\\(\\s*${token}\\s*,\\s*(#[0-9a-fA-F]{6})\\s*\\)`, "g");
  const found = new Set<string>();
  for (const [, ctor] of luWidgets)
    for (const m of css(ctor).matchAll(re)) found.add((m[1] ?? "").toLowerCase());
  return found;
}
/** The one default a token has across every widget — or fail loudly if they disagree. */
function defaultOf(token: string): string {
  const all = [...defaultsOf(token)];
  expect(all, `${token} must have exactly one default colour across the widgets`).toHaveLength(1);
  return all[0] as string;
}

// ── The opacity / alpha scan ────────────────────────────────────────────────────────────────
// Text must get its colour from a TOKEN a host can override to reach AA, never from a stacked
// alpha: opacity, `rgba()`/`hsla()`/slash-alpha colours, `color-mix(... transparent)`, 8/4-digit
// hex, and the `opacity=` / `fill-opacity=` attributes of an SVG template.

/** Properties that paint TEXT (HTML `color`, SVG text's `fill`). */
const TEXT_PROPS = /^(color|fill|-webkit-text-fill-color|text-decoration-color|caret-color)$/;
const ALPHA_COLOUR =
  /\b(?:rgba|hsla)\s*\(|\b(?:rgb|hsl)\s*\([^)]*\/|color-mix\s*\(|transparent|#[0-9a-f]{8}\b|#[0-9a-f]{4}\b/i;

/** Declarations `prop: value` in a rule body. */
function declarations(body: string): Array<[string, string]> {
  return body
    .split(";")
    .map((d) => d.split(/:(.+)/s).map((x) => x?.trim() ?? ""))
    .filter(([k]) => k)
    .map(([k, v]) => [(k ?? "").toLowerCase(), v ?? ""]);
}
/** Selectors of the rules in `text` that paint TEXT with an alpha colour. */
function alphaTextColours(text: string): string[] {
  return rules(text.replace(/\s+/g, " ")).flatMap((r) =>
    declarations(r.body)
      .filter(([k, v]) => TEXT_PROPS.test(k) && ALPHA_COLOUR.test(v))
      .map(([k]) => `${r.selector} ${k}`)
  );
}
/** Every `opacity` use in source: CSS (`opacity: x`) and template attributes (`opacity=${x}`). */
function opacityUses(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const uses: string[] = [];
  for (const m of code.matchAll(/\b((?:fill-|stroke-)?opacity)\s*([=:])/g)) {
    const before = code.slice(0, m.index);
    if (m[2] === "=") {
      const tag = [...before.matchAll(/<([a-zA-Z][\w-]*)/g)].pop()?.[1] ?? "?";
      uses.push(`<${tag} ${m[1]}=>`);
    } else {
      const sel = before
        .slice(Math.max(before.lastIndexOf("}"), before.lastIndexOf("`")) + 1)
        .split("{")
        .shift()
        ?.trim();
      uses.push(`${sel} { ${m[1]}: }`);
    }
  }
  return uses;
}

/** Non-test sources of the package that can paint a widget. */
function widgetSources(): Array<[string, string]> {
  const root = join(__dirname, "..");
  const out: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name))
        out.push([f.slice(root.length + 1), readFileSync(f, "utf8")]);
    }
  };
  walk(root);
  return out;
}

/**
 * The ONLY places an opacity is allowed, each with the reason. Anything else — a new widget, a
 * new rule — fails the test until it uses a colour token instead.
 */
const OPACITY_ALLOWLIST: Readonly<Record<string, string>> = {
  "widgets/lu-locale-picker.ts select:disabled { opacity: }":
    "a disabled control is inactive UI, exempt from WCAG 1.4.3, and deliberately dimmed",
  "widgets/lu-bar-chart.ts <rect opacity=>":
    "bar-fill hover dimming: a graphic, not text (the bar's label is a separate <text>)",
};

describe("caption contrast", () => {
  it("lu-kpi .caption takes its own token, falling back to dim text, with no opacity", () => {
    const caption = rules(css(widgets.LuKpi)).find((r) => r.selector === ".caption");
    expect(caption).toBeDefined();
    expect(caption?.body).not.toMatch(/opacity/);
    expect(caption?.body).toMatch(
      /color:\s*var\(--lu-text-caption,\s*var\(--lu-text-dim,\s*#[0-9a-f]{6}\)\)/i
    );
  });

  it("the default caption colour, read from the stylesheet, meets WCAG AA (4.5:1) on the default panel", () => {
    // Both colours are DERIVED from the widgets' own defaults, so changing the default dim text
    // (or the panel) in a stylesheet moves this test with it — and fails it if AA is lost.
    const caption = rules(css(widgets.LuKpi)).find((r) => r.selector === ".caption");
    const captionDefault = (
      /#[0-9a-f]{6}(?=\)\))/i.exec(caption?.body ?? "")?.[0] ?? ""
    ).toLowerCase();
    const dim = defaultOf("--lu-text-dim");
    const panel = defaultOf("--lu-panel");
    expect(captionDefault, "the caption falls back to the dim default").toBe(dim);
    expect(contrast(captionDefault, panel)).toBeGreaterThanOrEqual(4.5);
    // ...and the old stacked value did not: .8 opacity of the dim default over the panel.
    const channel = (hex: string, i: number): number => Number.parseInt(hex.slice(i, i + 2), 16);
    const stacked = `#${[1, 3, 5]
      .map((i) =>
        Math.round(channel(dim, i) * 0.8 + channel(panel, i) * 0.2)
          .toString(16)
          .padStart(2, "0")
      )
      .join("")}`;
    expect(contrast(stacked, panel)).toBeLessThan(4.5);
  });

  it("no widget paints text with an alpha colour (rgba, hsla, slash-alpha, color-mix, 8-digit hex)", () => {
    const offenders = luWidgets.flatMap(([name, ctor]) =>
      alphaTextColours(css(ctor)).map((r) => `${name} ${r}`)
    );
    expect(offenders).toEqual([]);
    expect(luWidgets.length).toBeGreaterThan(10);
  });

  it("no source stacks an opacity over anything but the documented allowlist", () => {
    const uses = widgetSources().flatMap(([file, src]) =>
      opacityUses(src).map((u) => `${file.replace(/^.*?(widgets\/|charts\/)/, "$1")} ${u}`)
    );
    // Both ways: nothing new slips in, and a stale allowlist entry cannot linger.
    expect(uses.sort()).toEqual(Object.keys(OPACITY_ALLOWLIST).sort());
  });

  it("the scanners catch each spelling they exist for (so a clean result means something)", () => {
    for (const decl of [
      "color: rgba(1, 2, 3, 0.5)",
      "color: var(--x, rgba(1,2,3,.5))",
      "fill: hsla(10, 20%, 30%, 0.4)",
      "color: rgb(1 2 3 / 50%)",
      "color: color-mix(in srgb, red 50%, transparent)",
      "color: #11223380",
      "color: transparent",
    ])
      expect(alphaTextColours(`.t { ${decl}; }`), decl).toEqual([`.t ${decl.split(":")[0]}`]);
    // A background may be translucent: only TEXT is policed.
    expect(alphaTextColours(".t { background: rgba(1,2,3,.5); color: #112233; }")).toEqual([]);
    expect(opacityUses("css`.a { opacity: .5 }`")).toEqual([".a { opacity: }"]);
    expect(opacityUses("svg`<text fill-opacity=${x}>t</text>`")).toEqual(["<text fill-opacity=>"]);
    expect(opacityUses("svg`<text opacity=${x}>t</text>`")).toEqual(["<text opacity=>"]);
    expect(opacityUses("/* opacity: 1 */ // opacity: 2")).toEqual([]);
  });
});
