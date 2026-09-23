import { describe, expect, it } from "vitest";
import {
  deltaDirection,
  formatSemanticNumber,
  semanticNumberFormatOptions,
  unitSuffix,
} from "./format";

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

describe("deltaDirection", () => {
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
