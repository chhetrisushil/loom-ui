import type { ActionOutcome } from "@loom-ui/core/browser";
import type { WidgetAction } from "@loom/blueprint-runtime";
import { css } from "lit";
import { say } from "../say";

// Shared by the chat and input widgets (U8).

export type DispatchResult = "ok" | "failed" | "stale" | "unavailable";

/**
 * Emit `action` and wait for the HOST's answer. No handler = `unavailable` (nothing is pretended to
 * be sent). A handler that returns nothing is success; one that answers `ok: false` or rejects is
 * `failed` (`stale` when its reason says the view moved). The reason is never shown as text: the
 * widget maps it to its own fixed words.
 */
export async function dispatch(
  onAction: ((a: WidgetAction) => unknown) | undefined,
  action: WidgetAction
): Promise<DispatchResult> {
  if (onAction === undefined) return "unavailable";
  try {
    const out = (await onAction(action)) as Partial<ActionOutcome> | null | undefined;
    if (typeof out === "object" && out !== null && out.ok === false)
      return out.reason === "stale" ? "stale" : "failed";
    return "ok";
  } catch {
    return "failed";
  }
}

/** The fixed words for a failed dispatch. */
export function failureText(result: DispatchResult): string {
  switch (result) {
    case "stale":
      return say("lu.chat.dispatch.stale");
    case "unavailable":
      return say("lu.chat.dispatch.unavailable");
    default:
      return say("lu.chat.dispatch.failed");
  }
}

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
