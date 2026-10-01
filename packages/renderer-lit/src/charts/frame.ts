import { css } from "lit";

/**
 * The box a chart widget draws into — shared so `lu-timeseries` and `lu-bar-chart` cannot differ.
 *
 * A chart measures its own host with a `ResizeObserver` and draws an SVG of exactly that size. In
 * a box with a DEFINITE height (a grid cell) that settles at once. In an AUTO-height box (a flex
 * column, a stack) the host's height IS its content's, so the SVG it just drew became the size it
 * measured next: any extra pixel of in-flow content (an inline SVG's baseline gap, a wrapped
 * legend) fed back as `height = measured + gap` on every tick, and the chart grew without bound.
 *
 * Two rules end that. The plot is taken OUT OF FLOW (`position: absolute`), so what it draws can
 * never change what it measures; and the host gets a block size of its own when its container
 * gives none — `aspect-ratio` from its width, floored by `min-height`. Both only apply while
 * `height: 100%` has nothing definite to resolve against: a definite-height cell still wins.
 *
 * `width: 100%` for the same reason: with the plot out of flow the host has no intrinsic width,
 * so in a flex row it would otherwise collapse to nothing and never be measured.
 *
 * Tunable by a host through two custom properties:
 * - `--lu-chart-aspect`: width / height used when the container has no definite height (default 16 / 9)
 * - `--lu-chart-min-height`: the smallest block size a chart is drawn at (default 120px)
 */
export const chartHostStyles = css`
  :host {
    display: block;
    position: relative;
    box-sizing: border-box; /* width: 100% + a host's padding/border must not overflow */
    width: 100%;
    height: 100%;
    min-height: var(--lu-chart-min-height, 120px);
    aspect-ratio: var(--lu-chart-aspect, 16 / 9);
  }
`;
