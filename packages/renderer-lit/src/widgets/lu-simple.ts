// Five compact built-in elements: the loom kinds with no bespoke Lit widget, matching loom's
// React renderers' semantics (`plugins/renderer-react/src/renderers/*.tsx` in loom).
import { type TemplateResult, css, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { measure } from "../format";
import { LuWidget } from "./base";

/** loom's `TimelineRenderer` entry shape: `{ timestamp?, message?, level? }`. */
interface TimelineEntry {
  readonly timestamp?: number | string;
  readonly message?: string;
  readonly level?: string;
}

function asEntry(entry: unknown): TimelineEntry | undefined {
  return entry !== null && typeof entry === "object" ? (entry as TimelineEntry) : undefined;
}

/**
 * The entry's text. loom's React renderer reads `entry.message`; `label`/`title` are accepted
 * as fallbacks because loom's terminal timeline stringifies whatever it is given, and a plain
 * string entry is stringified rather than becoming "[object Object]".
 */
function describeEntry(entry: unknown): string {
  const r = asEntry(entry);
  if (r !== undefined) {
    if (typeof r.message === "string") return r.message;
    const rec = r as Record<string, unknown>;
    if (typeof rec.label === "string") return rec.label;
    if (typeof rec.title === "string") return rec.title;
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
    // A token stream (the value grows chunk by chunk — core's `appendChunk`): the span is stable
    // so Lit patches one text node in place, and it is a POLITE live region that announces only
    // what is ADDED (`aria-relevant`, non-atomic) so a reader hears the new tokens, not the whole
    // text again. `aria-busy` holds announcements back while a chunk burst lands and clears when
    // the store marks the stream done (status `ready`).
    const busy = this.status?.state === "pending";
    return html`<span
      aria-live="polite"
      aria-atomic="false"
      aria-relevant="additions text"
      aria-busy=${busy ? "true" : "false"}
      >${text}</span
    >`;
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
    .ts {
      color: var(--lu-text-dim, #8b949e);
      margin-inline-end: 6px;
      font-variant-numeric: tabular-nums;
    }
  `;

  // Mirrors TimelineRenderer: the timestamp is its own span when the entry carries one, the
  // level lands on `data-level` (and is absent when the entry has none), and the text is the
  // entry's `message` — an entry object rendered through `String` would read "[object Object]".
  // `props.maxItems` is deliberately NOT honoured: loom's React renderer ignores it, and the
  // two web surfaces must show the same rows for one compiled blueprint.
  protected renderReady(): TemplateResult | typeof nothing {
    const entries = this.value as unknown[];
    return html`<ul>
      ${entries.map((e) => {
        const entry = asEntry(e);
        const level = typeof entry?.level === "string" ? entry.level : undefined;
        const ts = entry?.timestamp;
        return html`<li data-level=${level ?? nothing}>
          ${ts !== undefined && ts !== "" ? html`<span class="ts">${String(ts)}</span>` : nothing}<span
            class="msg"
            >${describeEntry(e)}</span
          >
        </li>`;
      })}
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
    return html`${this.visibleTitle === undefined ? nothing : html`<div class="title">${this.visibleTitle}</div>`}
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
