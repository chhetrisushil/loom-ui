import { describe, expect, it } from "vitest";
import { validateExperience } from "./catalog";
import { declareHandle } from "./declareHandle.test-support";
import { Experience, genesis } from "./experience";
import { mintVersionHash, seal } from "./log";
import { mergeExperiences } from "./merge";
import {
  type ContainerNode,
  type ExperienceNode,
  MAX_TREE_DEPTH,
  type SemanticNode,
  compareSiblings,
  findNode,
  nodeIds,
  normalize,
} from "./node";
import { type Operation, apply } from "./operations";
import { testCatalog } from "./testCatalog.test-support";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

const meta = { author: "alice", createdAt: "2026-10-11T00:00:00Z", sourceKind: "prompt" };
const text = (key: string, fallback: string) => ({ key, fallback });

function metric(id: string, order: string, extra: Partial<SemanticNode> = {}): SemanticNode {
  return {
    id,
    order,
    kind: "semantic",
    type: "Metric",
    typeVersion: "1.0.0",
    span: 6,
    props: {},
    binding: { handle: `h-${id}`, priority: "P1" },
    ...extra,
  };
}
const row = (id: string, order: string, children: ExperienceNode[] = []): ContainerNode => ({
  id,
  order,
  kind: "container",
  direction: "row",
  span: 6,
  children,
});

function must<T>(r: { ok: true; value: T } | { ok: false }): T {
  if (!r.ok) throw new Error(`expected ok, got: ${JSON.stringify(r)}`);
  return r.value;
}
const run = (e: Experience, ...ops: Operation[]): Experience =>
  ops.reduce((cur, op) => must(apply(cur, op)), e);

/** root(grid) -> a, b (bound metrics), with their providers declared. */
function baseExperience(): Experience {
  const g = genesis({
    experienceId: "exp-1",
    intent: { objective: "Revenue overview", source: "user" },
    meta,
  });
  return run(
    g,
    declareHandle("h-a"),
    declareHandle("h-b"),
    { type: "insertNode", parentId: "root", node: metric("a", "G") },
    { type: "insertNode", parentId: "root", node: metric("b", "T") }
  );
}

const spec = (handle: string, ttl: number) => ({
  handle,
  executionGraph: [],
  reshaping: { engine: "JSONPath" as const, scriptRef: "$" },
  outputShapeHash: "",
  cachePolicy: { ttlSeconds: ttl, scope: "global" as const },
});

const kinds = (r: ReturnType<typeof mergeExperiences>) => r.conflicts.map((c) => c.kind);

// ── the classic three-plane merge cases (layout, providers, one key meaning two things) ─────

