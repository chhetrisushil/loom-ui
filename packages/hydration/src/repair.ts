import type { Finding, Operation, ProviderSpec } from "@loom-ui/core";
import type { DriftRecord } from "./provider";

// ── Crossing the determinism boundary ─────────────────────────────────────────
// Hydration REPORTS drift; it never repairs. The app runs a durable loom execution that applies
// the operation built here (via core's `apply`, so the artifact's lineage records it), emits
// SCHEMA_REPAIRED with this payload, and re-seals. Input drift (a tool's input schema moved) is a
// pin move and can be remapped mechanically; output drift (the reshaped value's shape changed)
// means the reshaping is wrong for the data and needs the planner — that is a different slice.

export const SCHEMA_REPAIRED = "SCHEMA_REPAIRED";

export interface SchemaRepairedPayload {
  readonly experienceId: string;
  readonly versionHash: string;
  readonly handle: string;
  readonly drift: readonly DriftRecord[];
  readonly op: Operation;
}

export function remapOperation(
  spec: ProviderSpec,
  drift: readonly DriftRecord[]
): { ok: true; op: Operation } | { ok: false; finding: Finding } {
  if (drift.length === 0)
    return {
      ok: false,
      finding: { code: "repair-mismatch", severity: "error", message: "no drift to repair" },
    };
  if (drift.some((d) => d.kind === "output"))
    return {
      ok: false,
      finding: {
        code: "repair-needs-planner",
        severity: "error",
        message: `provider "${spec.handle}": output shape drifted; remapping a pin cannot fix a reshaping that no longer matches the data`,
      },
    };
  const steps = new Map(spec.executionGraph.map((s) => [s.stepId, s] as const));
  for (const d of drift) {
    if (d.handle !== spec.handle)
      return {
        ok: false,
        finding: {
          code: "repair-mismatch",
          severity: "error",
          message: `drift for "${d.handle}" applied to provider "${spec.handle}"`,
        },
      };
    if (d.stepId === undefined || !steps.has(d.stepId))
      return {
        ok: false,
        finding: {
          code: "repair-mismatch",
          severity: "error",
          message: `drift names step "${d.stepId ?? "?"}", which provider "${spec.handle}" does not have`,
        },
      };
  }
  const observedByStep = new Map(drift.map((d) => [d.stepId as string, d.observed]));
  const executionGraph = spec.executionGraph.map((s) =>
    observedByStep.has(s.stepId)
      ? { ...s, toolSchemaHash: observedByStep.get(s.stepId) as string }
      : s
  );
  return {
    ok: true,
    op: { type: "remapProvider", handle: spec.handle, spec: { ...spec, executionGraph } },
  };
}
