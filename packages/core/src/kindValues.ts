// The ZOD-FREE half of the per-kind value contracts, for a browser bundle.
//
// `values.ts` declares each kind's contract as a zod schema, and zod is ~60 kB minified that a
// bundler cannot tree-shake (its schemas are top-level objects). A browser renderer needs only a
// verdict — "does this value fit its kind, and if not, what do I say?" — so that verdict is
// computed here by hand, from the SAME contract, with NO runtime import. `import type` from
// `values.ts` is erased, so nothing below drags zod into a bundle.
//
// The two declarations must not drift: `kindValues.test.ts` runs this checker and
// `kindValueContract(kind).safeParse` over a large mutated corpus and requires the same verdict
// AND the same finding message, which is the message a reader sees in an error state. Change a
// contract in `values.ts` and that test fails until this file follows.

import type { Finding } from "./experience";
import type { SemanticFormat, TableColumn } from "./values";

/** The kinds this framework adds over loom's built-ins. */
export const FRAMEWORK_KINDS = [
  "TimeSeries",
  "BarChart",
  "Kpi",
  "Table",
  "StatusCard",
  "Note",
  "A2UIView",
  "SandboxView",
] as const;

/** A column's heading, whichever form it was written in. */
export function tableColumnLabel(column: TableColumn): string {
  return typeof column === "string" ? column : column.label;
}
/** A column's semantics, if it declared any. */
export function tableColumnFormat(column: TableColumn): SemanticFormat | undefined {
  return typeof column === "string" ? undefined : column.format;
}

/** `{ key, fallback }` — a localizable text that has not been resolved yet (`LocalizedText`). */
export function isLocalizedText(v: unknown): v is { key: string; fallback: string } {
  return (
    parsedType(v) === "object" &&
    typeof (v as { key?: unknown }).key === "string" &&
    (v as { key: string }).key.length > 0 &&
    typeof (v as { fallback?: unknown }).fallback === "string"
  );
}

// ── A minimal validator with zod's own issue semantics ─────────────────────────
// Only what the contracts use. A node is `valid`, `dirty` (a check failed but the value is the
// right type — it still parses) or `aborted` (wrong type). The distinction decides what a union
// reports, exactly as zod's does: a dirty option's own issues win over "Invalid input".

type Status = "valid" | "dirty" | "aborted";
interface Issue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}
/**
 * The path to the value being checked: ONE mutable stack, pushed and popped around each child,
 * so a clean value allocates no per-node path. An issue copies it (`fail`); nothing else may keep it.
 */
type Path = (string | number)[];

/** zod's `getParsedType` names, as they appear in its messages. */
function parsedType(v: unknown): string {
  switch (typeof v) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(v) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    default:
      if (Array.isArray(v)) return "array";
      if (v === null) return "null";
      if (
        typeof (v as { then?: unknown }).then === "function" &&
        typeof (v as { catch?: unknown }).catch === "function"
      )
        return "promise";
      if (typeof Map !== "undefined" && v instanceof Map) return "map";
      if (typeof Set !== "undefined" && v instanceof Set) return "set";
      if (typeof Date !== "undefined" && v instanceof Date) return "date";
      return "object";
  }
}

const invalidType = (expected: string, received: string): string =>
  received === "undefined" ? "Required" : `Expected ${expected}, received ${received}`;

type Out = Issue[];

/**
 * A sink that records nothing. Validators take their `out` as a parameter, so a caller that needs
 * only the STATUS (a union's first pass) hands this one: no issue objects, no path copies. The
 * issues are built only when something fails and someone will read them.
 */
const SINK: Out = Object.freeze([]) as unknown as Out;
/** Record an issue — copying the (shared, mutable) path stack only when the issue is kept. */
function fail(out: Out, path: Path, message: string): void {
  if (out !== SINK) out.push({ path: path.slice(), message });
}
type Opt = { optional?: boolean; nullable?: boolean };

function type(expected: string, v: unknown, path: Path, out: Out): Status {
  const got = parsedType(v);
  if (got === expected) return "valid";
  fail(out, path, invalidType(expected, got));
  return "aborted";
}
const string = (v: unknown, p: Path, out: Out): Status => type("string", v, p, out);
const number = (v: unknown, p: Path, out: Out): Status => type("number", v, p, out);
const worst = (a: Status, b: Status): Status =>
  a === "aborted" || b === "aborted"
    ? "aborted"
    : a === "dirty" || b === "dirty"
      ? "dirty"
      : "valid";

/** An optional / nullable wrapper: `undefined` (and `null`, if nullable) pass without a look. */
function opt(
  v: unknown,
  path: Path,
  out: Out,
  o: Opt,
  inner: (v: unknown, p: Path, out: Out) => Status
): Status {
  if (v === undefined && o.optional) return "valid";
  if (v === null && o.nullable) return "valid";
  return inner(v, path, out);
}