describe("mergeExperiences: layout plane", () => {
  it("merges disjoint insertions with no conflict", () => {
    const base = baseExperience();
    const ours = run(base, declareHandle("h-c"), {
      type: "insertNode",
      parentId: "root",
      node: metric("c", "Z"),
    });
    const theirs = run(base, declareHandle("h-d"), {
      type: "insertNode",
      parentId: "root",
      node: metric("d", "j"),
    });
    const m = mergeExperiences(base, ours, theirs);
    expect(m.conflicts).toEqual([]);
    expect(findNode(m.experience.root, "c")).toBeDefined();
    expect(findNode(m.experience.root, "d")).toBeDefined();
  });

  it("flags a move/move conflict when both reparent the same node differently", () => {
    const base = run(
      baseExperience(),
      { type: "insertNode", parentId: "root", node: row("c1", "Z") },
      { type: "insertNode", parentId: "root", node: row("c2", "j") }
    );
    const ours = run(base, { type: "moveNode", nodeId: "a", newParentId: "c1", newOrder: "G" });
    const theirs = run(base, { type: "moveNode", nodeId: "a", newParentId: "c2", newOrder: "G" });
    const m = mergeExperiences(base, ours, theirs);
    expect(m.conflicts.some((c) => c.kind === "move/move" && c.ref === "a")).toBe(true);
    // ours-biased: the partial still places the node, under OUR parent.
    const c1 = findNode(m.experience.root, "c1") as ContainerNode;
    expect(c1.children.map((n) => n.id)).toEqual(["a"]);
  });

  it("flags a node reordered differently within the same parent as move/move", () => {
    const base = baseExperience();
    const ours = run(base, { type: "moveNode", nodeId: "a", newParentId: "root", newOrder: "M" });
    const theirs = run(base, { type: "moveNode", nodeId: "a", newParentId: "root", newOrder: "X" });
    const m = mergeExperiences(base, ours, theirs);
    expect(m.conflicts.map((c) => [c.kind, c.ref])).toEqual([["move/move", "a"]]);
    expect((findNode(m.experience.root, "a") as SemanticNode).order).toBe("M");
    // one side reordering is clean
    expect(mergeExperiences(base, ours, base).conflicts).toEqual([]);
  });

  it("flags remove/edit and edit/edit conflicts", () => {
    const base = baseExperience();
    const removed = run(base, { type: "removeNode", nodeId: "a" });
    const edited = run(base, { type: "setProps", nodeId: "a", patch: { title: "keep me" } });
    const m1 = mergeExperiences(base, removed, edited);
    expect(m1.conflicts.some((c) => c.kind === "remove/edit" && c.ref === "a")).toBe(true);

    const ours = run(base, { type: "setProps", nodeId: "a", patch: { title: "ours" } });
    const theirs = run(base, { type: "setProps", nodeId: "a", patch: { title: "theirs" } });
    const m2 = mergeExperiences(base, ours, theirs);
    expect(m2.conflicts.some((c) => c.kind === "edit/edit" && c.ref === "a")).toBe(true);
    const a = findNode(m2.experience.root, "a") as SemanticNode;
    expect(a.props.title).toBe("ours");
  });

  it("takes a one-sided edit cleanly (no conflict), whichever side made it", () => {
    const base = baseExperience();
    const edited = run(base, { type: "setProps", nodeId: "a", patch: { title: "one side" } });
    for (const m of [mergeExperiences(base, edited, base), mergeExperiences(base, base, edited)]) {
      expect(m.conflicts).toEqual([]);
      expect((findNode(m.experience.root, "a") as SemanticNode).props.title).toBe("one side");
    }
  });

  it("a removal of an untouched node is clean; removed on both sides is clean", () => {
    const base = baseExperience();
    const removed = run(base, { type: "removeNode", nodeId: "a" });
    expect(mergeExperiences(base, removed, base).conflicts).toEqual([]);
    const m = mergeExperiences(base, removed, removed);
    expect(m.conflicts).toEqual([]);
    expect(nodeIds(m.experience.root)).toEqual(["root", "b"]);
  });
});

describe("mergeExperiences: provider plane", () => {
  it("keyed union merges disjoint handles", () => {
    const base = baseExperience();
    const ours = run(base, { type: "remapProvider", handle: "h-1", spec: spec("h-1", 30) });
    const theirs = run(base, { type: "remapProvider", handle: "h-2", spec: spec("h-2", 30) });
    const m = mergeExperiences(base, ours, theirs);
    expect(m.conflicts).toEqual([]);
    expect(Object.keys(m.experience.providers).sort()).toEqual(["h-1", "h-2", "h-a", "h-b"]);
  });

  it("conflicts when the same handle changed differently on both sides, ours wins", () => {
    const withBase = run(baseExperience(), {
      type: "remapProvider",
      handle: "h-1",
      spec: spec("h-1", 10),
    });
    const o = run(withBase, { type: "remapProvider", handle: "h-1", spec: spec("h-1", 20) });
    const t = run(withBase, { type: "remapProvider", handle: "h-1", spec: spec("h-1", 99) });
    const m = mergeExperiences(withBase, o, t);
    expect(m.conflicts.some((c) => c.plane === "provider" && c.ref === "h-1")).toBe(true);
    expect(m.experience.providers["h-1"]?.cachePolicy.ttlSeconds).toBe(20);
  });

  it("a one-sided provider change is taken; a removal of an unchanged provider is honoured", () => {
    const withBase = run(baseExperience(), {
      type: "remapProvider",
      handle: "h-1",
      spec: spec("h-1", 10),
    });
    const changed = run(withBase, { type: "remapProvider", handle: "h-1", spec: spec("h-1", 20) });
    const m = mergeExperiences(withBase, withBase, changed);
    expect(m.conflicts).toEqual([]);
    expect(m.experience.providers["h-1"]?.cachePolicy.ttlSeconds).toBe(20);
    const removed = run(withBase, { type: "removeProvider", handle: "h-1" });
    const m2 = mergeExperiences(withBase, removed, withBase);
    expect(m2.conflicts).toEqual([]);
    expect(Object.keys(m2.experience.providers)).not.toContain("h-1");
  });
});

