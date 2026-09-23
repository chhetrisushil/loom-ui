import type { SemanticFormat } from "@loom-ui/core";
import { formattingLocale } from "./i18n";

// One declaration of what a number means, in `@loom-ui/core` beside the value contracts that
// carry it; the renderers only read it.
export type { SemanticFormat };

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
      currencyCodes = new Set();
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

function numberFormat(f: SemanticFormat, locale: string): Intl.NumberFormat {
  const opts: Intl.NumberFormatOptions = {};
  if (f.notation) opts.notation = f.notation;
  if (f.maximumFractionDigits !== undefined) opts.maximumFractionDigits = f.maximumFractionDigits;
  if (f.semanticType === "integer") opts.maximumFractionDigits = 0;
  if (f.semanticType === "percentage") opts.style = "percent";
  if (f.semanticType === "currency") {
    opts.style = "currency";
    opts.currency = f.currency ?? "USD";
  }
  return new Intl.NumberFormat(locale, opts);
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
