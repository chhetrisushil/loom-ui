import { type SemanticFormat, semanticNumberFormatOptions } from "@loom-ui/core";
import { formattingLocale } from "./i18n";

// One declaration of what a number means, in `@loom-ui/core` beside the value contracts that
// carry it; the renderers only read it.
export type { SemanticFormat };

/** `deltaPct` is a fraction; it reads as a percentage to one decimal. One declaration, shared by
 * `lu-kpi`'s badge and `describeValue`'s spoken form, so the two never drift apart. */
export const DELTA_FORMAT: SemanticFormat = {
  semanticType: "percentage",
  maximumFractionDigits: 1,
};

/** An em dash, not "∞" and not "NaN": a missing figure, never an infinite one. */
const NOT_A_NUMBER = "—";

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

export function effectiveFormat(
  format: SemanticFormat | undefined,
  unit: string | undefined
): SemanticFormat | undefined {
  return format ?? formatFromUnit(unit);
}

// The semantics→Intl.NumberFormat-options mapping lives once, in @loom-ui/core, so this DOM
// renderer and the terminal renderer (which cannot import this ESM/lit package) apply identical
// rounding/grouping/currency rules instead of each re-deriving them from the contract.
function numberFormat(f: SemanticFormat, locale: string): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, semanticNumberFormatOptions(f));
}

export function measure(value: number, format?: SemanticFormat): string {
  if (!Number.isFinite(value)) return NOT_A_NUMBER;
  return numberFormat(format ?? { semanticType: "number" }, formattingLocale()).format(value);
}

export function tick(value: number, format?: SemanticFormat): string {
  if (!Number.isFinite(value)) return NOT_A_NUMBER;
  return numberFormat(
    { ...(format ?? { semanticType: "number" }), notation: "compact", maximumFractionDigits: 1 },
    formattingLocale()
  ).format(value);
}

export function timeTick(iso: string, spanMs: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NOT_A_NUMBER;
  const withinDays = spanMs <= 3 * 86_400_000;
  return new Intl.DateTimeFormat(
    formattingLocale(),
    withinDays ? { timeStyle: "short" } : { dateStyle: "medium" }
  ).format(d);
}
