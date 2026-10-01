import { describe, expect, it } from "vitest";
import { checkKindValue as lite, checkKindValueIssues as liteIssues } from "./kindValues";
import { kindValueContract, kindValueContracts, checkKindValue as zodCheck } from "./values";

// A SEEDED randomized differential test: the hand-written zod-free `checkKindValue` against the
// zod contracts, for EVERY kind. It exists to catch drift — e.g. after a zod upgrade changes an
// issue's wording or order — beyond what `kindValues.test.ts`'s single-point mutations reach.
//
//   * schema-shaped skeletons (random optionals, random picks from valid AND near-valid pools),
//   * then several simultaneous mutations at random depths (replace, delete, truncate),
//   * deep junk: own `__proto__` keys, `then`/`catch` objects, NaN, ±Infinity, -0, Date, Map,
//     Set, bigint, symbols, functions, cyclic-free nested structures,
//   * the VERDICT, the MESSAGE and the FULL issue list (path, message, order) must match.
//
// Deterministic: one fixed seed, a fixed iteration count. On a mismatch the failure prints the
// seed, the iteration and the offending value, so it replays exactly.

const SEED = 0x5eed_c0de;
const ITERATIONS = 1200; // per kind

/** mulberry32: a tiny, well-distributed, seedable PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const int = (r: Rng, n: number): number => Math.floor(r() * n);
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[int(r, xs.length)] as T;
const chance = (r: Rng, p: number): boolean => r() < p;

// ── Skeletons: schema-shaped values, valid most of the time, near-valid some of the time ────

const digits = [0, 0, 1, 2, 3, 20, 21, -1, 1.5, 0.5];
const nums = [0, 1, -1, 42, 3.14, 1e9, -0, Number.NaN, Number.POSITIVE_INFINITY];
const strs = ["", "a", "label", "USD", "usd", "US", "ms", "x y"];
const maybe = <T>(r: Rng, make: () => T, p = 0.5): T | undefined =>
  chance(r, p) ? make() : undefined;

function genFormat(r: Rng): Record<string, unknown> {
  const f: Record<string, unknown> = {
    semanticType: pick(r, [
      "number",
      "integer",
      "decimal",
      "percentage",
      "currency",
      "number",
      "integer",
      "currency",
      "bogus",
    ]),
  };
  if (chance(r, 0.5)) f.currency = pick(r, ["USD", "EUR", "usd", "US", "USDX", ""]);
  if (chance(r, 0.4)) f.notation = pick(r, ["standard", "compact", "compact", "long"]);
  if (chance(r, 0.5)) f.minimumFractionDigits = pick(r, digits);
  if (chance(r, 0.5)) f.maximumFractionDigits = pick(r, digits);
  return f;
}
const finite = (r: Rng): number =>
  chance(r, 0.9) ? pick(r, [0, 1, -1, 42, 3.14, 1e9]) : pick(r, nums);
const arr = <T>(r: Rng, make: () => T, max = 4): T[] =>
  Array.from({ length: int(r, max + 1) }, make);
const withOptional = (r: Rng, o: Record<string, unknown>, key: string, v: () => unknown) => {
  if (chance(r, 0.5)) o[key] = v();
};

const GENERATORS: Readonly<Record<string, (r: Rng) => unknown>> = {
  MetricCard: finite,
  StatusBadge: (r) => pick(r, strs),
  ProgressBar: finite,
  AlertCard: (r) => pick(r, strs),
  StreamingText: (r) => pick(r, strs),
  Timeline: (r) => arr(r, () => pick(r, [{}, 1, "e", { at: 1 }])),
  DataTable: (r) => arr(r, () => pick(r, [{ a: 1 }, {}, { a: { b: [1] } }, 1])),
  ApprovalCard: (r) => pick(r, [true, { id: 1 }, "x"]),
  TimeSeries: (r) => ({
    series: arr(r, () => {
      const s: Record<string, unknown> = {
        label: pick(r, strs),
        points: arr(r, () => ({ timestamp: pick(r, strs), value: finite(r) })),
      };
      withOptional(r, s, "unit", () => pick(r, strs));
      withOptional(r, s, "format", () => genFormat(r));
      withOptional(r, s, "axis", () => pick(r, ["left", "right", "top"]));
      return s;
    }),
  }),
  BarChart: (r) => {
    const o: Record<string, unknown> = {
      bars: arr(r, () => ({ label: pick(r, strs), value: finite(r) })),
    };
    withOptional(r, o, "unit", () => pick(r, strs));
    withOptional(r, o, "format", () => genFormat(r));
    return o;
  },
  Kpi: (r) => {
    const o: Record<string, unknown> = { value: finite(r) };
    withOptional(r, o, "unit", () => pick(r, strs));
    withOptional(r, o, "format", () => genFormat(r));
    withOptional(r, o, "label", () => pick(r, strs));
    withOptional(r, o, "deltaPct", () => (chance(r, 0.3) ? null : finite(r)));
    return o;
  },
  Table: (r) => {
    const columns = arr(r, () =>
      chance(r, 0.5)
        ? pick(r, strs)
        : { label: pick(r, strs), ...(chance(r, 0.5) ? { format: genFormat(r) } : {}) }
    );
    return {
      columns,
      rows: arr(r, () => arr(r, () => pick(r, [...strs, 1, 2.5, null, -0, Number.NaN])), 5),
    };
  },
  StatusCard: (r) => {
    const o: Record<string, unknown> = {
      level: pick(r, ["ok", "warning", "critical", "fatal"]),
      headline: pick(r, strs),
    };
    withOptional(r, o, "detail", () => pick(r, strs));
    return o;
  },
  Note: () => undefined,
  A2UIView: (r) => pick(r, [{ x: 1 }, [], "s"]),
  SandboxView: (r) => pick(r, [{ x: 1 }, [], "s"]),
};

// ── Deep junk: a fresh value each call (the checkers must not mutate it, but never share) ────

const JUNK: ReadonlyArray<(r: Rng) => unknown> = [
  () => null,
  () => undefined,
  () => Number.NaN,
  () => Number.POSITIVE_INFINITY,
  () => Number.NEGATIVE_INFINITY,
  () => -0,
  () => 0,
  () => 1.5,
  () => 21,
  () => -1,
  () => 10n,
  () => Symbol("s"),
  () => () => 1,
  () => new Date(0),
  () => new Date(Number.NaN),
  () => new Map([["a", 1]]),
  () => new Set([1]),
  () => "",
  () => "USD",
  () => "ok",
  () => true,
  () => [],
  () => [[]],
  () => ({}),
  // An OWN `__proto__` key (JSON.parse creates one; an object literal would set the prototype).
  () => JSON.parse('{"__proto__":{"label":"x","value":1},"label":"y"}'),
  () => JSON.parse('{"__proto__":[1]}'),
  // Thenables: zod calls a value with both `then` and `catch` a promise; with only `then` it is
  // an ordinary object. Deliberate, so the linter's `then` rule is waived on exactly these.
  () => ({
    // biome-ignore lint/suspicious/noThenProperty: a thenable is the junk under test
    then: () => 1,
    catch: () => 1,
  }),
  () => ({
    // biome-ignore lint/suspicious/noThenProperty: a then-only object is the junk under test
    then: () => 1,
  }),
  () => Promise.resolve(1),
  () => ({ semanticType: "currency" }),
  () => ({ semanticType: "integer", maximumFractionDigits: 2 }),
  () => ({ semanticType: "number", minimumFractionDigits: 5, maximumFractionDigits: 1 }),
  () => ({ label: 1, format: { semanticType: 3 } }),
  () => ({ key: "k", fallback: "f" }),
  (r) => ({ a: { b: { c: [1, { d: pick(r, nums) }] } } }),
  (r) => [pick(r, nums), pick(r, strs), null, [pick(r, nums)]],
];
const junk = (r: Rng): unknown => pick(r, JUNK)(r);

// ── Multi-point mutation ──────────────────────────────────────────────────────────────────

type Step = string | number;
function collect(node: unknown, path: Step[], out: Step[][]): void {
  out.push(path);
  if (Array.isArray(node)) node.forEach((x, i) => collect(x, [...path, i], out));
  else if (
    node !== null &&
    typeof node === "object" &&
    Object.getPrototypeOf(node) === Object.prototype
  )
    for (const k of Object.keys(node))
      collect((node as Record<string, unknown>)[k], [...path, k], out);
}

/** Copy `node` with the value at `path` replaced by `edit(old)` (`DELETE` removes the key). */
const DELETE = Symbol("delete");
function edit(node: unknown, path: readonly Step[], f: (old: unknown) => unknown): unknown {
  if (path.length === 0) return f(node);
  const [head, ...rest] = path as [Step, ...Step[]];
  if (Array.isArray(node)) {
    const copy = node.slice();
    const next = edit(node[head as number], rest, f);
    if (next === DELETE) copy.splice(head as number, 1);
    else copy[head as number] = next;
    return copy;
  }
  const o = { ...(node as Record<string, unknown>) };
  const next = edit(o[head as string], rest, f);
  if (next === DELETE) delete o[head as string];
  else o[head as string] = next;
  return o;
}

