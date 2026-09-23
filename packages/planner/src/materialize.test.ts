import {
  type ContainerNode,
  type Operation,
  apply,
  genesis,
  isContainer,
  replay,
  validateExperience,
} from "@loom-ui/core";
import { outputShapeHashOf } from "@loom-ui/hydration";
import { describe, expect, it } from "vitest";
import type { PlanDraft } from "./contract";
import { buildProviderSpec, materialize, orphanedProviders, providerHandle } from "./materialize";
import type { CapabilityRef } from "./spi";
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

const buildSpecFor = (handle: string) => ({
  handle,
  executionGraph: [],
  reshaping: { engine: "JSONPath" as const, scriptRef: "" },
  outputShapeHash: "sha256:x",
  cachePolicy: { ttlSeconds: 60, scope: "principal" as const },
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
        providerHandle(
          "orders.summary",
          "2.1.0",
          "sha256:orders-summary-2-1",
          { window: "7d" },
          "totals.count"
        )
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
  it("the same tool@version pinned to DIFFERENT input schemas is TWO providers, not one — the schema pin is part of the handle", () => {
    const twoPins: CapabilityRef[] = [
      {
        handle: "capOld",
        toolName: "shared.tool",
        toolVersion: "1.0.0",
        toolSchemaHash: "sha256:a",
        sampleOutput: { value: 1 },
      },
      {
        handle: "capNew",
        toolName: "shared.tool",
        toolVersion: "1.0.0",
        toolSchemaHash: "sha256:b",
        sampleOutput: { value: 1 },
      },
    ];
    const d: PlanDraft = {
      summary: "s",
      nodes: [
        {
          id: "first",
          type: "Metric",
          label: "first",
          span: 6,
          props: {},
          binding: { capability: "capOld", arguments: {}, path: "value", priority: "P1" },
        },
        {
          id: "second",
          type: "Metric",
          label: "second",
          span: 6,
          props: {},
          binding: { capability: "capNew", arguments: {}, path: "value", priority: "P1" },
        },
      ],
    };
    const { ops, findings } = materialize(d, base(), planningCatalog, twoPins);
    const remaps = ops.filter((o) => o.type === "remapProvider");
    expect(remaps).toHaveLength(2);
    expect(new Set(remaps.map((o) => (o as { handle: string }).handle)).size).toBe(2);
    expect(findings).toEqual([]);
  });
  it("two capabilities colliding on the same (tool, version, schema pin, args, path) handle with different SAMPLES: the first gets the provider, the second is refused as provider-conflict with its binding dropped", () => {
    const conflicting: CapabilityRef[] = [
      {
        handle: "capA",
        toolName: "shared.tool",
        toolVersion: "1.0.0",
        toolSchemaHash: "sha256:a",
        sampleOutput: { value: 1 },
      },
      {
        // Same tool, version, schema pin — so the SAME handle — but a sample of a different
        // shape, so the spec it would pin (`outputShapeHash`) is not the same spec.
        handle: "capB",
        toolName: "shared.tool",
        toolVersion: "1.0.0",
        toolSchemaHash: "sha256:a",
        sampleOutput: { value: "one" },
      },
    ];
    const d: PlanDraft = {
      summary: "s",
      nodes: [
        {
          id: "first",
          type: "Metric",
          label: "first",
          span: 6,
          props: {},
          binding: { capability: "capA", arguments: {}, path: "value", priority: "P1" },
        },
        {
          id: "second",
          type: "Metric",
          label: "second",
          span: 6,
          props: {},
          binding: { capability: "capB", arguments: {}, path: "value", priority: "P1" },
        },
      ],
    };
    const { ops, findings } = materialize(d, base(), planningCatalog, conflicting);
    expect(ops.filter((o) => o.type === "remapProvider")).toHaveLength(1);
    expect(findings.map((f) => f.code)).toEqual(["provider-conflict"]);
    expect(findings[0]?.nodeId).toBe("second");
    const r = replay(base(), ops);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const kids = r.value.root.kind === "container" ? r.value.root.children : [];
      const first = kids.find((k) => k.id === "first");
      const second = kids.find((k) => k.id === "second");
      expect(first?.kind === "semantic" && first.binding?.handle).toBeDefined();
      expect(second?.kind === "semantic" ? second.binding : undefined).toBeUndefined();
    }
  });
  it("carries a draft binding's sensitivity onto the inserted node, and leaves it absent when the draft has none", () => {
    const classified: PlanDraft = {
      summary: "s",
      nodes: [
        { ...draft.nodes[1]!, binding: { ...draft.nodes[1]!.binding!, sensitivity: "sensitive" } },
        draft.nodes[0]!,
      ],
    };
    const { ops, findings } = materialize(classified, base(), planningCatalog, capabilitiesFixture);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    const inserted = ops.filter((o) => o.type === "insertNode");
    const topSkus = inserted.find((o) => o.type === "insertNode" && o.node.id === "top_skus");
    expect(
      topSkus?.type === "insertNode" &&
        topSkus.node.kind === "semantic" &&
        topSkus.node.binding?.sensitivity
    ).toBe("sensitive");
    const orders = inserted.find((o) => o.type === "insertNode" && o.node.id === "orders");
    expect(
      orders?.type === "insertNode" && orders.node.kind === "semantic"
        ? "sensitivity" in (orders.node.binding ?? {})
        : true
    ).toBe(false);
  });
});