describe("mergeExperiences: one localization key meaning two things", () => {
  /** Two branches add a node each, giving the same key different words: no id collides. */
  const branch = (base: Experience, id: string, label: ReturnType<typeof text>) =>
    run(base, declareHandle(`h-${id}`), {
      type: "insertNode",
      parentId: "root",
      node: metric(id, id === "x" ? "Z" : "j", { label }),
    });

  it("is a conflict, and says which branch said what", () => {
    const base = baseExperience();
    const ours = branch(base, "x", text("entity.customer", "Customer"));
    const theirs = branch(base, "y", text("entity.customer", "Account"));
    const m = mergeExperiences(base, ours, theirs);
    const c = m.conflicts.filter((k) => k.kind === "message/message");
    expect(c).toHaveLength(1);
    expect(c[0]?.ref).toBe("entity.customer");
    expect(c[0]?.detail).toMatch(/means two different things/);
    expect(c[0]?.detail).toContain('ours says "Customer" (x)');
    expect(c[0]?.detail).toContain('theirs says "Account" (y)');
  });

  it("is not raised when both sides agree on the words (reuse)", () => {
    const base = baseExperience();
    const m = mergeExperiences(
      base,
      branch(base, "x", text("entity.customer", "Customer")),
      branch(base, "y", text("entity.customer", "Customer"))
    );
    expect(kinds(m)).toEqual([]);
  });

  it("is not raised for different keys, however different the text", () => {
    const base = baseExperience();
    const m = mergeExperiences(
      base,
      branch(base, "x", text("dashboard.forecast", "Forecast")),
      branch(base, "y", text("dashboard.margin", "Margin"))
    );
    expect(kinds(m)).toEqual([]);
  });

  it("ignores a node with no label: nothing keyed to collide", () => {
    const base = baseExperience();
    const plain = (id: string) =>
      run(base, declareHandle(`h-${id}`), {
        type: "insertNode",
        parentId: "root",
        node: metric(id, id === "x" ? "Z" : "j"),
      });
    expect(kinds(mergeExperiences(base, plain("x"), plain("y")))).toEqual([]);
  });

  it("does not blame a branch for a use both sides already had", () => {
    const base = baseExperience();
    const customer = text("entity.customer", "Customer");
    const ours = run(base, { type: "setLabel", nodeId: "a", label: customer });
    const theirs = branch(ours, "y", text("entity.customer", "Account"));
    const m = mergeExperiences(base, ours, theirs);
    const c = m.conflicts.find((k) => k.kind === "message/message");
    expect(c?.detail).toContain("(y)");
    expect(c?.detail).not.toContain("(a)");
  });

  it("is not raised when only one side changed: a key used twice inside one side is its own state", () => {
    const base = baseExperience();
    const split = run(
      base,
      { type: "setLabel", nodeId: "a", label: text("entity.customer", "Customer") },
      { type: "setLabel", nodeId: "b", label: text("entity.customer", "Account") }
    );
    expect(mergeExperiences(base, split, base).conflicts).toEqual([]);
    expect(mergeExperiences(base, base, split).conflicts).toEqual([]);
    expect(mergeExperiences(base, split, split).conflicts).toEqual([]);
  });

  it("also reads container titles and localized values inside props", () => {
    const base = baseExperience();
    const ours = run(base, {
      type: "insertNode",
      parentId: "root",
      node: { ...row("p", "Z"), title: text("k.shared", "One") },
    });
    const theirs = run(base, declareHandle("h-q"), {
      type: "insertNode",
      parentId: "root",
      node: metric("q", "j", { props: { caption: { nested: [text("k.shared", "Two")] } } }),
    });
    const c = mergeExperiences(base, ours, theirs).conflicts.find(
      (k) => k.kind === "message/message"
    );
    expect(c?.ref).toBe("k.shared");
  });
});

// ── beyond the ported cases ──────────────────────────────────────────────────────────────────────