function mutate(r: Rng, base: unknown): unknown {
  let v = base;
  const points = 1 + int(r, 4);
  for (let i = 0; i < points; i++) {
    const paths: Step[][] = [];
    collect(v, [], paths);
    const path = pick(r, paths);
    const how = int(r, 5);
    v = edit(v, path, (old) => {
      if (how === 0 && path.length > 0) return DELETE;
      if (how === 1 && Array.isArray(old)) return old.slice(0, int(r, old.length + 1));
      return junk(r);
    });
    // `DELETE` at the root is meaningless; keep the root as junk.
    if (v === DELETE) v = junk(r);
  }
  return v;
}

/** JSON-ish, but total: bigint, symbol, function, NaN, -0, Map, Date all print distinguishably. */
function show(v: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    v,
    (_k, x) => {
      if (typeof x === "bigint") return `${x}n`;
      if (typeof x === "symbol") return x.toString();
      if (typeof x === "function") return `[fn ${x.name}]`;
      if (typeof x === "number")
        return Object.is(x, -0) ? "-0" : Number.isFinite(x) ? x : String(x);
      if (x instanceof Map) return { $map: [...x] };
      if (x instanceof Set) return { $set: [...x] };
      if (x instanceof Date)
        return { $date: Number.isNaN(x.getTime()) ? "invalid" : x.toISOString() };
      if (x !== null && typeof x === "object") {
        if (seen.has(x)) return "[circular]";
        seen.add(x);
      }
      return x;
    },
    1
  );
}

