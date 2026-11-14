import "./deferredContracts.test-support";
import { describe, expect, it } from "vitest";
import { checkKindValueIssues as lite } from "./kindValues";
import { kindValueContract } from "./values";
import {
  MAX_WIDGET_REFS,
  MAX_WIDGET_REF_LABEL,
  REF_OPEN_ACTION,
  WIDGET_REF_KINDS,
  widgetRefProblems,
  widgetRefsOf,
} from "./widgetRefs";

const BASE: Readonly<Record<string, unknown>> = {
  Kpi: { value: 1 },
  BarChart: { bars: [{ label: "a", value: 1 }] },
  TimeSeries: { series: [{ label: "s", points: [{ timestamp: "t", value: 1 }] }] },
  Table: { columns: ["a"], rows: [["x"]] },
  StatusCard: { level: "ok", headline: "h" },
  Diagram: { layout: "network", nodes: [{ id: "a", label: "A" }], edges: [] },
};

/** What the zod contract and the zod-free checker each say, as "path: message" strings. */
function verdicts(kind: string, value: unknown): { zod: string[]; lite: string[] } {
  const r = (kindValueContract(kind) as { safeParse(v: unknown): unknown }).safeParse(value) as {
    success: boolean;
    error?: { issues: { path: unknown[]; message: string }[] };
  };
  return {
    zod: r.success ? [] : (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`),
    lite: lite(kind, value).map((i) => `${i.path.join(".")}: ${i.message}`),
  };
}
const withRefs = (kind: string, refs: unknown) => ({ ...(BASE[kind] as object), refs });

describe("source references (widgetRefs)", () => {
  it("exports the action and the cap", () => {
    expect(REF_OPEN_ACTION).toBe("REF_OPEN");
    expect(MAX_WIDGET_REFS).toBe(16);
    expect([...WIDGET_REF_KINDS].sort()).toEqual(Object.keys(BASE).sort());
  });

  for (const kind of Object.keys(BASE)) {
    describe(kind, () => {
      it("accepts no refs, an empty list, and up to the cap", () => {
        for (const refs of [
          undefined,
          [],
          [{ id: "s1" }],
          [{ id: "s1", label: "A source" }, { id: "x.y:z-1" }],
          Array.from({ length: MAX_WIDGET_REFS }, (_, i) => ({ id: `r${i}` })),
          [{ id: "ok", label: "l".repeat(MAX_WIDGET_REF_LABEL) }],
        ]) {
          const v = refs === undefined ? BASE[kind] : withRefs(kind, refs);
          expect(verdicts(kind, v)).toEqual({ zod: [], lite: [] });
        }
      });

      const refused: [string, unknown, string][] = [
        [
          "17 refs",
          Array.from({ length: 17 }, (_, i) => ({ id: `r${i}` })),
          `refs: at most ${MAX_WIDGET_REFS} refs`,
        ],
        ["a bad id", [{ id: "bad id" }], "refs.0: a ref id must be a short identifier"],
        ["an empty id", [{ id: "" }], "refs.0: a ref id must be a short identifier"],
        ["a long id", [{ id: "a".repeat(129) }], "refs.0: a ref id must be a short identifier"],
        ["a duplicate id", [{ id: "a" }, { id: "a" }], "refs.1: ref ids must be unique"],
        [
          "an over-long label",
          [{ id: "a", label: "l".repeat(MAX_WIDGET_REF_LABEL + 1) }],
          `refs.0: a ref label is at most ${MAX_WIDGET_REF_LABEL} characters`,
        ],
        [
          "a non-string label",
          [{ id: "a", label: 5 }],
          "refs.0.label: Expected string, received number",
        ],
        ["a non-string id", [{ id: 5 }], "refs.0.id: Expected string, received number"],
        ["a non-list", "x", "refs: Expected array, received string"],
      ];
      for (const [what, refs, message] of refused) {
        it(`refuses ${what}, with the same words from both checkers`, () => {
          const got = verdicts(kind, withRefs(kind, refs));
          expect(got.zod).toEqual([message]);
          expect(got.lite).toEqual([message]);
        });
      }

      it("never echoes the data in a message", () => {
        const secret = "SECRET ID!";
        const got = verdicts(kind, withRefs(kind, [{ id: secret, label: "L".repeat(500) }]));
        expect(got.zod.join()).not.toContain(secret);
        expect(got.zod).toEqual(got.lite);
      });
    });
  }

  it("widgetRefProblems is total on any input", () => {
    for (const junk of [undefined, null, 1, "s", {}, [null, 1, "x", [], { id: 1, label: 1 }]])
      expect(() => widgetRefProblems(junk)).not.toThrow();
  });

  it("widgetRefsOf reads refs only on the kinds that carry them", () => {
    expect(widgetRefsOf("Kpi", { value: 1, refs: [{ id: "a" }] })).toEqual([{ id: "a" }]);
    expect(widgetRefsOf("Kpi", { value: 1 })).toEqual([]);
    expect(widgetRefsOf("Prose", { refs: [{ id: "a" }] })).toEqual([]);
    expect(widgetRefsOf("Kpi", 3)).toEqual([]);
  });
});
