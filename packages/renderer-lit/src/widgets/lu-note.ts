import { isLocalizedText } from "@loom-ui/core/browser";
import { type TemplateResult, css, html, nothing } from "lit";
import { titleText } from "../title";
import { LuWidget } from "./base";

/** Compile resolves a text prop to a string; an uncompiled `LocalizedText` shows its fallback, never its key. */
function noteText(value: unknown): string {
  if (typeof value === "string") return value;
  return isLocalizedText(value) ? value.fallback : "";
}

// Static text from props. A Note is never bound, so an undefined value bypasses the status
// matrix entirely — the matrix would read "never bound" as "loading" forever. A DEFINED value
// reaching a Note is a contract violation (its kind contract is `z.undefined()`, per
// `kindValueContracts`), not something to render around silently: that case still goes through
// the standard matrix, which turns the failed `checkKindValue` into the usual error state.
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
    // Same guard as LuWidget's own accessors: before a widget is assigned there is nothing to draw.
    if (!this.widget) return nothing;
    if (this.value !== undefined) return super.render();
    return this.renderReady();
  }

  protected renderReady(): TemplateResult | typeof nothing {
    // Only a non-empty string is a title (`""` and a stray `0` are none, as for every widget); the
    // accessible name keeps it even when the host draws the visible one.
    const title = titleText(this.widget.title);
    return html`<div role="note" aria-label=${title ?? nothing}>
      ${title !== undefined && this.chrome !== "host" ? html`<div class="title">${title}</div>` : nothing}
      <p class="text">${noteText((this.widget.props as { text?: unknown }).text)}</p>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-note": LuNote;
  }
}