describe("materialize — revise (diff against the base)", () => {
  const countHandle = providerHandle(
    "orders.summary",
    "2.1.0",
    "sha256:orders-summary-2-1",
    { window: "7d" },
    "totals.count"
  );
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
    expect(ops.map((o) => o.type)).toEqual(["remapProvider", "bindProvider", "removeProvider"]);
    // `orders` was the only binder of the 7d handle; re-pathing it orphans that provider.
    expect(ops[2]).toEqual({ type: "removeProvider", handle: countHandle });
  });
  it("a binding whose ONLY change is its sensitivity emits a bindProvider carrying it — the handle is untouched, so no remapProvider", () => {
    const exp = composed();
    const revised: PlanDraft = {
      summary: "s",
      nodes: [
        draft.nodes[0]!,
        { ...draft.nodes[1]!, binding: { ...draft.nodes[1]!.binding!, sensitivity: "sensitive" } },
        draft.nodes[2]!,
      ],
    };
    const { ops, findings } = materialize(revised, exp, planningCatalog, capabilitiesFixture);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(ops).toEqual([
      {
        type: "bindProvider",
        nodeId: "top_skus",
        handle: expect.any(String),
        priority: "P1",
        sensitivity: "sensitive",
      },
    ]);
    const r = replay(exp, ops);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const kids = r.value.root.kind === "container" ? r.value.root.children : [];
      const topSkus = kids.find((k) => k.id === "top_skus");
      expect(topSkus?.kind === "semantic" && topSkus.binding?.sensitivity).toBe("sensitive");
    }
  });
  it("a draft that OMITS a class the node already carries emits nothing: core's bindProvider merges, so an op that drops it would be vacuous", () => {
    const classified: PlanDraft = {
      summary: "s",
      nodes: [
        draft.nodes[0]!,
        { ...draft.nodes[1]!, binding: { ...draft.nodes[1]!.binding!, sensitivity: "sensitive" } },
        draft.nodes[2]!,
      ],
    };
    const r = replay(
      base(),
      materialize(classified, base(), planningCatalog, capabilitiesFixture).ops
    );
    if (!r.ok) throw new Error(r.finding.message);
    const exp = r.value;
    // `draft` is `classified` minus the class, and identical in every other respect.
    const { ops, findings } = materialize(draft, exp, planningCatalog, capabilitiesFixture);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(ops).toEqual([]);
    // No op, but not silence: the model asked for something the merge cannot do, and a caller
    // reading the findings is the only party who can tell the class is still there.
    const notRemoved = findings.filter((f) => f.code === "sensitivity-not-removed");
    expect(notRemoved).toHaveLength(1);
    expect(notRemoved[0]?.severity).toBe("warn");
    expect(notRemoved[0]?.nodeId).toBe("top_skus");
    expect(notRemoved[0]?.message).toContain("sensitive");
  });
  it("a caller-only type whose node carries a class says nothing when the draft omits it: the model never saw the class", () => {
    // `Metric` leaves `sensitivity` absent in the catalogue, so the class on this node is the
    // CALLER's — `describeExperience` never showed it and the draft could not have carried it.
    const callerClassified: PlanDraft = {
      summary: "s",
      nodes: [
        { ...draft.nodes[0]!, binding: { ...draft.nodes[0]!.binding!, sensitivity: "sensitive" } },
        draft.nodes[1]!,
        draft.nodes[2]!,
      ],
    };
    const r = replay(
      base(),
      materialize(callerClassified, base(), planningCatalog, capabilitiesFixture).ops
    );
    if (!r.ok) throw new Error(r.finding.message);
    const { ops, findings } = materialize(draft, r.value, planningCatalog, capabilitiesFixture);
    expect(findings).toEqual([]);
    expect(ops).toEqual([]);
  });
  it("a model may not LOWER a class: the effective class stays the strictest of the two, no bindProvider is emitted, and the attempt is a warn", () => {
    const secretDraft: PlanDraft = {
      summary: "s",
      nodes: [
        draft.nodes[0]!,
        { ...draft.nodes[1]!, binding: { ...draft.nodes[1]!.binding!, sensitivity: "secret" } },
        draft.nodes[2]!,
      ],
    };
    const r = replay(
      base(),
      materialize(secretDraft, base(), planningCatalog, capabilitiesFixture).ops
    );
    if (!r.ok) throw new Error(r.finding.message);
    const exp = r.value;
    const lowered: PlanDraft = {
      summary: "s",
      nodes: [
        draft.nodes[0]!,
        { ...draft.nodes[1]!, binding: { ...draft.nodes[1]!.binding!, sensitivity: "internal" } },
        draft.nodes[2]!,
      ],
    };
    const { ops, findings } = materialize(lowered, exp, planningCatalog, capabilitiesFixture);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(ops).toEqual([]);
    const notLowered = findings.filter((f) => f.code === "sensitivity-not-lowered");
    expect(notLowered).toHaveLength(1);
    expect(notLowered[0]?.severity).toBe("warn");
    expect(notLowered[0]?.nodeId).toBe("top_skus");
    expect(notLowered[0]?.message).toContain("top_skus");
    expect(notLowered[0]?.message).toContain("secret");
    expect(notLowered[0]?.message).toContain("internal");
    const after = replay(exp, ops);
    expect(after.ok).toBe(true);
    if (after.ok) {
      const kids = after.value.root.kind === "container" ? after.value.root.children : [];
      const topSkus = kids.find((k) => k.id === "top_skus");
      expect(topSkus?.kind === "semantic" && topSkus.binding?.sensitivity).toBe("secret");
    }
  });
  it("a model may RAISE a class: the proposal is stricter, so it is emitted and there is no warn", () => {
    const internalDraft: PlanDraft = {
      summary: "s",
      nodes: [
        draft.nodes[0]!,
        { ...draft.nodes[1]!, binding: { ...draft.nodes[1]!.binding!, sensitivity: "internal" } },
        draft.nodes[2]!,
      ],
    };
    const r = replay(
      base(),
      materialize(internalDraft, base(), planningCatalog, capabilitiesFixture).ops
    );
    if (!r.ok) throw new Error(r.finding.message);
    const exp = r.value;
    const raised: PlanDraft = {
      summary: "s",
      nodes: [
        draft.nodes[0]!,
        { ...draft.nodes[1]!, binding: { ...draft.nodes[1]!.binding!, sensitivity: "secret" } },
        draft.nodes[2]!,
      ],
    };
    const { ops, findings } = materialize(raised, exp, planningCatalog, capabilitiesFixture);
    expect(findings).toEqual([]);
    expect(ops).toEqual([
      {
        type: "bindProvider",
        nodeId: "top_skus",
        handle: expect.any(String),
        priority: "P1",
        sensitivity: "secret",
      },
    ]);
  });
  it("a capability's sample changing shape under an UNCHANGED handle re-emits the provider (stale pin) with no bindProvider", () => {
    const exp = composed();
    const staleShapeCapabilities: CapabilityRef[] = capabilitiesFixture.map((c) =>
      c.handle === "orders_summary"
        ? {
            ...c,
            sampleOutput: {
              window: "7d",
              totals: { count: "412", revenueCents: 1_234_500 },
              rows: [{ sku: "A1", units: 5 }],
            },
          }
        : c
    );
    const { ops, findings } = materialize(draft, exp, planningCatalog, staleShapeCapabilities);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(ops.filter((o) => o.type === "bindProvider")).toHaveLength(0);
    const remaps = ops.filter((o) => o.type === "remapProvider");
    expect(remaps).toHaveLength(1);
    expect(remaps[0]?.type === "remapProvider" && remaps[0].spec.outputShapeHash).toBe(
      outputShapeHashOf("412")
    );
  });
  it("a removed prop key whose sibling keys are otherwise unchanged: props-not-removed warns and no setProps op is emitted", () => {
    const composedProps = () => {
      const seed: PlanDraft = {
        summary: "s",
        nodes: [
          {
            id: "widget",
            type: "Metric",
            label: "Widget",
            span: 6,
            props: { columns: ["sku", "units"], unit: "x" },
          },
        ],
      };
      const r = replay(base(), materialize(seed, base(), planningCatalog, capabilitiesFixture).ops);
      if (!r.ok) throw new Error(r.finding.message);
      return r.value;
    };
    const exp = composedProps();
    const revised: PlanDraft = {
      summary: "s",
      nodes: [
        {
          id: "widget",
          type: "Metric",
          label: "Widget",
          span: 6,
          props: { columns: ["sku", "units"] },
        },
      ],
    };
    const { ops, findings } = materialize(revised, exp, planningCatalog, capabilitiesFixture);
    expect(ops.filter((o) => o.type === "setProps")).toHaveLength(0);
    expect(findings).toEqual([
      expect.objectContaining({
        code: "props-not-removed",
        severity: "warn",
        nodeId: "widget",
        message: expect.stringContaining('"unit"'),
      }),
    ]);
  });
  it("a span change is applied as setPlacement(span) — and leaves the node's grid placement alone", () => {
    const placed = apply(composed(), { type: "setPlacement", nodeId: "note", row: 3, column: 1 });
    if (!placed.ok) throw new Error(placed.finding.message);
    const revised: PlanDraft = {
      summary: "s",
      nodes: draft.nodes.map((n, i) => (i === 2 ? { ...n, span: 6 } : n)),
    };
    const { ops, findings } = materialize(
      revised,
      placed.value,
      planningCatalog,
      capabilitiesFixture
    );
    expect(findings).toEqual([]);
    expect(ops).toEqual([{ type: "setPlacement", nodeId: "note", span: 6 }]);
    const r = replay(placed.value, ops);
    const note = r.ok && isContainer(r.value.root) ? r.value.root.children[2] : undefined;
    expect(note).toMatchObject({ id: "note", span: 6, row: 3, column: 1 });
  });
  it("a widening span that would overflow the grid emits setPlacement with column CLAMPED so it fits — the model never named a column", () => {
    const placed = apply(composed(), { type: "setPlacement", nodeId: "orders", column: 9 });
    if (!placed.ok) throw new Error(placed.finding.message);
    const revised: PlanDraft = {
      summary: "s",
      nodes: draft.nodes.map((n, i) => (i === 0 ? { ...n, span: 6 } : n)),
    };
    const { ops, findings } = materialize(
      revised,
      placed.value,
      planningCatalog,
      capabilitiesFixture
    );
    expect(findings).toEqual([]);
    expect(ops).toEqual([{ type: "setPlacement", nodeId: "orders", span: 6, column: 7 }]);
    const r = replay(placed.value, ops);
    const orders = r.ok && isContainer(r.value.root) ? r.value.root.children[0] : undefined;
    expect(orders).toMatchObject({ id: "orders", span: 6, column: 7 });
  });
  it("a widening span that does NOT overflow leaves column absent from the op", () => {
    const placed = apply(composed(), { type: "setPlacement", nodeId: "orders", column: 1 });
    if (!placed.ok) throw new Error(placed.finding.message);
    const revised: PlanDraft = {
      summary: "s",
      nodes: draft.nodes.map((n, i) => (i === 0 ? { ...n, span: 6 } : n)),
    };
    const { ops } = materialize(revised, placed.value, planningCatalog, capabilitiesFixture);
    expect(ops).toEqual([{ type: "setPlacement", nodeId: "orders", span: 6 }]);
    const r = replay(placed.value, ops);
    expect(r.ok).toBe(true);
    const orders = r.ok && isContainer(r.value.root) ? r.value.root.children[0] : undefined;
    expect(orders).toMatchObject({ id: "orders", span: 6, column: 1 });
  });
  it("clamps to column 1 at the extreme: a full-width widened span leaves no room to keep any of the original column", () => {
    const placed = apply(composed(), { type: "setPlacement", nodeId: "orders", column: 9 });
    if (!placed.ok) throw new Error(placed.finding.message);
    const revised: PlanDraft = {
      summary: "s",
      nodes: draft.nodes.map((n, i) => (i === 0 ? { ...n, span: 12 } : n)),
    };
    const { ops, findings } = materialize(
      revised,
      placed.value,
      planningCatalog,
      capabilitiesFixture
    );
    expect(findings).toEqual([]);
    expect(ops).toEqual([{ type: "setPlacement", nodeId: "orders", span: 12, column: 1 }]);
    const r = replay(placed.value, ops);
    expect(r.ok).toBe(true);
    const orders = r.ok && isContainer(r.value.root) ? r.value.root.children[0] : undefined;
    expect(orders).toMatchObject({ id: "orders", span: 12, column: 1 });
  });
  it("a span change on a node under a NON-grid parent emits a span-only setPlacement — no row/column key, nothing to overflow", () => {
    const rowRoot: ContainerNode = {
      id: "root",
      order: "V",
      kind: "container",
      direction: "row",
      span: 12,
      children: [],
    };
    const rowBase = genesis({
      experienceId: "e",
      intent: intentFixture,
      meta: metaFixture,
      root: rowRoot,
    });
    const composedOps = materialize(draft, rowBase, planningCatalog, capabilitiesFixture).ops;
    const rowComposed = replay(rowBase, composedOps);
    if (!rowComposed.ok) throw new Error(rowComposed.finding.message);
    const revised: PlanDraft = {
      summary: "s",
      nodes: draft.nodes.map((n, i) => (i === 0 ? { ...n, span: 6 } : n)),
    };
    const { ops, findings } = materialize(
      revised,
      rowComposed.value,
      planningCatalog,
      capabilitiesFixture
    );
    expect(findings).toEqual([]);
    expect(ops).toEqual([{ type: "setPlacement", nodeId: "orders", span: 6 }]);
    const r = replay(rowComposed.value, ops);
    expect(r.ok).toBe(true);
    const orders = r.ok && isContainer(r.value.root) ? r.value.root.children[0] : undefined;
    expect(orders).toMatchObject({ id: "orders", span: 6 });
    expect(orders && "column" in orders).toBe(false);
    expect(orders && "row" in orders).toBe(false);
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
      nodes: [
        ...draft.nodes,
        {
          id: "grp",
          type: "Insight",
          label: "x",
          span: 12,
          props: {},
          binding: {
            capability: "orders_summary",
            arguments: { window: "7d" },
            path: "totals.count",
            priority: "P1",
          },
        },
      ],
    };
    const { ops, findings } = materialize(
      revised,
      withContainer.value,
      planningCatalog,
      capabilitiesFixture
    );
    expect(ops.filter((o) => o.type === "remapProvider")).toHaveLength(0);
    expect(findings.map((f) => f.code)).toEqual(["not-semantic"]);
  });
  it("a draft id naming a node NESTED inside a container is refused as nested-node: no insert, no provider, and replay still applies", () => {
    const withContainer = apply(composed(), {
      type: "insertNode",
      parentId: "root",
      node: { id: "grp", order: "Z", kind: "container", direction: "row", span: 12, children: [] },
    });
    if (!withContainer.ok) throw new Error(withContainer.finding.message);
    const withDeep = apply(withContainer.value, {
      type: "insertNode",
      parentId: "grp",
      node: {
        id: "deep",
        order: "a",
        kind: "semantic",
        type: "Insight",
        typeVersion: "1.0.0",
        span: 12,
        label: { key: "deep.label", fallback: "Deep" },
        props: { tone: "neutral" },
      },
    });
    if (!withDeep.ok) throw new Error(withDeep.finding.message);
    const revised: PlanDraft = {
      summary: "s",
      nodes: [
        ...draft.nodes,
        { id: "deep", type: "Insight", label: "edited", span: 12, props: { tone: "warn" } },
      ],
    };
    const { ops, findings } = materialize(
      revised,
      withDeep.value,
      planningCatalog,
      capabilitiesFixture
    );
    const nested = findings.filter((f) => f.code === "nested-node");
    expect(nested).toHaveLength(1);
    expect(nested[0]?.severity).toBe("error");
    expect(nested[0]?.nodeId).toBe("deep");
    expect(ops.some((o) => o.type === "insertNode" && o.node.id === "deep")).toBe(false);
    expect(ops.some((o) => o.type === "setProps" && o.nodeId === "deep")).toBe(false);
    // The refusal is what keeps replay clean: an insert would collide with the existing id.
    const r = replay(withDeep.value, ops);
    expect(r.ok).toBe(true);
  });
  it("a draft id naming the ROOT is refused as not-semantic", () => {
    const revised: PlanDraft = {
      summary: "s",
      nodes: [{ id: "root", type: "Insight", label: "x", span: 12, props: {} }],
    };
    const { ops, findings } = materialize(
      revised,
      composed(),
      planningCatalog,
      capabilitiesFixture
    );
    expect(findings.filter((f) => f.code === "not-semantic").map((f) => f.nodeId)).toEqual([
      "root",
    ]);
    expect(ops.some((o) => o.type === "insertNode")).toBe(false);
  });
  it("removing the only binder of a handle retires its provider, after the removeNode", () => {
    const exp = composed();
    const revised: PlanDraft = { summary: "s", nodes: [draft.nodes[1]!, draft.nodes[2]!] };
    const { ops } = materialize(revised, exp, planningCatalog, capabilitiesFixture);
    expect(ops).toEqual([
      { type: "removeNode", nodeId: "orders" },
      { type: "removeProvider", handle: countHandle },
    ]);
    const r = replay(exp, ops);
    expect(r.ok).toBe(true);
    expect(r.ok && Object.prototype.hasOwnProperty.call(r.value.providers, countHandle)).toBe(
      false
    );
  });
  it("a handle another node still binds is kept", () => {
    const shared: PlanDraft = {
      summary: "s",
      nodes: [draft.nodes[0]!, { ...draft.nodes[0]!, id: "orders_copy" }],
    };
    const r0 = replay(
      base(),
      materialize(shared, base(), planningCatalog, capabilitiesFixture).ops
    );
    if (!r0.ok) throw new Error(r0.finding.message);
    const { ops } = materialize(
      { summary: "s", nodes: [draft.nodes[0]!] },
      r0.value,
      planningCatalog,
      capabilitiesFixture
    );
    expect(ops).toEqual([{ type: "removeNode", nodeId: "orders_copy" }]);
  });
  it("a provider the base declared with NO binder is not the plan's to retire", () => {
    const withAppOwned = apply(composed(), {
      type: "remapProvider",
      handle: "app_owned",
      spec: {
        handle: "app_owned",
        executionGraph: [],
        reshaping: { engine: "JSONPath", scriptRef: "" },
        outputShapeHash: "sha256:x",
        cachePolicy: { ttlSeconds: 60, scope: "principal" },
      },
    });
    if (!withAppOwned.ok) throw new Error(withAppOwned.finding.message);
    const { ops } = materialize(draft, withAppOwned.value, planningCatalog, capabilitiesFixture);
    expect(ops).toEqual([]);
  });
  it("orphanedProviders counts nested binders and removed subtrees, and sorts by handle", () => {
    const g0 = base();
    const e = replay(g0, [
      {
        type: "remapProvider",
        handle: "b",
        spec: { ...buildSpecFor("b") },
      },
      { type: "remapProvider", handle: "a", spec: { ...buildSpecFor("a") } },
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "box",
          order: "a",
          kind: "container",
          direction: "row",
          span: 12,
          children: [
            {
              id: "x",
              order: "V",
              kind: "semantic",
              type: "Metric",
              typeVersion: "1.0.0",
              span: 4,
              props: {},
              binding: { handle: "b", priority: "P1" },
            },
            {
              id: "y",
              order: "W",
              kind: "semantic",
              type: "Metric",
              typeVersion: "1.0.0",
              span: 4,
              props: {},
              binding: { handle: "a", priority: "P1" },
            },
          ],
        },
      },
    ]);
    if (!e.ok) throw new Error(e.finding.message);
    expect(orphanedProviders(e.value, [{ type: "removeNode", nodeId: "box" }])).toEqual([
      { type: "removeProvider", handle: "a" },
      { type: "removeProvider", handle: "b" },
    ]);
    expect(orphanedProviders(e.value, [])).toEqual([]);
    expect(
      orphanedProviders(e.value, [{ type: "bindProvider", nodeId: "x", handle: "a" }])
    ).toEqual([{ type: "removeProvider", handle: "b" }]);
  });
  describe("orphanedProviders — exact after-state (not approximated per op-type)", () => {
    // A richer fixture than the flat "box" one above: `x` sits two containers deep, `solo` is a
    // sibling bound to its own handle — enough structure for a moved binder, a doubly-nested
    // removal, and an insert that lands on a handle a removal just freed to all diverge from what
    // an op-type-by-op-type approximation would guess.
    const nested = () => {
      const g0 = base();
      const e = replay(g0, [
        { type: "remapProvider", handle: "a", spec: buildSpecFor("a") },
        { type: "remapProvider", handle: "b", spec: buildSpecFor("b") },
        { type: "remapProvider", handle: "c", spec: buildSpecFor("c") },
        {
          type: "insertNode",
          parentId: "root",
          node: {
            id: "box",
            order: "a",
            kind: "container",
            direction: "row",
            span: 12,
            children: [
              {
                id: "inner",
                order: "V",
                kind: "container",
                direction: "column",
                span: 12,
                children: [
                  {
                    id: "x",
                    order: "V",
                    kind: "semantic",
                    type: "Metric",
                    typeVersion: "1.0.0",
                    span: 4,
                    props: {},
                    binding: { handle: "b", priority: "P1" },
                  },
                ],
              },
              {
                id: "y",
                order: "W",
                kind: "semantic",
                type: "Metric",
                typeVersion: "1.0.0",
                span: 4,
                props: {},
                binding: { handle: "a", priority: "P1" },
              },
            ],
          },
        },
        {
          type: "insertNode",
          parentId: "root",
          node: {
            id: "solo",
            order: "b",
            kind: "semantic",
            type: "Metric",
            typeVersion: "1.0.0",
            span: 4,
            props: {},
            binding: { handle: "c", priority: "P1" },
          },
        },
      ]);
      if (!e.ok) throw new Error(e.finding.message);
      return e.value;
    };
    it("a moveNode that relocates a binder out of a subtree before it is removed keeps that binder's provider", () => {
      const exp = nested();
      const ops: Operation[] = [
        { type: "moveNode", nodeId: "x", newParentId: "root", newOrder: "d" },
        { type: "removeNode", nodeId: "box" },
      ];
      const orphaned = orphanedProviders(exp, ops);
      // `x` (still bound to "b") survived the move; "y" (bound to "a") went down with `box`.
      expect(orphaned).toEqual([{ type: "removeProvider", handle: "a" }]);
      const r = replay(exp, [...ops, ...orphaned]);
      expect(r.ok).toBe(true);
      expect(r.ok && Object.prototype.hasOwnProperty.call(r.value.providers, "b")).toBe(true);
    });
    it("bindProvider onto a node inserted bound to a DIFFERENT handle retires nothing: the handle it lands on stays bound", () => {
      const exp = nested();
      const ops: Operation[] = [
        { type: "removeNode", nodeId: "solo" },
        {
          type: "insertNode",
          parentId: "root",
          node: {
            id: "n",
            order: "z",
            kind: "semantic",
            type: "Metric",
            typeVersion: "1.0.0",
            span: 4,
            props: {},
            binding: { handle: "a", priority: "P1" },
          },
        },
        { type: "bindProvider", nodeId: "n", handle: "c" },
      ];
      const orphaned = orphanedProviders(exp, ops);
      expect(orphaned).toEqual([]);
      const r = replay(exp, [...ops, ...orphaned]);
      expect(r.ok).toBe(true);
    });
    it("removing a node inserted bound to a freed handle retires that handle too", () => {
      const exp = nested();
      const ops: Operation[] = [
        { type: "removeNode", nodeId: "solo" },
        {
          type: "insertNode",
          parentId: "root",
          node: {
            id: "n",
            order: "z",
            kind: "semantic",
            type: "Metric",
            typeVersion: "1.0.0",
            span: 4,
            props: {},
            binding: { handle: "c", priority: "P1" },
          },
        },
        { type: "removeNode", nodeId: "n" },
      ];
      const orphaned = orphanedProviders(exp, ops);
      expect(orphaned).toEqual([{ type: "removeProvider", handle: "c" }]);
      const r = replay(exp, [...ops, ...orphaned]);
      expect(r.ok).toBe(true);
    });
    it("a prompt op's nested materialized ops are folded exactly like top-level ops", () => {
      const exp = nested();
      const ops: Operation[] = [
        { type: "prompt", text: "x", materialized: [{ type: "removeNode", nodeId: "solo" }] },
      ];
      const orphaned = orphanedProviders(exp, ops);
      expect(orphaned).toEqual([{ type: "removeProvider", handle: "c" }]);
      const r = replay(exp, [...ops, ...orphaned]);
      expect(r.ok).toBe(true);
    });
    it("ops that do not replay onto base leave nothing to orphan", () => {
      const exp = nested();
      expect(orphanedProviders(exp, [{ type: "removeNode", nodeId: "does-not-exist" }])).toEqual(
        []
      );
    });
    it("remove a node and re-insert the same id bound to the same handle: the handle is kept", () => {
      const exp = nested();
      const ops: Operation[] = [
        { type: "removeNode", nodeId: "solo" },
        {
          type: "insertNode",
          parentId: "root",
          node: {
            id: "solo",
            order: "b",
            kind: "semantic",
            type: "Metric",
            typeVersion: "1.0.0",
            span: 4,
            props: {},
            binding: { handle: "c", priority: "P1" },
          },
        },
      ];
      expect(orphanedProviders(exp, ops)).toEqual([]);
    });
    it("insert a DIFFERENT node bound to the just-removed node's handle: the handle is kept", () => {
      const exp = nested();
      const ops: Operation[] = [
        { type: "removeNode", nodeId: "solo" },
        {
          type: "insertNode",
          parentId: "root",
          node: {
            id: "other",
            order: "b",
            kind: "semantic",
            type: "Metric",
            typeVersion: "1.0.0",
            span: 4,
            props: {},
            binding: { handle: "c", priority: "P1" },
          },
        },
      ];
      expect(orphanedProviders(exp, ops)).toEqual([]);
    });
  });
});
