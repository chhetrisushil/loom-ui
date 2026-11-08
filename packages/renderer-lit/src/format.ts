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

/** `2026`, `2026-01`, `2026-01-31`: a calendar date with no time of day (ECMAScript reads these as UTC). */
const DATE_ONLY = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/**
 * A time-axis label. A timestamp is drawn in the viewer's zone, as a time within 3 days and a date
 * beyond. A date-only value names a calendar date, not an instant: it is parsed as UTC midnight, so it
 * is formatted in UTC too (else "2026-01" reads "Dec 31, 2025" west of UTC), and always as a date.
 */
export function timeTick(iso: string, spanMs: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NOT_A_NUMBER;
  if (DATE_ONLY.test(iso))
    return new Intl.DateTimeFormat(formattingLocale(), {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(d);
  const withinDays = spanMs <= 3 * 86_400_000;
  return new Intl.DateTimeFormat(
    formattingLocale(),
    withinDays ? { timeStyle: "short" } : { dateStyle: "medium" }
  ).format(d);
}
