import { noChange } from "lit";
import { Directive, type ElementPart, type PartInfo, PartType, directive } from "lit/directive.js";

// ── CSP-safe inline styles ───────────────────────────────────────────────────────────────────────
// A strict Content-Security-Policy (`style-src 'self'`, no 'unsafe-inline') reports every inline
// `style` ATTRIBUTE, even an empty one, and Lit's `styleMap` commits its first render as an attribute
// string. This is an ELEMENT directive (`<div ${cssomStyle({...})}>`): it writes each property through
// the CSSOM (`style.setProperty`), which CSP permits, and never emits a `style` attribute binding.
// Keys must be kebab-case CSS property names (`background-color`) or custom properties (`--x`);
// camelCase keys (`backgroundColor`) are NOT supported and are silently ignored by `setProperty`.
// `!important` in a value is not supported either (`setProperty` would need its third argument).
// A property dropped from a later render is removed; null, undefined and "" values are skipped.

export type CssomStyle = Readonly<Record<string, string | number | undefined | null>>;

class CssomStyleDirective extends Directive {
  private prev = new Set<string>();

  constructor(info: PartInfo) {
    super(info);
    if (info.type !== PartType.ELEMENT) {
      throw new Error(
        "cssomStyle() can only be used as an element binding: <div ${cssomStyle(...)}>"
      );
    }
  }

  render(_style: CssomStyle): unknown {
    return noChange;
  }

  override update(part: ElementPart, [style]: [CssomStyle]): unknown {
    const el = part.element as HTMLElement;
    const next = new Set<string>();
    for (const [name, value] of Object.entries(style)) {
      if (value === undefined || value === null || value === "") continue;
      next.add(name);
      el.style.setProperty(name, String(value));
    }
    for (const name of this.prev) if (!next.has(name)) el.style.removeProperty(name);
    this.prev = next;
    return noChange;
  }
}

export const cssomStyle = directive(CssomStyleDirective);
