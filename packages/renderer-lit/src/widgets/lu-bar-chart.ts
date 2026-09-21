import type { BarChartValue } from "@loom-ui/core";
import { type TemplateResult, css, html, nothing, svg } from "lit";
import { customElement, state } from "lit/decorators.js";
import { SERIES_COLORS, linearScale, niceTicks } from "../charts/svg";
import { effectiveFormat, tick as formatTick, measure } from "../format";
import { dirFor } from "../rtl";
import { LuWidget } from "./base";

const M = { top: 10, right: 12, bottom: 24, left: 46 };

@customElement("lu-bar-chart")
export class LuBarChart extends LuWidget {
  readonly kind = "BarChart";

  @state() private width = 320;
  @state() private height = 200;
  @state() private hover: number | null = null;

  private ro?: ResizeObserver;

  static styles = css`
    :host {
      display: block;
      height: 100%;
      min-height: 0;
    }
    text {
      fill: var(--gx-text-dim, #8b949e);
      font-size: 10px;
      font-family: inherit;
    }
    .grid line {
      stroke: var(--gx-grid, rgba(139, 148, 158, 0.15));
    }
    .val {
      fill: var(--gx-text, #e6edf3);
      font-size: 10px;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    // Pinned to `ltr` inside a mirrored page (PRD §25, behaviour "preserve") — see lu-timeseries
    // for why a plot's own coordinates must not mirror with the surrounding text.
    const dir = dirFor(this.tagName);
    if (dir !== undefined) this.setAttribute("dir", dir);
    this.ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0) {
        this.width = rect.width;
        this.height = Math.max(rect.height, 110);
      }
    });
    this.ro.observe(this);
  }

  disconnectedCallback(): void {
    this.ro?.disconnect();
    super.disconnectedCallback();
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as BarChartValue;
    const bars = v.bars;
    if (bars.length === 0) return nothing;
    const fmt = effectiveFormat(undefined, v.unit);
    const w = this.width;
    const h = this.height;
    const innerW = w - M.left - M.right;
    const innerH = h - M.top - M.bottom;
    // Finite values only. A single Infinite bar — a reshape script dividing by a count that
    // was zero — otherwise becomes the axis maximum, scaling every real bar to zero height and
    // putting NaN into the gridline geometry.
    const maxV = Math.max(...bars.filter((b) => Number.isFinite(b.value)).map((b) => b.value), 0);
    const sy = linearScale([0, maxV * 1.08 || 1], [M.top + innerH, M.top]);
    const ticks = niceTicks(0, maxV * 1.08 || 1, 4);
    const band = innerW / bars.length;
    const barW = Math.min(band * 0.62, 64);

    return html`<svg
      role="img"
      aria-label=${this.label()}
      width=${w}
      height=${h}
      @pointerleave=${() => {
        this.hover = null;
      }}
    >
      <g class="grid">
        ${ticks.map(
          (t) => svg`<line x1=${M.left} x2=${M.left + innerW} y1=${sy(t)} y2=${sy(t)} />`
        )}
      </g>
      ${ticks.map(
        (t) =>
          svg`<text x=${M.left - 6} y=${sy(t) + 3} text-anchor="end">${formatTick(t, fmt)}</text>`
      )}
      ${bars.map((b, i) => {
        // A value that cannot be plotted gets no bar. The category keeps its axis label, so
        // the gap is visible as missing data rather than as a bar of some invented height.
        if (!Number.isFinite(b.value)) return nothing;
        const x = M.left + band * i + (band - barW) / 2;
        const y = sy(b.value);
        const color = SERIES_COLORS[i % SERIES_COLORS.length]!;
        return svg`
          <rect class="bar" x=${x} y=${y} width=${barW} height=${Math.max(M.top + innerH - y, 0)}
            rx="3" fill=${color}
            opacity=${this.hover === null || this.hover === i ? 0.95 : 0.45}
            @pointerenter=${() => {
              this.hover = i;
            }} />
          ${
            this.hover === i
              ? svg`<text class="val" x=${x + barW / 2} y=${y - 4} text-anchor="middle">${measure(b.value, fmt)}${fmt === undefined && v.unit ? ` ${v.unit}` : ""}</text>`
              : nothing
          }
          <text x=${x + barW / 2} y=${M.top + innerH + 14} text-anchor="middle">${b.label.slice(0, Math.max(4, Math.floor(band / 7)))}</text>`;
      })}
    </svg>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-bar-chart": LuBarChart;
  }
}
