import { describe, expect, it } from "vitest";
import {
  type ContainerNode,
  ExperienceNode,
  type SemanticNode,
  findNode,
  isContainer,
  nodeIds,
  normalize,
  rebuild,
  walk,
} from "./node";

const metric = (id: string, order: string): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  binding: { handle: `h-${id}`, priority: "P1" },
});

const root: ContainerNode = {
  id: "root",
  order: "V",
  kind: "container",
  direction: "row",
  span: 12,
  children: [metric("b", "b"), metric("a", "a")],
};

describe("ExperienceNode schema", () => {
  it("accepts a well-formed tree and rejects an unknown kind or a visual kind", () => {
    expect(ExperienceNode.safeParse(root).success).toBe(true);
    expect(ExperienceNode.safeParse({ ...root, kind: "widget" }).success).toBe(false);
    expect(
      ExperienceNode.safeParse({ ...metric("x", "x"), type: "" }).success,
      "an empty type is not a semantic type"
    ).toBe(false);
  });
  it("rejects a span outside 1..12 and a priority outside P0..P2", () => {
    expect(ExperienceNode.safeParse({ ...metric("x", "x"), span: 0 }).success).toBe(false);
    expect(ExperienceNode.safeParse({ ...metric("x", "x"), span: 13 }).success).toBe(false);
    expect(
      ExperienceNode.safeParse({ ...metric("x", "x"), binding: { handle: "h", priority: "P3" } })
        .success
    ).toBe(false);
  });
});

describe("tree helpers", () => {
  it("walk visits parent before children; findNode finds by id; nodeIds lists all", () => {
    const seen: string[] = [];
    walk(root, (n) => seen.push(n.id));
    expect(seen).toEqual(["root", "b", "a"]);
    expect(findNode(root, "a")?.id).toBe("a");
    expect(findNode(root, "zzz")).toBeUndefined();
    expect(nodeIds(root).sort()).toEqual(["a", "b", "root"]);
  });
  it("normalize sorts children by order at every level and does not mutate its input", () => {
    const n = normalize(root);
    expect(isContainer(n) && n.children.map((c) => c.id)).toEqual(["a", "b"]);
    expect(root.children.map((c) => c.id)).toEqual(["b", "a"]);
  });
  it("rebuild removes a node when the editor returns null and throws if the root is removed", () => {
    const out = rebuild(root, (n) => (n.id === "a" ? null : n));
    expect(nodeIds(out).sort()).toEqual(["b", "root"]);
    expect(() => rebuild(root, () => null)).toThrow(/root/);
  });
});
