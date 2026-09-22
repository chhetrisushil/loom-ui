import { canonicalJson, fnv1a64 } from "@loom/core";
import type { CapabilityRef, ComposeInput, ReviseInput } from "./spi";

/** What a decision is keyed on: the inputs that change the PROMPT. Samples only pin shapes. */
const capabilityKey = (c: CapabilityRef) => ({
  handle: c.handle,
  toolName: c.toolName,
  toolVersion: c.toolVersion,
  toolSchemaHash: c.toolSchemaHash,
});

export function planDecisionId(
  kind: "compose",
  input: Pick<ComposeInput, "intent" | "catalog" | "capabilities"> & { context?: unknown }
): string;
export function planDecisionId(
  kind: "revise",
  input: {
    versionHash: string;
    request: ReviseInput["request"];
    capabilities?: readonly CapabilityRef[];
    context?: unknown;
  }
): string;
export function planDecisionId(kind: "compose" | "revise", input: Record<string, unknown>): string {
  const key =
    kind === "compose"
      ? {
          intent: input.intent,
          catalogId: (input.catalog as { id: string }).id,
          capabilities: (input.capabilities as readonly CapabilityRef[]).map(capabilityKey),
          context: input.context ?? null,
        }
      : {
          versionHash: input.versionHash,
          request: input.request,
          capabilities: ((input.capabilities as readonly CapabilityRef[] | undefined) ?? []).map(
            capabilityKey
          ),
          context: input.context ?? null,
        };
  return `plan:${kind}:${fnv1a64(canonicalJson(key))}`;
}
