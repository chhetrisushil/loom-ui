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

describe("locale shim", () => {
  it("t is identity; setLocale notifies and changes formattingLocale; isRtl knows the RTL scripts", () => {
    expect(t("hello")).toBe("hello");
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
