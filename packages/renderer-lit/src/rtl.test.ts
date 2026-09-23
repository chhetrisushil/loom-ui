import { afterEach, describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { dirFor, rtlBehaviorOf } from "./rtl";

// The keys in RTL_BEHAVIOR are TAG NAMES, and the tags are `lu-*`. Before the element-prefix
// rename they carried a different prefix, which made every lookup miss and every chart mirror
// inside an Arabic page, silently: a "preserve" behaviour that never matches looks exactly like
// no behaviour at all.

afterEach(() => {
  setLocale("en-US");
});

describe("rtl", () => {
  it("pins the charts to ltr under an RTL locale, by their real tag names", () => {
    setLocale("ar");
    expect(dirFor("lu-timeseries")).toBe("ltr");
    expect(dirFor("lu-bar-chart")).toBe("ltr");
    expect(dirFor("lu-sparkline")).toBe("ltr");
    // The uppercase `element.tagName` is what the widgets actually pass.
    expect(dirFor("LU-BAR-CHART")).toBe("ltr");
  });
  it("lets everything else inherit the page direction", () => {
    setLocale("ar");
    expect(dirFor("lu-metric-card")).toBeUndefined();
    expect(rtlBehaviorOf("lu-metric-card")).toBe("mirror");
  });
  it("pins nothing under an LTR locale", () => {
    setLocale("en-US");
    expect(dirFor("lu-timeseries")).toBeUndefined();
    expect(rtlBehaviorOf("lu-timeseries")).toBe("preserve");
  });
});
