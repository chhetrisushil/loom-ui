import type { TimeFormat } from "./values";

// ── Time labels: the words every renderer labels a point in time with ─────────────────────────────
//
// One formatter for a declared `TimeFormat`, shared like `chatWords.ts`: a renderer passes its own
// translating lookup as `words`, so the catalogue keys below are asked for HERE, once.

/** The catalogue keys a time label may need (`@loom-ui/core/messages`), filled by the caller. */
export type TimeLabelKey = "lu.time.half" | "lu.time.quarter" | "lu.time.weekOf";
export type TimeLabelWords = (
  key: TimeLabelKey,
  vars: Readonly<Record<string, string | number>>
) => string;

const dateFormats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  // Only a formatter with a NAMED zone is reusable: one without resolves the default zone when it is
  // built, and would keep reading that zone after the runtime's default changed.
  if (opts.timeZone === undefined) return new Intl.DateTimeFormat(locale, opts);
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = dateFormats.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(locale, opts);
    if (dateFormats.size >= 256) dateFormats.clear();
    dateFormats.set(key, f);
  }
  return f;
}

/**
 * A point in time as `format` declares it, in `locale`: year "2026", half "H1 2026", quarter
 * "Q1 2026", month "Jan 2026", week "Week of Jan 5, 2026", day "Jan 5, 2026", datetime
 * "Jan 5, 2026, 9:30 AM" (en-US). The zone is `format.timeZone`, else UTC for every granularity
 * coarser than `datetime` (a period is a calendar label: "2026-01" is January everywhere) and the
 * reader's own zone for `datetime`. A week is labelled by the timestamp's own date, which the host
 * sets to the week's first day under its own week rule; half and quarter read the timestamp's month,
 * so any day inside the period works. `words` fills the catalogue keys (a renderer passes its
 * translating lookup). `undefined` when the timestamp does not parse or the zone is refused.
 */
export function formatTimeLabel(
  iso: string,
  format: TimeFormat,
  locale: string,
  words: TimeLabelWords
): string | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const zone = format.timeZone ?? (format.granularity === "datetime" ? undefined : "UTC");
  const tz: Intl.DateTimeFormatOptions = zone === undefined ? {} : { timeZone: zone };
  try {
    switch (format.granularity) {
      case "year":
        return dateFormat(locale, { year: "numeric", ...tz }).format(d);
      case "month":
        return dateFormat(locale, { year: "numeric", month: "short", ...tz }).format(d);
      case "day":
        return dateFormat(locale, { dateStyle: "medium", ...tz }).format(d);
      case "datetime":
        return dateFormat(locale, { dateStyle: "medium", timeStyle: "short", ...tz }).format(d);
      case "week":
        return words("lu.time.weekOf", {
          date: dateFormat(locale, { dateStyle: "medium", ...tz }).format(d),
        });
      case "half":
      case "quarter": {
        const parts = dateFormat("en-US", {
          year: "numeric",
          month: "numeric",
          ...tz,
        }).formatToParts(d);
        const month = Number(parts.find((p) => p.type === "month")?.value);
        const year = Number(parts.find((p) => p.type === "year")?.value);
        const n = Math.ceil(month / (format.granularity === "half" ? 6 : 3));
        const digits = new Intl.NumberFormat(locale, { useGrouping: false });
        return words(format.granularity === "half" ? "lu.time.half" : "lu.time.quarter", {
          n: digits.format(n),
          year: digits.format(year),
        });
      }
    }
  } catch {
    return undefined; // a zone Intl refuses (only reachable from an unchecked prop)
  }
}
