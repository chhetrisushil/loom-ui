import { type ProvenanceLedger, emptyLedger, foldProvenance } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { DecisionLinks, linkFromLedger } from "./links";

const rec = (nodeId: string, policyDecisionId?: string) => ({
  op: { type: "setTitle" as const, nodeId, title: null },
  by: { source: "agent" as const, ...(policyDecisionId !== undefined && { policyDecisionId }) },
  at: "t",
});

describe("U11 decision links", () => {
  it("linkFromLedger maps each node to the decision of the op that last touched it; unstamped nodes earn nothing", () => {
    const ledger: ProvenanceLedger = foldProvenance(emptyLedger(), [
      {
        versionHash: "v1",
        at: "t",
        by: { source: "agent" },
        ops: [rec("a", "pv:1"), rec("b", "pv:1"), rec("human")],
      },
      {
        versionHash: "v2",
        at: "t",
        by: { source: "agent" },
        ops: [rec("b", "pv:2"), rec("__proto__", "pv:2")],
      },
    ] as never);
    const link = linkFromLedger(ledger, {
      executionOf: (d) => (d === "pv:1" ? "e1" : "e2"),
      tenant: "acme",
    });
    expect(link.nodes?.a).toEqual({ executionId: "e1", decisionId: "pv:1" });
    expect(link.nodes?.b).toEqual({ executionId: "e2", decisionId: "pv:2" });
    expect(link.nodes && Object.hasOwn(link.nodes, "human")).toBe(false);
    // a hostile id is just a key, never the prototype
    expect(link.nodes && Object.hasOwn(link.nodes, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(link.nodes)).toBeNull();
    expect(link.decisions).toHaveLength(2);
    expect(link.tenant).toBe("acme");
    // a decision whose execution is unknown is left out
    expect(linkFromLedger(ledger, { executionOf: () => undefined }).decisions).toEqual([]);
  });

  it("the registry is bounded: the oldest view is forgotten and then attributes nothing", () => {
    const links = new DecisionLinks(2);
    for (const v of ["1", "2", "3"]) links.register("e", v, { decisions: [] });
    expect(links.size).toBe(2);
    expect(links.resolve("e", "1")).toBeUndefined();
    expect(links.resolve("e", "3")).toBeDefined();
  });
});
