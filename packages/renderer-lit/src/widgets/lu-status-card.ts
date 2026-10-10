import type { StatusCardValue } from "@loom-ui/core/browser";
import { type TemplateResult, css, html, nothing } from "lit";
import { describeValue } from "../a11y";

import { LEVEL_KEY, say } from "../say";
import { LuWidget } from "./base";

// A level dot, a headline and optional detail. The description also lives in a visually-hidden
// `role="status" aria-live="polite"` region, so a CHANGE of status is announced without
// stealing focus — unlike loom's StatusBadge, which stays a bare string.
export class LuStatusCard extends LuWidget {
  readonly kind = "StatusCard";

  static styles = css`
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }
    :host {
      display: block;
      height: 100%;
      padding: 6px 10px;
      box-sizing: border-box;
    }
    .card {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex: none;
      background: currentColor;
      box-shadow: 0 0 8px currentColor;
    }
    .ok {
      color: var(--lu-status-ok, #4ade80);
    }
    .warning {
      color: var(--lu-status-warning, #fbbf24);
    }
    .critical {
      color: var(--lu-status-critical, #f87171);
    }
    .level-text {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .headline {
      font-size: 14px;
      font-weight: 600;
      color: var(--lu-text, #e6edf3);
      line-height: 1.3;
    }
    .detail {
      font-size: 12px;
      color: var(--lu-text-dim, #8b949e);
      margin-top: 2px;
    }
  `;

  /**
   * The group's own accessible name stays the plain title: the polite live region below already
   * speaks the level/headline/detail sentence on every change, and the visible headline speaks
   * it again in the ordinary reading order. Using the full sentence here too would announce the
   * same content a third time to a screen reader entering the widget.
   */
  protected override label(): string {
    if (this.state().state !== "ready") return super.label();
    const source = this.sourceLabel;
    return source === undefined ? this.title_ : `${source}: ${this.title_}`;
  }

  protected renderReady(): TemplateResult | typeof nothing {
    // `level` is one of three literals: the contract ran before this did.
    const v = this.value as StatusCardValue;
    return html`<span role="status" aria-live="polite" class="sr-only"
        >${describeValue("StatusCard", v, this.title_)}</span
      >
      <div class="card">
        <span class="dot ${v.level}" data-level=${v.level} aria-hidden="true"></span>
        <div>
          <div class="level-text ${v.level}" data-level-text>${say(LEVEL_KEY[v.level])}</div>
          <div class="headline">${v.headline}</div>
          ${v.detail ? html`<div class="detail">${v.detail}</div>` : nothing}
        </div>
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-status-card": LuStatusCard;
  }
}
