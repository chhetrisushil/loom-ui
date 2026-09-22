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
  it("names the promotion event", () => {
    expect(EXPERIENCE_PROMOTED).toBe("EXPERIENCE_PROMOTED");
  });
});
