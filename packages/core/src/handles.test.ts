import { describe, expect, it } from "vitest";
import { genesis } from "./experience";
import { experienceHandles } from "./handles";
import type { ContainerNode, ExperienceNode, SemanticNode } from "./node";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const sem = (
  id: string,
  handle: string | undefined,
  priority: "P0" | "P1" | "P2" = "P1"
): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  ...(handle !== undefined && { binding: { handle, priority } }),
});
const exp = (children: ExperienceNode[]) => {
  const g = genesis({ experienceId: "e", intent: { objective: "x", source: "user" }, meta });
  return { ...g, root: { ...g.root, children } };
};

describe("experienceHandles", () => {
  it("dedupes handles across nodes, keeps the highest priority, lists every binding node", () => {
    const out = experienceHandles(
      exp([sem("a", "h1", "P2"), sem("b", "h1", "P0"), sem("c", "h2", "P1"), sem("d", undefined)])
    );
    expect(out).toEqual([
      { handle: "h1", priority: "P0", nodeIds: ["a", "b"] },
      { handle: "h2", priority: "P1", nodeIds: ["c"] },
    ]);
  });
  it("orders by priority then handle, deterministically, and descends into containers", () => {
    const row: ContainerNode = {
      id: "row",
      order: "z",
      kind: "container",
      direction: "row",
      span: 12,
      children: [sem("x", "zeta", "P0"), sem("y", "alpha", "P0")],
    };
    const out = experienceHandles(exp([sem("m", "mid", "P1"), row]));
    expect(out.map((h) => h.handle)).toEqual(["alpha", "zeta", "mid"]);
  });
  it("returns [] for an experience with no bindings", () => {
    expect(experienceHandles(exp([sem("a", undefined)]))).toEqual([]);
  });
});
