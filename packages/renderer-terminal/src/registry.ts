import {
  type BarChartValue,
  DELTA_FORMAT,
  type KpiValue,
  LocalizedText,
  type SemanticFormat,
  type StatusCardValue,
  type TableCell,
  type TableValue,
  type TimeSeriesValue,
  checkKindValue,
  deltaDirection,
  effectiveFormat,
  formatSemanticNumber,
  tableColumnFormat,
  tableColumnLabel,
  unitSuffix,
} from "@loom-ui/core";
import { RendererRegistry, type Widget } from "@loom/blueprint-runtime";
import {
  type TerminalWidgetRenderer,
  defaultTerminalRegistry,
} from "@loom/plugin-renderer-terminal";

const SPARK = "▁▂▃▄▅▆▇█";
/**
 * Who draws a widget's title: `"widget"` (default) prints `Title: …` in the body; `"host"` leaves
 * the title to the embedding app's own chrome (a title bar, a frame), so the body carries none —
 * error and empty renderings included. One rule for every kind either way.
 */
export type TitleChrome = "widget" | "host";

export interface TerminalRegistryOptions {
  /** Who draws each widget's title. Default `"widget"` — today's output, unchanged. */
  readonly chrome?: TitleChrome;
}

/** A non-empty string is a title; `""` (or a stray non-string) is none, so the kind stands in. */
const titleText = (w: Widget): string | undefined =>
  typeof w.title === "string" && w.title !== "" ? w.title : undefined;
const title = (w: Widget): string => titleText(w) ?? w.kind;
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s.padEnd(n));

/** One fixed, deterministic locale for every terminal number: the same grouping/rounding/currency
 * rules the DOM renderer's `measure()` applies for its reader, without varying with the host's
 * own locale. */
const LOCALE = "en-US";
/** Plural category of a count, in the same fixed locale as every terminal number. */
const PLURALS = new Intl.PluralRules(LOCALE);

/**
 * A number exactly as the web's `measure()` would print it for the same value, format and unit —
 * full numeric parity, not merely the same shape: an explicit `format` (or, absent one, a legacy
 * `unit` read as semantics via `effectiveFormat`, the same "$"/"€"/"%"/ISO-4217 lookup the DOM
 * renderer uses) goes through `@loom-ui/core`'s `formatSemanticNumber`, so a `currency` prints
 * the web's own symbol ("€1,234,567.89"), never an ISO-code suffix, and a plain number groups and
 * rounds exactly as `Intl.NumberFormat` does for the DOM renderer. The raw `unit` shows as a
 * literal suffix unless the format draws its own symbol (currency, percentage) — core's
 * `unitSuffix`, the same rule by which the DOM renderer shows it as a separate span. (renderer-lit is an ESM/lit-DOM package this CommonJS one
 * cannot import, so this DOM-free part of its formatting logic lives in core instead of being
 * re-derived here.)
 */
