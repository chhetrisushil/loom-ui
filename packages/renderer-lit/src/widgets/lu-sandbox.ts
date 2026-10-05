import type { WidgetAction } from "@loom/blueprint-runtime";
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

/** Upper bound on the height an untrusted frame may claim for itself, in CSS pixels. */
const MAX_FRAME_HEIGHT = 4000;

/** `[0, MAX_FRAME_HEIGHT]`; a non-finite report (NaN passes `typeof === "number"`) collapses to 0. */
function clampFrameHeight(height: number): number {
  return Number.isFinite(height) ? Math.min(Math.max(height, 0), MAX_FRAME_HEIGHT) : 0;
}

@customElement("lu-sandbox")
export class LuSandbox extends LitElement {
  /** The untrusted render code: a `(root, data, emit)` function body. */
  @property({ attribute: false }) code = "";
  /** The data model handed to the component (re-posted on change). */
  @property({ attribute: false }) data: unknown = {};
  /**
   * The host's action path (set by `lu-sandbox-widget` to the stamped `onAction`). The frame is
   * untrusted: its `action`/`context` are carried under `payload` of a `SANDBOX_ACTION`, and the
   * renderer stamps provenance — nothing the frame sends can set it.
   */
  @property({ attribute: false }) onAction?: (a: WidgetAction) => void;

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
    // Code change ⇒ re-`init` the LIVE frame with the new code; data-only change ⇒ just
    // re-render. The frame itself is NOT torn down and rebuilt — `srcdoc` is constant, so the
    // iframe is never reloaded and whatever the previous code left on the frame's global object
    // is still there. Both messages no-op until the frame reports `ready`.
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
        // The height is reported BY the untrusted frame and goes straight into the host's
        // layout: clamped, so a component that reports 1e9 (or a negative) cannot make the host
        // page scroll for a million pixels.
        this.frameHeight = clampFrameHeight(msg.height);
        break;
      case "action":
        // With `onAction` wired the provenance-free DOM event is not fired (see `lu-a2ui-view`).
        if (this.onAction) {
          this.onAction({
            type: "SANDBOX_ACTION",
            widgetId: "",
            payload: { action: msg.action, context: msg.context },
          });
          break;
        }
        // DEPRECATED: no provenance on the DOM event; prefer `onAction`.
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
