import { type TemplateResult, css, html, type nothing } from "lit";
import { customElement } from "lit/decorators.js";
import type { A2UIView } from "../a2ui/plan";
import { t } from "../i18n";
import { LuWidget } from "./base";
import "./lu-a2ui-view";
import "./lu-sandbox";

// ── Registry kinds for the two embedded surfaces ─────────────────────────────
// `lu-a2ui-view` (a declarative agent-authored component tree) and `lu-sandbox` (untrusted
// author code in a null-origin frame) are plain elements with `data`. These kinds mount them
// INSIDE a LuWidget, so the bound value arrives through the same status matrix as every other
// kind (loading, stale, error) and becomes the element's `data`. The tree and the code are
// DECLARED props (`view`, `code`) on the kind's contract. The inner element is kept across value
// updates: Lit's property bindings re-render the view / re-post to the frame, never rebuild it.

@customElement("lu-a2ui-widget")
export class LuA2UIWidget extends LuWidget {
  readonly kind = "A2UIView";

  static styles = css`
    :host {
      display: block;
      height: 100%;
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const view = (this.widget.props as { view?: A2UIView }).view;
    return html`<lu-a2ui-view .view=${view} .data=${this.value}></lu-a2ui-view>`;
  }
}

@customElement("lu-sandbox-widget")
export class LuSandboxWidget extends LuWidget {
  readonly kind = "SandboxView";

  static styles = css`
    :host {
      display: block;
      height: 100%;
    }
    .missing {
      color: var(--lu-text-dim, #8b949e);
      font-size: 12px;
      font-style: italic;
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const code = (this.widget.props as { code?: unknown }).code;
    if (typeof code !== "string" || code.length === 0)
      return html`<span class="missing">${t("no component code")}</span>`;
    return html`<lu-sandbox .code=${code} .data=${this.value}></lu-sandbox>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-a2ui-widget": LuA2UIWidget;
    "lu-sandbox-widget": LuSandboxWidget;
  }
}
