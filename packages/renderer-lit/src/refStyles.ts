import { css } from "lit";

// The look of the source markers `LuWidget` draws for a value with `refs` (see base.ts). Added to the styles of the six
// kinds that carry refs. The 24 px hit area (WCAG 2.2 2.5.8) is the same trick chat's reference button uses.
export const refStyles = css`
  .lu-refs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 4px;
    margin: 2px 0;
    font-size: 11px;
    line-height: 1.4;
  }
  .lu-ref {
    all: unset;
    position: relative;
    display: inline-block;
    min-width: 1.4em;
    padding: 0 4px;
    box-sizing: border-box;
    text-align: center;
    border-radius: var(--lu-radius, 6px);
    background: var(--lu-panel-2, rgba(99, 102, 241, 0.16));
    color: var(--lu-accent, #6366f1);
  }
  button.lu-ref {
    cursor: pointer;
  }
  button.lu-ref::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    min-width: 24px;
    min-height: 24px;
    width: 100%;
    height: 100%;
    transform: translate(-50%, -50%);
  }
  button.lu-ref:hover {
    background: var(--lu-accent, #6366f1);
    color: var(--lu-bg, #fff);
  }
  button.lu-ref[aria-disabled="true"] {
    cursor: progress;
    color: var(--lu-text-dim, #8b949e);
  }
  button.lu-ref:focus-visible {
    outline: 2px solid var(--lu-accent, #6366f1);
    outline-offset: 1px;
  }
  .lu-ref-status {
    color: var(--lu-status-critical, #f87171);
  }
  .lu-ref-status:empty {
    display: none;
  }
`;

/** A chart draws out of flow (charts/frame.ts), so its source strip floats over the plot's empty top margin. */
export const refOverlayStyles = css`
  .lu-refs {
    position: absolute;
    top: 0;
    inset-inline-end: 4px;
    margin: 0;
  }
`;
