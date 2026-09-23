import type { KpiValue } from "@loom-ui/core";
import { type TemplateResult, css, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { DELTA_FORMAT, type SemanticFormat, effectiveFormat, measure } from "../format";
import { LuWidget } from "./base";

// A value in its own semantics, a ▲/▼ change badge, and the value's own label (the widget
// title when it has none) — richer than loom's MetricCard, which stays a bare number.
@customElement("lu-kpi")
export class LuKpi extends LuWidget {
  readonly kind = "Kpi";

  static styles = css`
    :host {
      display: flex;
      height: 100%;
      flex-direction: column;
      justify-content: center;
      padding: 4px 10px;
      box-sizing: border-box;
    }
    .value {
      font-size: clamp(22px, 4.2cqw, 40px);
      font-weight: 650;
      color: var(--gx-text, #e6edf3);
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    .unit {
      font-size: 13px;
      color: var(--gx-text-dim, #8b949e);
      margin-inline-start: 6px;
    }
    .delta {
      display: inline-block;
      margin-inline-start: 10px;
      font-size: 12px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 999px;
    }
    .up {
      color: #4ade80;
      background: rgba(74, 222, 128, 0.12);
    }
    .down {
      color: #f87171;
      background: rgba(248, 113, 113, 0.12);
    }
    .label {
      font-size: 12px;
      color: var(--gx-text-dim, #8b949e);
      margin-top: 2px;
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as KpiValue;
    const props = this.widget.props as { unit?: string; format?: SemanticFormat };
    const unit = v.unit ?? props.unit;
    const fmt = effectiveFormat(v.format ?? props.format, unit);
    // A currency/percent format renders its own symbol; the unit suffix would double it.
    const suffix = fmt === undefined ? unit : undefined;
    const delta = v.deltaPct ?? null;
    const direction = delta !== null && delta >= 0 ? "up" : "down";
    return html`<div aria-hidden="true">
        <span class="value">${measure(v.value, fmt)}</span>
        ${suffix ? html`<span class="unit">${suffix}</span>` : nothing}
        ${
          delta !== null
            ? html`<span class="delta ${direction}" data-direction=${direction}
                >${direction === "up" ? "▲" : "▼"} ${measure(Math.abs(delta), DELTA_FORMAT)}</span
              >`
            : nothing
        }
      </div>
      <div class="label">${v.label ?? this.title_}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-kpi": LuKpi;
  }
}
