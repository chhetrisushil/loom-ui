import { type Operation, apply, genesis, replay, validateExperience } from "@loom-ui/core";
import { outputShapeHashOf } from "@loom-ui/hydration";
import { describe, expect, it } from "vitest";
import type { PlanDraft } from "./contract";
import { buildProviderSpec, materialize, providerHandle } from "./materialize";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
} from "./testing.test-support";

const base = () => genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture });
const draft: PlanDraft = {
  summary: "s",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders (7d)",
      span: 4,
      props: { unit: "orders" },
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0",
      },
    },
    {
      id: "top_skus",
      type: "Collection",
      label: "Top SKUs",
      span: 8,
      props: { columns: ["sku", "units"] },
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "rows",
        priority: "P1",
      },
    },
    { id: "note", type: "Insight", label: "Why", span: 12, props: { tone: "neutral" } },
  ],
};

const declaredBefore = (ops: Operation[]) =>
  ops.every((op, i) => {
    const handle =
      op.type === "insertNode" && op.node.kind === "semantic"
        ? op.node.binding?.handle
        : op.type === "bindProvider"
          ? op.handle
          : undefined;
    return (
      handle === undefined ||
      ops.slice(0, i).some((p) => p.type === "remapProvider" && p.handle === handle)
    );
  });

describe("materialize — compose", () => {
  it("declares a provider before any op that references its handle, one insertNode per node in order, and replays to a valid experience", () => {
    const { ops, findings } = materialize(draft, base(), planningCatalog, capabilitiesFixture);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    const types = ops.map((o) => o.type);
    expect(types.filter((t) => t === "insertNode")).toHaveLength(3);
    expect(types.filter((t) => t === "remapProvider")).toHaveLength(2); // two distinct (args, path) → two providers
    expect(declaredBefore(ops)).toBe(true);
    const r = replay(base(), ops);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(validateExperience(r.value, planningCatalog, "web").ok).toBe(true);
      const rootChildren = r.value.root.kind === "container" ? r.value.root.children : [];
      const ids = rootChildren.map((c) => c.id);
      expect(ids).toEqual(["orders", "top_skus", "note"]);
      const orders = rootChildren[0];
      expect(orders?.kind === "semantic" && orders.binding?.priority).toBe("P0");
      expect(orders?.kind === "semantic" && orders.typeVersion).toBe("1.0.0");
      expect(orders?.kind === "semantic" && orders.label?.fallback).toBe("Orders (7d)");
    }
  });
  it("pins toolSchemaHash from the capability and outputShapeHash from the RESHAPED sample via hydration's helper", () => {
    const cap = capabilitiesFixture[0]!;
    const r = buildProviderSpec(cap, {
      capability: cap.handle,
      arguments: { window: "7d" },
      path: "totals.count",
      priority: "P0",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec.executionGraph[0]?.toolSchemaHash).toBe("sha256:orders-summary-2-1");
      expect(r.spec.outputShapeHash).toBe(outputShapeHashOf(412));
      expect(r.spec.reshaping).toEqual({ engine: "JSONPath", scriptRef: "totals.count" });
      expect(r.spec.handle).toBe(
        providerHandle("orders.summary", "2.1.0", { window: "7d" }, "totals.count")
      );
    }
  });
  it("two nodes with the same tool, arguments and path share ONE provider handle", () => {
    const d: PlanDraft = {
      summary: "s",
      nodes: [
        {
          id: "a",
          type: "Metric",
          label: "a",
          span: 6,
          props: {},
          binding: {
            capability: "orders_summary",
            arguments: { window: "7d" },
            path: "totals.count",
            priority: "P1",
          },
        },
        {
          id: "b",
          type: "Metric",
          label: "b",
          span: 6,
          props: {},
          binding: {
            capability: "orders_summary",
            arguments: { window: "7d" },
            path: "totals.count",
            priority: "P2",
          },
        },
      ],
    };
    const { ops } = materialize(d, base(), planningCatalog, capabilitiesFixture);
    expect(ops.filter((o) => o.type === "remapProvider")).toHaveLength(1);
  });
  it("refuses to bind an unsampled capability (finding, binding dropped) and a path that selects nothing", () => {
    const d: PlanDraft = {
      summary: "s",
      nodes: [
        {
          id: "inc",
          type: "Metric",
          label: "Incidents",
          span: 6,
          props: {},
          binding: { capability: "incidents_open", arguments: {}, path: "", priority: "P1" },
        },
        {
          id: "ghost",
          type: "Metric",
          label: "Ghost",
          span: 6,
          props: {},
          binding: {
            capability: "orders_summary",
            arguments: {},
            path: "totals.nope",
            priority: "P1",
          },
        },
      ],
    };
    const { ops, findings } = materialize(d, base(), planningCatalog, capabilitiesFixture);
    expect(findings.map((f) => f.code).sort()).toEqual(["capability-unsampled", "reshape-invalid"]);
    expect(findings.every((f) => f.nodeId !== undefined)).toBe(true);
    expect(ops.filter((o) => o.type === "bindProvider")).toHaveLength(0);
    const r = replay(base(), ops);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(
        validateExperience(r.value, planningCatalog, "web").findings.map((f) => f.code)
      ).toContain("missing-binding");
  });
  it("an unknown capability handle in the draft is a finding, not a throw", () => {
    const d: PlanDraft = {
      summary: "s",
      nodes: [
        {
          id: "x",
          type: "Metric",
          label: "x",
          span: 6,
          props: {},
          binding: { capability: "nope", arguments: {}, path: "", priority: "P1" },
        },
      ],
    };
    const { findings } = materialize(d, base(), planningCatalog, capabilitiesFixture);
    expect(findings.map((f) => f.code)).toContain("unknown-capability");
  });
});

