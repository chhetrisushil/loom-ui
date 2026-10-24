import { createHash } from "node:crypto";
import {
  type BarChartValue,
  type ChatValue,
  DELTA_FORMAT,
  type KpiValue,
  LocalizedText,
  type LuI18n,
  type LuMessageKey,
  MD_MAX_LINES,
  type MediaKind,
  type MediaPolicy,
  type MediaRef,
  type ProseValue,
  type Say,
  type SemanticFormat,
  type StatusCardValue,
  type TableCell,
  type TableValue,
  type TimeSeriesValue,
  chatMarkdownLines,
  chatTranscriptLines,
  checkKindValue,
  checkMediaUrl,
  cleanMediaText,
  createSay,
  deltaDirection,
  describeMedia,
  effectiveFormat,
  fieldsProblem,
  formatSemanticNumber,
  isActiveMediaType,
  isSameOriginMediaUrl,
  lookupMessage,
  maxBytesFor,
  oneLineChatText,
  optionsProblem,
  pluralForms,
  selectPlural,
  tableColumnFormat,
  tableColumnLabel,
  unitSuffix,
} from "@loom-ui/core";
import { type MultiSelectValue, multiSelectValueIssues } from "@loom-ui/core/chat-ui";
import { MD_DOC_MAX_TEXT, parseMarkdownDocument, parseOrgDocument } from "@loom-ui/core/document";
import { RendererRegistry, type Widget } from "@loom/blueprint-runtime";
import {
  type TerminalWidgetRenderer,
  defaultTerminalRegistry,
} from "@loom/plugin-renderer-terminal";
import { inert } from "./inert";

const LEVEL_KEY = {
  ok: "lu.level.ok",
  warning: "lu.level.warning",
  critical: "lu.level.critical",
} as const satisfies Record<string, LuMessageKey>;

const SPARK = "▁▂▃▄▅▆▇█";
/**
 * Who draws a widget's title: `"widget"` (default) prints `Title: …` in the body; `"host"` leaves
 * the title to the embedding app's own chrome (a title bar, a frame), so the body carries none —
 * error and empty renderings included. One rule for every kind either way.
 */
export type TitleChrome = "widget" | "host";

/**
 * What a terminal can do about media (U9). A terminal loads nothing, so there is no resolver: it
 * prints WHAT the media is (name, type, size) and a way to name it. Media is shown as untrusted
 * unless the host says otherwise, exactly as the web surface does without a vouching resolver.
 */
export interface TerminalMediaOptions {
  /**
   * A SYNCHRONOUS viewer-scoped link for a ref (e.g. a short-lived signed URL the host minted for
   * this session), or `undefined` for none. It is re-checked with `checkMediaUrl` before printing;
   * a refused link prints nothing. Without one the line carries a non-reversible tag only, never any part of the
   * address (an address is a capability, and terminal output is copied and logged).
   */
  readonly link?: (ref: MediaRef, kind: MediaKind) => string | undefined;
  /** Whether the HOST vouches for this ref's bytes. Default: nothing is trusted. User-origin media never is. */
  readonly trusted?: (ref: MediaRef, kind: MediaKind) => boolean;
  /** The same display policy the web surface takes (size limits, URL rules). */
  readonly policy?: MediaPolicy;
}

export interface TerminalRegistryOptions {
  /** Who draws each widget's title. Default `"widget"` — today's output, unchanged. */
  readonly chrome?: TitleChrome;
  /** How media prints. Default: handle only, everything untrusted. */
  readonly media?: TerminalMediaOptions;
  /**
   * The host override for every fixed word the terminal prints (see `LU_MESSAGE_KEYS`) and the locale
   * its numbers and plurals use. Default: English, locale `en-US` — see {@link DEFAULT_TERMINAL_LOCALE}.
   */
  readonly i18n?: LuI18n;
}

/** A non-empty string is a title; `""` (or a stray non-string) is none, so the kind stands in. */
const titleText = (w: Widget): string | undefined =>
  typeof w.title === "string" && w.title !== "" ? w.title : undefined;
