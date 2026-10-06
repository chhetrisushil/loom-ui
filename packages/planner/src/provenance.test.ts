import { Provenance } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { plannerProvenance } from "./provenance";
import type { PlanReport } from "./spi";

const report = (over: Partial<PlanReport> = {}): PlanReport => ({
  decisionId: "plan:compose:abc",
  attempts: [],
  firstAttemptValid: true,
  modelId: "m-1",
  ...over,
});

describe("plannerProvenance", () => {
  it("stamps the agent, the model and the loom decision that recorded the plan", () => {
    const p = plannerProvenance({ report: report() }, { agentId: "planner-7" });
    expect(p).toEqual({
      source: "agent",
      agentId: "planner-7",
      modelId: "m-1",
      decisionId: "plan:compose:abc",
    });
    expect(Provenance.safeParse(p).success).toBe(true);
  });

  it("omits what the report does not have rather than inventing it", () => {
    expect(plannerProvenance({ report: report({ decisionId: "", modelId: "" }) })).toEqual({
      source: "agent",
    });
  });

  it("omits (never truncates) a decision id the provenance schema would refuse", () => {
    for (const decisionId of ["d".repeat(257), ""]) {
      const p = plannerProvenance({ report: report({ decisionId }) });
      expect(p).not.toHaveProperty("decisionId");
      expect(Provenance.safeParse(p).success).toBe(true);
    }
    const edge = "d".repeat(256);
    expect(plannerProvenance({ report: report({ decisionId: edge }) }).decisionId).toBe(edge);
  });

  it("copies no model text: the summary is the lineage's, under its class rules", () => {
    const p = plannerProvenance({ report: report() });
    expect(Object.keys(p).sort()).toEqual(["decisionId", "modelId", "source"]);
  });
});
