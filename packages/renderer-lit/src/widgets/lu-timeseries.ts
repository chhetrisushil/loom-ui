import type { SemanticFormat, TimeSeriesValue } from "@loom-ui/core";
import { type TemplateResult, css, html, nothing, svg } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  SERIES_COLORS,
  type Scale,
  extent,
  linePath,
  linearScale,
  niceTicks,
  padDomain,
  timeTickIndices,
} from "../charts/svg";
import { effectiveFormat, tick as formatTick, measure, timeTick } from "../format";
import { t } from "../i18n";
import { dirFor } from "../rtl";
import { hideTooltip, showTooltip } from "../tooltip";
import { LuWidget } from "./base";

// Multi-series line chart, hand-rolled SVG inside the shadow root; resizes via ResizeObserver;
// crosshair tooltip on hover. A series marked `axis: "right"` is scaled against its own domain
// and labelled on a right-hand axis — a series whose unit differs from the rest (bytes alongside
// requests, say) would otherwise flatten to a near-flat line sharing one scale; every other
// series shares the left axis. An axis's ticks read in the format of the first series drawn on
// it.
const M = { top: 12, right: 14, bottom: 22, left: 46 };
/** Right margin when a right-hand axis needs room for its tick labels. */
const RIGHT_AXIS_MARGIN = 46;

type Series = TimeSeriesValue["series"][number];

@customElement("lu-timeseries")
export class LuTimeseries extends LuWidget {
  readonly kind = "TimeSeries";

  @state() private width = 480;
  @state() private height = 240;
  @state() private hoverIndex: number | null = null;

  private ro?: ResizeObserver;

