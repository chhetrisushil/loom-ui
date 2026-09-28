import type { MCPToolNode } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import {
  resolveArguments,
  resolvePath,
  stepReferences,
  terminalSteps,
  topoWaves,
  walkPath,
} from "./plan";

const step = (
  stepId: string,
  dependsOn: string[] = [],
  args: Record<string, unknown> = {}
): MCPToolNode => ({
  stepId,
  toolName: `tool.${stepId}`,
  toolVersion: "1",
  toolSchemaHash: `h-${stepId}`,
  arguments: args,
  dependsOn,
  idempotent: true,
});

describe("topoWaves", () => {
  it("orders steps into dependency waves and treats deps outside the graph as satisfied", () => {
    const { waves, cycle } = topoWaves([
      step("c", ["a", "b"]),
      step("a"),
      step("b", ["a"]),
      step("d", ["zzz"]),
    ]);
    expect(waves.map((w) => w.map((s) => s.stepId))).toEqual([["a", "d"], ["b"], ["c"]]);
    expect(cycle).toEqual([]);
  });
  it("reports a cycle instead of looping or guessing", () => {
    const { waves, cycle } = topoWaves([step("a", ["b"]), step("b", ["a"]), step("c")]);
    expect(waves.map((w) => w.map((s) => s.stepId))).toEqual([["c"]]);
    expect(cycle.sort()).toEqual(["a", "b"]);
  });
  it("terminalSteps are the steps nothing depends on", () => {
    expect(
      terminalSteps([step("a"), step("b", ["a"]), step("c", ["a"])]).map((s) => s.stepId)
    ).toEqual(["b", "c"]);
  });
});

describe("resolvePath", () => {
  it("walks dotted paths with indices over OWN properties only", () => {
    const o = { result: { items: [{ value: 7 }] } };
    expect(resolvePath(o, "result.items[0].value")).toBe(7);
    expect(resolvePath(o, "result.missing")).toBeUndefined();
    expect(resolvePath(o, "result.items[5].value")).toBeUndefined();
    expect(resolvePath({}, "__proto__.polluted")).toBeUndefined();
    expect(resolvePath({ a: 1 }, "constructor")).toBeUndefined();
  });
});

describe("resolveArguments", () => {
  const outputs = new Map<string, unknown>([["fetch", { rows: [{ id: "r1" }], total: 3 }]]);
  it("substitutes {{steps.<id>.output.<path>}} at any depth and leaves other values alone", () => {
    const r = resolveArguments(
      step("x", ["fetch"], {
        id: "{{steps.fetch.output.rows[0].id}}",
        n: "{{steps.fetch.output.total}}",
        nested: { keep: "literal", all: "{{steps.fetch.output}}" },
        list: ["{{steps.fetch.output.total}}", 1],
      }),
      outputs
    );
    expect(r).toEqual({
      ok: true,
      args: {
        id: "r1",
        n: 3,
        nested: { keep: "literal", all: { rows: [{ id: "r1" }], total: 3 } },
        list: [3, 1],
      },
    });
  });
  it("an unresolved reference is a finding naming the step and path", () => {
    const r = resolveArguments(
      step("x", ["fetch"], { id: "{{steps.fetch.output.nope}}" }),
      outputs
    );
    expect(!r.ok && r.finding.code).toBe("unresolved-step-reference");
    expect(!r.ok && r.finding.message).toMatch(/fetch.*nope/);
    const r2 = resolveArguments(step("x", ["ghost"], { id: "{{steps.ghost.output.a}}" }), outputs);
    expect(!r2.ok && r2.finding.code).toBe("unresolved-step-reference");
  });
});