const title = (w: Widget): string => titleText(w) ?? w.kind;
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s.padEnd(n));

/**
 * The terminal's default locale for every number and plural: one fixed, deterministic tag, so the
 * same value prints the same bytes on every machine (logs, snapshots, CI) instead of varying with the
 * host's own locale. A host that wants another passes `i18n: { locale }`.
 */
export const DEFAULT_TERMINAL_LOCALE = "en-US";

/** What a renderer needs to speak: the locale, and the host's words by key. */
interface Env {
  readonly locale: string;
  readonly say: Say;
  /** A counted noun (`lu.plural.row`) in `locale`'s grammar when the host translated it, else English. */
  readonly plural: (base: "lu.plural.row", n: number) => string;
}

function envOf(i18n: LuI18n | undefined): Env {
  const locale = i18n?.locale ?? DEFAULT_TERMINAL_LOCALE;
  return {
    locale,
    say: createSay(i18n),
    plural: (base, n) =>
      selectPlural(locale, base, n, pluralForms(base), (k, f) => lookupMessage(i18n, k, f)),
  };
}

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
  x: Env,
  v: number,
  format: SemanticFormat | undefined,
  unit: string | undefined
): string {
  const fmt = effectiveFormat(format, unit);
  const text = formatSemanticNumber(v, fmt, x.locale);
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

const timeSeries = (host: boolean, x: Env) =>
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
      const text = formatted(x, last, s.format ?? props.format, s.unit ?? props.unit);
      const marker = splitAxes && s.axis === "right" ? RIGHT_AXIS_MARKER : "";
      return `${hang(host)}${padLabelWithMarker(s.label, marker, 12)} ${sparkline(values)}  ${text}`;
    });
    return (host ? lines : [`${title(w)}:`, ...lines]).join("\n");
  });

const barChart = (host: boolean, x: Env) =>
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
      const text = formatted(x, b.value, chartFormat, chartUnit);
      return `${hang(host)}${pad(b.label, 12)} ${"█".repeat(filled)}${"·".repeat(20 - filled)} ${text}`;
    });
    return (host ? lines : [`${title(w)}:`, ...lines]).join("\n");
  });

const kpi = (host: boolean, x: Env) =>
  guarded(host, "Kpi", (w, v, l) => {
    const k = v as KpiValue;
    const props = w.props as { unit?: string; format?: SemanticFormat };
    const delta = k.deltaPct ?? null;
    const direction = delta === null ? undefined : deltaDirection(delta);
    const arrow = direction === "up" ? "▲ " : direction === "down" ? "▼ " : "";
    const change =
      delta === null
        ? ""
        : `  ${arrow}${formatSemanticNumber(Math.abs(delta), DELTA_FORMAT, x.locale)}`;
    // The label is a caption beside the title, as on the web — the title stays.
    const text = `${formatted(x, k.value, k.format ?? props.format, k.unit ?? props.unit)}${change}`;
    // Host-owned title: the caption (still information) trails the figure instead.
    if (host) return k.label ? `${text}  (${k.label})` : text;
    return `${k.label ? `${title(w)} (${k.label})` : title(w)}: ${text}`;
  });

/** Rows printed before the "… N more rows" line. */
const TABLE_ROWS = 20;
/** Widest a terminal column grows before its cells are cut. */
const TABLE_COL_MAX = 24;