describe("materialize — revise (diff against the base)", () => {
  const composed = () => {
    const r = replay(base(), materialize(draft, base(), planningCatalog, capabilitiesFixture).ops);
    if (!r.ok) throw new Error(r.finding.message);
    return r.value;
  };
  it("keeps untouched nodes (no ops), changes props/label/binding in place, removes omitted nodes, inserts new ones after the existing children", () => {
    const exp = composed();
    const revised: PlanDraft = {
      summary: "s",
      nodes: [
        draft.nodes[0]!, // untouched
        { ...draft.nodes[1]!, label: "Top 10 SKUs", props: { columns: ["sku"] } }, // label + props
        // "note" omitted → removed
        { id: "status", type: "Status", label: "Pipeline", span: 4, props: {} }, // new, optional binding omitted
      ],
    };
    const { ops, findings } = materialize(revised, exp, planningCatalog, capabilitiesFixture);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(ops.map((o) => o.type).sort()).toEqual([
      "insertNode",
      "removeNode",
      "setLabel",
      "setProps",
    ]);
    const r = replay(exp, ops);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ids = r.value.root.kind === "container" ? r.value.root.children.map((c) => c.id) : [];
      expect(ids).toEqual(["orders", "top_skus", "status"]);
    }
  });
  it("a changed binding emits remapProvider (when the provider is new) + bindProvider; an unchanged one emits nothing", () => {
    const exp = composed();
    const revised: PlanDraft = {
      summary: "s",
      nodes: [
        {
          ...draft.nodes[0]!,
          binding: {
            capability: "orders_summary",
            arguments: { window: "30d" },
            path: "totals.count",
            priority: "P0",
          },
        },
        draft.nodes[1]!,
        draft.nodes[2]!,
      ],
    };
    const { ops } = materialize(revised, exp, planningCatalog, capabilitiesFixture);
    expect(ops.map((o) => o.type)).toEqual(["remapProvider", "bindProvider"]);
  });
  it("a span change is reported (span-unchanged, warn) and not applied — span is not a prop", () => {
    const exp = composed();
    const revised: PlanDraft = {
      summary: "s",
      nodes: draft.nodes.map((n, i) => (i === 2 ? { ...n, span: 6 } : n)),
    };
    const { ops, findings } = materialize(revised, exp, planningCatalog, capabilitiesFixture);
    expect(ops).toEqual([]);
    expect(findings).toEqual([
      expect.objectContaining({ code: "span-unchanged", severity: "warn", nodeId: "note" }),
    ]);
  });
  it("never touches a nested container's children: a draft node id that names a container is refused", () => {
    const exp = composed();
    const withContainer = apply(exp, {
      type: "insertNode",
      parentId: "root",
      node: { id: "grp", order: "Z", kind: "container", direction: "row", span: 12, children: [] },
    });
    if (!withContainer.ok) throw new Error(withContainer.finding.message);
    const revised: PlanDraft = {
      summary: "s",
      nodes: [...draft.nodes, { id: "grp", type: "Insight", label: "x", span: 12, props: {} }],
    };
    const { findings } = materialize(
      revised,
      withContainer.value,
      planningCatalog,
      capabilitiesFixture
    );
    expect(findings.map((f) => f.code)).toContain("not-semantic");
  });
});
