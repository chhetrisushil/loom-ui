import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deltaDirection,
  formatSemanticNumber,
  isTimeFormat,
  semanticNumberFormatOptions,
  unitSuffix,
} from "./format";
import { type TimeLabelWords, formatTimeLabel } from "./timeWords";

describe("formatSemanticNumber", () => {
  it("rounds and groups an integer, deterministically, whatever the locale argument omitted", () => {
    expect(formatSemanticNumber(1234.4, { semanticType: "integer" })).toBe("1,234");
  });
  it("formats percentage and currency the same way Intl.NumberFormat does for a locale-aware caller", () => {
    expect(formatSemanticNumber(0.256, { semanticType: "percentage" })).toBe("26%");
    expect(formatSemanticNumber(12, { semanticType: "currency", currency: "EUR" })).toBe("€12.00");
  });
  it("a non-finite value is an em dash, never NaN or Infinity", () => {
    expect(formatSemanticNumber(Number.NaN, { semanticType: "integer" })).toBe("—");
    expect(formatSemanticNumber(Number.POSITIVE_INFINITY, undefined)).toBe("—");
  });
  it("is deterministic across locale arguments: grouping never depends on the host's own locale", () => {
    expect(formatSemanticNumber(1234, { semanticType: "integer" }, "en-US")).toBe(
      formatSemanticNumber(1234, { semanticType: "integer" })
    );
  });
});

describe("semanticNumberFormatOptions", () => {
  it("maps each semantic type to the Intl.NumberFormat options the DOM renderer already used", () => {
    expect(semanticNumberFormatOptions({ semanticType: "integer" })).toEqual({
      maximumFractionDigits: 0,
    });
    expect(semanticNumberFormatOptions({ semanticType: "percentage" })).toEqual({
      style: "percent",
    });
    expect(semanticNumberFormatOptions({ semanticType: "currency", currency: "JPY" })).toEqual({
      style: "currency",
      currency: "JPY",
    });
    expect(semanticNumberFormatOptions({ semanticType: "number" })).toEqual({});
  });
});

