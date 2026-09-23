import { describe, expect, it } from "vitest";
import { Experience, ProviderSpec, experienceArtifact, genesis } from "./experience";
import { mintVersionHash, seal } from "./log";
import { type ContainerNode, MAX_TREE_DEPTH, type SemanticNode } from "./node";

const intent = { objective: "Investigate checkout latency", source: "user" as const };

describe("genesis", () => {
  it("creates an unpersisted lineage root with an empty 12-column grid container, so a child's span means what the planner promised", () => {
    const e = genesis({
      experienceId: "exp-1",
      intent,
      meta: { author: "alice", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" },
    });
    expect(e.versionHash).toBe("");
    expect(e.parents).toEqual([]);
    expect(e.root.kind).toBe("container");
    expect(e.root.id).toBe("root");
    if (e.root.kind !== "container") throw new Error("expected a container root");
    expect(e.root.direction).toBe("grid");
    expect(e.root.span).toBe(12);
    expect(e.root.children).toEqual([]);
    expect(Experience.safeParse(e).success).toBe(true);
  });
});

describe("genesis depth cap", () => {
  // I1. Every other entry point refuses a too-deep tree with a finding; `genesis` is handed a
  // tree the caller just built, so admitting it would seed a lineage nothing downstream accepts.
  it("throws when the supplied root nests past the cap", () => {
    let deep: ContainerNode = {
      id: "n0",
      order: "V",
      kind: "container",
      direction: "column",
      span: 12,
      children: [],
    };
    for (let i = 1; i <= MAX_TREE_DEPTH; i++)
      deep = {
        id: `n${i}`,
        order: "V",
        kind: "container",
        direction: "column",
        span: 12,
        children: [deep],
      };
    expect(() =>
      genesis({
        experienceId: "exp-1",
        intent,
        meta: { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" },
        root: deep,
      })
    ).toThrow(/over the 256 limit/);
  });
});

describe("experienceArtifact", () => {
  const base = genesis({
    experienceId: "exp-1",
    intent,
    meta: { author: "alice", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" },
  });
  it("excludes versionHash and meta, so authorship never changes identity", () => {
    const a = experienceArtifact(base) as Record<string, unknown>;
    expect("versionHash" in a).toBe(false);
    expect("meta" in a).toBe(false);
    expect(experienceArtifact({ ...base, meta: { ...base.meta, author: "bob" } })).toEqual(a);
  });
  it("includes intent and parents (sorted), so a re-edit-back is a distinct node in the graph", () => {
    const a = experienceArtifact({ ...base, parents: ["sha256:b", "sha256:a"] }) as {
      parents: string[];
    };
    expect(a.parents).toEqual(["sha256:a", "sha256:b"]);
    expect(experienceArtifact({ ...base, intent: { ...intent, objective: "other" } })).not.toEqual(
      experienceArtifact(base)
    );
  });
  it("normalizes child order, so two trees with the same nodes in different array order collide", () => {
    const n = (id: string, order: string): SemanticNode => ({
      id,
      order,
      kind: "semantic",
      type: "Metric",
      typeVersion: "1.0.0",
      span: 4,
      props: {},
    });
    const x = { ...base, root: { ...base.root, children: [n("a", "a"), n("b", "b")] } };
    const y = { ...base, root: { ...base.root, children: [n("b", "b"), n("a", "a")] } };
    expect(experienceArtifact(x)).toEqual(experienceArtifact(y));
  });
});

describe("placement and titles in the content address (Blueprint IR 2.1.0)", () => {
  const g = genesis({
    experienceId: "exp-hash-pin",
    intent: { objective: "Pin", source: "user" },
    meta: { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" },
  });
  const m: SemanticNode = {
    id: "m",
    order: "A",
    kind: "semantic",
    type: "Metric",
    typeVersion: "1.0.0",
    span: 4,
    props: {},
  };
  const c: ContainerNode = {
    id: "c",
    order: "B",
    kind: "container",
    direction: "row",
    span: 8,
    children: [],
  };
  const plain = { ...g, root: { ...g.root, children: [m, c] } };

  it("an experience that sets none of the new fields keeps the address it had before they existed", () => {
    // Minted at loom-ui e0ed543, before nodes could carry placement or a title. Absent optional
    // fields must add no keys to the hashed artifact, or every stored experience would re-address.
    expect(mintVersionHash(plain)).toBe(
      "sha256:0d5b685ab8b2cc4b2ebad096fe63c5e05666903635489ab346133b6e8284b76a"
    );
  });

  it("placement and a title are part of the address, and seal keeps them", () => {
    const placed = {
      ...g,
      root: {
        ...g.root,
        children: [
          { ...m, row: 1, column: 1 },
          { ...c, title: { key: "c.title", fallback: "C" } },
        ],
      },
    };
    expect(mintVersionHash(placed)).not.toBe(mintVersionHash(plain));
    const root = seal(placed).root as ContainerNode;
    expect(root.children[0]).toMatchObject({ row: 1, column: 1 });
    expect(root.children[1]).toMatchObject({ title: { key: "c.title", fallback: "C" } });
  });
});

// A provider exactly as every Experience stored before slice 6 spelled it. The schema may only
// GROW by optional, default-less fields: parse must hand back exactly this object (no key added,
// none removed), because `mintVersionHash` hashes the PARSED providers — a default would re-key
// every sealed Experience.
const legacyStep = {
  stepId: "s",
  toolName: "readings.current",
  toolVersion: "1.0.0",
  toolSchemaHash: "sha256:pin",
  arguments: { station: "ridge" },
  dependsOn: [],
  idempotent: true,
};
const legacy = {
  handle: "h",
  executionGraph: [legacyStep],
  reshaping: { engine: "JSONPath", scriptRef: "" },
  outputShapeHash: "",
  cachePolicy: { ttlSeconds: 60, scope: "global" },
};

describe("ProviderSpec grows additively", () => {
  it("a provider written before the new fields parses to exactly itself, so its hash is unchanged", () => {
    expect(ProviderSpec.parse(legacy)).toStrictEqual(legacy);
  });

  it("accepts outputCheck 'contract' and 'shape', and refuses anything else", () => {
    expect(ProviderSpec.parse({ ...legacy, outputCheck: "contract" })).toStrictEqual({
      ...legacy,
      outputCheck: "contract",
    });
    expect(ProviderSpec.parse({ ...legacy, outputCheck: "shape" }).outputCheck).toBe("shape");
    expect(ProviderSpec.safeParse({ ...legacy, outputCheck: "exact" }).success).toBe(false);
  });
});
