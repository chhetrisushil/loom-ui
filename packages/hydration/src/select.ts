import type { Finding } from "@loom-ui/core";
import { resolvePath } from "./plan";

// Pure reshaping pieces (no sandbox, no MCP): `@loom-ui/hydration/client` exports them so a planner
// can dry-run a JSONPath binding without the server plane. `reshape.ts` re-exports them.

/**
 * Why a reshaping failed, when the tool OUTPUT demonstrably caused it — the failures a re-authored
 * binding can repair. Typed from the failure's channel and payload, never from message text:
 *
 * - `script-error`: the sandbox reports the script threw on this input (a `TypedFailure` on loom's
 *   `scriptError` channel, `SANDBOX_ERRORS.scriptError`).
 * - `selects-nothing`: a JSONPath selects nothing from the output.
 * - `uncloneable-output`: the output holds a value `structuredClone` cannot copy (a function, say),
 *   so a Named reshaper is never handed it. Recorded WITHOUT a sample: such a value is not a data
 *   observation a planner can author against.
 * - `limit-cpu`, `limit-memory`, `limit-output`: a deterministic resource limit the script hit on
 *   this input. `limit-cpu` is measured against the host's instruction-count `interruptBudget`,
 *   not time — deterministic for a given budget, so LOWERING the budget surfaces as output drift.
 *
 * Anything else has no kind and is not drift. That includes a `wallClock` limit (host-load
 * dependent — on a loaded host a script can trip `wallClock` before `cpu`, and then no drift is
 * reported that time), a Named reshaper's own throw (host code: a host bug or its own I/O is not
 * proven output-caused, and must never get the host's reshaper replaced by a model-authored
 * binding), a missing script, an unregistered reshaper, an untyped throw (transport, worker pool,
 * integrity), an authorization or quota denial, and an abort.
 */
export type ReshapeFailureKind =
  | "script-error"
  | "selects-nothing"
  | "uncloneable-output"
  | "limit-cpu"
  | "limit-memory"
  | "limit-output";

export type ReshapeResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      finding: Finding;
      /** Set only when the output demonstrably caused the failure (see `ReshapeFailureKind`). */
      failureKind?: ReshapeFailureKind;
    };

export function jsonPathSelect(value: unknown, path: string): ReshapeResult {
  if (path === "" || path === "$") return { ok: true, value };
  const out = resolvePath(value, path);
  if (out === undefined)
    return {
      ok: false,
      failureKind: "selects-nothing",
      finding: {
        code: "reshape-failed",
        severity: "error",
        message: `JSONPath "${path}" selects nothing from the tool output`,
      },
    };
  return { ok: true, value: out };
}
