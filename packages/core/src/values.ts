import { z } from "zod";
import type { Finding } from "./experience";

// ── Per-kind value contracts ──────────────────────────────────────────────────
// A compiled widget binds to `values.<handle>`; the kind says what shape that value must have.
// loom's own renderers never declared theirs — they duck-type — so this pins them: what the
// React renderers accept today, so a Lit renderer that accepts the same shape gives the
// "one web compile serves either renderer" property. The two framework kinds declare theirs
// here for the same reason. The slice-5 planner pins `outputShapeHash` to values that pass.

export const TimeSeriesValue = z.object({
  series: z.array(
    z.object({
      label: z.string(),
      unit: z.string().optional(),
      points: z.array(z.object({ timestamp: z.string(), value: z.number() })),
    })
  ),
});
export type TimeSeriesValue = z.infer<typeof TimeSeriesValue>;

export const BarChartValue = z.object({
  unit: z.string().optional(),
  bars: z.array(z.object({ label: z.string(), value: z.number() })),
});
export type BarChartValue = z.infer<typeof BarChartValue>;

export const FRAMEWORK_KINDS = ["TimeSeries", "BarChart"] as const;

export const kindValueContracts: Readonly<Record<string, z.ZodType>> = {
  MetricCard: z.number(),
  StatusBadge: z.string(),
  ProgressBar: z.number(),
  AlertCard: z.string(),
  StreamingText: z.string(),
  Timeline: z.array(z.unknown()),
  DataTable: z.array(z.record(z.unknown())),
  ApprovalCard: z.unknown(),
  TimeSeries: TimeSeriesValue,
  BarChart: BarChartValue,
};

export function kindValueContract(kind: string): z.ZodType | undefined {
  return Object.hasOwn(kindValueContracts, kind) ? kindValueContracts[kind] : undefined;
}

/** `undefined` is "not hydrated yet" and passes; an unknown kind has no contract and passes. */
export function checkKindValue(
  kind: string,
  value: unknown
): { ok: true } | { ok: false; finding: Finding } {
  const schema = kindValueContract(kind);
  if (schema === undefined || value === undefined) return { ok: true };
  const r = schema.safeParse(value);
  if (r.success) return { ok: true };
  const issue = r.error.issues[0];
  const path = issue?.path.join(".") ?? "";
  return {
    ok: false,
    finding: {
      code: "value-contract",
      severity: "error",
      message: `value for kind "${kind}" does not match its contract at ${path || "<root>"}: ${issue?.message ?? "invalid"}`,
    },
  };
}
