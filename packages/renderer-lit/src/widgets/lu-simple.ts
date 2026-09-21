// Five compact built-in elements: the loom kinds with no bespoke Lit widget, matching loom's
// React renderers' semantics.
import { type TemplateResult, css, html, type nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { measure } from "../format";
import { LuWidget } from "./base";

function describeEntry(entry: unknown): string {
  if (entry !== null && typeof entry === "object") {
    const r = entry as Record<string, unknown>;
    if (typeof r.label === "string") return r.label;
    if (typeof r.title === "string") return r.title;
  }
  return String(entry);
}

@customElement("lu-progress")
export class LuProgress extends LuWidget {
  readonly kind = "ProgressBar";

  static styles = css`
    :host {
      display: flex;
      height: 100%;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      box-sizing: border-box;
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as number;
    const props = this.widget.props as { max?: number };
    const max = props.max ?? 100;
    return html`<progress max=${max} value=${v}></progress><span>${measure(v)}</span>`;
  }
}

@customElement("lu-alert")
export class LuAlert extends LuWidget {
  readonly kind = "AlertCard";

  static styles = css`
    :host {
      display: block;
      height: 100%;
      padding: 4px 10px;
      box-sizing: border-box;
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const props = this.widget.props as { severity?: string };
    return html`<div class="alert" data-severity=${props.severity ?? "info"}>${this.value as string}</div>`;
  }
}

@customElement("lu-text")
export class LuText extends LuWidget {
  readonly kind = "StreamingText";

  static styles = css`
    :host {
      display: block;
      height: 100%;
      padding: 4px 10px;
      box-sizing: border-box;
      white-space: pre-wrap;
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const props = this.widget.props as { placeholder?: string };
    const text = (this.value as string) || props.placeholder || "";
    return html`<span>${text}</span>`;
  }
}

@customElement("lu-list")
export class LuList extends LuWidget {
  readonly kind = "Timeline";

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow: auto;
    }
    ul {
      margin: 0;
      padding-inline-start: 18px;
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const entries = this.value as unknown[];
    const props = this.widget.props as { maxItems?: number };
    const items = props.maxItems !== undefined ? entries.slice(0, props.maxItems) : entries;
    return html`<ul>
      ${items.map((e) => html`<li>${describeEntry(e)}</li>`)}
    </ul>`;
  }
}

@customElement("lu-approval")
export class LuApproval extends LuWidget {
  readonly kind = "ApprovalCard";

  static styles = css`
    :host {
      display: flex;
      height: 100%;
      flex-direction: column;
      justify-content: center;
      gap: 6px;
      padding: 6px 10px;
      box-sizing: border-box;
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    button {
      cursor: pointer;
    }
  `;

  protected renderReady(): TemplateResult | typeof nothing {
    const props = this.widget.props as { approveLabel?: string; rejectLabel?: string };
    return html`<div class="title">${this.title_}</div>
      <div class="value">${describeEntry(this.value)}</div>
      <div class="actions">
        <button
          @click=${() => this.onAction?.({ type: "approve", widgetId: this.widget.id })}
        >
          ${props.approveLabel ?? "Approve"}
        </button>
        <button @click=${() => this.onAction?.({ type: "reject", widgetId: this.widget.id })}>
          ${props.rejectLabel ?? "Reject"}
        </button>
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-progress": LuProgress;
    "lu-alert": LuAlert;
    "lu-text": LuText;
    "lu-list": LuList;
    "lu-approval": LuApproval;
  }
}
