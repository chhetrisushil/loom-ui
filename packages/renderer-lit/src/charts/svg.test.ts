import { describe, expect, it } from "vitest";
import {
  areaPath,
  extent,
  linePath,
  linearScale,
  niceTicks,
  padDomain,
  timeTickIndices,
} from "./svg.js";

// ── The geometry a generated blueprint gets drawn with ───────────────────────
//
// These functions turn a CanonicalDataShape into pixels, and the shape is
// whatever an LLM-authored reshape script produced. So the inputs here are not
// hypothetical edge cases — they are the ordinary output of a script that
// divided by a count that happened to be zero, or filtered a series down to one
// point, or summed a column of nulls.
//
// The failure mode is specific and silent: any NaN reaching a path's `d` voids
// the whole path, and the browser draws NOTHING. No error, no warning, a widget
// of exactly the right size containing nothing at all. Every assertion below
// exists to keep a number from becoming that.

describe("linearScale", () => {
  it("maps a domain across a range", () => {
    const s = linearScale([0, 10], [0, 100]);
    expect(s(0)).toBe(0);
    expect(s(5)).toBe(50);
    expect(s(10)).toBe(100);
  });

  // A single-point series, or a flat one — every value identical — gives a zero
  // span. Without the guard this is 0/0 for every point.
  it("survives a zero-width domain", () => {
    const s = linearScale([7, 7], [0, 100]);
    expect(Number.isFinite(s(7))).toBe(true);
  });

  it("stays finite for an inverted range", () => {
    const s = linearScale([0, 10], [100, 0]);
    expect(s(0)).toBe(100);
    expect(s(10)).toBe(0);
  });
});

describe("extent", () => {
  it("finds min and max", () => {
    expect(extent([3, 1, 4, 1, 5])).toEqual([1, 5]);
  });

  // An empty series is what a filter that matched nothing produces, and it is
  // extremely common in generated reshape scripts.
  it("falls back to a usable domain when there is nothing to measure", () => {
    expect(extent([])).toEqual([0, 1]);
  });

  it("ignores NaN rather than propagating it", () => {
    const [min, max] = extent([1, Number.NaN, 3]);
    expect(Number.isFinite(min) && Number.isFinite(max)).toBe(true);
  });

  it("returns a usable domain when every value is NaN", () => {
    expect(extent([Number.NaN, Number.NaN])).toEqual([0, 1]);
  });
});

describe("padDomain", () => {
  it("anchors a positive domain at zero", () => {
    expect(padDomain([2, 100])[0]).toBe(0);
  });

  it("stays finite for an all-zero series", () => {
    const [lo, hi] = padDomain([0, 0]);
    expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true);
    expect(hi).toBeGreaterThan(lo);
  });

  it("stays finite for a negative domain", () => {
    const [lo, hi] = padDomain([-50, -10]);
    expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("niceTicks", () => {
  it("covers an ordinary range with a handful of ticks", () => {
    const ticks = niceTicks(0, 100);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.every(Number.isFinite)).toBe(true);
    expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(100.001);
  });

  it("handles a flat series without dividing by zero", () => {
    expect(niceTicks(5, 5).every(Number.isFinite)).toBe(true);
    expect(niceTicks(0, 0)).toEqual([0, 1]);
  });

  it("handles negative and straddling ranges", () => {
    expect(niceTicks(-100, -10).every(Number.isFinite)).toBe(true);
    expect(niceTicks(-50, 50).every(Number.isFinite)).toBe(true);
  });

  // The loop is `for (v = start; v <= hi; v += step)`. A step of zero would
  // never terminate and would hang the tab, not just the widget — so this
  // asserts termination, with the value check second.
  it("terminates on a range too small to make ticks from", () => {
    const ticks = niceTicks(1, 1 + Number.EPSILON);
    expect(Array.isArray(ticks)).toBe(true);
    expect(ticks.length).toBeLessThan(1000);
  });

  it("terminates on an enormous range", () => {
    const ticks = niceTicks(0, Number.MAX_SAFE_INTEGER);
    expect(ticks.length).toBeLessThan(1000);
    expect(ticks.every(Number.isFinite)).toBe(true);
  });
});

describe("linePath", () => {
  it("writes a move-then-line path", () => {
    expect(
      linePath([
        { x: 0, y: 0 },
        { x: 10, y: 5 },
      ])
    ).toBe("M0.0,0.0L10.0,5.0");
  });

  it("is empty for no points, not a broken path", () => {
    expect(linePath([])).toBe("");
  });

  // The whole reason this file exists. `(NaN).toFixed(1)` is the string "NaN",
  // so a single bad coordinate yields `d="MNaN,NaN…"` — which the browser
  // refuses in its entirety, drawing nothing and reporting nothing.
  it("never emits a NaN coordinate", () => {
    const d = linePath([
      { x: 0, y: 0 },
      { x: Number.NaN, y: 10 },
      { x: 20, y: Number.NaN },
    ]);
    expect(d).not.toMatch(/NaN/);
  });

  it("never emits an Infinite coordinate", () => {
    const d = linePath([
      { x: 0, y: 0 },
      { x: Number.POSITIVE_INFINITY, y: 10 },
      { x: 20, y: Number.NEGATIVE_INFINITY },
    ]);
    expect(d).not.toMatch(/Infinity/);
  });
});

describe("areaPath", () => {
  it("closes the shape back to the baseline", () => {
    const d = areaPath(
      [
        { x: 0, y: 10 },
        { x: 10, y: 5 },
      ],
      100
    );
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
  });

  it("is empty for no points", () => {
    expect(areaPath([], 100)).toBe("");
  });

  it("never emits a NaN coordinate", () => {
    const d = areaPath(
      [
        { x: 0, y: 0 },
        { x: Number.NaN, y: 10 },
      ],
      100
    );
    expect(d).not.toMatch(/NaN/);
  });
});

describe("timeTickIndices", () => {
  it("labels every point when there are few", () => {
    expect(timeTickIndices(3)).toEqual([0, 1, 2]);
  });

  it("thins a long series to a readable count, keeping both ends", () => {
    const idx = timeTickIndices(100);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(99);
    expect(idx.length).toBeLessThanOrEqual(5);
  });

  it("survives an empty or single-point series", () => {
    expect(timeTickIndices(0)).toEqual([]);
    expect(timeTickIndices(1)).toEqual([0]);
  });
});
