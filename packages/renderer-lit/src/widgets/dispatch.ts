import type { WidgetAction } from "@loomwork/blueprint-runtime";
import type { ActionOutcome } from "@loomwork/ui-core/browser";
import { say } from "../say.js";

// Emitting a widget action and waiting for the host's answer: every widget that emits one (the
// base, tables, chat and inputs). Its own module so a widget that is not a chat or input control
// does not carry chatShared's input styles.

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
