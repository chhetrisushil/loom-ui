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
  return stripCssComments(flat(s));
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

// ── Source scanning primitives ──────────────────────────────────────────────────────────────
// Everything below is string-aware: a quote opens a string that a `/*`, `//` or a backtick inside
// it cannot escape from, and templates nest (`html`..${cond ? html`..` : nothing}..``).

/** Index just past the closing quote of the string literal starting at `i`. */
function skipQuoted(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q) j += src[j] === "\\" ? 2 : 1;
  return j + 1;
}
/** Index just past the `}` closing the `${` expression whose body starts at `j`. */
function skipExpr(src: string, from: number): number {
  let j = from;
  let depth = 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") j = skipQuoted(src, j);
    else if (c === "`") j = skipTemplate(src, j);
    else {
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return j + 1;
      j++;
    }
  }
  return j;
}
/** Index just past the closing backtick of the template starting at `i`. */
function skipTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length && src[j] !== "`") {
    if (src[j] === "\\") j += 2;
    else if (src[j] === "$" && src[j + 1] === "{") j = skipExpr(src, j + 2);
    else j++;
  }
  return j + 1;
}

/** TS source minus its `//` and `/* *\/` comments — never inside a string or a template. */
function stripTsComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const j = skipQuoted(src, i);
      out += src.slice(i, j);
      i = j;
    } else if (c === "`") {
      const j = skipTemplate(src, i);
      out += src.slice(i, j);
      i = j;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** CSS minus its `/* *\/` comments (CSS has no `//`), never inside a quoted string. */
function stripCssComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const j = skipQuoted(text, i);
      out += text.slice(i, j);
      i = j;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

interface Template {
  readonly tag: "css" | "html" | "svg";
  /** The static text; every `${…}` is replaced by a `__E__` placeholder. */
  readonly text: string;
}
/** Every `css`/`html`/`svg` tagged template in `src` (comments already stripped), nested ones too. */
function taggedTemplates(src: string, out: Template[] = []): Template[] {
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipQuoted(src, i);
    } else if (c === "`") {
      const tag = /(?<![\w$.])(css|html|svg)$/.exec(src.slice(Math.max(0, i - 4), i))?.[1];
      let text = "";
      let j = i + 1;
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\") {
          text += src.slice(j, j + 2);
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "{") {
          const end = skipExpr(src, j + 2);
          taggedTemplates(src.slice(j + 2, end - 1), out); // a nested template is its own unit
          text += "__E__";
          j = end;
        } else text += src[j++];
      }
      if (tag !== undefined) out.push({ tag: tag as Template["tag"], text });
      i = j + 1;
    } else i++;
  }
  return out;
}

/** `value` with every `url(...)` body emptied: ids like `#abcd` and data URIs are not colours. */
function withoutUrls(value: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const m = /url\(/i.exec(value.slice(i));
    if (!m) return out + value.slice(i);
    const open = i + m.index + m[0].length;
    out += `${value.slice(i, open)})`;
    let depth = 1;
    let j = open;
    while (j < value.length && depth > 0) {
      if (value[j] === '"' || value[j] === "'") j = skipQuoted(value, j);
      else {
        if (value[j] === "(") depth++;
        else if (value[j] === ")") depth--;
        j++;
      }
    }
    i = j;
  }
}
/** Every `fn(args)` call in a CSS value, nested ones included (balanced parentheses). */
function cssCalls(value: string): Array<{ name: string; args: string }> {
  const calls: Array<{ name: string; args: string }> = [];
  for (const m of value.matchAll(/([a-z-]+)\(/gi)) {
    let depth = 1;
    let j = (m.index ?? 0) + m[0].length;
    const start = j;
    while (j < value.length && depth > 0) {
      if (value[j] === "(") depth++;
      else if (value[j] === ")") depth--;
      j++;
    }
    calls.push({ name: (m[1] ?? "").toLowerCase(), args: value.slice(start, j - 1) });
  }
  return calls;
}
/** Does `args` have a `/` outside any nested parentheses — the alpha separator of `rgb(r g b / a)`? */
function hasTopLevelSlash(args: string): boolean {
  let depth = 0;
  for (const c of args) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "/" && depth === 0) return true;
  }
  return false;
}

// ── The opacity / alpha scan ────────────────────────────────────────────────────────────────
// Text must get its colour from a TOKEN a host can override to reach AA, never from a stacked
// alpha: opacity, `rgba()`/`hsla()`/slash-alpha colours (nested parentheses included),
// `color-mix()` that mixes with `transparent` or an alpha colour (an OPAQUE mix is fine), 8/4-digit
// hex, and the `opacity=` / `fill-opacity=` attributes of an SVG template. Only CSS and template
// attributes are scanned — a TS object literal's `{ opacity: 1 }` is not styling.

