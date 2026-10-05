import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { SANDBOX_TOOL_ID } from "@loom/plugin-sandbox";
import type { DataProvider } from "./dataProvider";

/** The kind id of a step whose target is a registered loom effect. */
export const LOOM_EFFECT_KIND = "loom-effect";

/**
 * The failure channel for a target the host did not declare. Served to a client as the fixed
 * `tool-targetUnregistered` code — never the target id or any text of the effect's own.
 */
export const TARGET_UNREGISTERED = "targetUnregistered";

/**
 * Effects hydration already reaches through a dedicated plane (the MCP kind, the sandbox
 * reshaper). Exposing them as a data TARGET would let a stored step bypass the pin and the
 * reshaping boundary, so a host cannot list them.
 */
const RESERVED_TARGETS: ReadonlySet<string> = new Set([MCP_INVOKE_TOOL_ID, SANDBOX_TOOL_ID]);

export interface LoomEffectProviderOptions {
  /**
   * The effects a stored step may name, each with its CURRENT pin: the host's fingerprint of that
   * effect's input contract (a hash of its zod schema, a version tag — whatever changes exactly
   * when callers must re-author). A step naming an effect not listed here is refused
   * (`tool-targetUnregistered`) and nothing runs — a stored (or planner-authored) experience can
   * name any string, so "any registered effect" is a host decision made here, not a default.
   * Pins must be non-empty.
   */
  readonly effects: Readonly<Record<string, string>>;
}

/**
 * The `loom-effect` kind: a step whose `toolName` is the id of an effect registered with the
 * loom effect runtime (a `tool$`, a read-model query effect, an A2A call…), invoked through the
 * SAME transient invoker and therefore the same authoriser, budget and principal as the MCP
 * kind. The effect must be `ambient`-or-undeclared (the runtime itself refuses a `journaled`
 * one on the transient path, surfacing as `tool-failed`).
 *
 * An effect's call is not memoised across a pass (the in-pass memo coalesces `mcp.invoke` only:
 * an arbitrary effect is not known to be a pure read), so two steps naming one effect with equal
 * arguments call it twice.
 */
export function loomEffectProvider(options: LoomEffectProviderOptions): DataProvider {
  const pins = new Map<string, string>();
  for (const [id, pin] of Object.entries(options.effects)) {
    if (id === "") throw new TypeError("loomEffectProvider: an effect id is empty");
    if (RESERVED_TARGETS.has(id))
      throw new TypeError(
        `loomEffectProvider: "${id}" is reached through its own plane (the MCP kind / the sandbox) and cannot be a data target`
      );
    if (typeof pin !== "string" || pin === "")
      throw new TypeError(`loomEffectProvider: effect "${id}" needs a non-empty pin`);
    pins.set(id, pin);
  }
  return Object.freeze<DataProvider>({
    kind: LOOM_EFFECT_KIND,
    async invoke(call, invoker, opts) {
      const current = pins.get(call.target);
      if (current === undefined)
        throw new TypedFailure(TARGET_UNREGISTERED, { target: call.target });
      if (current !== call.expectedPin)
        throw new TypedFailure("schemaDrift", {
          toolName: call.target,
          expectedSchemaHash: call.expectedPin,
          observedHash: current,
        });
      return invoker.invokeTransient(call.target, call.args, opts);
    },
  });
}
