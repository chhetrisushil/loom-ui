import { apply, genesis, replay } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { EXPERIENCE_OP_ACTION, EXPERIENCE_PROMOTED, interpretAction } from "./interaction";
import { materialize } from "./materialize";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
} from "./testing.test-support";

const exp = (() => {
  const g = genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture });
  const r = replay(
    g,
    materialize(
      { summary: "s", nodes: [{ id: "note", type: "Insight", label: "n", span: 12, props: {} }] },
      g,
      planningCatalog,
      capabilitiesFixture
    ).ops
  );
  if (!r.ok) throw new Error(r.finding.message);
  return r.value;
})();

describe("interpretAction", () => {
  it("an experience.op action carrying a valid Operation on an existing node is an experience operation", () => {
    const r = interpretAction(exp, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "note",
      payload: {
        type: "setLabel",
        nodeId: "note",
        label: { key: "note.label", fallback: "Renamed" },
      },
    });
    expect(r.kind).toBe("experience");
    if (r.kind === "experience") expect(r.op.type).toBe("setLabel");
  });
  it("APPROVE from loom's ApprovalCard is a business action, returned untouched", () => {
    const action = { type: "APPROVE", widgetId: "gate", payload: { approved: true } };
    const r = interpretAction(exp, action);
    expect(r).toEqual({ kind: "business", action });
  });
  it("an experience.op whose payload is not an Operation, or targets a missing node, or touches the root, is refused with a finding — never applied, never a throw", () => {
    const notOp = interpretAction(exp, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "note",
      payload: { hello: "world" },
    });
    expect(notOp.kind).toBe("refused");
    const missing = interpretAction(exp, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "x",
      payload: { type: "removeNode", nodeId: "ghost" },
    });
    expect(missing.kind === "refused" && missing.finding.code).toBe("missing-node");
    const root = interpretAction(exp, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "root",
      payload: { type: "removeNode", nodeId: "root" },
    });
    expect(root.kind === "refused" && root.finding.code).toBe("root-immutable");
    const prompt = interpretAction(exp, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "note",
      payload: { type: "prompt", text: "x", materialized: [] },
    });
    expect(prompt.kind === "refused" && prompt.finding.code).toBe("prompt-not-interactive");
  });
  it("an experience.op carrying a valid remapProvider is refused with provider-op-not-interactive — a data-plane re-pin is a planner or app repair action, not a widget click", () => {
    const remap = interpretAction(exp, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "note",
      payload: {
        type: "remapProvider",
        handle: "h1",
        spec: {
          handle: "h1",
          executionGraph: [
            {
              stepId: "s1",
              toolName: "orders.summary",
              toolVersion: "2.1.0",
              toolSchemaHash: "sha256:orders-summary-2-1",
              arguments: { window: "7d" },
              dependsOn: [],
              idempotent: true,
            },
          ],
          reshaping: { engine: "JSONPath", scriptRef: "totals.count" },
          outputShapeHash: "sha256:x",
          cachePolicy: { ttlSeconds: 60, scope: "principal" },
        },
      },
    });
    expect(remap.kind === "refused" && remap.finding.code).toBe("provider-op-not-interactive");
  });
  it("names the promotion event", () => {
    expect(EXPERIENCE_PROMOTED).toBe("EXPERIENCE_PROMOTED");
  });
  it("an experience.op carrying removeProvider is refused with provider-op-not-interactive — retiring a provider is the planner's or the app's, never a widget's", () => {
    const r = interpretAction(exp, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "note",
      payload: { type: "removeProvider", handle: "h1" },
    });
    expect(r.kind === "refused" && r.finding.code).toBe("provider-op-not-interactive");
  });
  it("a widget may resize or re-place a node (setPlacement) — but not the root, and not a missing node", () => {
    const ok = interpretAction(exp, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "note",
      payload: { type: "setPlacement", nodeId: "note", span: 6, row: 1, column: 7 },
    });
    expect(ok.kind).toBe("experience");
    if (ok.kind === "experience") expect(ok.op.type).toBe("setPlacement");
    const root = interpretAction(exp, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "root",
      payload: { type: "setPlacement", nodeId: "root", span: 6 },
    });
    expect(root.kind === "refused" && root.finding.code).toBe("root-immutable");
    const ghost = interpretAction(exp, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "ghost",
      payload: { type: "setPlacement", nodeId: "ghost", span: 6 },
    });
    expect(ghost.kind === "refused" && ghost.finding.code).toBe("missing-node");
  });
  it("a widget may retitle a section (setTitle) — but not the root's title", () => {
    const withSection = apply(exp, {
      type: "insertNode",
      parentId: "root",
      node: { id: "sec", order: "a", kind: "container", direction: "grid", span: 12, children: [] },
    });
    if (!withSection.ok) throw new Error(withSection.finding.message);
    const title = { key: "sec.title", fallback: "Renamed" };
    const ok = interpretAction(withSection.value, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "sec",
      payload: { type: "setTitle", nodeId: "sec", title },
    });
    expect(ok.kind === "experience" && ok.op).toEqual({ type: "setTitle", nodeId: "sec", title });
    const root = interpretAction(withSection.value, {
      type: EXPERIENCE_OP_ACTION,
      widgetId: "root",
      payload: { type: "setTitle", nodeId: "root", title },
    });
    expect(root.kind === "refused" && root.finding.code).toBe("root-immutable");
  });
  it("a widget may NOT set a container's role (role-op-not-interactive) — the app's presentation vocabulary, not direct manipulation", () => {
    const withSection = apply(exp, {
      type: "insertNode",
      parentId: "root",
      node: {
        id: "sec",
        order: "a",
        kind: "container",
        direction: "column",
        span: 12,
        children: [],
      },
    });
    if (!withSection.ok) throw new Error(withSection.finding.message);
    for (const role of ["stepped", null]) {
      const r = interpretAction(withSection.value, {
        type: EXPERIENCE_OP_ACTION,
        widgetId: "sec",
        payload: { type: "setRole", nodeId: "sec", role },
      });
      expect(r.kind === "refused" && r.finding.code).toBe("role-op-not-interactive");
    }
    // …while the same op, applied by the app or a planner, is an ordinary operation.
    expect(apply(withSection.value, { type: "setRole", nodeId: "sec", role: "stepped" }).ok).toBe(
      true
    );
  });
});
