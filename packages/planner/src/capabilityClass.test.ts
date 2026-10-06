import { genesis, replay } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { checkPlannerConformance } from "./conformance";
import type { PlanDraft } from "./contract";
import { materialize } from "./materialize";
import { ReferencePlanner } from "./reference";
import type { CapabilityRef, Planner } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";

// U10b: a capability's declared `sensitivity` classes every node bound to it (tool-level,
// fail-closed). The model's proposal may raise the class, never lower it.

const base = () => genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture });
const declared = (c: "internal" | "sensitive" | "secret"): CapabilityRef[] =>
  capabilitiesFixture.map((cap) =>
    cap.handle === "orders_summary" ? { ...cap, sensitivity: c } : cap
  );

const binding = {
  capability: "orders_summary",
  arguments: { window: "7d" },
  path: "totals.count",
  priority: "P0" as const,
};
// `Metric` is a caller-only type: a draft carrying a class on it would not even parse, so the model
// cannot have proposed one. `Collection` is `model-may-set`.
const metric: PlanDraft = {
  summary: "s",
  nodes: [{ id: "orders", type: "Metric", label: "Orders", span: 4, props: {}, binding }],
};
const collection = (sensitivity?: "internal" | "sensitive" | "secret"): PlanDraft => ({
  summary: "s",
  nodes: [
    {
      id: "skus",
      type: "Collection",
      label: "SKUs",
      span: 8,
      props: { columns: ["sku"] },
      binding: { ...binding, path: "rows", ...(sensitivity !== undefined && { sensitivity }) },
    },
  ],
});
const classOf = (ops: ReturnType<typeof materialize>["ops"], id: string) => {
  const op = ops.find((o) => o.type === "insertNode" && o.node.id === id);
  return op?.type === "insertNode" && op.node.kind === "semantic"
    ? op.node.binding?.sensitivity
    : "NOT-INSERTED";
};

describe("materialize: a capability's declared class classes its bound nodes", () => {
  it("a node on a caller-only type bound to a secret capability is secret though the model proposed nothing", () => {
    const { ops, findings } = materialize(metric, base(), planningCatalog, declared("secret"));
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(classOf(ops, "orders")).toBe("secret");
  });
  it("a proposal may raise the class but never lower it", () => {
    expect(
      classOf(
        materialize(collection("internal"), base(), planningCatalog, declared("sensitive")).ops,
        "skus"
      )
    ).toBe("sensitive");
    expect(
      classOf(
        materialize(collection("secret"), base(), planningCatalog, declared("sensitive")).ops,
        "skus"
      )
    ).toBe("secret");
    expect(
      classOf(materialize(collection(), base(), planningCatalog, declared("sensitive")).ops, "skus")
    ).toBe("sensitive");
  });
  it("a capability declaring nothing adds nothing: the node stays unclassified", () => {
    const { ops } = materialize(metric, base(), planningCatalog, capabilitiesFixture);
    expect(classOf(ops, "orders")).toBeUndefined();
  });
  it("revise raises an existing unclassified node bound to a now-declared capability (bindProvider carries the class)", () => {
    const first = materialize(metric, base(), planningCatalog, capabilitiesFixture);
    const exp = replay(base(), first.ops);
    if (!exp.ok) throw new Error(exp.finding.message);
    const second = materialize(metric, exp.value, planningCatalog, declared("secret"));
    const rebind = second.ops.find((o) => o.type === "bindProvider");
    expect(rebind?.type === "bindProvider" && rebind.sensitivity).toBe("secret");
    const applied = replay(exp.value, second.ops);
    if (!applied.ok) throw new Error(applied.finding.message);
    const node =
      applied.value.root.kind === "container" ? applied.value.root.children[0] : undefined;
    expect(node?.kind === "semantic" && node.binding?.sensitivity).toBe("secret");
  });
});

const compose = JSON.stringify({ summary: "s", nodes: metric.nodes });

describe("checkPlannerConformance: bound nodes are classed at least their capability's class", () => {
  const fixture = (planner: Planner) =>
    checkPlannerConformance(planner, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: declared("secret"),
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
  it("the reference planner passes", async () => {
    const planner = new ReferencePlanner({
      model: scriptedModel([compose, compose]),
      modelId: "m",
    });
    const findings = await fixture(planner);
    expect(findings.map((f) => f.code)).not.toContain("binding-class-below-capability");
  });
  it("a planner that leaves the node unclassified fails with binding-class-below-capability", async () => {
    const inner = new ReferencePlanner({ model: scriptedModel([compose, compose]), modelId: "m" });
    // Plans as if the capability declared nothing — the pre-U10b behaviour.
    const lax: Planner = {
      compose: (i, ctx) => inner.compose({ ...i, capabilities: capabilitiesFixture }, ctx),
      revise: (i, ctx) => inner.revise({ ...i, capabilities: capabilitiesFixture }, ctx),
    };
    const findings = await fixture(lax);
    expect(findings.map((f) => f.code)).toContain("binding-class-below-capability");
  });
});
