import type { Surface } from "@loom-ui/core";
import { canonicalJson, fnv1a64 } from "@loom/core";
import type { CapabilityRef, ComposeInput, ReviseInput } from "./spi";

/**
 * What a decision is keyed on: EVERY input that shapes the prompt — intent/request, catalogue
 * CONTENT (not just its id: an entry's props or surface resolution can change under a stable id,
 * and both reach the prompt), the offered capabilities including the tool-authored text the model
 * reads, the caller's context, and the SURFACE (it selects the validation the plan must survive,
 * so a plan made for one is not a plan for the other).
 *
 * `sampleOutput` is deliberately NOT part of the key. A sample pins shapes, it is not prose the
 * model reasons from, and — decisively — `reviseForDrift` hands a NEW sample to a NEW revise
 * request, which already has its own id through `request`. Keying on the sample instead would
 * make every re-fetch of the same tool a different decision, so a replay would silently re-plan.
 * The same holds for a revise's per-handle `observed` samples: only WHICH handles were observed is
 * keyed (it decides which providers can be re-pinned at all), never the sample values — and only
 * when there is at least one, so a revise without observations keeps the id it always had.
 */
const capabilityKey = (c: CapabilityRef) => ({
  handle: c.handle,
  // Only a non-MCP kind adds a key: a capability with none keeps the decision id it always had.
  ...(c.kind !== undefined && { kind: c.kind }),
  toolName: c.toolName,
  toolVersion: c.toolVersion,
  toolSchemaHash: c.toolSchemaHash,
  description: c.description ?? null,
  inputSchema: c.inputSchema ?? null,
});

/** The catalogue's CONTENT, so an entry edited under a stable id is a different decision. */
const catalogKey = (catalog: { id: string; entries: unknown }) => ({
  id: catalog.id,
  entries: fnv1a64(canonicalJson(catalog.entries)),
});

export function planDecisionId(
  kind: "compose",
  input: Pick<ComposeInput, "intent" | "catalog" | "capabilities"> & {
    context?: unknown;
    surface?: Surface;
  }
): string;
export function planDecisionId(
  kind: "revise",
  input: {
    versionHash: string;
    request: ReviseInput["request"];
    catalog?: ReviseInput["catalog"];
    capabilities?: readonly CapabilityRef[];
    context?: unknown;
    surface?: Surface;
    /** The handles `ReviseInput.observed` carries a sample for. */
    observedHandles?: readonly string[];
  }
): string;
export function planDecisionId(kind: "compose" | "revise", input: Record<string, unknown>): string {
  const surface = (input.surface as Surface | undefined) ?? "web";
  const catalog = input.catalog as ReviseInput["catalog"] | undefined;
  const key =
    kind === "compose"
      ? {
          intent: input.intent,
          catalog: catalogKey(input.catalog as ComposeInput["catalog"]),
          capabilities: (input.capabilities as readonly CapabilityRef[]).map(capabilityKey),
          context: input.context ?? null,
          surface,
        }
      : {
          versionHash: input.versionHash,
          request: input.request,
          catalog: catalog === undefined ? null : catalogKey(catalog),
          capabilities: ((input.capabilities as readonly CapabilityRef[] | undefined) ?? []).map(
            capabilityKey
          ),
          context: input.context ?? null,
          surface,
          ...(Array.isArray(input.observedHandles) &&
            input.observedHandles.length > 0 && {
              observedHandles: [...(input.observedHandles as readonly string[])].sort(),
            }),
        };
  return `plan:${kind}:${fnv1a64(canonicalJson(key))}`;
}