/** `z.object` (non-strict): every key is visited in declaration order, extras ignored. */
function object(
  v: unknown,
  path: Path,
  out: Out,
  keys: ReadonlyArray<readonly [string, (v: unknown, p: Path, out: Out) => Status]>
): Status {
  if (type("object", v, path, out) === "aborted") return "aborted";
  let status: Status = "valid";
  for (const [key, check] of keys) {
    path.push(key);
    status = worst(status, check((v as Record<string, unknown>)[key], path, out));
    path.pop();
  }
  return status;
}

function array(
  v: unknown,
  path: Path,
  out: Out,
  item: (v: unknown, p: Path, out: Out) => Status
): Status {
  if (type("array", v, path, out) === "aborted") return "aborted";
  let status: Status = "valid";
  const items = v as unknown[];
  for (let i = 0; i < items.length; i++) {
    path.push(i);
    status = worst(status, item(items[i], path, out));
    path.pop();
  }
  return status;
}

function enumOf(options: readonly string[]) {
  const joined = options.map((o) => `'${o}'`).join(" | ");
  return (v: unknown, path: Path, out: Out): Status => {
    if (typeof v !== "string") {
      fail(out, path, invalidType(joined, parsedType(v)));
      return "aborted";
    }
    if (options.includes(v)) return "valid";
    fail(out, path, `Invalid enum value. Expected ${joined}, received '${v}'`);
    return "aborted";
  };
}

/**
 * `z.union([a, b])`: first valid option wins; else the first DIRTY option's issues; else
 * "Invalid input". The common case is a value that fits some option, so the first pass runs every
 * option against the SINK (status only — no issue arrays, no path copies); only a value that fits
 * none re-runs the options with real issue arrays, to build what the reader will see.
 */
function union(
  v: unknown,
  path: Path,
  out: Out,
  options: ReadonlyArray<(v: unknown, p: Path, out: Out) => Status>
): Status {
  let dirty = false;
  for (const option of options) {
    const status = option(v, path, SINK);
    if (status === "valid") return "valid";
    if (status === "dirty") dirty = true;
  }
  // Nobody reads the issues (we are inside another union's first pass): the status is the answer.
  if (out === SINK) return dirty ? "dirty" : "aborted";
  if (dirty) {
    for (const option of options) {
      const issues: Out = [];
      if (option(v, path, issues) === "dirty") {
        out.push(...issues);
        return "dirty";
      }
    }
  }
  fail(out, path, "Invalid input");
  return "aborted";
}

// ── The contracts ──────────────────────────────────────────────────────────────

const SEMANTIC_TYPES = enumOf(["number", "integer", "decimal", "percentage", "currency"]);
const NOTATIONS = enumOf(["standard", "compact"]);
const AXES = enumOf(["left", "right"]);
const LEVELS = enumOf(["ok", "warning", "critical"]);

/** `z.number().int().min(0).max(20).optional()`: all three checks run; each failure is an issue. */
function fractionDigits(v: unknown, path: Path, out: Out): Status {
  if (v === undefined) return "valid";
  if (number(v, path, out) === "aborted") return "aborted";
  const n = v as number;
  let status: Status = "valid";
  if (!Number.isInteger(n)) {
    fail(out, path, "Expected integer, received float");
    status = "dirty";
  }
  if (n < 0) {
    fail(out, path, "Number must be greater than or equal to 0");
    status = "dirty";
  }
  if (n > 20) {
    fail(out, path, "Number must be less than or equal to 20");
    status = "dirty";
  }
  return status;
}

function currencyCode(v: unknown, path: Path, out: Out): Status {
  if (v === undefined) return "valid";
  if (string(v, path, out) === "aborted") return "aborted";
  if (/^[A-Z]{3}$/.test(v as string)) return "valid";
  fail(out, path, "Invalid");
  return "dirty";
}

function semanticFormat(v: unknown, path: Path, out: Out): Status {
  const status = object(v, path, out, [
    ["semanticType", SEMANTIC_TYPES],
    ["currency", currencyCode],
    ["notation", (x, p, o) => opt(x, p, o, { optional: true }, NOTATIONS)],
    ["minimumFractionDigits", fractionDigits],
    ["maximumFractionDigits", fractionDigits],
  ]);
  // The refinements run on an object that is valid or merely dirty, after every field's issues.
  if (status === "aborted") return status;
  const f = v as Record<string, unknown>;
  let next = status;
  const min = f.minimumFractionDigits as number | undefined;
  const max = f.maximumFractionDigits as number | undefined;
  if (min !== undefined && max !== undefined && !(min <= max)) {
    fail(out, path, "minimumFractionDigits must not exceed maximumFractionDigits");
    next = "dirty";
  }
  if (f.semanticType === "currency" && f.currency === undefined) {
    fail(
      out,
      path,
      "a currency format needs its ISO 4217 `currency` code — no currency is assumed"
    );
    next = "dirty";
  }
  if (f.semanticType === "integer" && !((min ?? 0) === 0 && (max ?? 0) === 0)) {
    fail(
      out,
      path,
      "an integer format takes no fraction digits (minimum/maximumFractionDigits must be 0)"
    );
    next = "dirty";
  }
  return next;
}
const optionalFormat = (v: unknown, p: Path, out: Out): Status =>
  opt(v, p, out, { optional: true }, semanticFormat);
