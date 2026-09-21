import { describe, expect, it } from "vitest";
import { Experience, experienceArtifact, genesis } from "./experience";
import type { SemanticNode } from "./node";

const intent = { objective: "Investigate checkout latency", source: "user" as const };

describe("genesis", () => {
  it("creates an unpersisted lineage root with an empty column container", () => {
    const e = genesis({
      experienceId: "exp-1",
      intent,
      meta: { author: "alice", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" },
    });
    expect(e.versionHash).toBe("");
    expect(e.parents).toEqual([]);
    expect(e.root.kind).toBe("container");
    expect(e.root.id).toBe("root");
    expect(Experience.safeParse(e).success).toBe(true);
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