  static styles = css`
    :host {
      display: block;
      height: 100%;
      min-height: 0;
    }
    svg {
      display: block;
    }
    .axis text {
      fill: var(--lu-text-dim, #8b949e);
      font-size: 10px;
      font-family: inherit;
    }
    .grid line {
      stroke: var(--lu-grid, rgba(139, 148, 158, 0.15));
    }
    .legend {
      display: flex;
      gap: 12px;
      padding: 0 4px 2px;
      font-size: 11px;
      color: var(--lu-text-dim, #8b949e);
      flex-wrap: wrap;
    }
    .swatch {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 2px;
      margin-inline-end: 4px;
    }
    .wrap {
      position: relative;
      height: 100%;
      display: flex;
      flex-direction: column;
    }
    .chart {
      flex: 1;
      min-height: 0;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    // Pinned to `ltr` inside a mirrored page (PRD §25, behaviour "preserve"). The plot's
    // coordinates are its own: a time axis reads left-to-right in data visualisation in every
    // language, and mirroring it would make a rising trend descend — a false statement about
    // the data rather than a translation of it. The frame, title and legend around it are DOM
    // and mirror normally.
    const dir = dirFor(this.tagName);
    if (dir !== undefined) this.setAttribute("dir", dir);
    this.ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0) {
        this.width = rect.width;
        this.height = Math.max(rect.height, 120);
      }
    });
    this.ro.observe(this);
  }

  disconnectedCallback(): void {
    this.ro?.disconnect();
    hideTooltip();
    super.disconnectedCallback();
  }

  /** value format › widget props.format › the series' (or widget's) unit. */
  private formatOf(s: Series): SemanticFormat | undefined {
    const props = this.widget.props as { unit?: string; format?: SemanticFormat };
    return effectiveFormat(s.format ?? props.format, s.unit ?? props.unit);
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as TimeSeriesValue;
    const series = v.series;
    if (series.length === 0) return nothing;
    const timestamps = series[0]?.points.map((p) => p.timestamp) ?? [];
    const n = timestamps.length;
    if (n === 0) return nothing;

    const leftDeclared = series.filter((s) => s.axis !== "right");
    const rightDeclared = series.filter((s) => s.axis === "right");
    // A right axis only earns its keep when there is something left-hand to contrast it
    // against; with nothing declared left, a second scale would draw a meaningless 0-1 axis
    // over an empty left domain instead of the data every series actually holds. Fall back to
    // one shared left-axis scale, and drop the right-axis distinction (ticks, legend suffix)
    // along with it.
    const splitAxes = leftDeclared.length > 0 && rightDeclared.length > 0;
    const left = splitAxes ? leftDeclared : series;
    const right = splitAxes ? rightDeclared : [];
    const onRight = (s: Series): boolean => splitAxes && s.axis === "right";
    const w = this.width;
    const h = Math.max(this.height - (series.length > 1 ? 22 : 0), 100);
    const innerW = w - M.left - (right.length > 0 ? RIGHT_AXIS_MARGIN : M.right);
    const innerH = h - M.top - M.bottom;
    const sx = linearScale([0, n - 1], [M.left, M.left + innerW]);

    const leftDomain = padDomain(extent(left.flatMap((s) => s.points.map((p) => p.value))));
    const rightDomain = padDomain(extent(right.flatMap((s) => s.points.map((p) => p.value))));
    const syL = linearScale(leftDomain, [M.top + innerH, M.top]);
    const syR = linearScale(rightDomain, [M.top + innerH, M.top]);
    const yOf = (s: Series): Scale => (onRight(s) ? syR : syL);

    const first = timestamps[0] ?? "";
    const last = timestamps[n - 1] ?? "";
    const spanMs = new Date(last).getTime() - new Date(first).getTime() || 86_400_000;
    const xTicks = timeTickIndices(n, Math.max(3, Math.min(6, Math.floor(innerW / 80))));
    const yTicks = niceTicks(leftDomain[0], leftDomain[1], 4);
    const yTicksR = right.length > 0 ? niceTicks(rightDomain[0], rightDomain[1], 4) : [];
    const axisFormat = (side: "left" | "right"): SemanticFormat | undefined => {
      const s = series.find((x) => (onRight(x) ? "right" : "left") === side);
      return s === undefined ? undefined : this.formatOf(s);
    };
    const fmtL = axisFormat("left");
    const fmtR = axisFormat("right");

    const colorFor = (i: number): string => SERIES_COLORS[i % SERIES_COLORS.length]!;
    const hover = this.hoverIndex;

    return html`<div class="wrap">
      ${
        series.length > 1
          ? html`<div class="legend">
              ${series.map(
                (s, i) =>
                  html`<span
                    ><span class="swatch" style="background:${colorFor(i)}"></span
                    >${s.label}${onRight(s) ? ` (${t("R")})` : ""}</span
                  >`
              )}
            </div>`
          : nothing
      }
      <div class="chart">
        <svg
          role="img"
          aria-label=${this.label()}
          width=${w}
          height=${h}
          @pointermove=${(e: PointerEvent) => this.onMove(e, sx, n, series, colorFor, timestamps)}
          @pointerleave=${() => {
            this.hoverIndex = null;
            hideTooltip();
          }}
        >
          <g class="grid">
            ${yTicks.map(
              (v) => svg`<line x1=${M.left} x2=${M.left + innerW} y1=${syL(v)} y2=${syL(v)} />`
            )}
          </g>
          <g class="axis">
            ${yTicks.map(
              (v) =>
                svg`<text x=${M.left - 6} y=${syL(v) + 3} text-anchor="end">${formatTick(v, fmtL)}</text>`
            )}
            ${yTicksR.map(
              (v) =>
                svg`<text x=${M.left + innerW + 6} y=${syR(v) + 3} text-anchor="start">${formatTick(v, fmtR)}</text>`
            )}
            ${xTicks.map(
              (i) =>
                svg`<text x=${sx(i)} y=${M.top + innerH + 14} text-anchor="middle">${timeTick(timestamps[i] ?? "", spanMs)}</text>`
            )}
          </g>
          ${series.map((s, i) => {
            const sy = yOf(s);
            const pts = s.points.map((p, j) => ({ x: sx(j), y: sy(p.value) }));
            return svg`<path class="series" d=${linePath(pts)} fill="none" stroke=${colorFor(i)}
              stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`;
          })}
          ${
            hover !== null && hover < n
              ? svg`
                <line x1=${sx(hover)} x2=${sx(hover)} y1=${M.top} y2=${M.top + innerH}
                  stroke="var(--lu-text-dim, #8b949e)" stroke-dasharray="3,3" stroke-width="1"/>
                ${series.map((s, i) => {
                  const p = s.points[hover];
                  return p
                    ? svg`<circle cx=${sx(hover)} cy=${yOf(s)(p.value)} r="3.5" fill=${colorFor(i)} />`
                    : nothing;
                })}`
              : nothing
          }
        </svg>
      </div>
    </div>`;
  }

  private onMove(
    e: PointerEvent,
    sx: (v: number) => number,
    n: number,
    series: TimeSeriesValue["series"],
    colorFor: (i: number) => string,
    timestamps: string[]
  ): void {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = (x - sx(0)) / (sx(n - 1) - sx(0) || 1);
    const hover = Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    this.hoverIndex = hover;
    // Portal tooltip so it's never clipped by the widget/scroll container.
    const rows = series
      .map((s, i) => {
        const fmt = this.formatOf(s);
        const v = s.points[hover]?.value ?? 0;
        const suffix = fmt === undefined && s.unit ? ` ${escapeHtml(s.unit)}` : "";
        return `<div style="color:${colorFor(i)}">${escapeHtml(s.label)}: ${escapeHtml(
          measure(v, fmt)
        )}${suffix}</div>`;
      })
      .join("");
    showTooltip(
      `<div style="margin-bottom:2px;color:var(--lu-text-dim,#8b949e)">${escapeHtml(timeTick(timestamps[hover] ?? "", 1e12))}</div>${rows}`,
      rect.left + sx(hover),
      rect.top + M.top,
      { html: true }
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c
  );
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-timeseries": LuTimeseries;
  }
}
