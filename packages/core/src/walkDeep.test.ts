import type { DataClass } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { effectiveClasses, liveClasses } from "./classes";
import type { Experience } from "./experience";
import {
  type ContainerNode,
  type ExperienceNode,
  type SemanticNode,
  isContainer,
  walk,
} from "./node";
import { strictestClass } from "./viewer";

const CLASSES = ["internal", "sensitive", "secret"] as const;

/** The pre-iterative `walk`, kept as the oracle: parent before children, children read lazily. */
function recursiveWalk(
  n: ExperienceNode,
  visit: (n: ExperienceNode, parent: ContainerNode | null) => void,
  parent: ContainerNode | null = null
): void {
  visit(n, parent);
  if (isContainer(n)) for (const c of n.children) recursiveWalk(c, visit, n);
}

const leaf = (id: string, sensitivity?: (typeof CLASSES)[number]): SemanticNode => ({
  id,
  order: "V",
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  binding: { handle: `h-${id}`, priority: "P1", ...(sensitivity && { sensitivity }) },
  ...(sensitivity && { projection: { id: `p-${id}`, path: "$.x", version: "1", sensitivity } }),
});

const box = (id: string, children: ExperienceNode[]): ContainerNode => ({
  id,
  order: "V",
  kind: "container",
  direction: "column",
  span: 12,
  children,
});

/** Seeded xorshift: the same trees every run. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

function randomTree(rand: () => number): ContainerNode {
  let next = 0;
  const grow = (depth: number): ExperienceNode => {
    const id = `x${next++}`;
    if (depth > 6 || rand() < 0.35)
      // handles repeat across leaves so the "strictest wins" fold is exercised
      return {
        ...leaf(id, rand() < 0.6 ? CLASSES[Math.floor(rand() * 3)] : undefined),
        binding: {
          handle: `h${Math.floor(rand() * 5)}`,
          priority: "P1",
          ...(rand() < 0.6 && { sensitivity: CLASSES[Math.floor(rand() * 3)] }),
        },
      };
    const kids = Array.from({ length: Math.floor(rand() * 4) }, () => grow(depth + 1));
    return box(id, kids);
  };
  return box(
    "root",
    Array.from({ length: 1 + Math.floor(rand() * 4) }, () => grow(1))
  );
}

/** A spine `levels` deep ending in one secret leaf, built ITERATIVELY. */
function spine(levels: number): ContainerNode {
  let node = box("n0", [leaf("deep", "secret")]);
  for (let i = 1; i < levels; i++) node = box(`n${i}`, [node]);
  return node;
}

describe("walk and the class readers on a very deep tree", () => {
  it("walk visits the same nodes, parents and order as the recursive walk on random trees", () => {
    const rand = rng(0x5eed);
    for (let i = 0; i < 200; i++) {
      const tree = randomTree(rand);
      const a: Array<[string, string | null]> = [];
      const b: Array<[string, string | null]> = [];
      walk(tree, (n, p) => a.push([n.id, p?.id ?? null]));
      recursiveWalk(tree, (n, p) => b.push([n.id, p?.id ?? null]));
      expect(a).toEqual(b);
    }
  });

  it("liveClasses matches a recursive reading entry for entry, in insertion order", () => {
    const rand = rng(0xc1a55);
    for (let i = 0; i < 200; i++) {
      const tree = randomTree(rand);
      const want = new Map<string, DataClass>();
      recursiveWalk(tree, (n) => {
        if (n.kind !== "semantic" || n.binding?.sensitivity === undefined) return;
        want.set(
          n.binding.handle,
          strictestClass(want.get(n.binding.handle), n.binding.sensitivity) as DataClass
        );
      });
      expect([...liveClasses(tree)]).toEqual([...want]);
    }
  });

  it("walk, liveClasses and effectiveClasses survive a 50 000-deep tree (the recursive walk overflows)", () => {
    const root = spine(50_000);
    let visited = 0;
    walk(root, () => visited++);
    expect(visited).toBe(50_001);
    expect(liveClasses(root).get("h-deep")).toBe("secret");
    const exp = { root, providers: {} } as unknown as Experience;
    expect(effectiveClasses(exp).get("h-deep")).toBe("secret");
  });
});
