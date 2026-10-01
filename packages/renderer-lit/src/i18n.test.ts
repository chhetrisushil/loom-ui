import { describe, expect, it } from "vitest";
import {
  currentLocale,
  formattingLocale,
  isRtl,
  localeLabel,
  onLocaleChange,
  setLocale,
  t,
} from "./i18n";
import { tPlural } from "./plural";

describe("locale shim", () => {
  it("t is identity; setLocale notifies and changes formattingLocale; isRtl knows the RTL scripts", () => {
    expect(t("hello")).toBe("hello");
    // A key may carry its English text; identity returns the text, else the key.
    expect(t("row.one", "row")).toBe("row");
    const seen: string[] = [];
    const off = onLocaleChange((l) => seen.push(l));
    setLocale("de-DE");
    expect(currentLocale()).toBe("de-DE");
    expect(formattingLocale()).toBe("de-DE");
    expect(seen).toEqual(["de-DE"]);
    off();
    setLocale("ar-EG");
    expect(seen).toEqual(["de-DE"]);
    expect(isRtl("ar-EG")).toBe(true);
    expect(isRtl("en-US")).toBe(false);
    expect(localeLabel("de-DE")).toMatch(/Deutsch|German/);
    setLocale("en-US");
  });
});

describe("tPlural", () => {
  const rows = { one: "row", other: "rows" };
  it("selects the category with Intl.PluralRules for the formatting locale", () => {
    setLocale("en");
    expect(tPlural("row", 1, rows)).toBe("row");
    expect(tPlural("row", 0, rows)).toBe("rows");
    setLocale("fr");
    expect(tPlural("row", 0, rows)).toBe("row");
    setLocale("ru");
    expect(tPlural("row", 3, rows)).toBe("rows"); // `few` has no English form: falls back to other
    setLocale("en-US");
  });
  it("survives a locale Intl cannot parse (falls back to other)", () => {
    setLocale("not a locale!!");
    expect(tPlural("row", 1, rows)).toBe("rows");
    setLocale("en-US");
  });
});
