import { z } from "zod";
import type { Finding } from "./experience";

// ── Per-kind value contracts ──────────────────────────────────────────────────
// A compiled widget binds to `values.<handle>`; the kind says what shape that value must have.
// loom's own renderers never declared theirs — they duck-type — so this pins them: what the
// React renderers accept today, so a Lit renderer that accepts the same shape gives the
// "one web compile serves either renderer" property. The two framework kinds declare theirs
// here for the same reason. The slice-5 planner pins `outputShapeHash` to values that pass.

/**
 * What a number MEANS, so the reader's locale decides how it looks — the framework's set of
 * number/date/currency semantics. A contract narrower than the payloads it guards would turn a
 * healthy `duration` column into a contract failure (and, under output-check-by-contract, into
 * drift), so every semantic type a producer might emit is accepted; a renderer with no special
 * rendering for a type formats it as a plain number.
 */
export const SemanticFormat = z.object({
  semanticType: z.enum([
    "number",
    "integer",
    "decimal",
    "currency",
    "percentage",
    "date",
    "time",
    "datetime",
    "duration",
    "unit",
    "measurement",
    "region",
    "country",
    "language",
  ]),
  /** ISO 4217. Well-formed is all `Intl.NumberFormat` requires; a malformed code throws there. */
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  unit: z.string().optional(),
  notation: z.enum(["standard", "compact"]).optional(),
  // 0..20: outside it `Intl.NumberFormat` throws a RangeError out of a render.
  minimumFractionDigits: z.number().int().min(0).max(20).optional(),
  maximumFractionDigits: z.number().int().min(0).max(20).optional(),
  dateStyle: z.enum(["short", "medium", "long", "full"]).optional(),
  timeStyle: z.enum(["short", "medium", "long", "full"]).optional(),
});
export type SemanticFormat = z.infer<typeof SemanticFormat>;

/**
 * Which y-axis a series is scaled against. A series whose unit differs from the rest of the
 * chart — bytes alongside requests, say — would flatten to a near-flat line sharing one scale;
 * assigning it "right" gives it its own scale and its own labelled axis.
 */
export const ChartAxis = z.enum(["left", "right"]);
export type ChartAxis = z.infer<typeof ChartAxis>;

export const TimeSeriesValue = z.object({
  series: z.array(
    z.object({
      label: z.string(),
      /** Legacy display suffix; `format` supersedes it when both are present. */
      unit: z.string().optional(),
      format: SemanticFormat.optional(),
      axis: ChartAxis.optional(),
      points: z.array(z.object({ timestamp: z.string(), value: z.number() })),
    })
  ),
});
export type TimeSeriesValue = z.infer<typeof TimeSeriesValue>;

export const BarChartValue = z.object({
  unit: z.string().optional(),
  format: SemanticFormat.optional(),
  bars: z.array(z.object({ label: z.string(), value: z.number() })),
});
export type BarChartValue = z.infer<typeof BarChartValue>;

// ── Widget value contracts ──────────────────────────────────────────────────────
// These conflict with loom's MetricCard (a number), DataTable (records) and StatusBadge (a
// string), whose contracts loom's React renderers depend on — so they are NEW kinds, never a
// widening of loom's. A value may carry an extra discriminator field; a non-strict object
// ignores unrecognized keys.

export const KpiValue = z.object({
  value: z.number(),
  unit: z.string().optional(),
  format: SemanticFormat.optional(),
  label: z.string().optional(),
  /** A FRACTION (0.12 is +12%), rendered as a percentage. `null` = no comparison available. */
  deltaPct: z.number().nullable().optional(),
});
export type KpiValue = z.infer<typeof KpiValue>;

export const TableColumn = z.union([
  z.string(),
  z.object({ label: z.string(), format: SemanticFormat.optional() }),
]);
export type TableColumn = z.infer<typeof TableColumn>;
export const TableCell = z.union([z.string(), z.number(), z.null()]);
export type TableCell = z.infer<typeof TableCell>;
/** Columnar: headings (with optional per-column semantics) and rows of cells in column order. */
export const TableValue = z.object({
  columns: z.array(TableColumn),
  rows: z.array(z.array(TableCell)),
});
export type TableValue = z.infer<typeof TableValue>;

/** A column's heading, whichever form it was written in. */
export function tableColumnLabel(column: TableColumn): string {
  return typeof column === "string" ? column : column.label;
}
/** A column's semantics, if it declared any. */
export function tableColumnFormat(column: TableColumn): SemanticFormat | undefined {
  return typeof column === "string" ? undefined : column.format;
}

export const StatusLevel = z.enum(["ok", "warning", "critical"]);
export type StatusLevel = z.infer<typeof StatusLevel>;
export const StatusCardValue = z.object({
  level: StatusLevel,
  headline: z.string(),
  detail: z.string().optional(),
});
export type StatusCardValue = z.infer<typeof StatusCardValue>;

export const FRAMEWORK_KINDS = [
  "TimeSeries",
  "BarChart",
  "Kpi",
  "Table",
  "StatusCard",
  "Note",
] as const;

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
  Kpi: KpiValue,
  Table: TableValue,
  StatusCard: StatusCardValue,
  // Static text from props: a Note is never bound, so any value that reaches it is a defect.
  Note: z.undefined(),
  // The bound value is the embedded view's / component's data model — any JSON.
  A2UIView: z.unknown(),
  SandboxView: z.unknown(),
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
