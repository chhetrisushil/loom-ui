import { genesis, replay } from "@loom-ui/core";
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
});
