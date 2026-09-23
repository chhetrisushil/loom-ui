import {
  type BarChartValue,
  type KpiValue,
  LocalizedText,
  type SemanticFormat,
  type StatusCardValue,
  type TableCell,
  type TableValue,
  type TimeSeriesValue,
  checkKindValue,
  formatSemanticNumber,
  tableColumnFormat,
  tableColumnLabel,
} from "@loom-ui/core";
import { RendererRegistry, type Widget } from "@loom/blueprint-runtime";
import {
  type TerminalWidgetRenderer,
  defaultTerminalRegistry,
} from "@loom/plugin-renderer-terminal";

const SPARK = "▁▂▃▄▅▆▇█";
const title = (w: Widget): string => w.title ?? w.kind;
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s.padEnd(n));
const num = (v: number): string => (Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "—");

/**
 * A number in its semantics, deterministically (no locale): a fraction as a percentage, a
 * currency with its ISO code, else the unit as a suffix ("%" hugs the number). An `integer`
 * column rounds AND groups digits — "1,234", not "1234.4" — via `@loom-ui/core`'s
 * `formatSemanticNumber`, the same Intl.NumberFormat-options mapping the DOM renderer's
 * `measure()` uses (renderer-lit is an ESM/lit-DOM package this CommonJS one cannot import, so
 * the shared, DOM-free part of that logic lives in core instead of being re-derived here).
 */
function formatted(
  v: number,
  format: SemanticFormat | undefined,
  unit: string | undefined
): string {
  if (!Number.isFinite(v)) return "—";
  if (format?.semanticType === "percentage") return `${num(v * 100)}%`;
  if (format?.semanticType === "currency") return `${num(v)} ${format.currency ?? "USD"}`;
  if (format?.semanticType === "integer") return formatSemanticNumber(v, format, "en-US");
  if (unit === undefined || unit === "") return num(v);
  return unit === "%" ? `${num(v)}%` : `${num(v)} ${unit}`;
}

/**
 * Min and max of the finite values, in one pass — never `Math.min(...values)` /
 * `Math.max(...values)`, which spreads the whole array into call arguments and hits V8's
 * argument-count ceiling on a long series. `undefined` iff no value is finite.
 */
function finiteMinMax(values: readonly number[]): { min: number; max: number } | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    seen = true;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return seen ? { min, max } : undefined;
}

export function sparkline(values: readonly number[]): string {
  const range = finiteMinMax(values);
  if (range === undefined) return "";
  const { min, max } = range;
  return values
    .map((v) =>
      Number.isFinite(v)
        ? SPARK[max === min ? 0 : Math.round(((v - min) / (max - min)) * (SPARK.length - 1))]
        : " "
    )
    .join("");
}

const guarded =
  (kind: string, body: (w: Widget, v: unknown) => string): TerminalWidgetRenderer =>
  (w, v) => {
    const check = checkKindValue(kind, v);
    if (!check.ok) return `✗ ${title(w)}: ${check.finding.message}`;
    if (v === undefined) return `${title(w)}: —`;
    return body(w, v);
  };

const timeSeries = guarded("TimeSeries", (w, v) => {
  const { series } = v as TimeSeriesValue;
  const lines = series.map((s) => {
    const values = s.points.map((p) => p.value);
    const last = values.length > 0 ? (values[values.length - 1] as number) : Number.NaN;
    return `    ${pad(`${s.label}${s.axis === "right" ? " (R)" : ""}`, 12)} ${sparkline(values)}  ${num(last)}${s.unit ? ` ${s.unit}` : ""}`;
  });
  return [`${title(w)}:`, ...lines].join("\n");
});

const barChart = guarded("BarChart", (w, v) => {
  const { bars, unit } = v as BarChartValue;
  // Single-pass max (never Math.max(...spread) — same argument-count hazard as sparkline's
  // min/max), floored at 1 so an all-non-finite/zero series never divides by zero below.
  let max = 1;
  for (const b of bars) {
    const abs = Math.abs(b.value);
    if (Number.isFinite(abs) && abs > max) max = abs;
  }
  const lines = bars.map((b) => {
    const filled = Number.isFinite(b.value) ? Math.round((Math.abs(b.value) / max) * 20) : 0;
    return `    ${pad(b.label, 12)} ${"█".repeat(filled)}${"·".repeat(20 - filled)} ${num(b.value)}${unit ?? ""}`;
  });
  return [`${title(w)}:`, ...lines].join("\n");
});

