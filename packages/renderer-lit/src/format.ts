import {
  DELTA_FORMAT,
  type SemanticFormat,
  deltaDirection,
  effectiveFormat,
  formatFromUnit,
  semanticNumberFormatOptions,
  unitSuffix,
} from "@loom-ui/core/browser";
import { formattingLocale } from "./i18n";

// One declaration of what a number means, and of the semantics→format-options mapping it
// implies, in `@loom-ui/core` beside the value contracts that carry it; both this DOM renderer
// and the terminal renderer (which cannot import this ESM/lit package) read the same source
// instead of each re-deriving it, so a KPI badge and its terminal line never drift apart.
export type { SemanticFormat };
export { DELTA_FORMAT, deltaDirection, effectiveFormat, formatFromUnit, unitSuffix };

/** An em dash, not "∞" and not "NaN": a missing figure, never an infinite one. */
const NOT_A_NUMBER = "—";

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
