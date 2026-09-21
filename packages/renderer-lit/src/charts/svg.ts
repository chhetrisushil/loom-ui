// Dependency-free SVG chart helpers: scales, nice ticks, path builders.
// Pure functions — the Lit widgets are thin templates over these. Anything
// locale-dependent lives in ../format.ts, which has a LocaleContext to work from.

export interface Scale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
}

export function linearScale(domain: [number, number], range: [number, number]): Scale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  const fn = ((v: number) => r0 + ((v - d0) / span) * (r1 - r0)) as Scale;
  fn.domain = domain;
  fn.range = range;
  return fn;
}

/** 4-6 "nice" ticks covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  // Sanitised at the door so the function is TOTAL: every caller scales these
  // values into pixel coordinates, and one non-finite tick becomes `y1="NaN"` on
  // a gridline — which voids that element and, on some renderers, the group
  // around it. Guarding here protects every axis rather than each caller
  // remembering to.
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 1;
  if (lo === hi) {
    if (lo === 0) return [0, 1];
    lo = lo > 0 ? 0 : lo * 2;
    hi = hi > 0 ? hi * 1.2 : 0;
  }
  const span = hi - lo;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? mag * 10;
  const start = Math.ceil(lo / step) * step;
  // `v += step` has to actually MOVE v. When the range is flat to within a few
  // ULPs — a metric that barely changes, or a script that divided by something
  // huge — the step lands below the precision of `start` and the addition is a
  // no-op, so the loop below never terminates and takes the tab with it. The
  // domain is still legitimate; it simply cannot be subdivided, so it gets its
  // own two ticks rather than an infinite number of them.
  if (!Number.isFinite(step) || step <= 0 || start + step === start) return [lo, hi];
  const ticks: number[] = [];
  // A ceiling as well as the guard above: `count` is a request for 4-6 ticks, so
  // anything past a small multiple of it means the arithmetic went somewhere
  // unintended and an axis with thousands of labels helps nobody either way.
  const limit = count * 4 + 2;
  for (let v = start; v <= hi + step / 1e6 && ticks.length < limit; v += step) {
    ticks.push(Math.round(v * 1e9) / 1e9);
  }
  return ticks;
}

/**
 * The [min, max] of the values that can actually be PLOTTED.
 *
 * Non-finite values are skipped, not merely tolerated. Ignoring NaN was already
 * accidental — `NaN < min` is false — but Infinity sailed through and became the
 * axis maximum, and every finite point then scaled to `v / Infinity`, i.e. zero,
 * while the tick at Infinity scaled to NaN and poisoned the gridline geometry.
 * One bad value took out the whole chart.
 *
 * A lone Infinity therefore no longer stretches the axis; its own point is
 * dropped by `linePath`, and the rest of the series draws as it should.
 */
export function extent(values: number[]): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  return [min, max];
}

/** Pad a [min,max] domain so lines don't hug the frame; zero-anchor positives. */
export function padDomain([min, max]: [number, number]): [number, number] {
  if (min >= 0 && min < max * 0.4) min = 0;
  const pad = (max - min || Math.abs(max) || 1) * 0.08;
  return [min === 0 ? 0 : min - pad, max + pad];
}

/**
 * A polyline through the points, skipping any that are not finite.
 *
 * `(NaN).toFixed(1)` is the string "NaN", so one bad coordinate used to yield
 * `d="M0.0,0.0LNaN,10.0…"` — and a path the browser cannot parse is not
 * partially drawn, it is not drawn AT ALL. The widget then occupies its cell,
 * reports ready, logs nothing, and shows an empty box. Non-finite values reach
 * here easily: the canonical-shape gate rejects NaN but ACCEPTS Infinity, which
 * is what a reshape script produces by dividing by a count that was zero.
 *
 * A gap starts a new subpath rather than joining across it. Connecting the
 * points either side would draw a straight line through missing data and invent
 * a trend that was never in it.
 */
export function linePath(points: { x: number; y: number }[]): string {
  let d = "";
  let penDown = false;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      penDown = false;
      continue;
    }
    d += `${penDown ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    penDown = true;
  }
  return d;
}

/** The same line, closed down to `baseline`. Non-finite points are skipped, and
 * the closing edges are anchored on the first and last points that SURVIVED —
 * anchoring on the raw first/last would put a NaN back into the path that
 * `linePath` just took out of it. */
export function areaPath(points: { x: number; y: number }[], baseline: number): string {
  const finite = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (finite.length === 0 || !Number.isFinite(baseline)) return "";
  const line = linePath(finite);
  // Non-null: the length check above guarantees both indices exist.
  const last = finite[finite.length - 1]!;
  const first = finite[0]!;
  return `${line}L${last.x.toFixed(1)},${baseline}L${first.x.toFixed(1)},${baseline}Z`;
}

// `formatValue`/`formatTime` used to live here. They hardcoded English — "1.2M"
// (German writes "1,2 Mio."), a literal month-name table, and a clock read from
// the browser's timezone rather than the reader's. Their locale-aware
// replacements are `measure`/`tick`/`timeTick` in ../format.ts, which need a
// LocaleContext and so do not belong in this dependency-free module.

/** Evenly-spaced index ticks for a time axis (first/last always included). */
export function timeTickIndices(n: number, count = 5): number[] {
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(i * step));
}

/** The categorical series ramp (indigo-anchored, colorblind-considerate). */
export const SERIES_COLORS = ["#818cf8", "#34d399", "#fbbf24", "#f472b6", "#38bdf8", "#fb923c"];
