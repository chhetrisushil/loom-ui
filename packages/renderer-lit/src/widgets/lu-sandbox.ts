import { LitElement, css, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import {
  SANDBOX_ALLOW,
  buildSandboxSrcdoc,
  hostMessage,
  parseFrameMessage,
} from "../sandbox/protocol";

// ── The user-component sandbox ────────────────────────────────────────────────
//
// Runs an UNTRUSTED user-authored renderer inside a null-origin iframe
// (`sandbox="allow-scripts"`, no allow-same-origin) and bridges it to the host by
// postMessage. The isolation model and the message protocol live in
// `../sandbox/protocol` (pure + tested); this element is the thin DOM wiring:
// create the frame, drive it with the widget's data, and surface its actions as
// the SAME composed `a2ui-action` event the declarative interpreter raises — so
// the studio handles user-component actions identically.
//
// The code and data crossing into the frame are the component's own render code
// and the widget's already-client-visible canonical data: no host secret is ever
// posted, so the null-origin target (targetOrigin "*") leaks nothing.

@customElement("lu-sandbox")
export class LuSandbox extends LitElement {
  /** The untrusted render code: a `(root, data, emit)` function body. */
  @property({ attribute: false }) code = "";
  /** The data model handed to the component (re-posted on change). */
  @property({ attribute: false }) data: unknown = {};

  @query("iframe") private frame!: HTMLIFrameElement;
  @state() private frameHeight = 0;

  private ready = false;
  private readonly onMessage = (e: MessageEvent) => this.handleMessage(e);

  static styles = css`
    :host { display: block; }
    iframe { width: 100%; border: 0; display: block; background: transparent; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.onMessage);
  }

  disconnectedCallback(): void {
    window.removeEventListener("message", this.onMessage);
    this.ready = false;
    super.disconnectedCallback();
  }

  updated(changed: Map<string, unknown>): void {
    // Code change ⇒ re-initialize the frame from scratch. Data-only change ⇒
    // just re-render. Both no-op until the frame reports `ready`.
    if (changed.has("code")) this.init();
    else if (changed.has("data")) this.post({ type: "render", data: this.data });
  }

  render() {
    return html`<iframe
      part="frame"
      sandbox=${SANDBOX_ALLOW}
      srcdoc=${buildSandboxSrcdoc()}
      style="height:${this.frameHeight}px"
    ></iframe>`;
  }

  private handleMessage(e: MessageEvent): void {
    // Only the frame we own may talk to us (origin is "null" and unusable here).
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const msg = parseFrameMessage(e.data);
    if (!msg) return;
    switch (msg.type) {
      case "ready":
        this.ready = true;
        this.init();
        break;
      case "resize":
        this.frameHeight = msg.height;
        break;
      case "action":
        this.dispatchEvent(
          new CustomEvent("a2ui-action", {
            detail: { action: msg.action, context: msg.context },
            bubbles: true,
            composed: true,
          })
        );
        break;
      case "error":
        this.dispatchEvent(
          new CustomEvent("sandbox-error", {
            detail: { message: msg.message },
            bubbles: true,
            composed: true,
          })
        );
        break;
    }
  }

  private init(): void {
    if (this.code) this.post({ type: "init", code: this.code, data: this.data });
  }

  private post(
    message: { type: "init"; code: string; data: unknown } | { type: "render"; data: unknown }
  ): void {
    if (!this.ready || !this.frame?.contentWindow) return;
    this.frame.contentWindow.postMessage(hostMessage(message), "*");
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-sandbox": LuSandbox;
  }
}