describe("walkPath — an index past the end of a real array is out-of-range; every other miss is absent", () => {
  const o = { rows: [{ sku: "a" }, { sku: "b" }], none: [], obj: { 0: "x" }, nul: null };
  it("resolves what exists, a present null included", () => {
    expect(walkPath(o, "rows[1].sku")).toEqual({ ok: true, value: "b" });
    expect(walkPath(o, "nul")).toEqual({ ok: true, value: null });
  });
  it("[i] over an array with i >= length is out-of-range — [0] over [] and [3] over two rows", () => {
    expect(walkPath(o, "none[0].sku")).toEqual({ ok: false, cause: "out-of-range" });
    expect(walkPath(o, "rows[3]")).toEqual({ ok: false, cause: "out-of-range" });
    expect(walkPath(o, "rows[2].sku")).toEqual({ ok: false, cause: "out-of-range" });
  });
  it("a missing key, null mid-path, an index on a non-array, a malformed segment are absent", () => {
    expect(walkPath(o, "rows[0].skuu")).toEqual({ ok: false, cause: "absent" });
    expect(walkPath(o, "missing[0]")).toEqual({ ok: false, cause: "absent" });
    expect(walkPath(o, "nul.x")).toEqual({ ok: false, cause: "absent" });
    expect(walkPath(o, "obj[0]")).toEqual({ ok: false, cause: "absent" });
    expect(walkPath(o, "rows[0].sku[0]")).toEqual({ ok: false, cause: "absent" });
    expect(walkPath(o, "[0]")).toEqual({ ok: false, cause: "absent" });
    expect(walkPath({}, "__proto__.polluted")).toEqual({ ok: false, cause: "absent" });
  });
  it("resolvePath is walkPath's value, or undefined", () => {
    expect(resolvePath(o, "none[0].sku")).toBeUndefined();
    expect(resolvePath(o, "rows[0].sku")).toBe("a");
  });
});

describe("resolveArguments — upstream-empty vs a bad path", () => {
  const outs = (rows: unknown) => new Map<string, unknown>([["top", { rows }]]);
  it("an index past the end of the upstream's rows is upstream-empty, a WARN naming the step and path", () => {
    const r = resolveArguments(
      step("x", ["top"], { sku: "{{steps.top.output.rows[0].sku}}" }),
      outs([])
    );
    expect(!r.ok && r.finding).toEqual({
      code: "upstream-empty",
      severity: "warn",
      message: 'step "x" references "top" at path "rows[0].sku": the upstream has no such row',
    });
  });
  it("rows[0].sku + rows[1].sku over ONE row is upstream-empty", () => {
    const r = resolveArguments(
      step("x", ["top"], {
        a: "{{steps.top.output.rows[0].sku}}",
        b: "{{steps.top.output.rows[1].sku}}",
      }),
      outs([{ sku: "a" }])
    );
    expect(!r.ok && r.finding.code).toBe("upstream-empty");
  });
  it("a bad path anywhere in the step wins over an out-of-range one, whichever comes first", () => {
    for (const args of [
      { a: "{{steps.top.output.rows[1].sku}}", b: "{{steps.top.output.rows[0].skuu}}" },
      { b: "{{steps.top.output.rows[0].skuu}}", a: "{{steps.top.output.rows[1].sku}}" },
    ]) {
      const r = resolveArguments(step("x", ["top"], args), outs([{ sku: "a" }]));
      expect(!r.ok && r.finding.code).toBe("unresolved-step-reference");
      expect(!r.ok && r.finding.severity).toBe("error");
    }
  });
  it("an index on an object, a missing key, and a step with no output stay unresolved-step-reference", () => {
    for (const [args, rows] of [
      [{ a: "{{steps.top.output.rows[0]}}" }, { 0: "x" }],
      [{ a: "{{steps.top.output.rows[0].skuu}}" }, [{ sku: "a" }]],
      [{ a: "{{steps.ghost.output.rows[0]}}" }, []],
      [{ a: "{{steps.ghost.output}}" }, []],
    ] as const) {
      const r = resolveArguments(step("x", ["top"], args), outs(rows));
      expect(!r.ok && r.finding.code).toBe("unresolved-step-reference");
    }
  });
});

describe("stepReferences", () => {
  it("lists every templated step id once, in first-seen order, through nested arrays and objects — and only whole-string templates", () => {
    expect(
      stepReferences({
        a: "{{steps.b.output.x}}",
        nested: { list: ["{{steps.a.output}}", "{{steps.b.output.y}}"] },
        prose: "see {{steps.c.output.x}}",
        n: 3,
      })
    ).toEqual(["b", "a"]);
    expect(stepReferences({})).toEqual([]);
  });
});
