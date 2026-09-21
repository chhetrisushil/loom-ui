// ── Body-level tooltip portal ────────────────────────────────────────────────
// Renders tooltips in a single fixed element appended to document.body, so they
// escape any `overflow: hidden/auto` ancestor (widget cells, the history rail,
// scroll containers) that would otherwise clip them. Framework-agnostic; called
// from Lit components on hover. Positioned in viewport coordinates and clamped
// to stay on-screen.

let node: HTMLDivElement | null = null;

function portal(): HTMLDivElement {
  if (!node) {
    node = document.createElement("div");
    node.setAttribute("data-gx-tooltip", "");
    Object.assign(node.style, {
      position: "fixed",
      zIndex: "10000",
      pointerEvents: "none",
      display: "none",
      maxWidth: "300px",
      padding: "7px 10px",
      borderRadius: "8px",
      fontSize: "11.5px",
      lineHeight: "1.5",
      fontFamily: "inherit",
      // Reference the app's design tokens (from :root), with safe fallbacks.
      background: "var(--gx-panel-2, #1c2128)",
      color: "var(--gx-text, #e6edf3)",
      border: "1px solid var(--gx-border, #30363d)",
      boxShadow: "0 8px 24px rgba(0,0,0,.5)",
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(node);
  }
  return node;
}

export interface ShowTooltipOptions {
  /** Treat content as HTML rather than plain text. */
  html?: boolean;
  /** Anchor the tooltip above this rect's top-center (else at the point). */
  anchor?: DOMRect;
}

/** Show the portal tooltip near (clientX, clientY) or above `opts.anchor`. */
export function showTooltip(
  content: string,
  clientX: number,
  clientY: number,
  opts: ShowTooltipOptions = {}
): void {
  const t = portal();
  if (opts.html) t.innerHTML = content;
  else t.textContent = content;
  t.style.display = "block";

  const rect = t.getBoundingClientRect();
  const margin = 8;
  const px = opts.anchor ? opts.anchor.left + opts.anchor.width / 2 : clientX;
  const anchorTop = opts.anchor ? opts.anchor.top : clientY;

  let left = px - rect.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));

  let top = anchorTop - rect.height - 10; // prefer above
  if (top < margin) top = (opts.anchor ? opts.anchor.bottom : clientY) + 14; // flip below

  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}

export function hideTooltip(): void {
  if (node) node.style.display = "none";
}
