import { DELTA_FORMAT, checkKindValue, deltaDirection, unitSuffix } from "@loom-ui/core/browser";
import type {
  BarChartValue,
  KpiValue,
  StatusCardValue,
  TableValue,
  TimeSeriesValue,
} from "@loom-ui/core/browser";
import { type SemanticFormat, effectiveFormat, measure } from "./format";
import { t } from "./i18n";
import { tPlural } from "./plural";

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
      return `${title}: ${measure(value as number, fmt)}${spokenUnit(fmt, p?.unit)}`;
    }
    case "ProgressBar":
      return `${title}: ${measure(value as number)}`;
    case "StatusBadge":
    case "AlertCard":
    case "StreamingText":
      return `${title}: ${String(value)}`;
    case "DataTable": {
      const rows = value as Record<string, unknown>[];
      return `${title}: ${tableWith(rows.length)}`;
    }
    case "Timeline": {
      const n = (value as unknown[]).length;
      return `${title}: ${n} ${tPlural("entry", n, { one: "entry", other: "entries" })}`;
    }
    case "TimeSeries": {
      const v = value as TimeSeriesValue;
      const parts = v.series.map((s) => {
        const last = s.points[s.points.length - 1];
        const fmt = effectiveFormat(s.format ?? p?.format, s.unit ?? p?.unit);
        const unit = s.unit ?? p?.unit;
        return `${s.label} ${last ? measure(last.value, fmt) : "—"}${spokenUnit(fmt, unit)}`;
      });
      // The kind comes first, as for a table ("table with N rows"): the series names alone say
      // WHAT is plotted, not that it is a line chart a reader cannot see.
      return `${title}: ${t("line chart")}, ${parts.join(", ")}`;
    }
    case "BarChart": {
      const v = value as BarChartValue;
      const unit = v.unit ?? p?.unit;
      const fmt = effectiveFormat(v.format ?? p?.format, unit);
      return `${title}: ${t("bar chart")}, ${v.bars.map((b) => `${b.label} ${measure(b.value, fmt)}`).join(", ")}${spokenUnit(fmt, unit)}`;
    }
    case "Kpi": {
      const v = value as KpiValue;
      // Same fallback lu-kpi's renderReady uses: the value's own unit/format win, then the
      // widget's props — the spoken text must not drop to a bare number when only props carry
      // the semantics.
      const unit = v.unit ?? p?.unit;
      const fmt = effectiveFormat(v.format ?? p?.format, unit);
      const delta = v.deltaPct ?? null;
      const direction = delta === null ? undefined : deltaDirection(delta);
      const change =
        delta === null || direction === undefined || direction === "none"
          ? ""
          : direction === "flat"
            ? `, ${t("unchanged")}`
            : `, ${t(direction)} ${measure(Math.abs(delta), DELTA_FORMAT)}`;
      // The label is a caption beside the title, heard with it — never in its place.
      const name = v.label ? `${title}, ${v.label}` : title;
      return `${name}: ${measure(v.value, fmt)}${spokenUnit(fmt, unit)}${change}`;
    }
    case "Table":
      return `${title}: ${tableWith((value as TableValue).rows.length)}`;
    case "StatusCard": {
      const v = value as StatusCardValue;
      return `${title}: ${t(v.level)}, ${v.headline}${v.detail ? `. ${v.detail}` : ""}`;
    }
    default:
      return title;
  }
}
/** One phrase for every table, so Table, DataTable and their <caption>s read alike. */
function tableWith(rows: number): string {
  return `${t("table with")} ${rows} ${tPlural("row", rows, { one: "row", other: "rows" })}`;
}
/** The unit as spoken after a figure: core's `unitSuffix` rule, so it matches what is shown. */
function spokenUnit(fmt: SemanticFormat | undefined, unit: string | undefined): string {
  const suffix = unitSuffix(fmt, unit);
  return suffix === undefined ? "" : ` ${suffix}`;
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
