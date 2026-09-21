import type { MCPToolNode } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { resolveArguments, resolvePath, terminalSteps, topoWaves } from "./plan";

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
