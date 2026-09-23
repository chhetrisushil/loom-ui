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
