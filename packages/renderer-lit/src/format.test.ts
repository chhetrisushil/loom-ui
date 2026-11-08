import { afterEach, describe, expect, it, vi } from "vitest";
import { effectiveFormat, formatFromUnit, measure, tick, timeTick } from "./format";
import { setLocale } from "./i18n";

describe("semantic formatting", () => {
  it("measure formats numbers, percentages and currency in the current locale; non-finite is an em dash", () => {
    setLocale("en-US");
    expect(measure(1234.5)).toBe("1,234.5");
    expect(measure(0.256, { semanticType: "percentage", maximumFractionDigits: 1 })).toBe("25.6%");
    expect(measure(12, { semanticType: "currency", currency: "USD" })).toBe("$12.00");
    expect(measure(Number.NaN)).toBe("—");
    expect(measure(Number.POSITIVE_INFINITY)).toBe("—");
  });
  it("tick is compact; timeTick picks time within 3 days and date beyond", () => {
    setLocale("en-US");
    expect(tick(1_250_000)).toBe("1.3M");
    expect(timeTick("2026-01-01T13:05:00Z", 3_600_000)).toMatch(/\d/);
    expect(timeTick("2026-01-01T13:05:00Z", 30 * 86_400_000)).toMatch(/Jan/);
  });
  it("timeTick draws a date-only value as the written date in every zone, and always as a date", () => {
    setLocale("en-US");
    try {
      for (const zone of ["America/New_York", "America/Los_Angeles", "Asia/Tokyo", "UTC"]) {
        vi.stubEnv("TZ", zone);
        const month = 30 * 86_400_000;
        expect(timeTick("2026-01", month), zone).toBe("Jan 1, 2026");
        expect(timeTick("2026-04", month), zone).toBe("Apr 1, 2026");
        expect(timeTick("2026-04-01", month), zone).toBe("Apr 1, 2026");
        expect(timeTick("2026", month), zone).toBe("Jan 1, 2026");
        // a short span of dates (two days) is still dates, never a time of day
        expect(timeTick("2026-04-01", 86_400_000), zone).toBe("Apr 1, 2026");
        expect(timeTick("2026-04-01", 1e12), zone).toBe("Apr 1, 2026"); // the hover label
      }
      // a timestamp keeps the viewer's zone (the zone switch above is real, not a no-op)
      vi.stubEnv("TZ", "America/New_York");
      expect(timeTick("2026-01-01T03:00:00Z", 30 * 86_400_000)).toBe("Dec 31, 2025");
      expect(timeTick("2026-01-01T13:05:00Z", 3_600_000)).toBe("8:05 AM");
      vi.stubEnv("TZ", "Asia/Tokyo");
      expect(timeTick("2026-01-01T13:05:00Z", 3_600_000)).toBe("10:05 PM");
      expect(timeTick("2026-01-31T20:00:00Z", 30 * 86_400_000)).toBe("Feb 1, 2026");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("formatFromUnit maps $ and % and leaves others; effectiveFormat prefers an explicit format", () => {
    expect(formatFromUnit("$")).toEqual({ semanticType: "currency", currency: "USD" });
    expect(formatFromUnit("%")).toEqual({ semanticType: "percentage" });
    expect(formatFromUnit("ms")).toBeUndefined();
    expect(effectiveFormat({ semanticType: "integer" }, "$")).toEqual({ semanticType: "integer" });
    expect(effectiveFormat(undefined, "%")).toEqual({ semanticType: "percentage" });
  });
  it("formatFromUnit reads any ISO 4217 code, keeps $, € and %, and leaves all-caps non-currencies alone", () => {
    expect(formatFromUnit("JPY")).toEqual({ semanticType: "currency", currency: "JPY" });
    expect(formatFromUnit(" GBP ")).toEqual({ semanticType: "currency", currency: "GBP" });
    expect(formatFromUnit("USD")).toEqual({ semanticType: "currency", currency: "USD" });
    expect(formatFromUnit("€")).toEqual({ semanticType: "currency", currency: "EUR" });
    expect(formatFromUnit("MPH")).toBeUndefined();
    expect(formatFromUnit("usd")).toBeUndefined();
  });
});

describe("formatFromUnit without Intl.supportedValuesOf", () => {
  afterEach(() => {
    vi.resetModules();
  });
  it("still recognises the literal USD and EUR codes when the API is unavailable", async () => {
    const original = Intl.supportedValuesOf;
    try {
      // Simulate a runtime that lacks this optional API; a fresh module import is required
      // because `isCurrencyCode` caches its lookup on first call, in this same process.
      // @ts-expect-error -- simulating an older runtime without this optional API
      Intl.supportedValuesOf = undefined;
      vi.resetModules();
      const fresh = await import("./format");
      expect(fresh.formatFromUnit("USD")).toEqual({ semanticType: "currency", currency: "USD" });
      expect(fresh.formatFromUnit("EUR")).toEqual({ semanticType: "currency", currency: "EUR" });
      expect(fresh.formatFromUnit("MPH")).toBeUndefined();
    } finally {
      Intl.supportedValuesOf = original;
    }
  });
});
