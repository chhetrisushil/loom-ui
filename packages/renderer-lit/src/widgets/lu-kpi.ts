import { DELTA_FORMAT, type KpiValue, deltaDirection, unitSuffix } from "@loom-ui/core/browser";
import { type TemplateResult, css, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { type SemanticFormat, effectiveFormat, measure } from "../format";
import { LuWidget } from "./base";

// A value in its own semantics, a ▲/▼ change badge (none when flat), and the widget title with
// the value's own label as a caption beside it — richer than loom's MetricCard, which stays a
// bare number.
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
      color: var(--lu-text, #e6edf3);
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    .unit {
      font-size: 13px;
      color: var(--lu-text-dim, #8b949e);
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
      color: var(--lu-delta-up, #4ade80);
      background: var(--lu-delta-up-bg, rgba(74, 222, 128, 0.12));
    }
    .down {
      color: var(--lu-delta-down, #f87171);
      background: var(--lu-delta-down-bg, rgba(248, 113, 113, 0.12));
    }
    .flat {
      color: var(--lu-delta-flat, #8b949e);
      background: var(--lu-delta-flat-bg, rgba(139, 148, 158, 0.12));
    }
    .label {
      font-size: 12px;
      color: var(--lu-text-dim, #8b949e);
      margin-top: 2px;
    }
    /* A colour of its own, never an opacity over the dim token: opacity stacks on top of
       --lu-text-dim, so a host could not lift the caption to AA without lifting ALL dim text.
       Defaults to the dim token, which passes AA on the default panel (4.5:1+). */
    .caption {
      margin-inline-start: 6px;
      color: var(--lu-text-caption, var(--lu-text-dim, #8b949e));
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as KpiValue;
    const props = this.widget.props as { unit?: string; format?: SemanticFormat };
    const unit = v.unit ?? props.unit;
    const fmt = effectiveFormat(v.format ?? props.format, unit);
    // A currency/percent format renders its own symbol; any other keeps the unit beside it.
    const suffix = unitSuffix(fmt, unit);
    const delta = v.deltaPct ?? null;
    const direction = delta === null ? undefined : deltaDirection(delta);
    const arrow = direction === "up" ? "▲ " : direction === "down" ? "▼ " : "";
    return html`<div aria-hidden="true">
        <span class="value">${measure(v.value, fmt)}</span>
        ${suffix ? html`<span class="unit">${suffix}</span>` : nothing}
        ${
          delta !== null && direction !== undefined
            ? html`<span class="delta ${direction}" data-direction=${direction}
                >${arrow}${measure(Math.abs(delta), DELTA_FORMAT)}</span
              >`
            : nothing
        }
      </div>
      ${
        this.visibleTitle === undefined && !v.label
          ? nothing
          : html`<div class="label">
              ${this.visibleTitle ?? nothing}${v.label ? html`<span class="caption">${v.label}</span>` : nothing}
            </div>`
      }`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-kpi": LuKpi;
  }
}
