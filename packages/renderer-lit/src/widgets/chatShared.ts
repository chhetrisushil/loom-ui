import { css } from "lit";

// Styles shared by the chat and input widgets (U8). Dispatch lives in `./dispatch`.

export const inputStyles = css`
  :host {
    display: block;
    padding: 4px 10px;
    box-sizing: border-box;
    color: var(--lu-text, inherit);
  }
  /* A SelectInput with size "compact": fits its content, so it can sit beside other controls. */
  :host([compact]) {
    display: inline-block;
    vertical-align: middle;
  }
  :host([compact]) select {
    width: auto;
    max-width: 100%;
  }
  label,
  .label {
    display: block;
    margin-bottom: 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--lu-text-dim, #8b949e);
  }
  input[type="text"],
  input[type="number"],
  textarea,
  select {
    box-sizing: border-box;
    width: 100%;
    padding: 6px 8px;
    font: inherit;
    color: inherit;
    background: var(--lu-panel, transparent);
    border: 1px solid var(--lu-border, #30363d);
    border-radius: var(--lu-radius, 4px);
  }
  textarea {
    resize: vertical;
    min-height: 3.2em;
  }
  input:focus-visible,
  textarea:focus-visible,
  select:focus-visible,
  button:focus-visible,
  .log:focus-visible {
    outline: 2px solid var(--lu-accent, #58a6ff);
    outline-offset: 1px;
  }
  [aria-invalid="true"] {
    border-color: var(--lu-status-critical, #f87171);
  }
  button {
    margin-top: 6px;
    padding: 4px 12px;
    font: inherit;
    color: inherit;
    background: var(--lu-panel, transparent);
    border: 1px solid var(--lu-border, #30363d);
    border-radius: var(--lu-radius, 4px);
    cursor: pointer;
  }
  button[disabled] {
    color: var(--lu-text-dim, #8b949e);
    border-style: dashed;
    cursor: default;
  }
  .row {
    margin-bottom: 8px;
  }
  .hint,
  .count {
    font-size: 11px;
    color: var(--lu-text-dim, #8b949e);
  }
  .error {
    margin-top: 2px;
    font-size: 12px;
    color: var(--lu-status-critical, #f87171);
  }
  /* Always one line high: a status appearing never moves what is below it. */
  .status {
    min-height: 1.4em;
    margin-top: 4px;
    font-size: 12px;
    color: var(--lu-text-dim, #8b949e);
  }
  .status[data-error] {
    color: var(--lu-status-critical, #f87171);
  }
`;
