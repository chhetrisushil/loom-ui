import type { SemanticFormat } from "./values";

/** `deltaPct` is a fraction; it reads as a percentage to one decimal. One declaration, shared by
 * every renderer's delta badge (a KPI's ▲/▼, its spoken form, and the terminal's), so they never
 * drift apart. */
export const DELTA_FORMAT: SemanticFormat = {
  semanticType: "percentage",
  maximumFractionDigits: 1,
};

let currencyCodes: ReadonlySet<string> | undefined;

/**
 * ISO 4217 by lookup, never by guess: the platform's own list, so an all-caps unit that is not a
 * currency ("MPH", "RPM") stays a plain suffix. A runtime without `supportedValuesOf` declines.
 */
function isCurrencyCode(value: string): boolean {
  if (!/^[A-Z]{3}$/.test(value)) return false;
  if (currencyCodes === undefined) {
    try {
      currencyCodes = new Set(Intl.supportedValuesOf("currency"));
    } catch {
      // `supportedValuesOf` is optional (older runtimes). Without it, still recognise the two
      // codes this module already special-cases via `$` and `€`, so a bare "USD"/"EUR" unit
      // doesn't silently fall back to a plain suffix on a runtime that lacks the full list.
      currencyCodes = new Set(["USD", "EUR"]);
    }
  }
  return currencyCodes.has(value);
}

/** Read a legacy `unit` as semantics: `$`, `€`, `%`, or any ISO 4217 code. Anything else is left alone. */
export function formatFromUnit(unit: string | undefined): SemanticFormat | undefined {
  if (unit === undefined) return undefined;
  const u = unit.trim();
  if (u === "$") return { semanticType: "currency", currency: "USD" };
  if (u === "€") return { semanticType: "currency", currency: "EUR" };
  if (u === "%") return { semanticType: "percentage" };
  if (isCurrencyCode(u)) return { semanticType: "currency", currency: u };
  return undefined;
}

/** An explicit format wins; otherwise a legacy `unit` is read as semantics, if it says anything. */
export function effectiveFormat(
  format: SemanticFormat | undefined,
  unit: string | undefined
): SemanticFormat | undefined {
  return format ?? formatFromUnit(unit);
}

/**
 * The `Intl.NumberFormat` options a `SemanticFormat` implies — the one place this mapping lives,
 * so a DOM renderer (locale-aware, its own `Intl.NumberFormat` call per reader) and a terminal
 * renderer (deterministic, one fixed locale) apply identical rounding/grouping/currency rules
 * without each re-deriving them from the contract.
 */
export function semanticNumberFormatOptions(format: SemanticFormat): Intl.NumberFormatOptions {
  const opts: Intl.NumberFormatOptions = {};
  if (format.notation) opts.notation = format.notation;
  if (format.maximumFractionDigits !== undefined) {
    opts.maximumFractionDigits = format.maximumFractionDigits;
  }
  if (format.semanticType === "integer") opts.maximumFractionDigits = 0;
  if (format.semanticType === "percentage") opts.style = "percent";
  if (format.semanticType === "currency") {
    opts.style = "currency";
    opts.currency = format.currency ?? "USD";
  }
  return opts;
}

/**
 * A finite number in its semantics, at a fixed locale — grouped and rounded the same way
 * `Intl.NumberFormat` groups and rounds for a locale-aware caller (an `integer` column prints
 * "1,234", not "1234.4"), without depending on, or varying with, the host's own locale. Callers
 * that DO want the reader's locale build their own `Intl.NumberFormat` from
 * `semanticNumberFormatOptions` instead of this.
 */
export function formatSemanticNumber(
  value: number,
  format: SemanticFormat | undefined,
  locale = "en-US"
): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(
    locale,
    semanticNumberFormatOptions(format ?? { semanticType: "number" })
  ).format(value);
}
