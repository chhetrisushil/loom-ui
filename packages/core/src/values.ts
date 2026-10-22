import { z } from "zod";
import { chatValueIssues } from "./chatValue";
import type { Finding } from "./experience";
import {
  type ContractRegistry,
  FRAMEWORK_KINDS,
  type ValueContract,
  checkHostContract,
  hasKindContract,
  isFrameworkContractKind,
  tableColumnFormat,
  tableColumnLabel,
} from "./kindValues";
import { mediaValueIssues } from "./mediaRef";
import { tableRowProblems } from "./tableRows";

// The zod-free vocabulary lives in kindValues.ts (a browser bundle imports it without zod);
// re-exported here so this module keeps its public surface.
export {
  FRAMEWORK_KINDS,
  hasKindContract,
  isFrameworkContractKind,
  tableColumnFormat,
  tableColumnLabel,
};
export type { ContractRegistry, ValueContract };

// ── Per-kind value contracts ──────────────────────────────────────────────────
// A compiled widget binds to `values.<handle>`; the kind says what shape that value must have.
// loom's own renderers never declared theirs — they duck-type — so this pins them: what the
// React renderers accept today, so a Lit renderer that accepts the same shape gives the
// "one web compile serves either renderer" property. The two framework kinds declare theirs
// here for the same reason. The slice-5 planner pins `outputShapeHash` to values that pass.

/**
 * What a number MEANS, so the reader's locale decides how it looks. The set is exactly what the
 * renderers HONOUR — five number semantics, each with a distinct rendering on the web, in the
 * spoken form and in the terminal — so a format never promises a rendering nobody draws. A
 * consumer with richer semantics (dates, durations, measurements) maps them to these at its own
 * boundary. A non-strict object: a payload carrying fields outside this contract still passes,
 * and those fields are simply not part of the parsed format.
 */
export const SemanticFormat = z
  .object({
    semanticType: z.enum(["number", "integer", "decimal", "percentage", "currency"]),
    /** ISO 4217. Well-formed is all `Intl.NumberFormat` requires; a malformed code throws there. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    notation: z.enum(["standard", "compact"]).optional(),
    // 0..20: outside it `Intl.NumberFormat` throws a RangeError out of a render.
    minimumFractionDigits: z.number().int().min(0).max(20).optional(),
    maximumFractionDigits: z.number().int().min(0).max(20).optional(),
  })
  // min > max is also a RangeError out of `Intl.NumberFormat`, so it is refused here instead.
  .refine(
    (f) =>
      f.minimumFractionDigits === undefined ||
      f.maximumFractionDigits === undefined ||
      f.minimumFractionDigits <= f.maximumFractionDigits,
    { message: "minimumFractionDigits must not exceed maximumFractionDigits" }
  )
  // A generic framework assumes no currency: the code is what the format means.
  .refine((f) => f.semanticType !== "currency" || f.currency !== undefined, {
    message: "a currency format needs its ISO 4217 `currency` code — no currency is assumed",
  })
  // An integer is whole by definition: asking it for fraction digits is a contradiction, refused
  // here rather than silently overridden at format time.
  .refine(
    (f) =>
      f.semanticType !== "integer" ||
      ((f.minimumFractionDigits ?? 0) === 0 && (f.maximumFractionDigits ?? 0) === 0),
    {
      message:
        "an integer format takes no fraction digits (minimum/maximumFractionDigits must be 0)",
    }
  );
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
/** One action a table row offers. */
export const TableRowAction = z.object({
  id: z.string(),
  label: z.string(),
  primary: z.boolean().optional(),
  destructive: z.boolean().optional(),
});
/** Columnar: headings (with optional per-column semantics) and rows of cells in column order. */
export const TableValue = z
  .object({
    columns: z.array(TableColumn),
    rows: z.array(z.array(TableCell)),
    rowKeys: z.array(z.string()).optional(),
    rowActions: z.array(z.array(TableRowAction)).optional(),
  })
  .superRefine((v, ctx) => {
    for (const p of tableRowProblems(v))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: p.path, message: p.message });
  });
export type TableValue = z.infer<typeof TableValue>;

export const StatusLevel = z.enum(["ok", "warning", "critical"]);
export type StatusLevel = z.infer<typeof StatusLevel>;
export const StatusCardValue = z.object({
  level: StatusLevel,
  headline: z.string(),
  detail: z.string().optional(),
});
export type StatusCardValue = z.infer<typeof StatusCardValue>;

/**
 * A MediaRef for `kind`: the SHARED checker (`media.ts`) drives zod, so the zod-free contract in
 * `kindValues.ts` cannot drift from it. Messages are value-free.
 */
const mediaRefContract = (kind: string): z.ZodType =>
  z.unknown().superRefine((v, ctx) => {
    for (const i of mediaValueIssues(kind, v))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...i.path], message: i.message });
  });

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
  Image: mediaRefContract("Image"),
  Audio: mediaRefContract("Audio"),
  Video: mediaRefContract("Video"),
  File: mediaRefContract("File"),
  // Static (props only): a value reaching an upload control is a defect.
  MediaInput: z.undefined(),
  // U8: the transcript contract is the shared checker (`chatValue.ts`); the inputs are static.
  Chat: z.unknown().superRefine((v, ctx) => {
    for (const i of chatValueIssues(v))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...i.path], message: i.message });
  }),
  TextInput: z.undefined(),
  FormInput: z.undefined(),
  // The CURRENT choice, when the host binds one (display only; the user still submits). Optional.
  SelectInput: z.string().optional(),
};

export function kindValueContract(
  kind: string,
  contracts?: ContractRegistry
): ValueContract | undefined {
  if (Object.hasOwn(kindValueContracts, kind)) return kindValueContracts[kind];
  return contracts !== undefined && Object.hasOwn(contracts, kind) ? contracts[kind] : undefined;
}

/**
 * `undefined` is "not hydrated yet" and passes; an UNCONTRACTED kind (neither the framework's nor
 * in the host's `contracts`) passes too — callers that must not be vacuous ask `hasKindContract`.
 * The framework's contract wins for a framework kind: `contracts` only ever adds kinds.
 */
export function checkKindValue(
  kind: string,
  value: unknown,
  contracts?: ContractRegistry
): { ok: true } | { ok: false; finding: Finding } {
  const schema = kindValueContract(kind, contracts);
  if (schema === undefined || value === undefined) return { ok: true };
  // A HOST contract is untrusted code (see `checkHostContract`); the framework's is ours.
  if (!Object.hasOwn(kindValueContracts, kind)) return checkHostContract(kind, schema, value);
  const r = schema.safeParse(value);
  if (r.success) return { ok: true };
  const issue = r.error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  return {
    ok: false,
    finding: {
      code: "value-contract",
      severity: "error",
      message: `value for kind "${kind}" does not match its contract at ${path || "<root>"}: ${issue?.message ?? "invalid"}`,
    },
  };
}