const kpi = guarded("Kpi", (w, v) => {
  const k = v as KpiValue;
  const props = w.props as { unit?: string; format?: SemanticFormat };
  const delta = k.deltaPct ?? null;
  const change = delta === null ? "" : `  ${delta >= 0 ? "▲" : "▼"} ${num(Math.abs(delta) * 100)}%`;
  const label = k.label !== undefined ? ` (${k.label})` : "";
  return `${title(w)}: ${formatted(k.value, k.format ?? props.format, k.unit ?? props.unit)}${change}${label}`;
});

/** Rows printed before the "… N more rows" line. */
const TABLE_ROWS = 20;
/** Widest a terminal column grows before its cells are cut. */
const TABLE_COL_MAX = 24;

const table = guarded("Table", (w, v) => {
  const t = v as TableValue;
  const labels = t.columns.map(tableColumnLabel);
  const formats = t.columns.map(tableColumnFormat);
  const cellText = (c: TableCell): string =>
    c === null ? "—" : typeof c === "number" ? formatted(c, undefined, undefined) : c;
  const body = t.rows.slice(0, TABLE_ROWS).map((row) =>
    labels.map((_, i) => {
      const c = row[i] ?? null;
      const f = formats[i];
      return typeof c === "number" && f !== undefined ? formatted(c, f, undefined) : cellText(c);
    })
  );
  // Single pass per column (never Math.max(...spread)); capped so one long cell cannot push
  // every other column off the screen.
  const widths = labels.map((label, i) => {
    let width = label.length;
    for (const row of body) width = Math.max(width, (row[i] ?? "").length);
    return Math.min(width, TABLE_COL_MAX);
  });
  const line = (cells: readonly string[]): string =>
    `    ${cells.map((c, i) => pad(c, widths[i] ?? 0)).join("  ")}`.trimEnd();
  const out = [`${title(w)}:`, line(labels), ...body.map(line)];
  if (t.rows.length > TABLE_ROWS) out.push(`    … ${t.rows.length - TABLE_ROWS} more rows`);
  return out.join("\n");
});

const statusCard = guarded("StatusCard", (w, v) => {
  const s = v as StatusCardValue;
  return `${title(w)}: [${s.level}] ${s.headline}${s.detail ? ` — ${s.detail}` : ""}`;
});

// Never bound, so never `guarded`: loom calls a channel-less widget's renderer directly, with
// `value === undefined`, and the text lives in props (a string after compile; an uncompiled
// LocalizedText shows its fallback, never its key).
const note: TerminalWidgetRenderer = (w) => {
  const raw = w.props.text;
  const parsed = LocalizedText.safeParse(raw);
  const text = typeof raw === "string" ? raw : parsed.success ? parsed.data.fallback : "";
  return w.title ? `${w.title}: ${text}` : text;
};

// The A2UI tree and the sandboxed component are web surfaces: an interpreter this CommonJS
// package cannot import, and code that cannot run in a terminal. Say so, don't fake it.
const a2uiView = guarded("A2UIView", (w) => `${title(w)}: [A2UI view — rendered on the web]`);
const sandboxView = guarded(
  "SandboxView",
  (w) => `${title(w)}: [sandboxed component — rendered on the web]`
);

export const loomUiTerminalRegistry: RendererRegistry<TerminalWidgetRenderer> =
  new RendererRegistry<TerminalWidgetRenderer>()
    .register("TimeSeries", timeSeries)
    .register("BarChart", barChart)
    .register("Kpi", kpi)
    .register("Table", table)
    .register("StatusCard", statusCard)
    .register("Note", note)
    .register("A2UIView", a2uiView)
    .register("SandboxView", sandboxView);

/** loom's eight built-ins plus the framework's kinds. A NEW registry each call — never mutate a shared one. */
export function terminalRegistry(): RendererRegistry<TerminalWidgetRenderer> {
  return defaultTerminalRegistry.merge(loomUiTerminalRegistry);
}
