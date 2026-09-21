import { describe, expect, it } from "vitest";
import {
  checkFloor,
  compareVersions,
  findEntry,
  resolveSurface,
  validateExperience,
} from "./catalog";
import { genesis } from "./experience";
import { type ContainerNode, MAX_TREE_DEPTH, type SemanticNode } from "./node";
import { testCatalog } from "./testCatalog";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const sem = (id: string, type: string, extra: Partial<SemanticNode> = {}): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type,
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  binding: { handle: `h-${id}`, priority: "P1" },
  ...extra,
});
const exp = (children: SemanticNode[]) => {
  const g = genesis({ experienceId: "e", intent: { objective: "x", source: "user" }, meta });
  return { ...g, root: { ...g.root, children } };
};
/** A left spine `levels` containers deep, built ITERATIVELY — the recursive helpers cannot. */
const chain = (levels: number): ContainerNode => {
  let out: ContainerNode = {
    id: "n0",
    order: "V",
    kind: "container",
    direction: "column",
    span: 12,
    children: [],
  };
  for (let i = 1; i < levels; i++)
    out = {
      id: `n${i}`,
      order: "V",
      kind: "container",
      direction: "column",
      span: 12,
      children: [out],
    };
  return out;
};
const codes = (r: { findings: readonly { code: string }[] }) =>
  r.findings.map((f) => f.code).sort();

describe("compareVersions / findEntry", () => {
  it("orders semver numerically and finds an entry by (name, version)", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(findEntry(testCatalog, "Metric", "1.0.0")?.name).toBe("Metric");
    expect(findEntry(testCatalog, "Metric", "2.0.0")).toBeUndefined();
  });
});

describe("resolveSurface", () => {
  it("resolves a direct kind and records the path", () => {
    const r = resolveSurface(testCatalog, "Metric", "1.0.0", "web");
    expect(r.ok && r.kind).toBe("MetricCard");
    expect(r.ok && r.via).toEqual(["Metric@1.0.0"]);
  });
  it("follows a degrade chain and records every hop", () => {
    const r = resolveSurface(testCatalog, "Trend", "1.0.0", "terminal");
    expect(r.ok && r.kind).toBe("DataTable");
    expect(r.ok && r.via).toEqual(["Trend@1.0.0", "Collection@1.0.0"]);
  });
  it("reports an unknown type, an unresolvable surface, and a degrade cycle as findings", () => {
    expect(
      !resolveSurface(testCatalog, "Nope", "1.0.0", "web").ok &&
        resolveSurface(testCatalog, "Nope", "1.0.0", "web")
    ).toMatchObject({ finding: { code: "unknown-type" } });
    expect(resolveSurface(testCatalog, "Explainer", "1.0.0", "terminal")).toMatchObject({
      ok: false,
      finding: { code: "unresolvable-on-surface" },
    });
    expect(resolveSurface(testCatalog, "Loop", "1.0.0", "web")).toMatchObject({
      ok: false,
      finding: { code: "degrade-cycle" },
    });
  });
});

describe("checkFloor", () => {
  it("passes when every floor type is present at or above its version, fails naming the missing type", () => {
    const e = exp([sem("m", "Metric")]);
    expect(
      checkFloor(e, { minVersion: "0.0.0", types: [{ name: "Metric", version: "1.0.0" }] })
    ).toEqual([]);
    const f = checkFloor(e, { minVersion: "0.0.0", types: [{ name: "Status", version: "1.0.0" }] });
    expect(f.map((x) => x.code)).toEqual(["floor-violation"]);
    expect(f[0]?.message).toMatch(/Status/);
    expect(
      checkFloor(e, { minVersion: "0.0.0", types: [{ name: "Metric", version: "2.0.0" }] }).map(
        (x) => x.code
      )
    ).toEqual(["floor-violation"]);
  });
});

describe("validateExperience", () => {
  it("passes a well-formed experience and reports its node count (the denominator)", () => {
    const r = validateExperience(exp([sem("m", "Metric"), sem("s", "Status")]), testCatalog, "web");
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.nodes).toBe(2);
  });
  it("ok over zero nodes is true but the count says so", () => {
    const r = validateExperience(exp([]), testCatalog, "web");
    expect(r.ok).toBe(true);
    expect(r.nodes).toBe(0);
  });
  it("one finding per defect: unknown type, undeclared prop, missing binding, binding on a none-binding type, duplicate id, unresolvable surface", () => {
    const r = validateExperience(
      exp([
        sem("a", "Nope"),
        sem("b", "Metric", { props: { unit: "ms", payload: [1, 2] } }),
        sem("c", "Metric", { binding: undefined }),
        sem("d", "Explainer"),
        sem("e", "Status"),
        sem("e", "Status"),
        sem("f", "Explainer", { binding: undefined }),
      ]),
      testCatalog,
      "terminal"
    );
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual([
      "duplicate-node-id",
      "missing-binding",
      "undeclared-prop",
      "unexpected-binding",
      "unknown-type",
      "unresolvable-on-surface",
      "unresolvable-on-surface",
    ]);
  });
  it("an undeclared prop is an error, not a warning — a fetched row inlined into props is an exfiltration", () => {
    const r = validateExperience(
      exp([sem("b", "Metric", { props: { rows: [{ secret: 1 }] } })]),
      testCatalog,
      "web"
    );
    expect(r.findings[0]).toMatchObject({
      code: "undeclared-prop",
      severity: "error",
      nodeId: "b",
    });
  });
  it("folds floor violations in", () => {
    const e = {
      ...exp([sem("m", "Metric")]),
      vocabularyFloor: { minVersion: "0.0.0", types: [{ name: "Status", version: "1.0.0" }] },
    };
    expect(codes(validateExperience(e, testCatalog, "web"))).toEqual(["floor-violation"]);
  });
});

describe("tree depth", () => {
  // I1. `walk` is recursive; without the iterative probe this is a RangeError thrown out of a
  // function whose entire contract is that a defect is a finding.
  it("reports a tree past the cap as a finding rather than throwing", () => {
    const e = { ...exp([]), root: chain(300) };
    const r = validateExperience(e, testCatalog, "web");
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["tree-too-deep"]);
    expect(r.findings[0]?.message).toMatch(/nests 300 levels/);
  });
  it("still validates a tree under the cap", () => {
    const e = { ...exp([]), root: chain(200) };
    expect(validateExperience(e, testCatalog, "web").ok).toBe(true);
    expect(MAX_TREE_DEPTH).toBe(256);
  });
});
