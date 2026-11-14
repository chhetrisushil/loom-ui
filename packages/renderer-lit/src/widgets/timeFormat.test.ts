import { customWidget$ } from "@loomwork/blueprint-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureI18n, setLocale } from "../i18n";
import "../register";

// A declared TimeFormat drives lu-timeseries' time axis and hover label: each period reads as the
// host wrote it in every reader zone, ticks once per period, and never as a time of day when coarse.

const b = { projectionId: "hydration", path: "values.h" };
const mount = async (id: string, value: unknown, props: Record<string, unknown> = {}) => {
  const el = document.createElement("lu-timeseries") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  Object.assign(el, {
    widget: customWidget$({ kind: "TimeSeries", id, title: "Trend", binding: b, props }),
    value,
  });
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
};
const xTicks = (el: HTMLElement) =>
  [...(el.shadowRoot?.querySelectorAll(".axis text[text-anchor='middle']") ?? [])].map(
    (t) => t.textContent ?? ""
  );
const hoverHead = (el: HTMLElement) => {
  el.shadowRoot
    ?.querySelector("svg")
    ?.dispatchEvent(new MouseEvent("pointermove", { clientX: 0, clientY: 0 }));
  return document.querySelector("[data-lu-tooltip]")?.firstElementChild?.textContent ?? "";
};
const series = (timestamps: string[]) => [
  { label: "rev", points: timestamps.map((timestamp, i) => ({ timestamp, value: i + 1 })) },
];
const months = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
const days = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)
  );
const ZONES = ["America/New_York", "America/Los_Angeles", "Asia/Tokyo", "UTC"];

afterEach(() => {
  vi.unstubAllEnvs();
  // only the charts: the shared tooltip element lives in the body too
  for (const el of document.querySelectorAll("lu-timeseries")) el.remove();
});

describe("lu-timeseries: a declared timeFormat", () => {
  it("quarters over monthly points: one tick per quarter, the written quarter in every zone", async () => {
    setLocale("en-US");
    for (const zone of ZONES) {
      vi.stubEnv("TZ", zone);
      const el = await mount(`q-${zone}`, {
        timeFormat: { granularity: "quarter" },
        series: series(months),
      });
      expect(xTicks(el), zone).toEqual(["Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026"]);
      expect(hoverHead(el), zone).toBe("Q1 2026");
    }
  });

  it("each granularity labels the axis and the hover", async () => {
    setLocale("en-US");
    vi.stubEnv("TZ", "America/Los_Angeles");
    const cases: [string, string[], string, string][] = [
      ["year", ["2025-01", "2026-01"], "2025", "2026"],
      ["half", ["2026-01", "2026-07"], "H1 2026", "H2 2026"],
      ["month", ["2026-01", "2026-02"], "Jan 2026", "Feb 2026"],
      ["week", ["2026-01-05", "2026-01-12"], "Week of Jan 5, 2026", "Week of Jan 12, 2026"],
      ["day", ["2026-01-05", "2026-01-06"], "Jan 5, 2026", "Jan 6, 2026"],
    ];
    for (const [granularity, ts, first, second] of cases) {
      const el = await mount(`g-${granularity}`, {
        timeFormat: { granularity },
        series: series(ts),
      });
      expect(xTicks(el), granularity).toEqual([first, second]);
      expect(hoverHead(el), granularity).toBe(first);
    }
    const dt = await mount("g-datetime", {
      timeFormat: { granularity: "datetime", timeZone: "UTC" },
      series: series(["2026-01-05T09:30:00Z", "2026-01-05T10:30:00Z"]),
    });
    expect(xTicks(dt)).toEqual(["Jan 5, 2026, 9:30 AM", "Jan 5, 2026, 10:30 AM"]);
  });

  it("daily points under a month granularity tick once per month, never as a time of day", async () => {
    setLocale("en-US");
    vi.stubEnv("TZ", "America/New_York");
    const el = await mount("daily", {
      timeFormat: { granularity: "month" },
      series: series(days("2026-01-01", 90)),
    });
    expect(xTicks(el)).toEqual(["Jan 2026", "Feb 2026", "Mar 2026"]);
    // two points a day apart, coarse: dates, not "7:00 PM"
    const short = await mount("short", {
      timeFormat: { granularity: "day" },
      series: series(["2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z"]),
    });
    expect(xTicks(short)).toEqual(["Jan 5, 2026", "Jan 6, 2026"]);
  });

  it("precedence: the value's timeFormat, then props.timeFormat, then the inferred label", async () => {
    setLocale("en-US");
    vi.stubEnv("TZ", "UTC");
    const ts = ["2026-01", "2026-04"];
    const both = await mount(
      "p1",
      { timeFormat: { granularity: "quarter" }, series: series(ts) },
      { timeFormat: { granularity: "month" } }
    );
    expect(xTicks(both)).toEqual(["Q1 2026", "Q2 2026"]);
    const prop = await mount(
      "p2",
      { series: series(ts) },
      { timeFormat: { granularity: "month" } }
    );
    expect(xTicks(prop)).toEqual(["Jan 2026", "Apr 2026"]);
    expect(hoverHead(prop)).toBe("Jan 2026");
    // a prop is never checked: a malformed one is ignored, not a RangeError out of the render
    for (const bad of [
      { granularity: "month", timeZone: "Mars/Olympus" },
      { granularity: "eon" },
    ]) {
      const el = await mount(`p3-${bad.granularity}`, { series: series(ts) }, { timeFormat: bad });
      expect(xTicks(el)).toEqual(["Jan 1, 2026", "Apr 1, 2026"]);
    }
    const none = await mount("p4", { series: series(ts) });
    expect(xTicks(none)).toEqual(["Jan 1, 2026", "Apr 1, 2026"]);
  });

  it("the catalogue words and the locale are the reader's", async () => {
    configureI18n({ locale: "de-DE", messages: { "lu.time.quarter": "{n}. Quartal {year}" } });
    vi.stubEnv("TZ", "UTC");
    const el = await mount("de", {
      timeFormat: { granularity: "quarter" },
      series: series(["2026-01", "2026-04"]),
    });
    expect(xTicks(el)).toEqual(["1. Quartal 2026", "2. Quartal 2026"]);
    // and the locale: a German month
    const month = await mount("de-m", {
      timeFormat: { granularity: "month" },
      series: series(["2026-03"]),
    });
    expect(xTicks(month)).toEqual(["März 2026"]);
    configureI18n(undefined);
    setLocale("en-US");
  });
});
