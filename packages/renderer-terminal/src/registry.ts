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

export function sparkline(values: readonly number[]): string {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return "";
  const min = Math.min(...finite);
  const max = Math.max(...finite);
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
  const max = Math.max(1, ...bars.map((b) => Math.abs(b.value)).filter(Number.isFinite));
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
