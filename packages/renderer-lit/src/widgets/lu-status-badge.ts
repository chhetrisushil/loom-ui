import { type TemplateResult, css, html, type nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { LuWidget } from "./base";

@customElement("lu-status-badge")
export class LuStatusBadge extends LuWidget {
  readonly kind = "StatusBadge";

  static styles = css`
    :host {
      display: flex;
      height: 100%;
      align-items: center;
      padding: 4px 10px;
      box-sizing: border-box;
    }
    .badge {
      font-size: 13px;
      font-weight: 600;
      color: var(--gx-text, #e6edf3);
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    return html`<span class="badge" data-status=${String(this.value)}>${String(this.value)}</span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-status-badge": LuStatusBadge;
  }
}