const table = (host: boolean, x: Env) =>
  guarded(host, "Table", (w, v, l) => {
    const t = v as TableValue;
    // Widths are computed over the text that will be PRINTED: loom's traversal strips controls
    // from the whole frame afterwards, which would otherwise misalign a hostile cell.
    const labels = t.columns.map((c) => inert(tableColumnLabel(c)));
    const formats = t.columns.map(tableColumnFormat);
    const cellText = (c: TableCell): string =>
      c === null ? "—" : typeof c === "number" ? formatted(x, c, undefined, undefined) : inert(c);
    const body = t.rows.slice(0, TABLE_ROWS).map((row) =>
      labels.map((_, i) => {
        const c = row[i] ?? null;
        const f = formats[i];
        return typeof c === "number" && f !== undefined
          ? formatted(x, c, f, undefined)
          : cellText(c);
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
      // The terminal's locale (see DEFAULT_TERMINAL_LOCALE) decides the plural, like its numbers.
      out.push(
        `${hang(host)}${x.say("lu.terminal.table.moreRows", { n: more, noun: x.plural("lu.plural.row", more) })}`
      );
    }
    return out.join("\n");
  });

const statusCard = (host: boolean, x: Env) =>
  guarded(host, "StatusCard", (w, v, l) => {
    const s = v as StatusCardValue;
    return l(w, `[${x.say(LEVEL_KEY[s.level])}] ${s.headline}${s.detail ? ` — ${s.detail}` : ""}`);
  });

// A document laid out as text: markdown and org through core's document parsers and `chatMarkdownLines` (which
// cleans every line and caps the total), plain text as its first lines. Hung under the title like Chat.
const prose = (host: boolean, x: Env) =>
  guarded(host, "Prose", (w, v) => {
    const p = v as ProseValue;
    // Plain text over the document cap is cut (before it is split) and says so.
    const over = p.format === "plain" && p.text.length > MD_DOC_MAX_TEXT;
    const body =
      p.text === ""
        ? [x.say("lu.prose.empty")]
        : p.format === "plain"
          ? (over ? p.text.slice(0, MD_DOC_MAX_TEXT) : p.text)
              .split("\n")
              .slice(0, MD_MAX_LINES)
              .map((l) => oneLineChatText(l, 200))
          : chatMarkdownLines(
              p.format === "org" ? parseOrgDocument(p.text) : parseMarkdownDocument(p.text)
            );
    const out = [
      ...(p.note ? [oneLineChatText(p.note)] : []),
      ...body,
      ...(p.truncated || over ? [x.say("lu.prose.cut")] : []),
    ];
    const indent = hang(host);
    return [...(host ? [] : [`${title(w)}:`]), ...out.map((l) => `${indent}${l}`)].join("\n");
  });

// Never bound, so never `guarded`: loom calls a channel-less widget's renderer directly, with
// `value === undefined`, and the text lives in props (a string after compile; an uncompiled
// LocalizedText shows its fallback, never its key).
const note =
  (host: boolean, x: Env): TerminalWidgetRenderer =>
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
const a2uiView = (host: boolean, x: Env) =>
  guarded(host, "A2UIView", (w, _v, l) => l(w, x.say("lu.terminal.a2ui")));
const sandboxView = (host: boolean, x: Env) =>
  guarded(host, "SandboxView", (w, _v, l) => l(w, x.say("lu.terminal.sandbox")));

// ── Media (U9) ─────────────────────────────────────────────────────────────────
// `Image 'chart.png' (image/png, 1 KiB) [untrusted] ref#1a2b3c4d` — the SAME one-line
// description the web surface speaks (`describeMedia`), a trust marker, and a link or a non-reversible tag.
const mediaLine = (
  host: boolean,
  x: Env,
  kind: MediaKind,
  media: TerminalMediaOptions | undefined
) =>
  guarded(host, kind, (w, v, l) => {
    const ref = v as MediaRef;
    const policy = media?.policy;
    const tooLarge = ref.size !== undefined && ref.size > maxBytesFor(kind, policy);
    const trusted = ref.origin !== "user" && media?.trusted?.(ref, kind) === true;
    // Untrusted active content (HTML, SVG, XML, script types) is never offered: no link, no handle.
    const active = !trusted && isActiveMediaType(ref.mediaType);
    const sameOrigin = (u: string): boolean =>
      !trusted && isSameOriginMediaUrl(u, policy?.appOrigin);
    const link = tooLarge || active ? undefined : media?.link?.(ref, kind);
    const checked = checkMediaUrl(link, policy);
    const offered =
      checked.ok && !(sameOrigin(checked.url) && policy?.allowSameOriginUntrusted !== true)
        ? checked.url
        : undefined;
    // A NON-REVERSIBLE tag, never any part of the address (a prefix of a capability is a partial
    // capability, and terminal output is copied and logged). A usable link is the host's `media.link`.
    const tag = `ref#${createHash("sha256").update(ref.address).digest("hex").slice(0, 8)}`;
    const where = tooLarge
      ? x.say("lu.terminal.media.tooLarge")
      : active
        ? x.say("lu.terminal.media.blocked")
        : (offered ?? tag);
    const alt = kind === "Image" ? cleanMediaText(ref.alt, 200) : "";
    return l(
      w,
      `${describeMedia(kind, ref, x.say)}${alt === "" ? "" : ` — ${alt}`}${trusted ? "" : ` ${x.say("lu.terminal.untrusted")}`} ${where}`
    );
  });

// A media input is a web control (a file picker): say so, don't fake it. Static, so never `guarded`.
const mediaInput =
  (host: boolean, x: Env): TerminalWidgetRenderer =>
  (w) => {
    const t = titleText(w);
    const body = x.say("lu.terminal.fileUpload");
    return t !== undefined && !host ? `${t}: ${body}` : body;
  };

// ── Chat and inputs (U8) ───────────────────────────────────────────────────────
// The transcript prints as the SAME lines the web surface speaks (`chatTranscriptLines`: speaker,
// status note, fixed failure sentence + reference id, restricted entries as bare placeholders, media
// described without an address), under the title. Untrusted text is cleaned and bounded: a plain part is one
// line of at most `maxText` characters, a markdown part is up to 200 plain lines of at most 4 x `maxText`
// characters in all (`chatMarkdownLines`). A terminal escape (ESC), a C1 control or a bidi override in a turn
// cannot reach the screen.
const chatTranscript = (host: boolean, x: Env) =>
  guarded(host, "Chat", (w, v) => {
    const chat = v as ChatValue;
    const lines = chatTranscriptLines(chat, { say: x.say });
    const out: string[] = [];
    if (chat.older !== undefined) out.push(x.say("lu.terminal.chat.earlier"));
    out.push(...(lines.length === 0 ? [x.say("lu.terminal.chat.empty")] : lines));
    if (chat.running === true && !chat.entries.some((e) => e.status === "streaming"))
      out.push(x.say("lu.terminal.chat.replying"));
    if (chat.state === "closed") out.push(x.say("lu.terminal.chat.closed"));
    const indent = hang(host);
    return [...(host ? [] : [`${title(w)}:`]), ...out.map((l) => `${indent}${l}`)].join("\n");
  });

/** A prop that is text: a string, or an uncompiled LocalizedText's fallback; cleaned to one line. */
const propText = (raw: unknown): string => {
  const parsed = LocalizedText.safeParse(raw);
  const text = typeof raw === "string" ? raw : parsed.success ? parsed.data.fallback : "";
  return oneLineChatText(text, 120);
};

// An input is a prompt in a terminal: say what it asks, so an interactive host can collect the answer
// (and send it through the same write-back as the web). Static, so never `guarded`.
const textPrompt =
  (host: boolean, x: Env): TerminalWidgetRenderer =>
  (w) => {
    const label = propText(w.props.label) || x.say("lu.input.message");
    const multi = w.props.multiline === true ? x.say("lu.terminal.multiline") : "";
    const body = `> ${label}${multi} ${x.say("lu.terminal.textInput")}`;
    return host ? body : `${title(w)}: ${body}`;
  };

const formPrompt =
  (host: boolean, x: Env): TerminalWidgetRenderer =>
  (w) => {
    const label = propText(w.props.label) || x.say("lu.input.form");
    const fields =
      fieldsProblem(w.props.fields) === undefined
        ? (w.props.fields as ReadonlyArray<{
            name: string;
            label: string;
            type: string;
            required?: boolean;
          }>)
        : [];
    const rows = fields.map(
      (f) =>
        `${hang(host)}  ${oneLineChatText(f.label, 60)}${f.required === true ? "*" : ""} (${f.type})`
    );
    const head = `> ${label} ${x.say("lu.terminal.formInput")}`;
    return [host ? head : `${title(w)}: ${head}`, ...rows].join("\n");
  };

const selectPrompt =
  (host: boolean, x: Env): TerminalWidgetRenderer =>
  (w, v) => {
    const label = propText(w.props.label) || x.say("lu.input.choose");
    const options =
      optionsProblem(w.props.options) === undefined
        ? (w.props.options as ReadonlyArray<{ value: string; label: string }>)
        : [];
    // The bound current choice marks its option; a value that is not declared marks none and is never printed.
    const rows = options.map(
      (o, i) =>
        `${hang(host)}  ${i + 1}) ${oneLineChatText(o.label, 60)}${o.value === v ? ` ${x.say("lu.terminal.current")}` : ""}`
    );
    const head = `> ${label} ${x.say("lu.terminal.selectInput")}`;
    return [host ? head : `${title(w)}: ${head}`, ...rows].join("\n");
  };

const multiPrompt =
  (host: boolean, x: Env): TerminalWidgetRenderer =>
  (w, v) => {
    const label = propText(w.props.label) || x.say("lu.input.choose");
    const m = multiSelectValueIssues(v).length === 0 ? (v as MultiSelectValue) : undefined;
    const byValue = new Map((m?.options ?? []).map((o) => [o.value, o]));
    const chosen = (m?.selected ?? []).map((s) => byValue.get(s)).filter((o) => o !== undefined);
    const text = (o: { label: string; hint?: string }) =>
      `${oneLineChatText(o.label, 60)}${o.hint === undefined ? "" : ` (${oneLineChatText(o.hint, 40)})`}`;
    const rows =
      chosen.length === 0
        ? [`${hang(host)}  ${propText(w.props.emptyLabel) || x.say("lu.input.none")}`]
        : chosen.map(
            (o, i) => `${hang(host)}  ${i + 1}) ${text(o)} ${x.say("lu.terminal.current")}`
          );
    const rest = (m?.options.length ?? 0) - chosen.length;
    if (rest > 0) rows.push(`${hang(host)}  + ${rest} ${x.say("lu.terminal.moreOptions")}`);
    if (m?.note !== undefined) rows.push(`${hang(host)}  ${oneLineChatText(m.note, 200)}`);
    const head = `> ${label} ${x.say("lu.terminal.multiSelectInput")}`;
    return [host ? head : `${title(w)}: ${head}`, ...rows].join("\n");
  };

/** The framework kinds' renderers. A NEW registry each call — never mutate a shared one. */
export function createLoomUiTerminalRegistry(
  opts: TerminalRegistryOptions = {}
): RendererRegistry<TerminalWidgetRenderer> {
  const host = opts.chrome === "host";
  const x = envOf(opts.i18n);
  return new RendererRegistry<TerminalWidgetRenderer>()
    .register("TimeSeries", timeSeries(host, x))
    .register("BarChart", barChart(host, x))
    .register("Kpi", kpi(host, x))
    .register("Table", table(host, x))
    .register("StatusCard", statusCard(host, x))
    .register("Note", note(host, x))
    .register("Prose", prose(host, x))
    .register("A2UIView", a2uiView(host, x))
    .register("SandboxView", sandboxView(host, x))
    .register("Image", mediaLine(host, x, "Image", opts.media))
    .register("Audio", mediaLine(host, x, "Audio", opts.media))
    .register("Video", mediaLine(host, x, "Video", opts.media))
    .register("File", mediaLine(host, x, "File", opts.media))
    .register("MediaInput", mediaInput(host, x))
    .register("Chat", chatTranscript(host, x))
    .register("TextInput", textPrompt(host, x))
    .register("FormInput", formPrompt(host, x))
    .register("SelectInput", selectPrompt(host, x))
    .register("MultiSelectInput", multiPrompt(host, x));
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