const optionalString = (v: unknown, p: Path, out: Out): Status =>
  opt(v, p, out, { optional: true }, string);

const timeSeries = (v: unknown, p: Path, out: Out): Status =>
  object(v, p, out, [
    [
      "series",
      (s, sp, so) =>
        array(s, sp, so, (e, ep, eo) =>
          object(e, ep, eo, [
            ["label", string],
            ["unit", optionalString],
            ["format", optionalFormat],
            ["axis", (x, xp, xo) => opt(x, xp, xo, { optional: true }, AXES)],
            [
              "points",
              (pts, pp, po) =>
                array(pts, pp, po, (pt, ptp, pto) =>
                  object(pt, ptp, pto, [
                    ["timestamp", string],
                    ["value", number],
                  ])
                ),
            ],
          ])
        ),
    ],
  ]);

const barChart = (v: unknown, p: Path, out: Out): Status =>
  object(v, p, out, [
    ["unit", optionalString],
    ["format", optionalFormat],
    [
      "bars",
      (b, bp, bo) =>
        array(b, bp, bo, (e, ep, eo) =>
          object(e, ep, eo, [
            ["label", string],
            ["value", number],
          ])
        ),
    ],
  ]);

const kpi = (v: unknown, p: Path, out: Out): Status =>
  object(v, p, out, [
    ["value", number],
    ["unit", optionalString],
    ["format", optionalFormat],
    ["label", optionalString],
    ["deltaPct", (x, xp, xo) => opt(x, xp, xo, { optional: true, nullable: true }, number)],
  ]);

const tableColumn = (v: unknown, p: Path, out: Out): Status =>
  union(v, p, out, [
    string,
    (x, xp, xo) =>
      object(x, xp, xo, [
        ["label", string],
        ["format", optionalFormat],
      ]),
  ]);
const tableCell = (v: unknown, p: Path, out: Out): Status =>
  union(v, p, out, [string, number, (x, xp, xo) => type("null", x, xp, xo)]);

const table = (v: unknown, p: Path, out: Out): Status =>
  object(v, p, out, [
    ["columns", (c, cp, co) => array(c, cp, co, tableColumn)],
    ["rows", (r, rp, ro) => array(r, rp, ro, (row, rwp, rwo) => array(row, rwp, rwo, tableCell))],
  ]);

const statusCard = (v: unknown, p: Path, out: Out): Status =>
  object(v, p, out, [
    ["level", LEVELS],
    ["headline", string],
    ["detail", optionalString],
  ]);

const any = (): Status => "valid";
const record = (v: unknown, p: Path, out: Out): Status => type("object", v, p, out);

const CONTRACTS: Readonly<Record<string, (v: unknown, p: Path, out: Out) => Status>> = {
  MetricCard: number,
  StatusBadge: string,
  ProgressBar: number,
  AlertCard: string,
  StreamingText: string,
  Timeline: (v, p, out) => array(v, p, out, any),
  DataTable: (v, p, out) => array(v, p, out, record),
  ApprovalCard: any,
  TimeSeries: timeSeries,
  BarChart: barChart,
  Kpi: kpi,
  Table: table,
  StatusCard: statusCard,
  Note: (v, p, out) => type("undefined", v, p, out),
  A2UIView: any,
  SandboxView: any,
};

/**
 * `@loom-ui/core`'s `checkKindValue`, without zod: `undefined` is "not hydrated yet" and passes,
 * an unknown kind has no contract and passes, and a failure carries the same finding (code and
 * message) the zod-backed check produces — pinned by `kindValues.test.ts`.
 */
export function checkKindValue(
  kind: string,
  value: unknown
): { ok: true } | { ok: false; finding: Finding } {
  const contract = Object.hasOwn(CONTRACTS, kind) ? CONTRACTS[kind] : undefined;
  if (contract === undefined || value === undefined) return { ok: true };
  const issues: Out = [];
  contract(value, [], issues);
  const issue = issues[0];
  if (issue === undefined) return { ok: true };
  const path = issue.path.join(".");
  return {
    ok: false,
    finding: {
      code: "value-contract",
      severity: "error",
      message: `value for kind "${kind}" does not match its contract at ${path || "<root>"}: ${issue.message}`,
    },
  };
}
