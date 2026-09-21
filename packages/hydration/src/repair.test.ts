import { describe, expect, it } from "vitest";
import { SCHEMA_REPAIRED, remapOperation } from "./repair";
import { mcpStep, providerSpec } from "./testing.test-support";

describe("remapOperation", () => {
  it("builds a remapProvider op that moves each drifted step's pin to the observed hash and nothing else", () => {
    const spec = providerSpec("h", [mcpStep("a", "ta"), mcpStep("b", "tb", {}, ["a"])]);
    const r = remapOperation(spec, [
      {
        kind: "input",
        handle: "h",
        stepId: "a",
        toolName: "ta",
        expected: "schema-ta",
        observed: "ta-v2",
      },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.op.type).toBe("remapProvider");
    if (r.op.type !== "remapProvider") return;
    expect(r.op.handle).toBe("h");
    expect(r.op.spec.executionGraph.map((s) => s.toolSchemaHash)).toEqual(["ta-v2", "schema-tb"]);
    expect(r.op.spec.reshaping).toEqual(spec.reshaping);
  });
  it("output drift cannot be repaired by remapping: it needs the planner", () => {
    const r = remapOperation(providerSpec("h", [mcpStep("a", "ta")]), [
      { kind: "output", handle: "h", expected: "x", observed: "y" },
    ]);
    expect(!r.ok && r.finding.code).toBe("repair-needs-planner");
  });
  it("a drift record for another handle or an unknown step is refused", () => {
    const spec = providerSpec("h", [mcpStep("a", "ta")]);
    expect(
      remapOperation(spec, [
        { kind: "input", handle: "other", stepId: "a", expected: "e", observed: "o" },
      ])
    ).toMatchObject({ ok: false, finding: { code: "repair-mismatch" } });
    expect(
      remapOperation(spec, [
        { kind: "input", handle: "h", stepId: "zzz", expected: "e", observed: "o" },
      ])
    ).toMatchObject({ ok: false, finding: { code: "repair-mismatch" } });
    expect(remapOperation(spec, [])).toMatchObject({
      ok: false,
      finding: { code: "repair-mismatch" },
    });
  });
  it("names the userspace event the app records", () => {
    expect(SCHEMA_REPAIRED).toBe("SCHEMA_REPAIRED");
  });
});
