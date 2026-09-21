// Five compact built-in elements: the loom kinds with no bespoke Lit widget, matching loom's
// React renderers' semantics (`plugins/renderer-react/src/renderers/*.tsx` in loom).
import { type TemplateResult, css, html, nothing } from "lit";
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
    const props = this.widget.props as { max?: number };
    // Mirrors ProgressBarRenderer: core's contract is `z.number()`, which rejects NaN but
    // accepts Infinity, so both `max` and the bound value are re-checked for finiteness here.
    // Omitting the `value` attribute (via Lit's `nothing`) is the standard representation of an
    // INDETERMINATE bar — a bar at zero and a bar with no usable data must not look identical.
    const max = typeof props.max === "number" && props.max > 0 ? props.max : 100;
    const raw = this.value as number;
    const current = Number.isFinite(raw) ? raw : undefined;
    return html`<progress max=${max} value=${current !== undefined ? current : nothing}></progress>
      <span>${current === undefined ? "—" : measure(current)}</span>`;
  }
}

const ALERT_SEVERITIES = new Set(["info", "warning", "error", "critical"]);

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
    // Mirrors AlertCardRenderer's `SEVERITIES` allow-list: an unrecognised severity falls back
    // to "info" rather than being interpolated straight into `data-severity`, so a bound string
    // can never author a style hook.
    const severity =
      props.severity !== undefined && ALERT_SEVERITIES.has(props.severity)
        ? props.severity
        : "info";
    return html`<div class="alert" data-severity=${severity}>${this.value as string}</div>`;
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

  // Exact action shape from ApprovalCardRenderer — an app's `onAction` handler must not care
  // which renderer fired it, so "one web compile serves React or Lit" means these dispatch
  // identically: `type` is upper-case and `payload.approved` carries the boolean, not the type.
  private approve = (): void => {
    this.onAction?.({ type: "APPROVE", widgetId: this.widget.id, payload: { approved: true } });
  };
  private reject = (): void => {
    this.onAction?.({ type: "REJECT", widgetId: this.widget.id, payload: { approved: false } });
  };

  protected renderReady(): TemplateResult | typeof nothing {
    const props = this.widget.props as { approveLabel?: string; rejectLabel?: string };
    // Gated on `Boolean(value)` like ApprovalCardRenderer: a resolved (or absent) approval
    // shows no actions, only the same "No pending approval" text React renders.
    const pending = Boolean(this.value);
    return html`<div class="title">${this.title_}</div>
      ${
        pending
          ? html`<div class="actions">
              <button @click=${this.approve}>${props.approveLabel ?? "Approve"}</button>
              <button @click=${this.reject}>${props.rejectLabel ?? "Reject"}</button>
            </div>`
          : html`<div class="resolved">No pending approval</div>`
      }`;
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
