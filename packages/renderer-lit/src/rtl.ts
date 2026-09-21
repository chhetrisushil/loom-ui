import { formattingLocale, isRtl as isRtlLanguage } from "./i18n";

// ── Which way a widget faces ─────────────────────────────────────────────────
//
// PRD §25. The layout mirrors for Arabic and Hebrew without a second Blueprint:
// the CSS is written with LOGICAL properties (inline-start/end rather than
// left/right), so the browser mirrors it from `dir` alone and nothing in the
// artifact mentions a direction at all.
//
// That covers the DOM. It does not cover SVG, which has no reading direction and
// is laid out in its own coordinate system — so a chart has to say what it wants,
// which is what the behaviours below are for.

/** What a component does when the reader's language runs right-to-left. */
export type RtlBehavior =
  /** Flip with the text. The default, and what logical CSS gives for free. */
  | "mirror"
  /** Keep its own orientation regardless of the surrounding direction. */
  | "preserve"
  /** Mirrors in part; the component decides which parts. */
  | "custom";

/**
 * Per-component behaviour.
 *
 * The charts PRESERVE, and the reason is worth stating because "mirror
 * everything" is the obvious wrong answer. A time axis reads left-to-right in
 * data visualisation across languages — RTL publications print time series the
 * same way — and mirroring one makes a rising trend descend. That is not a
 * localization improvement, it is a false statement about the data.
 *
 * Their surroundings still mirror: the title, the legend, the widget frame, the
 * grid are all DOM, so the chart sits on the correct side of a mirrored page
 * while the plot itself keeps meaning what it says.
 */
export const RTL_BEHAVIOR: Record<string, RtlBehavior> = {
  "gx-timeseries": "preserve",
  "gx-bar-chart": "preserve",
  "gx-sparkline": "preserve",
  // Everything else is text and boxes, and mirrors.
};

export function rtlBehaviorOf(tagName: string): RtlBehavior {
  return RTL_BEHAVIOR[tagName.toLowerCase()] ?? "mirror";
}

/** Is the reader's language right-to-left? Read live — the picker can change it. */
export function isRtl(): boolean {
  return isRtlLanguage(formattingLocale());
}

/**
 * The `dir` a component should carry, or `undefined` to inherit.
 *
 * A "preserve" component pins itself to `ltr` so its internal coordinates keep
 * their meaning inside a mirrored page; everything else inherits and flips.
 */
export function dirFor(tagName: string): "ltr" | undefined {
  return rtlBehaviorOf(tagName) === "preserve" && isRtl() ? "ltr" : undefined;
}
