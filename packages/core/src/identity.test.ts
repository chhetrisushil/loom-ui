import { describe, expect, it } from "vitest";
import { genesis } from "./experience";
import { experienceNodeIds, preservesNodes } from "./identity";
import type { SemanticNode } from "./node";
import { apply } from "./operations";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const node = (id: string): SemanticNode => ({
  id,
  order: "V",
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
});

describe("experienceNodeIds + preservesNodes", () => {
  it("reports the ids a revision dropped, and nothing when a revision only edits props", () => {
    const g = genesis({ experienceId: "e", intent: { objective: "x", source: "user" }, meta });
    const a = apply(g, { type: "insertNode", parentId: "root", node: node("m1") });
    if (!a.ok) throw new Error("setup");
    const edited = apply(a.value, { type: "setProps", nodeId: "m1", patch: { unit: "ms" } });
    const removed = apply(a.value, { type: "removeNode", nodeId: "m1" });
    if (!edited.ok || !removed.ok) throw new Error("setup");
    expect(preservesNodes(experienceNodeIds(a.value), experienceNodeIds(edited.value)).ok).toBe(
      true
    );
    const report = preservesNodes(experienceNodeIds(a.value), experienceNodeIds(removed.value));
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.nodeId)).toEqual(["m1"]);
  });
});
