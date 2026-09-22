import { describe, expect, it } from "vitest";
import { planDecisionId } from "./decision";
import { capabilitiesFixture, intentFixture, planningCatalog } from "./testing.test-support";

describe("planDecisionId", () => {
  it("is deterministic over intent + catalogue id + capability pins, and ignores samples and key order", () => {
    const a = planDecisionId("compose", {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
    });
    const withSample = planDecisionId("compose", {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture.map((c) => ({ ...c, sampleOutput: { different: true } })),
    });
    const reordered = planDecisionId("compose", {
      capabilities: [...capabilitiesFixture].reverse(),
      catalog: planningCatalog,
      intent: { ...intentFixture },
    });
    expect(a).toMatch(/^plan:compose:[0-9a-f]{16}$/);
    expect(withSample).toBe(a);
    expect(reordered).not.toBe(a); // order of capabilities is part of the prompt, so part of the decision
  });
  it("changes when the intent or a schema pin changes", () => {
    const base = planDecisionId("compose", {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
    });
    const otherIntent = planDecisionId("compose", {
      intent: { ...intentFixture, objective: "other" },
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
    });
    const otherPin = planDecisionId("compose", {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture.map((c, i) =>
        i === 0 ? { ...c, toolSchemaHash: "sha256:changed" } : c
      ),
    });
    expect(otherIntent).not.toBe(base);
    expect(otherPin).not.toBe(base);
  });
  it("revise ids key on the base artifact hash and the request", () => {
    const r1 = planDecisionId("revise", { versionHash: "sha256:a", request: { text: "add" } });
    const r2 = planDecisionId("revise", { versionHash: "sha256:b", request: { text: "add" } });
    expect(r1).toMatch(/^plan:revise:/);
    expect(r1).not.toBe(r2);
  });
});
