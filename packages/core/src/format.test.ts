import { describe, expect, it } from "vitest";
import { formatSemanticNumber, semanticNumberFormatOptions } from "./format";

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