function formatted(
  v: number,
  format: SemanticFormat | undefined,
  unit: string | undefined
): string {
  const fmt = effectiveFormat(format, unit);
  const text = formatSemanticNumber(v, fmt, LOCALE);
  const suffix = unitSuffix(fmt, unit);
  return suffix === undefined ? text : `${text} ${suffix}`;
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

/** Tag a body with its title — or leave it bare when the host draws the title. */
type Lead = (w: Widget, rest: string) => string;
const lead =
  (host: boolean): Lead =>
  (w, rest) =>
    host ? rest : `${title(w)}: ${rest}`;

/**
 * The hanging indent that sets a multi-line body's rows under its `Title:` lead. Host chrome has no
 * lead to hang under, so it gets none (G18) — one helper, so every multi-line kind agrees.
 */
const HANG = "    ";
const hang = (host: boolean): string => (host ? "" : HANG);

type Body = (w: Widget, v: unknown, lead: Lead, host: boolean) => string;

const guarded =
  (host: boolean, kind: string, body: Body): TerminalWidgetRenderer =>
  (w, v) => {
    const l = lead(host);
    const check = checkKindValue(kind, v);
    if (!check.ok) return `✗ ${l(w, check.finding.message)}`;
    if (v === undefined) return l(w, "—");
    return body(w, v, l, host);
  };

// The right-axis marker is semantic information (which axis a series reads against), so it must
// never be lost to the label column's fixed width. `pad(`${label}${marker}`, width)` — padding
// the already-concatenated string — truncates whichever part lands past the width, so a label
// alone at or beyond `width` swallows the marker whole. Truncate the LABEL alone to leave room
// for the marker, then append the marker after, so it always survives; a short label+marker
// still pads to `width` exactly as before, so every row's sparkline column stays aligned.
const RIGHT_AXIS_MARKER = " (R)";

function padLabelWithMarker(label: string, marker: string, width: number): string {
  const combined = `${label}${marker}`;
  if (combined.length <= width) return combined.padEnd(width);
  if (marker === "") return combined.slice(0, width);
  const truncatedLabel = label.slice(0, Math.max(width - marker.length, 0));
  return `${truncatedLabel}${marker}`;
}

const timeSeries = (host: boolean) =>
  guarded(host, "TimeSeries", (w, v, l) => {
    const { series } = v as TimeSeriesValue;
    const props = w.props as { unit?: string; format?: SemanticFormat };
    // Same rule as the web's lu-timeseries: a right axis exists only when some series is on the
    // left to contrast it with; all-right falls back to one shared axis, so nothing is marked.
    const splitAxes =
      series.some((s) => s.axis !== "right") && series.some((s) => s.axis === "right");
    const lines = series.map((s) => {
      const values = s.points.map((p) => p.value);
      const last = values.length > 0 ? (values[values.length - 1] as number) : Number.NaN;
      // Same precedence as the web's `formatOf` (lu-timeseries.ts): this series' own format, else
      // the widget's; a unit resolves only when neither format does.
      const text = formatted(last, s.format ?? props.format, s.unit ?? props.unit);
      const marker = splitAxes && s.axis === "right" ? RIGHT_AXIS_MARKER : "";
      return `${hang(host)}${padLabelWithMarker(s.label, marker, 12)} ${sparkline(values)}  ${text}`;
    });
    return (host ? lines : [`${title(w)}:`, ...lines]).join("\n");
  });

const barChart = (host: boolean) =>
  guarded(host, "BarChart", (w, v, l) => {
    const { bars, format, unit } = v as BarChartValue;
    const props = w.props as { unit?: string; format?: SemanticFormat };
    // Same precedence as the web's lu-bar-chart.ts: the chart's own value-level format, else the
    // widget's props.format; a unit resolves only when neither format does. One format for every
    // bar, exactly as the web computes it once and reuses it for every bar's `measure()` call.
    const chartFormat = format ?? props.format;
    const chartUnit = unit ?? props.unit;
    // Single-pass max (never Math.max(...spread) — same argument-count hazard as sparkline's
    // min/max), floored at 1 so an all-non-finite/zero series never divides by zero below.
    let max = 1;
    for (const b of bars) {
      const abs = Math.abs(b.value);
      if (Number.isFinite(abs) && abs > max) max = abs;
    }
    const lines = bars.map((b) => {
      const filled = Number.isFinite(b.value) ? Math.round((Math.abs(b.value) / max) * 20) : 0;
      const text = formatted(b.value, chartFormat, chartUnit);
      return `${hang(host)}${pad(b.label, 12)} ${"█".repeat(filled)}${"·".repeat(20 - filled)} ${text}`;
    });
    return (host ? lines : [`${title(w)}:`, ...lines]).join("\n");
  });

const kpi = (host: boolean) =>
  guarded(host, "Kpi", (w, v, l) => {
    const k = v as KpiValue;
    const props = w.props as { unit?: string; format?: SemanticFormat };
    const delta = k.deltaPct ?? null;
    const direction = delta === null ? undefined : deltaDirection(delta);
    const arrow = direction === "up" ? "▲ " : direction === "down" ? "▼ " : "";
    const change =
      delta === null
        ? ""
        : `  ${arrow}${formatSemanticNumber(Math.abs(delta), DELTA_FORMAT, LOCALE)}`;
    // The label is a caption beside the title, as on the web — the title stays.
    const text = `${formatted(k.value, k.format ?? props.format, k.unit ?? props.unit)}${change}`;
    // Host-owned title: the caption (still information) trails the figure instead.
    if (host) return k.label ? `${text}  (${k.label})` : text;
    return `${k.label ? `${title(w)} (${k.label})` : title(w)}: ${text}`;
  });

/** Rows printed before the "… N more rows" line. */
const TABLE_ROWS = 20;
/** Widest a terminal column grows before its cells are cut. */
const TABLE_COL_MAX = 24;

const table = (host: boolean) =>
  guarded(host, "Table", (w, v, l) => {
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
      `${hang(host)}${cells.map((c, i) => pad(c, widths[i] ?? 0)).join("  ")}`.trimEnd();
    const out = [...(host ? [] : [`${title(w)}:`]), line(labels), ...body.map(line)];
    if (t.rows.length > TABLE_ROWS) {
      const more = t.rows.length - TABLE_ROWS;
      // The terminal's one fixed locale (see LOCALE) decides the plural, like its numbers.
      out.push(`${hang(host)}… ${more} more ${PLURALS.select(more) === "one" ? "row" : "rows"}`);
    }
    return out.join("\n");
  });

const statusCard = (host: boolean) =>
  guarded(host, "StatusCard", (w, v, l) => {
    const s = v as StatusCardValue;
    return l(w, `[${s.level}] ${s.headline}${s.detail ? ` — ${s.detail}` : ""}`);
  });

// Never bound, so never `guarded`: loom calls a channel-less widget's renderer directly, with
// `value === undefined`, and the text lives in props (a string after compile; an uncompiled
// LocalizedText shows its fallback, never its key).
const note =
  (host: boolean): TerminalWidgetRenderer =>
  (w) => {
    const raw = w.props.text;
    const parsed = LocalizedText.safeParse(raw);
    const text = typeof raw === "string" ? raw : parsed.success ? parsed.data.fallback : "";
    // Only a non-empty string is a title — `""` and a stray `0` are none, as for every kind.
    const t = titleText(w);
    return t !== undefined && !host ? `${t}: ${text}` : text;
  };

// The A2UI tree and the sandboxed component are web surfaces: an interpreter this CommonJS
// package cannot import, and code that cannot run in a terminal. Say so, don't fake it.
const a2uiView = (host: boolean) =>
  guarded(host, "A2UIView", (w, _v, l) => l(w, "[A2UI view — rendered on the web]"));
const sandboxView = (host: boolean) =>
  guarded(host, "SandboxView", (w, _v, l) => l(w, "[sandboxed component — rendered on the web]"));

/** The framework kinds' renderers. A NEW registry each call — never mutate a shared one. */
export function createLoomUiTerminalRegistry(
  opts: TerminalRegistryOptions = {}
): RendererRegistry<TerminalWidgetRenderer> {
  const host = opts.chrome === "host";
  return new RendererRegistry<TerminalWidgetRenderer>()
    .register("TimeSeries", timeSeries(host))
    .register("BarChart", barChart(host))
    .register("Kpi", kpi(host))
    .register("Table", table(host))
    .register("StatusCard", statusCard(host))
    .register("Note", note(host))
    .register("A2UIView", a2uiView(host))
    .register("SandboxView", sandboxView(host));
}

export const loomUiTerminalRegistry: RendererRegistry<TerminalWidgetRenderer> =
  createLoomUiTerminalRegistry();

/**
 * loom's eight built-ins plus the framework's kinds. A NEW registry each call — never mutate a shared one.
 * With `chrome: "host"` the framework kinds print no title; loom's own eight built-ins are loom's
 * renderers and keep theirs (the framework does not rewrite them).
 */
export function terminalRegistry(
  opts: TerminalRegistryOptions = {}
): RendererRegistry<TerminalWidgetRenderer> {
  return defaultTerminalRegistry.merge(createLoomUiTerminalRegistry(opts));
}
