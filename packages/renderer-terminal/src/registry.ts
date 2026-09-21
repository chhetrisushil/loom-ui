import { type BarChartValue, type TimeSeriesValue, checkKindValue } from "@loom-ui/core";
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
    return `    ${pad(s.label, 12)} ${sparkline(values)}  ${num(last)}${s.unit ? ` ${s.unit}` : ""}`;
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

export const loomUiTerminalRegistry: RendererRegistry<TerminalWidgetRenderer> =
  new RendererRegistry<TerminalWidgetRenderer>()
    .register("TimeSeries", timeSeries)
    .register("BarChart", barChart);

/** loom's eight built-ins plus the framework's kinds. A NEW registry each call — never mutate a shared one. */
export function terminalRegistry(): RendererRegistry<TerminalWidgetRenderer> {
  return defaultTerminalRegistry.merge(loomUiTerminalRegistry);
}