/** Properties that paint TEXT. `fill`/`stroke` do so only on a text-bearing SVG element. */
const TEXT_PROPS = new Set([
  "color",
  "fill",
  "stroke",
  "-webkit-text-fill-color",
  "text-decoration-color",
  "caret-color",
]);
const ALPHA_FNS = new Set(["rgb", "hsl", "hwb", "lab", "lch", "oklab", "oklch", "color"]);

/** Does any comma-separated selector end in a text-bearing SVG element (`text`, `tspan`)? */
function targetsSvgText(selector: string): boolean {
  return selector.split(",").some((sel) => {
    const compound =
      sel
        .trim()
        .split(/[\s>+~]+/)
        .pop() ?? "";
    return /^(?:text|tspan)(?![\w-])/i.test(compound);
  });
}

/** Can `value`, painted via `prop`, be translucent? (`prop` is already known to paint text.) */
function isTranslucent(prop: string, value: string): boolean {
  const v = withoutUrls(value);
  for (const { name, args } of cssCalls(v)) {
    if (name === "rgba" || name === "hsla") return true;
    if (ALPHA_FNS.has(name) && hasTopLevelSlash(args)) return true;
    // color-mix is translucent only if a mixed colour is: `transparent` here, or an alpha colour
    // (caught by the checks above/below, since cssCalls and the hex test see inside it).
    if (name === "color-mix" && /\btransparent\b/i.test(args)) return true;
  }
  if (/#[0-9a-f]{8}\b|#[0-9a-f]{4}\b/i.test(v)) return true;
  // `transparent` is a legitimate text paint for gradient text (`-webkit-text-fill-color`, the
  // text is painted by the background clip); anywhere else it hides the text.
  return /\btransparent\b/i.test(v) && prop !== "-webkit-text-fill-color";
}

/** Declarations `prop: value` in a rule body. */
function declarations(body: string): Array<[string, string]> {
  return body
    .split(";")
    .map((d) => d.split(/:(.+)/s).map((x) => x?.trim() ?? ""))
    .filter(([k]) => k)
    .map(([k, v]) => [(k ?? "").toLowerCase(), v ?? ""]);
}
/** Selectors of the rules in `text` that paint TEXT with a translucent colour. */
function alphaTextColours(text: string): string[] {
  return rules(withoutUrlsEverywhere(stripCssComments(text)).replace(/\s+/g, " ")).flatMap((r) =>
    declarations(r.body)
      .filter(
        ([k, v]) =>
          TEXT_PROPS.has(k) &&
          // fill/stroke paint text only on a text-bearing SVG element; anywhere else they are
          // shapes (a grid line's stroke may be translucent).
          (k !== "fill" && k !== "stroke" ? true : targetsSvgText(r.selector)) &&
          isTranslucent(k, v)
      )
      .map(([k]) => `${r.selector} ${k}`)
  );
}
/** A whole stylesheet with every `url(...)` body emptied (so a `;` inside a data URI cannot split a declaration). */
const withoutUrlsEverywhere = withoutUrls;

/** Every `opacity` use in source: CSS (`opacity: x`) and template attributes (`opacity=${x}`). */
function opacityUses(source: string): string[] {
  const uses: string[] = [];
  for (const tpl of taggedTemplates(stripTsComments(source))) {
    const text =
      tpl.tag === "css" ? stripCssComments(tpl.text) : tpl.text.replace(/<!--[\s\S]*?-->/g, "");
    // `(?<![\w-])`: a custom property DEFINITION such as `--hover-opacity: .5` is a token, not a use.
    for (const m of text.matchAll(/(?<![\w-])((?:fill-|stroke-)?opacity)\s*([=:])/g)) {
      const before = text.slice(0, m.index);
      if (m[2] === "=") {
        const tag = [...before.matchAll(/<([a-zA-Z][\w-]*)/g)].pop()?.[1] ?? "?";
        uses.push(`<${tag} ${m[1]}=>`);
      } else {
        const sel = before
          .slice(before.lastIndexOf("}") + 1)
          .split("{")
          .shift()
          ?.trim();
        uses.push(`${sel} { ${m[1]}: }`);
      }
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
      "color: #abcd",
      "color: transparent",
    ]) {
      const [prop] = decl.split(":");
      const sel = prop === "fill" ? "text" : ".t";
      expect(alphaTextColours(`${sel} { ${decl}; }`), decl).toEqual([`${sel} ${prop}`]);
    }
    // A background may be translucent: only TEXT is policed.
    expect(alphaTextColours(".t { background: rgba(1,2,3,.5); color: #112233; }")).toEqual([]);
    expect(opacityUses("css`.a { opacity: .5 }`")).toEqual([".a { opacity: }"]);
    expect(opacityUses("svg`<text fill-opacity=${x}>t</text>`")).toEqual(["<text fill-opacity=>"]);
    expect(opacityUses("svg`<text opacity=${x}>t</text>`")).toEqual(["<text opacity=>"]);
    expect(opacityUses("/* opacity: 1 */ // opacity: 2")).toEqual([]);
  });

  describe("color-mix: flagged only when it can produce transparency", () => {
    it("flags a mix with transparent or with an alpha colour", () => {
      for (const v of [
        "color-mix(in srgb, red 50%, transparent)",
        "color-mix(in srgb, transparent, red)",
        "color-mix(in srgb, rgba(1,2,3,.5), red)",
        "color-mix(in srgb, rgb(1 2 3 / 50%), red)",
        "color-mix(in srgb, #11223380, red)",
        "color-mix(in srgb, var(--a) 40%, color-mix(in srgb, red, transparent))",
      ])
        expect(alphaTextColours(`.t { color: ${v}; }`), v).toEqual([".t color"]);
    });
    it("does not flag an opaque mix", () => {
      for (const v of [
        "color-mix(in srgb, red 50%, blue)",
        "color-mix(in srgb, var(--a) 40%, var(--b))",
        "color-mix(in oklab, #112233, #445566)",
        "color-mix(in srgb, var(--a, #fff), color-mix(in srgb, red, blue))",
      ])
        expect(alphaTextColours(`.t { color: ${v}; }`), v).toEqual([]);
    });
  });

  describe("transparent: only a `color` it can hide", () => {
    it("is allowed for gradient text and for non-text properties", () => {
      expect(alphaTextColours(".g { -webkit-text-fill-color: transparent; }")).toEqual([]);
      expect(alphaTextColours(".g { background: transparent; }")).toEqual([]);
      expect(alphaTextColours("rect { fill: transparent; }")).toEqual([]);
    });
    it("is flagged for `color` and for the fill of an SVG text", () => {
      expect(alphaTextColours(".g { color: transparent; }")).toEqual([".g color"]);
      expect(alphaTextColours("text { fill: transparent; }")).toEqual(["text fill"]);
    });
    it("gradient text is not a loophole for a translucent fill colour", () => {
      expect(alphaTextColours(".g { -webkit-text-fill-color: rgba(1,2,3,.5); }")).toEqual([
        ".g -webkit-text-fill-color",
      ]);
    });
  });

  describe("fill and stroke: only on text-bearing SVG elements", () => {
    it("ignores shapes, gridlines and look-alike selectors", () => {
      for (const sel of ["rect", ".grid line", "path.area", ".context", "textarea", "text-box"])
        for (const prop of ["fill", "stroke"])
          expect(
            alphaTextColours(`${sel} { ${prop}: rgba(1,2,3,.15); }`),
            `${sel} ${prop}`
          ).toEqual([]);
    });
    it("flags text and tspan, however nested or listed", () => {
      for (const sel of ["text", ".axis text", "svg > text.tick", "g tspan", ".a rect, .b text"])
        for (const prop of ["fill", "stroke"])
          expect(
            alphaTextColours(`${sel} { ${prop}: rgba(1,2,3,.15); }`),
            `${sel} ${prop}`
          ).toEqual([`${sel} ${prop}`]);
    });
    it("`color` is policed on every selector", () => {
      expect(alphaTextColours("rect { color: rgba(1,2,3,.5); }")).toEqual(["rect color"]);
    });
  });

  describe("url(#id) is a reference, not a colour", () => {
    it("does not read an id, or a data URI, as hex or alpha", () => {
      expect(alphaTextColours("text { fill: url(#abcd); }")).toEqual([]);
      expect(alphaTextColours("text { fill: url(#abcd1234); }")).toEqual([]);
      expect(alphaTextColours('text { fill: url("#abcd") #123456; }')).toEqual([]);
      expect(
        alphaTextColours(".t { color: #123456; background: url(data:image/png;base64,AAAA); }")
      ).toEqual([]);
    });
    it("still reads a real 4/8-digit hex beside one", () => {
      expect(alphaTextColours("text { fill: url(#abcd) #abcd; }")).toEqual(["text fill"]);
    });
  });

  describe("nested parentheses: rgb(var(--x) / 50%)", () => {
    it("flags a slash-alpha colour whose channels contain a function", () => {
      expect(alphaTextColours(".t { color: rgb(var(--x) / 50%); }")).toEqual([".t color"]);
      expect(
        alphaTextColours(".t { color: hsl(var(--h) var(--s) var(--l) / var(--a, .5)); }")
      ).toEqual([".t color"]);
      expect(alphaTextColours(".t { color: var(--c, rgb(var(--x) / 50%)); }")).toEqual([
        ".t color",
      ]);
    });
    it("does not flag an opaque colour or a slash that is not the alpha separator", () => {
      expect(alphaTextColours(".t { color: rgb(var(--x)); }")).toEqual([]);
      expect(alphaTextColours(".t { color: rgb(1 2 3); }")).toEqual([]);
      expect(alphaTextColours(".t { color: rgb(calc(10 / 2) 1 2); }")).toEqual([]);
    });
  });

  describe("opacity: only CSS and template attributes", () => {
    it("ignores a custom-property definition, but not its use", () => {
      expect(opacityUses("css`.a { --lu-hover-opacity: .5; --fill-opacity: 1 }`")).toEqual([]);
      expect(opacityUses("css`.a { opacity: var(--lu-hover-opacity) }`")).toEqual([
        ".a { opacity: }",
      ]);
    });
    it("ignores non-CSS TS object literals and expressions inside a template", () => {
      expect(
        opacityUses("const o = { opacity: 0.5, 'fill-opacity': 1, strokeOpacity: 1 };")
      ).toEqual([]);
      expect(opacityUses("function f() { return { opacity: 1 }; }")).toEqual([]);
      expect(opacityUses("html`<p>${{ opacity: 1 }}</p>`")).toEqual([]);
      expect(opacityUses("html`<p>${call({ opacity: 1 })}</p>`")).toEqual([]);
    });
    it("finds an opacity in a template nested inside an expression", () => {
      expect(opacityUses("html`<g>${c ? svg`<rect opacity=${o}/>` : nothing}</g>`")).toEqual([
        "<rect opacity=>",
      ]);
    });
    it("finds the CSS and attribute spellings", () => {
      expect(opacityUses("css`select:disabled { opacity: .65 }`")).toEqual([
        "select:disabled { opacity: }",
      ]);
      expect(opacityUses('svg`<rect fill-opacity=${o} stroke-opacity="1"/>`')).toEqual([
        "<rect fill-opacity=>",
        "<rect stroke-opacity=>",
      ]);
    });
  });

  describe("the comment stripper is string-aware", () => {
    it("a `/*` or `//` inside a string does not start a comment (so nothing after it is lost)", () => {
      expect(
        opacityUses('css`.a { content: "/*"; opacity: .5 } .b { color: red } /* real */`')
      ).toEqual([".a { opacity: }"]);
      expect(opacityUses('css`.a { background: url("http://x/a.png"); opacity: .5 }`')).toEqual([
        ".a { opacity: }",
      ]);
      expect(opacityUses('const u = "http://a.b"; css`.a { opacity: .5 }`')).toEqual([
        ".a { opacity: }",
      ]);
      expect(opacityUses('const s = "// not a comment"; css`.a { opacity: .5 }`')).toEqual([
        ".a { opacity: }",
      ]);
      expect(opacityUses("const s = '/*'; css`.a { opacity: .5 }`; const t = '*/';")).toEqual([
        ".a { opacity: }",
      ]);
    });
    it("a real comment still hides what it contains", () => {
      expect(opacityUses("/* css`.a { opacity: .5 }` */")).toEqual([]);
      expect(opacityUses("// css`.a { opacity: .5 }`")).toEqual([]);
      expect(opacityUses("css`.a { /* opacity: .5 */ color: red }`")).toEqual([]);
      expect(opacityUses("css`.a { content: '*/'; /* x */ opacity: .5 }`")).toEqual([
        ".a { opacity: }",
      ]);
    });
    it("strips a CSS comment before the colour scan, but not a `/*` inside a string", () => {
      expect(alphaTextColours(".t { /* color: rgba(1,2,3,.5) */ color: #112233; }")).toEqual([]);
      expect(alphaTextColours('.t::after { content: "/*"; color: rgba(1,2,3,.5); }')).toEqual([
        ".t::after color",
      ]);
    });
  });
});
