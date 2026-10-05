import { toolKey } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { planDecisionId } from "./decision";
import { buildProviderSpec, providerHandle } from "./materialize";
import type { CapabilityRef } from "./spi";
import { capabilitiesFixture, intentFixture, planningCatalog } from "./testing.test-support";

// U3: a capability may name a non-MCP data-provider kind. An MCP capability (no `kind`) keeps every
// id it had: handles and decision ids are pinned below, minted before the kind existed.

const mcp = capabilitiesFixture[0] as CapabilityRef;
const effect: CapabilityRef = { ...mcp, handle: "orders_fx", kind: "loom-effect" };
const draft = {
  capability: "x",
  arguments: { window: "7d" },
  path: "totals.count",
  priority: "P0" as const,
};

describe("a capability of a non-MCP kind", () => {
  it("emits a step carrying its kind; an MCP capability's step carries no kind key", () => {
    const e = buildProviderSpec(effect, { ...draft, capability: effect.handle });
    const m = buildProviderSpec(mcp, { ...draft, capability: mcp.handle });
    if (!e.ok || !m.ok) throw new Error("expected both to build");
    expect(e.spec.executionGraph[0]?.kind).toBe("loom-effect");
    expect(e.spec.executionGraph[0]?.toolName).toBe(mcp.toolName);
    expect("kind" in (m.spec.executionGraph[0] ?? {})).toBe(false);
  });
  it("the same tool name under two kinds is two providers, not one handle", () => {
    const e = buildProviderSpec(effect, { ...draft, capability: effect.handle });
    const m = buildProviderSpec(mcp, { ...draft, capability: mcp.handle });
    if (!e.ok || !m.ok) throw new Error("expected both to build");
    expect(e.spec.handle).not.toBe(m.spec.handle);
    expect(toolKey(e.spec.executionGraph[0] as never)).toBe("loom-effect:orders.summary");
  });
  it("a different kind is a different decision; an MCP capability keeps its decision id", () => {
    const id = (caps: CapabilityRef[]) =>
      planDecisionId("compose", {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: caps,
      });
    expect(id([effect])).not.toBe(id([mcp]));
    expect(id(capabilitiesFixture)).toBe(PINNED_DECISION_ID);
  });
  it("an MCP capability keeps its provider handle", () => {
    const m = buildProviderSpec(mcp, { ...draft, capability: mcp.handle });
    if (!m.ok) throw new Error("expected to build");
    expect(m.spec.handle).toBe(PINNED_HANDLE);
    expect(m.spec.handle).toBe(
      providerHandle(
        "orders.summary",
        "2.1.0",
        "sha256:orders-summary-2-1",
        draft.arguments,
        draft.path
      )
    );
  });
});

const PINNED_DECISION_ID = "plan:compose:4f80edebea0a15d2";
const PINNED_HANDLE = "p-87943877cfd4d9aa";