describe(`zod-free checker vs zod contracts — seeded fuzz (seed 0x${SEED.toString(16)}, ${ITERATIONS}/kind)`, () => {
  for (const kind of Object.keys(kindValueContracts)) {
    it(`${kind}: same verdict and same message`, () => {
      const r = prng(SEED ^ kind.split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7));
      const gen = GENERATORS[kind];
      expect(gen, `no generator for ${kind}`).toBeDefined();
      let failures = 0;
      let multi = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const base = (gen as (r: Rng) => unknown)(r);
        // Half the corpus is the bare skeleton (valid or near-valid), half is multi-point mutated.
        const value = chance(r, 0.5) ? base : mutate(r, base);
        const want = zodCheck(kind, value);
        const got = lite(kind, value);
        if (!want.ok) failures++;
        expect(
          got,
          `DRIFT for ${kind} — seed 0x${SEED.toString(16)}, iteration ${i}\nvalue: ${show(value)}\nzod:   ${JSON.stringify(want)}\nlite:  ${JSON.stringify(got)}`
        ).toEqual(want);
        // The whole list, not just the first issue: a drift in the 2nd issue's wording or order
        // would be invisible to the finding (which reports issues[0]) but is still drift.
        const zr = kindValueContract(kind)?.safeParse(value);
        const wantIssues =
          value === undefined || zr === undefined || zr.success
            ? []
            : zr.error.issues.map((x) => ({ path: x.path, message: x.message }));
        const gotIssues = liteIssues(kind, value).map((x) => ({
          path: x.path,
          message: x.message,
        }));
        if (wantIssues.length > 1) multi++;
        expect(
          gotIssues,
          `ISSUE-LIST DRIFT for ${kind} — seed 0x${SEED.toString(16)}, iteration ${i}\nvalue: ${show(value)}`
        ).toEqual(wantIssues);
      }
      // The corpus must exercise BOTH verdicts for every kind with a real contract.
      if (!["ApprovalCard", "A2UIView", "SandboxView"].includes(kind)) {
        expect(failures).toBeGreaterThan(ITERATIONS / 20);
        expect(failures).toBeLessThan(ITERATIONS);
      }
      // The full-list comparison is only meaningful if the corpus has multi-issue values.
      if (["TimeSeries", "BarChart", "Table", "StatusCard", "Kpi"].includes(kind)) {
        expect(multi, `${kind}: no multi-issue values in the corpus`).toBeGreaterThan(0);
      }
    });
  }

  it("the same seed generates the same corpus (the test is deterministic)", () => {
    const run = () => {
      const r = prng(SEED);
      return Array.from({ length: 50 }, () => show(mutate(r, GENERATORS.Table?.(r))));
    };
    expect(run()).toEqual(run());
  });
});