describe("mergeExperiences: the rest of the contract", () => {
  it("add/add: the same id added differently on both sides", () => {
    const base = baseExperience();
    const mk = (title: string) =>
      run(base, declareHandle("h-n"), {
        type: "insertNode",
        parentId: "root",
        node: metric("n", "Z", { props: { title } }),
      });
    const m = mergeExperiences(base, mk("one"), mk("two"));
    expect(m.conflicts.some((c) => c.kind === "add/add" && c.ref === "n")).toBe(true);
    expect((findNode(m.experience.root, "n") as SemanticNode).props.title).toBe("one");
    // The same node added identically is not a conflict.
    expect(mergeExperiences(base, mk("one"), mk("one")).conflicts).toEqual([]);
  });

  it("a move on one side and an edit on the other is clean (independent dimensions)", () => {
    const base = run(baseExperience(), {
      type: "insertNode",
      parentId: "root",
      node: row("c1", "Z"),
    });
    const ours = run(base, { type: "moveNode", nodeId: "a", newParentId: "c1", newOrder: "G" });
    const theirs = run(base, { type: "setProps", nodeId: "a", patch: { title: "edited" } });
    const m = mergeExperiences(base, ours, theirs);
    expect(m.conflicts).toEqual([]);
    const c1 = findNode(m.experience.root, "c1") as ContainerNode;
    expect((c1.children[0] as SemanticNode).props.title).toBe("edited");
  });

  it("orphan: a node added into a container the other side removed", () => {
    const base = run(baseExperience(), {
      type: "insertNode",
      parentId: "root",
      node: row("c1", "Z"),
    });
    const ours = run(base, { type: "removeNode", nodeId: "c1" });
    const theirs = run(base, declareHandle("h-k"), {
      type: "insertNode",
      parentId: "c1",
      node: metric("k", "G"),
    });
    const m = mergeExperiences(base, ours, theirs);
    expect(m.conflicts.some((c) => c.kind === "orphan" && c.ref === "k")).toBe(true);
    // Falls back to ours: renderable, and the partial still parses.
    expect(nodeIds(m.experience.root)).toEqual(nodeIds(ours.root));
    expect(Experience.safeParse(m.experience).success).toBe(true);
  });

  it("orphan: two moves that together make a cycle never silently drop nodes", () => {
    const base = run(
      baseExperience(),
      { type: "insertNode", parentId: "root", node: row("p", "Z") },
      { type: "insertNode", parentId: "root", node: row("q", "j") }
    );
    const ours = run(base, { type: "moveNode", nodeId: "p", newParentId: "q", newOrder: "G" });
    const theirs = run(base, { type: "moveNode", nodeId: "q", newParentId: "p", newOrder: "G" });
    const m = mergeExperiences(base, ours, theirs);
    expect(
      m.conflicts
        .filter((c) => c.kind === "orphan")
        .map((c) => c.ref)
        .sort()
    ).toEqual(["p", "q"]);
    expect(nodeIds(m.experience.root).sort()).toEqual(nodeIds(ours.root).sort());
  });

  it("intent: one-sided is taken, a real disagreement is a conflict and ours wins", () => {
    const base = baseExperience();
    const reworded = { ...base, intent: { ...base.intent, objective: "Margin overview" } };
    const m1 = mergeExperiences(base, base, reworded);
    expect(m1.conflicts).toEqual([]);
    expect(m1.experience.intent.objective).toBe("Margin overview");
    const other = { ...base, intent: { ...base.intent, objective: "Cost overview" } };
    const m2 = mergeExperiences(base, reworded, other);
    expect(m2.conflicts.map((c) => c.kind)).toEqual(["intent/intent"]);
    expect(m2.experience.intent.objective).toBe("Margin overview");
  });

  it("sticky classes are the strictest either side ever carried, and are never lowered", () => {
    const base = baseExperience();
    const ours = run(base, {
      type: "bindProvider",
      nodeId: "a",
      handle: "h-a",
      sensitivity: "internal",
    });
    const theirs = run(base, {
      type: "bindProvider",
      nodeId: "a",
      handle: "h-a",
      sensitivity: "secret",
    });
    // `theirs` then drops the node that carried it: the class outlives the node.
    const theirsGone = run(theirs, { type: "removeNode", nodeId: "a" });
    const m = mergeExperiences(base, ours, theirsGone);
    expect(m.experience.handleClasses?.["h-a"]).toBe("secret");
    const swapped = mergeExperiences(base, theirsGone, ours);
    expect(swapped.experience.handleClasses?.["h-a"]).toBe("secret");
  });

  it("vocabularyFloor is the union of both sides' types, deterministic", () => {
    const base = baseExperience();
    const f = (...names: string[]): Experience => ({
      ...base,
      vocabularyFloor: { types: names.map((name) => ({ name, version: "1.0.0" })) },
    });
    const m = mergeExperiences(base, f("Table", "Metric"), f("Chart", "Metric"));
    expect(m.experience.vocabularyFloor.types.map((t) => t.name)).toEqual([
      "Chart",
      "Metric",
      "Table",
    ]);
    const swapped = mergeExperiences(base, f("Chart", "Metric"), f("Table", "Metric"));
    expect(swapped.experience.vocabularyFloor).toEqual(m.experience.vocabularyFloor);
  });

  it("the result is an unsealed partial: no hash, no parents, ours' lineage and meta", () => {
    const base = seal(baseExperience());
    const m = mergeExperiences(base, base, base);
    expect(m.experience.versionHash).toBe("");
    expect(m.experience.parents).toEqual([]);
    expect(m.experience.experienceId).toBe("exp-1");
    expect(m.experience.meta).toEqual(base.meta);
  });

  it("never throws on a tree past the depth cap: it reports `depth` and keeps ours", () => {
    const base = baseExperience();
    let deep: ContainerNode = row("d0", "V");
    for (let i = 1; i < MAX_TREE_DEPTH + 5; i++) deep = row(`d${i}`, "V", [deep]);
    const tooDeep: Experience = { ...base, root: deep };
    const m = mergeExperiences(base, tooDeep, base);
    expect(kinds(m)).toEqual(["depth"]);
    expect(m.experience.root).toBe(tooDeep.root);
  });

  it("reports `depth` when a combination of two legal trees nests past the cap", () => {
    // ours nests a long spine under `x`; theirs moves `x` under the bottom of another long spine.
    const spine = (prefix: string, n: number, leaf?: ExperienceNode): ContainerNode => {
      let cur: ContainerNode = row(`${prefix}0`, "V", leaf ? [leaf] : []);
      for (let i = 1; i < n; i++) cur = row(`${prefix}${i}`, "V", [cur]);
      return cur;
    };
    const base: Experience = {
      ...baseExperience(),
      root: {
        ...(baseExperience().root as ContainerNode),
        children: [row("x", "A"), spine("s", 150), spine("t", 150, row("tx", "A"))],
      },
    };
    expect(treeDepthOk(base.root)).toBe(true);
    const ours = run(base, { type: "moveNode", nodeId: "x", newParentId: "s0", newOrder: "A" });
    const theirs = run(base, {
      type: "moveNode",
      nodeId: "s149",
      newParentId: "tx",
      newOrder: "A",
    });
    const m = mergeExperiences(base, ours, theirs);
    expect(kinds(m)).toContain("depth");
    expect(m.experience.root).toBe(ours.root);
  });
});

