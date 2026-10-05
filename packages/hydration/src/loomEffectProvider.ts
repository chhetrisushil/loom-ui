import { toolInputJsonSchema } from "@loom/agent";
import { TypedFailure, jsonSchemaHash } from "@loom/core";
import type { EffectRuntime } from "@loom/effect-runtime";
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
 * The failure channel for an effect that itself raised `schemaDrift` (e.g. a target wrapping
 * `mcp.invoke`). Only the provider's OWN pin check may emit `schemaDrift`: a target's drift
 * would otherwise be read as this kind's pin drift, and a repair would re-pin to the inner
 * hash and flip forever. Served as the `tool-targetFailed` code (`tool-failed` to a client).
 */
export const TARGET_FAILED = "targetFailed";

/** The schema of an effect's input, as `tool$({ inputSchema })` takes it. */
export type EffectInputSchema = Parameters<typeof toolInputJsonSchema>[0];

/**
 * The pin of an effect's input contract: `jsonSchemaHash` (the one canonical hash MCP pins use)
 * of the schema's JSON-Schema form. Use it BOTH when the host builds a planner `CapabilityRef`
 * (`toolSchemaHash`) and when it lists the effect for {@link loomEffectProvider} (via
 * `{ inputSchema }`) so the two come from one source: editing the effect's zod schema moves
 * the pin, and every stored step drifts.
 */
export function effectPin(schema: EffectInputSchema): string {
  return jsonSchemaHash(toolInputJsonSchema(schema));
}

/** The effect kinds a data read can never reach: a person's answer, a model call. */
const REFUSED_KINDS: ReadonlySet<string> = new Set(["human", "llm"]);

/**
 * Effects hydration already reaches through a dedicated plane (the MCP kind, the sandbox
 * reshaper). Exposing them as a data TARGET would let a stored step bypass the pin and the
 * reshaping boundary, so a host cannot list them.
 */
const RESERVED_TARGETS: ReadonlySet<string> = new Set([MCP_INVOKE_TOOL_ID, SANDBOX_TOOL_ID]);

/** How a listed effect's pin is obtained: computed from its schema, or asserted by the host. */
export type EffectEntry =
  | { readonly inputSchema: NonNullable<EffectInputSchema> }
  | { readonly pin: string };

export interface LoomEffectProviderOptions {
  /**
   * The runtime the effects are registered with. Read at CONSTRUCTION only (`has` / `modeOf` /
   * `kindOf`): hydration is a read path that runs per viewer load, unmemoised and retried, so
   * every listed effect must be registered, explicitly `mode: "ambient"` (ADR 0073 — loom
   * refuses only an explicit `journaled` one on the transient path, so an UNDECLARED mode is
   * not a read declaration and is refused here), and not a `human` / `llm` kind.
   */
  readonly runtime: Pick<EffectRuntime, "has" | "modeOf" | "kindOf">;
  /**
   * The effects a stored step may name. `{ inputSchema }` computes the pin with
   * {@link effectPin} (a schema change drifts every stored step); `{ pin }` is HOST-ASSERTED —
   * nothing checks it against the effect, so the host owns changing it when callers must
   * re-author. A step naming an effect not listed is refused (`tool-targetUnregistered`) and
   * nothing runs. Pins must be non-empty.
   */
  readonly effects: Readonly<Record<string, EffectEntry>>;
}

/**
 * The `loom-effect` kind: a step whose `toolName` is the id of an effect registered with the
 * loom effect runtime (a `tool$`, a read-model query effect, an A2A call…), invoked through the
 * SAME transient invoker and therefore the same authoriser, budget and principal as the MCP
 * kind. Construction refuses an effect that is unregistered, not explicitly `ambient`, or a
 * `human` / `llm` kind.
 *
 * An effect's call is not memoised across a pass (the in-pass memo coalesces `mcp.invoke` only:
 * an arbitrary effect is not known to be a pure read), so two steps naming one effect with equal
 * arguments call it twice. (Memoising `ambient` effects is a possible follow-up.)
 *
 * A persisted experience crosses a version boundary only through the log: an older in-memory
 * `executeProvider` / `seal` that predates kinds would run a kinded step as an MCP call.
 */
export function loomEffectProvider(options: LoomEffectProviderOptions): DataProvider {
  const { runtime } = options;
  const pins = new Map<string, string>();
  for (const [id, entry] of Object.entries(options.effects)) {
    if (id === "") throw new TypeError("loomEffectProvider: an effect id is empty");
    if (RESERVED_TARGETS.has(id))
      throw new TypeError(
        `loomEffectProvider: "${id}" is reached through its own plane (the MCP kind / the sandbox) and cannot be a data target`
      );
    if (!runtime.has(id))
      throw new TypeError(`loomEffectProvider: effect "${id}" is not registered with the runtime`);
    if (runtime.modeOf(id) !== "ambient")
      throw new TypeError(
        `loomEffectProvider: effect "${id}" is not declared mode "ambient" (ADR 0073); a data read may not run an undeclared or journaled effect`
      );
    const kind = runtime.kindOf(id);
    if (kind !== undefined && REFUSED_KINDS.has(kind))
      throw new TypeError(
        `loomEffectProvider: effect "${id}" is a ${kind} effect, not a data read`
      );
    const pin =
      entry !== null && typeof entry === "object" && "inputSchema" in entry
        ? effectPin(entry.inputSchema)
        : (entry as { pin?: unknown } | null)?.pin;
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
      try {
        return await invoker.invokeTransient(call.target, call.args, opts);
      } catch (e) {
        if (e instanceof TypedFailure && e.channel === "schemaDrift")
          throw new TypedFailure(TARGET_FAILED, { target: call.target });
        throw e;
      }
    },
  });
}
