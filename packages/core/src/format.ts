import type { SemanticFormat } from "./values";

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