function treeDepthOk(n: ExperienceNode): boolean {
  let max = 0;
  const stack: Array<[ExperienceNode, number]> = [[n, 1]];
  for (let t = stack.pop(); t !== undefined; t = stack.pop()) {
    max = Math.max(max, t[1]);
    if (t[0].kind === "container") for (const c of t[0].children) stack.push([c, t[1] + 1]);
  }
  return max <= MAX_TREE_DEPTH;
}

// ── properties, over a seeded generator (no clock, no Math.random: a failure replays) ────────────

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function propertyBase(): Experience {
  return run(
    baseExperience(),
    {
      type: "insertNode",
      parentId: "root",
      node: row("c1", "Z", [metric("e", "G"), metric("f", "T")]),
    },
    { type: "insertNode", parentId: "root", node: row("c2", "j") },
    declareHandle("h-e"),
    declareHandle("h-f")
  );
}

/** A random edit session on `base`: `side` namespaces the ids it mints. */
function edit(base: Experience, side: string, next: () => number, steps: number): Experience {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  let cur = base;
  let fresh = 0;
  for (let i = 0; i < steps; i++) {
    const ids = nodeIds(cur.root);
    const semantics = ids.filter(
      (id) => (findNode(cur.root, id) as ExperienceNode).kind === "semantic"
    );
    const containers = ids.filter(
      (id) => (findNode(cur.root, id) as ExperienceNode).kind === "container"
    );
    const op: Operation = pick<() => Operation>([
      () => ({ type: "setProps", nodeId: pick(semantics), patch: { unit: pick(["p", "q", "r"]) } }),
      () => ({
        type: "setLabel",
        nodeId: pick(semantics),
        label: text(pick(["k.a", "k.b"]), pick(["One", "Two"])),
      }),
      () => ({ type: "removeNode", nodeId: pick(ids.filter((id) => id !== "root")) }),
      () => ({
        type: "moveNode",
        nodeId: pick(ids.filter((id) => id !== "root")),
        newParentId: pick(containers),
        newOrder: pick(["B", "H", "M", "S"]),
      }),
      () => ({
        type: "insertNode",
        parentId: pick(containers),
        // sometimes a SHARED id, so add/add is exercised
        node: metric(next() < 0.3 ? "shared" : `${side}${fresh++}`, pick(["C", "K", "W"]), {
          binding: { handle: "h-a", priority: "P1" },
        }),
      }),
    ])();
    const r = apply(cur, op);
    if (r.ok) cur = r.value;
  }
  return cur;
}

