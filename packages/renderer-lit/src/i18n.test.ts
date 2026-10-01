import { afterEach, describe, expect, it, vi } from "vitest";
import * as i18n from "./i18n";
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
  afterEach(() => {
    vi.restoreAllMocks();
    setLocale("en-US");
  });
  /** A host catalogue: `t(key, fallback)` answers from `cat`, else returns the fallback (identity). */
  const catalogue = (cat: Record<string, string>) =>
    vi.spyOn(i18n, "t").mockImplementation((key, fallback) => cat[key] ?? fallback ?? key);

  it("English: category by the English rules", () => {
    setLocale("en");
    expect(tPlural("row", 1, rows)).toBe("row");
    expect(tPlural("row", 0, rows)).toBe("rows");
    expect(tPlural("row", 2, rows)).toBe("rows");
  });
  it("with no translation the English text is grammatical in EVERY locale (identity t)", () => {
    // ja has only `other` (so n=1 would be "1 rows"); fr/pt treat 0 as `one` (so "0 row").
    for (const l of [
      "ja-JP",
      "zh",
      "fr",
      "fr-FR",
      "pt-BR",
      "ru",
      "ar-EG",
      "pl",
      "de-DE",
      "en-GB",
    ]) {
      setLocale(l);
      expect(tPlural("row", 1, rows), `${l} n=1`).toBe("row");
      expect(tPlural("row", 0, rows), `${l} n=0`).toBe("rows");
      expect(tPlural("row", 2, rows), `${l} n=2`).toBe("rows");
      expect(tPlural("row", 5, rows), `${l} n=5`).toBe("rows");
    }
  });
  it("a locale's plural category is used only where a translation exists for it", () => {
    setLocale("ru");
    // The host translates the three Russian categories it needs; `many`/`other` are absent.
    catalogue({ "row.one": "строка", "row.few": "строки", "row.many": "строк" });
    expect(tPlural("row", 1, rows)).toBe("строка"); // one
    expect(tPlural("row", 3, rows)).toBe("строки"); // few
    expect(tPlural("row", 5, rows)).toBe("строк"); // many
    expect(tPlural("row", 21, rows)).toBe("строка"); // one again (ru rules)
    // `other` (1.5) has no translation: the English rules answer, and they are grammatical.
    expect(tPlural("row", 1.5, rows)).toBe("rows");
  });
  it("a translated French `one` covers 0, a French host without `other` still reads English", () => {
    setLocale("fr");
    catalogue({ "row.one": "ligne" });
    expect(tPlural("row", 0, rows)).toBe("ligne");
    expect(tPlural("row", 1, rows)).toBe("ligne");
    expect(tPlural("row", 2, rows)).toBe("rows"); // `other` untranslated: English
  });
  it("a locale with a single category (ja) uses its translated `other` for every count", () => {
    setLocale("ja-JP");
    catalogue({ "row.other": "行" });
    for (const n of [0, 1, 2, 10]) expect(tPlural("row", n, rows)).toBe("行");
  });
  it("survives a locale Intl cannot parse (English rules)", () => {
    setLocale("not a locale!!");
    expect(tPlural("row", 1, rows)).toBe("row");
    expect(tPlural("row", 2, rows)).toBe("rows");
  });
});
