import { canonicalJson } from "@loom/core";
import { describe, expect, it } from "vitest";
import { genesis } from "./experience";
import { mintVersionHash } from "./log";
import { Operation, replay } from "./operations";

// Content addresses minted before new operation kinds and optional node fields existed. A stored
// artifact is re-hashed on read (`getExperience`); if either literal moves, every artifact
// written before the change reads back as `artifact-tampered`. The literals were minted on
// main e0ed543 — if the FIRST run of this file fails, the regression predates this branch.
const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const g = genesis({
  experienceId: "exp-golden",
  intent: { objective: "x", source: "user" },
  meta,
});
const spec = {
  handle: "h1",
  executionGraph: [],
  reshaping: { engine: "JSONPath" as const, scriptRef: "totals.count" },
  outputShapeHash: "sha256:o",
  cachePolicy: { ttlSeconds: 60, scope: "global" as const },
};
const folded: Operation[] = [
  { type: "remapProvider", handle: "h1", spec },
  {
    type: "insertNode",
    parentId: "root",
    node: {
      id: "m1",
      order: "V",
      kind: "semantic",
      type: "Metric",
      typeVersion: "1.0.0",
      span: 4,
      props: { unit: "ms" },
      binding: { handle: "h1", priority: "P0" },
    },
  },
  {
    type: "insertNode",
    parentId: "root",
    node: { id: "c1", order: "a", kind: "container", direction: "row", span: 12, children: [] },
  },
];

describe("content addresses written before this branch do not move", () => {
  it("a genesis and a folded experience keep their pinned versionHash", () => {
    expect(mintVersionHash(g)).toBe(
      "sha256:135b812dafd0d0333475125b0afab60fd504eef8f6b13c8248f131ba4d4f0f7a"
    );
    const r = replay(g, folded);
    if (!r.ok) throw new Error(r.finding.message);
    expect(mintVersionHash(r.value)).toBe(
      "sha256:3a50c6b88b05b4d2f04534a4c1dae56b4b8daf657a6bead48781efa7230b5354"
    );
  });
  it("every pre-existing operation kind parses to exactly itself — no key added, none dropped", () => {
    const recorded: Operation[] = [
      ...folded,
      { type: "removeNode", nodeId: "m1" },
      { type: "moveNode", nodeId: "m1", newParentId: "c1", newOrder: "a" },
      { type: "setProps", nodeId: "m1", patch: { unit: "s" } },
      { type: "setLabel", nodeId: "m1", label: { key: "m1.label", fallback: "p99" } },
      {
        type: "bindProvider",
        nodeId: "m1",
        handle: "h1",
        priority: "P1",
        sensitivity: "internal",
      },
      { type: "prompt", text: "add a metric", scopeNodeIds: ["m1"], materialized: [folded[0]!] },
    ];
    for (const op of recorded) expect(canonicalJson(Operation.parse(op))).toBe(canonicalJson(op));
  });
});
