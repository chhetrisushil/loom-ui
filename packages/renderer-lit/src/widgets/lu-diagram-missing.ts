import { LitElement, css, html } from "lit";
import { property } from "lit/decorators.js";
import { say } from "../say.js";

// The DEFAULT registry's stand-in for the `Diagram` kind. The real widget is the opt-in entry
// `@loomwork/ui-renderer-lit/diagram`; a page that composed a diagram without registering it sees ONE
// fixed placeholder (no value, no title, no props) instead of an empty hole, and a single console
// warning that says how to fix it.

let warned = false;

export class LuDiagramMissing extends LitElement {
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
      "[loom-ui] a diagram was composed but the diagram renderer is not registered: use createDiagramLitRegistry() from @loomwork/ui-renderer-lit/diagram"
    );
  }
  render() {
    return html`<div role="note" data-diagram-state="not-loaded">${say("lu.diagram.notLoaded")}</div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-diagram-missing": LuDiagramMissing;
  }
}