const hash = (e: Experience): string => mintVersionHash(e);

describe("mergeExperiences: properties (120 seeded cases)", () => {
  const cases = Array.from({ length: 120 }, (_, i) => i + 1);

  it("merge(b,x,x) = x and merge(b,x,b) = merge(b,b,x) = x, with no conflicts", () => {
    for (const seed of cases) {
      const next = rng(seed);
      const base = propertyBase();
      const x = edit(base, "x", next, 1 + Math.floor(next() * 6));
      for (const m of [
        mergeExperiences(base, x, x),
        mergeExperiences(base, x, base),
        mergeExperiences(base, base, x),
      ]) {
        expect(m.conflicts, `seed ${seed}`).toEqual([]);
        expect(hash(m.experience), `seed ${seed}`).toBe(hash(x));
      }
    }
  });

  it("is deterministic, never throws, and its partial always parses", () => {
    for (const seed of cases) {
      const next = rng(seed * 7919);
      const base = propertyBase();
      const x = edit(base, "x", next, 1 + Math.floor(next() * 6));
      const y = edit(base, "y", next, 1 + Math.floor(next() * 6));
      const m = mergeExperiences(base, x, y);
      expect(mergeExperiences(base, x, y), `seed ${seed}`).toEqual(m);
      const parsed = Experience.safeParse(m.experience);
      expect(parsed.success, `seed ${seed}: ${JSON.stringify(m.conflicts)}`).toBe(true);
      // every node of the result is a node one of the sides had: nothing is invented or dropped
      // silently (a dropped one is a reported conflict, never a quiet loss).
      const known = new Set([...nodeIds(x.root), ...nodeIds(y.root), ...nodeIds(base.root)]);
      for (const id of nodeIds(m.experience.root)) expect(known.has(id), `seed ${seed}`).toBe(true);
    }
  });

  it("clean merges are commutative", () => {
    let clean = 0;
    for (const seed of cases) {
      const next = rng(seed * 104729);
      const base = propertyBase();
      const x = edit(base, "x", next, 1 + Math.floor(next() * 5));
      const y = edit(base, "y", next, 1 + Math.floor(next() * 5));
      const xy = mergeExperiences(base, x, y);
      const yx = mergeExperiences(base, y, x);
      if (xy.conflicts.length === 0 && yx.conflicts.length === 0) {
        clean++;
        // Equal order keys keep the side's own position (so merge(b,x,x) = x), which is the one
        // thing a swap may change; compare with the render-boundary tie-break (by id) applied.
        const canon = (e: Experience): string =>
          hash({ ...e, root: normalize(e.root, compareSiblings) });
        expect(canon(xy.experience), `seed ${seed}`).toBe(canon(yx.experience));
      } else {
        // a conflict on one side of the swap is a conflict on the other
        expect(xy.conflicts.length === 0, `seed ${seed}`).toBe(yx.conflicts.length === 0);
      }
    }
    expect(clean).toBeGreaterThan(20); // the generator exercises the clean path, not only conflicts
  });

  it("a clean merge's tree passes validateExperience's structural checks", () => {
    for (const seed of cases) {
      const next = rng(seed * 31);
      const base = propertyBase();
      const x = edit(base, "x", next, 1 + Math.floor(next() * 4));
      const y = edit(base, "y", next, 1 + Math.floor(next() * 4));
      const m = mergeExperiences(base, x, y);
      if (m.conflicts.length > 0) continue;
      const errs = validateExperience(m.experience, testCatalog, "web").findings.filter(
        (f) => f.severity === "error"
      );
      expect(errs, `seed ${seed}`).toEqual([]);
    }
  });

  it("merging identical inputs seals to a stable hash", () => {
    const base = propertyBase();
    const x = edit(base, "x", rng(42), 5);
    const a = seal(mergeExperiences(base, x, x).experience);
    const b = seal(mergeExperiences(base, x, x).experience);
    expect(a.versionHash).toBe(b.versionHash);
    expect(a.versionHash).toBe(hash(x));
    expect(a.versionHash).toMatch(/^sha256:/);
  });
});
