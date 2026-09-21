import { formattingLocale } from "./i18n";

export interface SemanticFormat {
  semanticType: "number" | "integer" | "decimal" | "percentage" | "currency" | "date" | "time";
  currency?: string;
  notation?: "standard" | "compact";
  maximumFractionDigits?: number;
  dateStyle?: "short" | "medium" | "long";
  timeStyle?: "short" | "medium";
}

/** An em dash, not "∞" and not "NaN": a missing figure, never an infinite one. */
const NOT_A_NUMBER = "—";

export function formatFromUnit(unit: string | undefined): SemanticFormat | undefined {
  if (unit === undefined) return undefined;
  const u = unit.trim();
  if (u === "$" || u === "USD") return { semanticType: "currency", currency: "USD" };
  if (u === "€" || u === "EUR") return { semanticType: "currency", currency: "EUR" };
  if (u === "%") return { semanticType: "percentage" };
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
