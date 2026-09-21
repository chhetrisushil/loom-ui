/**
 * The host ↔ sandbox message protocol for running an UNTRUSTED user-authored
 * component renderer in a null-origin iframe. Pure (no DOM) so the security-
 * critical invariants — the sandbox token set, the origin-isolation of the
 * frame, and the message contract — are unit-testable without a browser.
 *
 * Threat model: a user-registered component ships arbitrary render code. It must
 * never reach the genUI origin's DOM, cookies, localStorage, or auth tokens, and
 * must not be able to exfiltrate over the network. The isolation is structural:
 *
 *  1. The frame is `sandbox="allow-scripts"` and, deliberately, NOTHING else —
 *     in particular NOT `allow-same-origin`. Scripts run, but the document is a
 *     unique ("null") origin: it cannot script the parent, read host cookies/
 *     storage, and cannot remove its own sandbox (which allow-same-origin +
 *     allow-scripts together would permit).
 *  2. A restrictive CSP inside the frame (`default-src 'none'`) blocks all
 *     network egress; only inline script/style + eval (for the code we hand it)
 *     and data: images are allowed. So even within its null origin the code
 *     cannot phone home.
 *  3. The host only accepts frame messages whose `event.source` is the frame's
 *     own window (origin is "null" and unusable for filtering), and both sides
 *     tag messages with a marker so stray postMessages are ignored.
 *
 * The data handed to the frame is the widget's already-client-visible canonical
 * data — never a secret — so posting with `targetOrigin: "*"` (required for a
 * null-origin target) leaks nothing.
 */

/** Marker on every protocol message, so unrelated postMessages are ignored. */
export const SANDBOX_MARKER = "__gxSandbox";

/**
 * The ONLY sandbox tokens the frame is granted. `allow-scripts` with NO
 * `allow-same-origin`: code runs, origin stays null. Changing this — especially
 * adding `allow-same-origin` — would breach the isolation; the test suite pins it.
 */
export const SANDBOX_ALLOW = "allow-scripts";

// ── Host → frame ────────────────────────────────────────────────────────────────

/** First message: the user code to run, plus the initial data model. */
export interface HostInit {
  type: "init";
  code: string;
  data: unknown;
}
/** Subsequent data-model update; the frame re-renders. */
export interface HostRender {
  type: "render";
  data: unknown;
}
export type HostMessage = HostInit | HostRender;

// ── Frame → host ────────────────────────────────────────────────────────────────

/** The frame's bootstrap has loaded and is ready to receive `init`. */
export interface FrameReady {
  type: "ready";
}
/** The user component raised an action (the inbound leg — same shape the
 * declarative interpreter emits, so the host handles both identically). */
export interface FrameAction {
  type: "action";
  action: string;
  context?: unknown;
}
/** The frame's content height changed (host resizes the iframe to fit). */
export interface FrameResize {
  type: "resize";
  height: number;
}
/** The user code threw while rendering. */
export interface FrameError {
  type: "error";
  message: string;
}
export type FrameMessage = FrameReady | FrameAction | FrameResize | FrameError;

/** Wrap a host→frame message with the protocol marker. */
export function hostMessage(message: HostMessage): Record<string, unknown> {
  return { [SANDBOX_MARKER]: true, ...message };
}

/** Wrap a frame→host message with the protocol marker (used by the bootstrap). */
export function frameMessage(message: FrameMessage): Record<string, unknown> {
  return { [SANDBOX_MARKER]: true, ...message };
}

/** Narrow an incoming `MessageEvent.data` to a marked FrameMessage, or null. */
export function parseFrameMessage(raw: unknown): FrameMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (m[SANDBOX_MARKER] !== true) return null;
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "action":
      return typeof m.action === "string"
        ? { type: "action", action: m.action, context: m.context }
        : null;
    case "resize":
      return typeof m.height === "number" ? { type: "resize", height: m.height } : null;
    case "error":
      return { type: "error", message: typeof m.message === "string" ? m.message : "error" };
    default:
      return null;
  }
}

// ── The trusted frame bootstrap ─────────────────────────────────────────────────

/**
 * The fixed, trusted document loaded into the sandbox via `srcdoc`. It accepts
 * ONLY messages from `window.parent`, runs the user code as a `(root, data,
 * emit)` function body (re-run on each render — stateless-render style), reports
 * height for auto-sizing, and forwards actions/errors. User code renders with
 * plain DOM (or a self-contained bundle); no host globals are exposed.
 */
export function buildSandboxSrcdoc(): string {
  return SANDBOX_SRCDOC;
}

const SANDBOX_SRCDOC = `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:;">
<style>html,body{margin:0;padding:0;font:14px system-ui,sans-serif;color:#e6edf3;background:transparent}</style>
</head>
<body>
<script>
(function(){
  var MARK = ${JSON.stringify(SANDBOX_MARKER)};
  var code = null;
  function post(msg){ msg[MARK] = true; window.parent.postMessage(msg, "*"); }
  function emit(action, context){ post({ type: "action", action: action, context: context }); }
  function reportHeight(){ post({ type: "resize", height: document.documentElement.scrollHeight }); }
  function render(data){
    if (code == null) return;
    try {
      document.body.innerHTML = "";
      var fn = new Function("root", "data", "emit", code);
      fn(document.body, data, emit);
      reportHeight();
    } catch (err) {
      var pre = document.createElement("pre");
      pre.style.color = "#f87171"; pre.style.whiteSpace = "pre-wrap";
      pre.textContent = String(err && err.stack || err);
      document.body.innerHTML = ""; document.body.appendChild(pre);
      post({ type: "error", message: String(err && err.message || err) });
      reportHeight();
    }
  }
  window.addEventListener("message", function(e){
    if (e.source !== window.parent) return;      // only the host may drive us
    var m = e.data;
    if (!m || m[MARK] !== true) return;
    if (m.type === "init") { code = m.code; render(m.data); }
    else if (m.type === "render") { render(m.data); }
  });
  post({ type: "ready" });
})();
</script>
</body>
</html>`;
