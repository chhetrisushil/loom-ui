import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { say } from "../say";

// The DEFAULT registry's stand-in for the chat kinds (U8). The real widgets are the opt-in entry
// `@loom-ui/renderer-lit/chat`; a page that composed a transcript or an input without registering
// them sees ONE fixed placeholder (no value, no title, no props) instead of an empty hole, and a
// single console warning that says how to fix it.

let warned = false;

@customElement("lu-chat-missing")
export class LuChatMissing extends LitElement {
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
      "[loom-ui] a chat or input widget was composed but the chat renderers are not registered: use createChatLitRegistry() from @loom-ui/renderer-lit/chat"
    );
  }
  render() {
    return html`<div role="note" data-chat-state="not-loaded">${say("lu.chat.notLoaded")}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-chat-missing": LuChatMissing;
  }
}