describe("semanticNumberFormatOptions: fraction digits", () => {
  it("passes minimumFractionDigits through, so a decimal can pad to a fixed width", () => {
    expect(
      semanticNumberFormatOptions({
        semanticType: "decimal",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    ).toEqual({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(
      formatSemanticNumber(7, {
        semanticType: "decimal",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    ).toBe("7.00");
  });
  it("an integer passes minimumFractionDigits 0 through untouched — nothing is coerced", () => {
    expect(
      semanticNumberFormatOptions({ semanticType: "integer", minimumFractionDigits: 0 })
    ).toEqual({ minimumFractionDigits: 0, maximumFractionDigits: 0 });
  });
});

describe("unitSuffix", () => {
  it("keeps the unit beside any format that does not draw its own symbol", () => {
    expect(unitSuffix({ semanticType: "decimal" }, "ms")).toBe("ms");
    expect(unitSuffix({ semanticType: "integer" }, "req/s")).toBe("req/s");
    expect(unitSuffix(undefined, "ms")).toBe("ms");
  });
  it("drops it when the format renders its own symbol — never '$12.00 USD' or '25% %'", () => {
    expect(unitSuffix({ semanticType: "currency", currency: "USD" }, "USD")).toBeUndefined();
    expect(unitSuffix({ semanticType: "percentage" }, "%")).toBeUndefined();
  });
  it("no unit, no suffix", () => {
    expect(unitSuffix({ semanticType: "decimal" }, undefined)).toBeUndefined();
    expect(unitSuffix(undefined, undefined)).toBeUndefined();
  });
});

describe("currency needs its code", () => {
  it("a currency format with no code is never formatted as some assumed currency", () => {
    const opts = semanticNumberFormatOptions({ semanticType: "currency" });
    expect(opts.style).toBeUndefined();
    expect(opts.currency).toBeUndefined();
    expect(formatSemanticNumber(12, { semanticType: "currency" })).toBe("12");
  });
});

describe("an explicit format beats a % unit", () => {
  it("decimal + unit '%' is the number as given with the unit beside it, not a fraction", () => {
    const fmt = { semanticType: "decimal" } as const;
    expect(`${formatSemanticNumber(25, fmt)} ${unitSuffix(fmt, "%")}`).toBe("25 %");
  });
});

describe("deltaDirection", () => {
  it("a non-finite delta has no direction at all — neither an arrow nor 'unchanged'", () => {
    expect(deltaDirection(Number.NaN)).toBe("none");
    expect(deltaDirection(Number.POSITIVE_INFINITY)).toBe("none");
    expect(deltaDirection(Number.NEGATIVE_INFINITY)).toBe("none");
  });
  it("up, down, or flat — a zero change is neither", () => {
    expect(deltaDirection(0.12)).toBe("up");
    expect(deltaDirection(-0.034)).toBe("down");
    expect(deltaDirection(0)).toBe("flat");
    expect(deltaDirection(-0)).toBe("flat");
  });
  it("a change that reads as 0% at the delta's precision is flat, never '▲ 0%'", () => {
    expect(deltaDirection(0.0001)).toBe("flat");
    expect(deltaDirection(-0.0004)).toBe("flat");
    expect(deltaDirection(0.0006)).toBe("up");
  });
});

describe("formatTimeLabel", () => {
  const words: TimeLabelWords = (key, vars) =>
    ({
      "lu.time.half": "H{n} {year}",
      "lu.time.quarter": "Q{n} {year}",
      "lu.time.weekOf": "Week of {date}",
    })[key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k]));
  const label = (iso: string, granularity: string, timeZone?: string, locale = "en-US") =>
    formatTimeLabel(
      iso,
      { granularity, ...(timeZone && { timeZone }) } as Parameters<typeof formatTimeLabel>[1],
      locale,
      words
    );
  afterEach(() => vi.unstubAllEnvs());

  const ZONES = ["America/New_York", "America/Los_Angeles", "Asia/Tokyo", "UTC"];

  it("draws each coarse granularity as the written period in every reader zone", () => {
    for (const zone of ZONES) {
      vi.stubEnv("TZ", zone);
      expect(label("2026-01", "year"), zone).toBe("2026");
      expect(label("2026-01", "half"), zone).toBe("H1 2026");
      expect(label("2026-07-01", "half"), zone).toBe("H2 2026");
      expect(label("2026-01", "quarter"), zone).toBe("Q1 2026");
      expect(label("2026-04-01", "quarter"), zone).toBe("Q2 2026");
      expect(label("2026-12-31", "quarter"), zone).toBe("Q4 2026");
      expect(label("2026-01", "month"), zone).toBe("Jan 2026");
      expect(label("2026-01-05", "week"), zone).toBe("Week of Jan 5, 2026");
      expect(label("2026-01-05", "day"), zone).toBe("Jan 5, 2026");
      // a UTC-midnight instant is still its UTC period, not the reader's previous day
      expect(label("2026-01-01T00:00:00Z", "month"), zone).toBe("Jan 2026");
    }
  });

  it("datetime reads in the reader's zone unless the format names one; a named zone moves the period", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(label("2026-01-01T13:05:00Z", "datetime")).toBe("Jan 1, 2026, 8:05 AM");
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(label("2026-01-01T13:05:00Z", "datetime")).toBe("Jan 1, 2026, 10:05 PM");
    expect(label("2026-01-01T13:05:00Z", "datetime", "UTC")).toBe("Jan 1, 2026, 1:05 PM");
    // an explicit zone applies to coarse granularities too: 03:00Z on Jan 1 is still Dec 31 in New York
    expect(label("2026-01-01T03:00:00Z", "quarter", "America/New_York")).toBe("Q4 2025");
    expect(label("2026-01-01T03:00:00Z", "month", "America/New_York")).toBe("Dec 2025");
  });

  it("follows the locale, and the catalogue words come from the caller", () => {
    expect(label("2026-01", "month", undefined, "de-DE")).toBe("Jan. 2026");
    expect(label("2026-04", "quarter", undefined, "ar-EG")).toBe("Q٢ ٢٠٢٦");
    const fr: TimeLabelWords = (key, v) => (key === "lu.time.quarter" ? `T${v.n} ${v.year}` : "?");
    expect(formatTimeLabel("2026-04", { granularity: "quarter" }, "fr-FR", fr)).toBe("T2 2026");
  });

  it("is undefined for a timestamp that does not parse or a zone Intl refuses", () => {
    expect(label("not a date", "month")).toBeUndefined();
    expect(label("2026-01", "month", "Mars/Olympus")).toBeUndefined();
  });

  it("isTimeFormat is the contract without zod (a widget prop is never checked)", () => {
    expect(isTimeFormat({ granularity: "month" })).toBe(true);
    expect(isTimeFormat({ granularity: "month", timeZone: "Asia/Tokyo" })).toBe(true);
    expect(isTimeFormat({ granularity: "fortnight" })).toBe(false);
    expect(isTimeFormat({ granularity: "month", timeZone: "Mars/Olympus" })).toBe(false);
    expect(isTimeFormat({ granularity: "month", timeZone: 5 })).toBe(false);
    expect(isTimeFormat(null)).toBe(false);
    expect(isTimeFormat("month")).toBe(false);
  });
});
