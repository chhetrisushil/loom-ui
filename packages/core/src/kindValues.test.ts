import { describe, expect, it } from "vitest";
import {
  FRAMEWORK_KINDS as LITE_KINDS,
  isLocalizedText,
  checkKindValue as lite,
} from "./kindValues";
import { LocalizedText } from "./node";
import { FRAMEWORK_KINDS, kindValueContracts, checkKindValue as zodCheck } from "./values";

// The zod-free checker the browser entry ships must give the SAME verdict and the SAME finding
// message as the zod contracts for every value — the message is what a reader sees in an error
// state, and the two surfaces (browser, terminal/server) must not disagree about it.

const pts = [{ timestamp: "t", value: 1 }];
const VALID: Readonly<Record<string, unknown>> = {
  MetricCard: 1,
  StatusBadge: "ok",
  ProgressBar: 3,
  AlertCard: "a",
  StreamingText: "s",
  Timeline: [{}, 1],
  DataTable: [{ a: 1 }],
  ApprovalCard: true,
  TimeSeries: {
    series: [
      {
        label: "l",
        unit: "ms",
        axis: "right",
        format: {
          semanticType: "currency",
          currency: "USD",
          notation: "compact",
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        },
        points: pts,
      },
    ],
  },
  BarChart: { unit: "u", format: { semanticType: "percentage" }, bars: [{ label: "a", value: 1 }] },
  Kpi: { value: 1, unit: "u", label: "l", deltaPct: null, format: { semanticType: "integer" } },
  Table: {
    columns: ["a", { label: "b", format: { semanticType: "decimal" } }],
    rows: [["x", 1, null]],
  },
  StatusCard: { level: "ok", headline: "h", detail: "d" },
  Note: undefined,
  A2UIView: { x: 1 },
  SandboxView: [1],
  Image: {
    address: "sha256:abc123",
    mediaType: "image/png",
    size: 10,
    name: "a.png",
    alt: "x",
    origin: "tool",
  },
  Audio: { address: "sha256:abc123", mediaType: "audio/mpeg" },
  Video: { address: "sha256:abc123", mediaType: "video/mp4", size: 0 },
  File: { address: "sha256:abc123", mediaType: "application/pdf", name: "r.pdf" },
  MediaInput: undefined,
  Chat: {
    entries: [
      {
        id: "t1.user",
        turn: 1,
        role: "user",
        status: "complete",
        parts: [{ type: "text", text: "hi" }],
        asker: { actor: "a", tenant: "t" },
        cursor: "0.3",
        at: 5,
      },
      {
        id: "t1.assistant",
        turn: 1,
        role: "assistant",
        status: "failed",
        reason: "model-error",
        errorId: "e-1",
        parts: [{ type: "media", ref: { address: "sha256:abc123", mediaType: "image/png" } }],
        tools: [{ name: "search", status: "done" }],
      },
      { id: "t2.user", turn: 2, role: "user", status: "restricted", editOf: undefined },
    ],
    viewer: { actor: "a", tenant: "t" },
    older: "0.1",
    state: "open",
    running: false,
  },
  TextInput: undefined,
  FormInput: undefined,
  SelectInput: undefined,
};

const JUNK: readonly unknown[] = [
  null,
  undefined,
  0,
  1,
  -1,
  1.5,
  21,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "",
  "x",
  "USD",
  "usd",
  true,
  false,
  [],
  [1],
  {},
  { a: 1 },
  new Date(0),
  new Map(),
  new Set(),
  () => 1,
  Symbol("s"),
  10n,
  Promise.resolve(1),
  "ok",
  "left",
  "compact",
  "currency",
  "integer",
  "weird",
  { semanticType: "currency" },
  { semanticType: "integer", maximumFractionDigits: 2 },
  { semanticType: "number", minimumFractionDigits: 5, maximumFractionDigits: 1 },
  { semanticType: "number", currency: "usd" },
  { semanticType: "number", minimumFractionDigits: -1, maximumFractionDigits: 99 },
  { semanticType: "number", minimumFractionDigits: 1.5 },
  { semanticType: "bogus" },
  { semanticType: 3 },
  { label: 1 },
  { label: "x", format: { semanticType: "currency" } },
  { label: "x", format: { semanticType: "nope" } },
];

/** Every (path, replacement) mutation of `base`: one junk value substituted at one place, or a key removed. */
function* mutants(base: unknown): Generator<unknown> {
  function* at(node: unknown, rebuild: (v: unknown) => unknown): Generator<unknown> {
    for (const j of JUNK) yield rebuild(j);
    if (Array.isArray(node)) {
      yield rebuild([]);
      for (let i = 0; i < node.length; i++) {
        yield* at(node[i], (v) => rebuild(node.map((x, k) => (k === i ? v : x))));
      }
    } else if (node !== null && typeof node === "object") {
      for (const k of Object.keys(node)) {
        const o = node as Record<string, unknown>;
        yield rebuild(Object.fromEntries(Object.entries(o).filter(([key]) => key !== k)));
        yield* at(o[k], (v) => rebuild({ ...o, [k]: v }));
      }
    }
  }
  yield* at(base, (v) => v);
}

describe("the zod-free checker agrees with the zod contracts", () => {
  it("covers exactly the kinds the zod contracts declare", () => {
    expect(Object.keys(VALID).sort()).toEqual(Object.keys(kindValueContracts).sort());
    expect([...LITE_KINDS]).toEqual([...FRAMEWORK_KINDS]);
  });

  for (const kind of Object.keys(VALID)) {
    it(`${kind}: same verdict and same message over a mutated corpus`, () => {
      let n = 0;
      let failures = 0;
      for (const value of [VALID[kind], ...mutants(VALID[kind])]) {
        const want = zodCheck(kind, value);
        const got = lite(kind, value);
        n++;
        if (!want.ok) failures++;
        expect(got).toEqual(want);
      }
      expect(n).toBeGreaterThan(20);
      // The corpus must actually exercise the failing branch for any kind with a real contract.
      if (!["ApprovalCard", "A2UIView", "SandboxView"].includes(kind))
        expect(failures).toBeGreaterThan(0);
    });
  }

  it("an unknown kind (including an inherited property name) has no contract and passes", () => {
    for (const kind of ["Nope", "toString", "__proto__", "constructor"]) {
      expect(lite(kind, 1)).toEqual(zodCheck(kind, 1));
      expect(lite(kind, 1)).toEqual({ ok: true });
    }
  });

  it("isLocalizedText matches LocalizedText.safeParse", () => {
    for (const v of [
      ...JUNK,
      { key: "k", fallback: "f" },
      { key: "", fallback: "f" },
      { key: "k" },
      { key: "k", fallback: 1 },
      { key: "k", fallback: "f", extra: 1 },
    ]) {
      expect(isLocalizedText(v)).toBe(LocalizedText.safeParse(v).success);
    }
  });
});
