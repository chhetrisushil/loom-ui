import { checkKindValue } from "@loom-ui/core";
import type { BarChartValue, TimeSeriesValue } from "@loom-ui/core";
import { type SemanticFormat, effectiveFormat, measure } from "./format";
import { t } from "./i18n";

/**
 * A spoken summary of a rendered value — the accessible name a screen reader gets. `props` is
 * the widget's own props, the same object its `renderReady` reads: a widget whose displayed
 * figure falls back to `props.format` / `props.unit` when the value carries neither must be
 * heard the same way, not as a plain number.
 */
export function describeValue(
  kind: string,
  value: unknown,
  title: string,
  props?: Record<string, unknown>
): string {
  if (value === undefined) return loadingStateText(title);
  if (!checkKindValue(kind, value).ok) return errorStateText(title);
  const p = props as { format?: SemanticFormat; unit?: string } | undefined;
  switch (kind) {
    case "MetricCard": {
      const fmt = effectiveFormat(p?.format, p?.unit);
      const suffix = fmt === undefined && p?.unit ? ` ${p.unit}` : "";
      return `${title}: ${measure(value as number, fmt)}${suffix}`;
    }
    case "ProgressBar":
      return `${title}: ${measure(value as number)}`;
    case "StatusBadge":
    case "AlertCard":
    case "StreamingText":
      return `${title}: ${String(value)}`;
    case "DataTable": {
      const rows = value as Record<string, unknown>[];
      return `${title}: ${t("table with")} ${rows.length} ${t("rows")}`;
    }
    case "Timeline":
      return `${title}: ${(value as unknown[]).length} ${t("entries")}`;
    case "TimeSeries": {
      const v = value as TimeSeriesValue;
      const parts = v.series.map((s) => {
        const last = s.points[s.points.length - 1];
        const fmt = effectiveFormat(s.format ?? p?.format, s.unit ?? p?.unit);
        const unit = s.unit ?? p?.unit;
        const suffix = fmt === undefined && unit ? ` ${unit}` : "";
        return `${s.label} ${last ? measure(last.value, fmt) : "—"}${suffix}`;
      });
      return `${title}: ${parts.join(", ")}`;
    }
    case "BarChart": {
      const v = value as BarChartValue;
      const unit = v.unit ?? p?.unit;
      const fmt = effectiveFormat(v.format ?? p?.format, unit);
      const suffix = fmt === undefined && unit ? ` ${unit}` : "";
      return `${title}: ${v.bars.map((b) => `${b.label} ${measure(b.value, fmt)}`).join(", ")}${suffix}`;
    }
    default:
      return title;
  }
}
export function emptyStateText(): string {
  return t("No data");
}
export function loadingStateText(title: string): string {
  return `${title}: ${t("loading")}`;
}
export function errorStateText(title: string): string {
  return `${title}: ${t("error")}`;
}
export function staleStateText(title: string): string {
  return `${title}: ${t("stale")}`;
}
