import { type TemplateResult, css, html, nothing } from "lit";
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
      gap: 6px;
      padding: 4px 10px;
      box-sizing: border-box;
    }
    .badge-title {
      font-size: 12px;
      color: var(--lu-text-dim, #8b949e);
    }
    .badge {
      font-size: 13px;
      font-weight: 600;
      color: var(--lu-text, #e6edf3);
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const status = String(this.value);
    // Mirrors StatusBadgeRenderer: the title is a visible sibling span, not folded into the
    // accessible name alone.
    return html`${
      this.visibleTitle !== undefined && this.widget.title
        ? html`<span class="badge-title">${this.widget.title}</span>`
        : nothing
    }<span class="badge" data-status=${status}>${status}</span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-status-badge": LuStatusBadge;
  }
}
