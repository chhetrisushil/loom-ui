import { LitElement, css, html } from "lit";
import { property } from "lit/decorators.js";
import { say } from "../say";

// The DEFAULT registry's stand-in for the media kinds (U9). The real widgets are the opt-in entry
// `@loom-ui/renderer-lit/media`; a page that composed media without registering them sees ONE fixed
// placeholder (no value, no address, no title) instead of an empty hole, and a single console warning
// that says how to fix it.

let warned = false;

export class LuMediaMissing extends LitElement {
  @property({ attribute: false }) widget?: { kind?: string };
  static styles = css`
    :host {
      display: block;
      padding: 4px 10px;
    }
    div {
      padding: 12px;
      border: 1px dashed var(--lu-border, #30363d);
      color: var(--lu-text-dim, #8b949e);
      font-size: 12px;
      font-style: italic;
    }
  `;
  override connectedCallback(): void {
    super.connectedCallback();
    if (warned) return;
    warned = true;
    console.warn(
      "[loom-ui] a media widget was composed but the media renderers are not registered: use createMediaLitRegistry() from @loom-ui/renderer-lit/media"
    );
  }
  render() {
    return html`<div role="note" data-media-state="not-loaded">${say("lu.media.notLoaded")}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-media-missing": LuMediaMissing;
  }
}
