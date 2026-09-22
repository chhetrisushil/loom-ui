import type { SemanticCatalog } from "@loom-ui/core";
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
  it("changes when the SURFACE, the catalogue CONTENT, a capability's description or the caller's context changes — and not when only a sample does", () => {
    const base = planDecisionId("compose", {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
    });
    expect(
      planDecisionId("compose", {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        surface: "web",
      })
    ).toBe(base); // "web" is the default the planner uses
    expect(
      planDecisionId("compose", {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        surface: "terminal",
      })
    ).not.toBe(base);
    const editedCatalog: SemanticCatalog = {
      ...planningCatalog,
      entries: planningCatalog.entries.map((e, i) =>
        i === 0 ? { ...e, props: [...e.props, "precision"] } : e
      ),
    };
    expect(editedCatalog.id).toBe(planningCatalog.id); // same id, different content
    expect(
      planDecisionId("compose", {
        intent: intentFixture,
        catalog: editedCatalog,
        capabilities: capabilitiesFixture,
      })
    ).not.toBe(base);
    expect(
      planDecisionId("compose", {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture.map((c, i) =>
          i === 0 ? { ...c, description: "something else entirely" } : c
        ),
      })
    ).not.toBe(base);
    expect(
      planDecisionId("compose", {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture.map((c, i) =>
          i === 0 ? { ...c, inputSchema: { type: "object", properties: { window: {} } } } : c
        ),
      })
    ).not.toBe(base);
    expect(
      planDecisionId("compose", {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        context: { viewer: "ops" },
      })
    ).not.toBe(base);
    expect(
      planDecisionId("compose", {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        context: { viewer: "ops" },
      })
    ).toBe(
      planDecisionId("compose", {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        context: { viewer: "ops" },
      })
    );
    // The sample is still excluded: a re-fetch of the same tool must not re-plan.
    expect(
      planDecisionId("compose", {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture.map((c) => ({ ...c, sampleOutput: { changed: true } })),
      })
    ).toBe(base);
  });
  it("revise ids cover the catalogue, the surface and the context too", () => {
    const common = {
      versionHash: "sha256:a",
      request: { text: "add" },
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
    };
    const base = planDecisionId("revise", common);
    expect(planDecisionId("revise", { ...common, surface: "terminal" })).not.toBe(base);
    expect(planDecisionId("revise", { ...common, context: { drift: [] } })).not.toBe(base);
    expect(
      planDecisionId("revise", {
        ...common,
        catalog: { ...planningCatalog, entries: planningCatalog.entries.slice(1) },
      })
    ).not.toBe(base);
    expect(planDecisionId("revise", { ...common })).toBe(base);
  });
  it("revise ids key on the base artifact hash and the request", () => {
    const r1 = planDecisionId("revise", { versionHash: "sha256:a", request: { text: "add" } });
    const r2 = planDecisionId("revise", { versionHash: "sha256:b", request: { text: "add" } });
    expect(r1).toMatch(/^plan:revise:/);
    expect(r1).not.toBe(r2);
  });
});
