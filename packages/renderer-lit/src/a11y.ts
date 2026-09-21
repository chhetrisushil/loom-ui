import { checkKindValue } from "@loom-ui/core";
import type { BarChartValue, TimeSeriesValue } from "@loom-ui/core";
import { measure } from "./format";
import { t } from "./i18n";

/** A spoken summary of a rendered value — the accessible name a screen reader gets. */
export function describeValue(kind: string, value: unknown, title: string): string {
  if (value === undefined) return loadingStateText(title);
  if (!checkKindValue(kind, value).ok) return errorStateText(title);
  switch (kind) {
    case "MetricCard":
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
        return `${s.label} ${last ? measure(last.value) : "—"}${s.unit ? ` ${s.unit}` : ""}`;
      });
      return `${title}: ${parts.join(", ")}`;
    }
    case "BarChart": {
      const v = value as BarChartValue;
      return `${title}: ${v.bars.map((b) => `${b.label} ${measure(b.value)}`).join(", ")}${v.unit ? ` ${v.unit}` : ""}`;
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
