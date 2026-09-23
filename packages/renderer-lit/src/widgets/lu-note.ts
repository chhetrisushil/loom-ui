import { LocalizedText } from "@loom-ui/core";
import { type TemplateResult, css, html, nothing } from "lit";
import { customElement } from "lit/decorators.js";
import { LuWidget } from "./base";

/** Compile resolves a text prop to a string; an uncompiled `LocalizedText` shows its fallback, never its key. */
function noteText(value: unknown): string {
  if (typeof value === "string") return value;
  const parsed = LocalizedText.safeParse(value);
  return parsed.success ? parsed.data.fallback : "";
}

// Static text from props. A Note is never bound, so an undefined value bypasses the status
// matrix entirely — the matrix would read "never bound" as "loading" forever. A DEFINED value
// reaching a Note is a contract violation (its kind contract is `z.undefined()`, per
// `kindValueContracts`), not something to render around silently: that case still goes through
// the standard matrix, which turns the failed `checkKindValue` into the usual error state.
@customElement("lu-note")
export class LuNote extends LuWidget {
  readonly kind = "Note";

  static styles = css`
    :host {
      display: block;
      height: 100%;
      padding: 4px 10px;
      box-sizing: border-box;
    }
    .title {
      font-size: 12px;
      font-weight: 600;
      color: var(--lu-text-dim, #8b949e);
    }
    .text {
      margin: 2px 0 0;
      color: var(--lu-text, #e6edf3);
      font-size: 14px;
      line-height: 1.5;
      white-space: pre-wrap;
    }
  `;

  render(): TemplateResult | typeof nothing {
    if (this.value !== undefined) return super.render();
    return this.renderReady();
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const title = this.widget.title;
    return html`<div role="note" aria-label=${title ?? nothing}>
      ${title ? html`<div class="title">${title}</div>` : nothing}
      <p class="text">${noteText((this.widget.props as { text?: unknown }).text)}</p>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-note": LuNote;
  }
}
