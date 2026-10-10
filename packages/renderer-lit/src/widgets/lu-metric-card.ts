import { type TemplateResult, css, html, nothing } from "lit";
import { type SemanticFormat, effectiveFormat, measure, unitSuffix } from "../format";
import { LuWidget } from "./base";

export class LuMetricCard extends LuWidget {
  readonly kind = "MetricCard";

  static styles = css`
    :host {
      display: flex;
      height: 100%;
      align-items: center;
      padding: 4px 10px;
      box-sizing: border-box;
    }
    .value {
      font-size: clamp(22px, 4.2cqw, 40px);
      font-weight: 650;
      color: var(--lu-text, #e6edf3);
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    .unit {
      font-size: 13px;
      color: var(--lu-text-dim, #8b949e);
      margin-inline-start: 6px;
    }
    .label {
      font-size: 12px;
      color: var(--lu-text-dim, #8b949e);
      margin-top: 2px;
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as number;
    const props = this.widget.props as { unit?: string; format?: SemanticFormat };
    const fmt = effectiveFormat(props.format, props.unit);
    // A currency/percent format already renders its own symbol, so the `unit` suffix would
    // double it up ("$1,234.50 $"); any other format keeps the unit beside the figure.
    const suffix = unitSuffix(fmt, props.unit);
    return html`<div aria-hidden="true">
        <span class="value">${measure(v, fmt)}</span>
        ${suffix ? html`<span class="unit">${suffix}</span>` : nothing}
      </div>
      ${this.visibleTitle === undefined ? nothing : html`<div class="label">${this.visibleTitle}</div>`}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-metric-card": LuMetricCard;
  }
}
