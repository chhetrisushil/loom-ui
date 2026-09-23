import { describe, expect, it } from "vitest";
import {
  checkFloor,
  compareVersions,
  defineSemanticCatalog,
  findEntry,
  resolveSurface,
  validateExperience,
} from "./catalog";
import { type Experience, genesis } from "./experience";
import { type ContainerNode, MAX_TREE_DEPTH, type SemanticNode } from "./node";
import { testCatalog } from "./testCatalog.test-support";

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
/** `sem` with the binding key ABSENT — under exactOptionalPropertyTypes "unbound" is a missing
 * key, never a present-and-undefined one. */
const unbound = (n: SemanticNode): SemanticNode => {
  const { binding: _binding, ...rest } = n;
  return rest;
};
/** The minimal `ProviderSpec` a bound handle needs to exist. */
const providerSpec = (handle: string) => ({
  handle,
  executionGraph: [],
  reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
  outputShapeHash: "sha256:o",
  cachePolicy: { ttlSeconds: 60, scope: "global" as const },
});
// Fixture adjustment (I5): a bound handle with no `ProviderSpec` is now an `unknown-handle` warn,
// so these experiences declare a provider per handle their nodes bind. Filtering the warn out of
// the assertions instead would have left the new check asserted nowhere.
const exp = (children: SemanticNode[]) => {
  const g = genesis({ experienceId: "e", intent: { objective: "x", source: "user" }, meta });
  const providers: Record<string, ReturnType<typeof providerSpec>> = {};
  for (const c of children)
    if (c.binding) providers[c.binding.handle] = providerSpec(c.binding.handle);
  return { ...g, root: { ...g.root, children }, providers };
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
    // A non-numeric segment used to produce NaN, and `NaN < 0` and `NaN > 0` are BOTH false — so
    // `checkFloor` read a prerelease as satisfying a floor it does not meet.
    expect(Number.isFinite(compareVersions("1.0.0-beta", "1.0.0"))).toBe(true);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-beta")).toBe(0);
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
    expect(checkFloor(e, { types: [{ name: "Metric", version: "1.0.0" }] })).toEqual([]);
    const f = checkFloor(e, { types: [{ name: "Status", version: "1.0.0" }] });
    expect(f.map((x) => x.code)).toEqual(["floor-violation"]);
    expect(f[0]?.message).toMatch(/Status/);
    expect(
      checkFloor(e, { types: [{ name: "Metric", version: "2.0.0" }] }).map((x) => x.code)
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
        unbound(sem("c", "Metric")),
        sem("d", "Explainer"),
        sem("e", "Status"),
        sem("e", "Status"),
        unbound(sem("f", "Explainer")),
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
  // I5. A handle with no `ProviderSpec` renders a permanently empty widget and explains nothing.
  it("warns on a binding to a handle the experience does not provide, without failing it", () => {
    const e = exp([sem("m", "Metric")]);
    const r = validateExperience({ ...e, providers: {} }, testCatalog, "web");
    expect(r.ok).toBe(true); // a warn, not an error
    expect(r.findings).toEqual([
      {
        code: "unknown-handle",
        severity: "warn",
        message: '"m" binds handle "h-m", which this experience does not provide',
        nodeId: "m",
      },
    ]);
    expect(validateExperience(e, testCatalog, "web").findings).toEqual([]);
  });
  it("reads providers as an own-property map, so a handle named __proto__ is still reported", () => {
    const e = exp([sem("m", "Metric", { binding: { handle: "__proto__", priority: "P1" } })]);
    const r = validateExperience({ ...e, providers: {} }, testCatalog, "web");
    expect(r.findings.map((f) => f.code)).toEqual(["unknown-handle"]);
  });
  it("folds floor violations in", () => {
    const e = {
      ...exp([sem("m", "Metric")]),
      vocabularyFloor: { types: [{ name: "Status", version: "1.0.0" }] },
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

describe("text props", () => {
  const textCatalog = defineSemanticCatalog({
    id: "text.v1",
    entries: [
      {
        name: "Callout",
        version: "1.0.0",
        props: ["text"],
        textProps: ["text"],
        binding: "none",
        surfaces: { web: { kind: "Note", props: ["text"], binding: "none" } },
      },
    ],
  });
  const callout = (text: unknown) => unbound(sem("c", "Callout", { props: { text } }));
  it("accepts a string or a LocalizedText", () => {
    for (const text of ["Plain", { key: "k", fallback: "f" }])
      expect(validateExperience(exp([callout(text)]), textCatalog, "web").findings).toEqual([]);
  });
  it("refuses anything else in a text prop as text-prop-shape", () => {
    for (const text of [7, { key: "k" }, ["a"]]) {
      const v = validateExperience(exp([callout(text)]), textCatalog, "web");
      expect(v.ok).toBe(false);
      expect(v.findings).toEqual([
        expect.objectContaining({ code: "text-prop-shape", severity: "error", nodeId: "c" }),
      ]);
    }
  });
});

describe("validateExperience — placement (Blueprint IR 2.1.0)", () => {
  const codes = (e: Experience) =>
    validateExperience(e, testCatalog, "web").findings.map((f) => [f.code, f.nodeId]);

  it("accepts placements that fit the 12-column grid, rowSpan included", () => {
    const e = exp([
      sem("a", "Metric", { span: 8, row: 1, rowSpan: 2, column: 1 }),
      sem("b", "Metric", { span: 4, row: 1, column: 9 }),
      sem("c", "Metric", { span: 4 }),
    ]);
    expect(validateExperience(e, testCatalog, "web").findings).toEqual([]);
  });

  it("reports an off-grid placement once per node, with loom's wording", () => {
    const e = exp([
      sem("over", "Metric", { span: 4, column: 10 }),
      sem("wide", "Metric", { column: 13 }),
      sem("rows", "Metric", { row: 0, rowSpan: 1.5 }),
    ]);
    const findings = validateExperience(e, testCatalog, "web").findings;
    expect(findings.map((f) => [f.code, f.nodeId, f.severity])).toEqual([
      ["placement-out-of-range", "over", "error"],
      ["placement-out-of-range", "wide", "error"],
      ["placement-out-of-range", "rows", "error"],
    ]);
    expect(findings[0]?.message).toMatch(/column 10 \+ span 4 overflows the 12-column grid/);
    expect(findings[1]?.message).toMatch(/column 13 is outside 1\.\.12/);
    expect(findings[2]?.message).toMatch(/row 0 .*; rowSpan 1\.5/);
  });

  it("reports placement on a node whose parent is not a grid, and on the root", () => {
    const base = exp([]);
    const row: ContainerNode = {
      id: "r",
      order: "B",
      kind: "container",
      direction: "row",
      span: 12,
      children: [sem("m", "Metric", { row: 1, column: 1 })],
    };
    const nested = {
      ...base,
      root: { ...base.root, children: [row] },
      providers: { "h-m": providerSpec("h-m") },
    };
    expect(codes(nested)).toEqual([["placement-outside-grid", "m"]]);
    expect(validateExperience(nested, testCatalog, "web").findings[0]?.message).toMatch(
      /"r" is a row/
    );
    const placedRoot = { ...base, root: { ...base.root, row: 1 } };
    expect(codes(placedRoot)).toEqual([["placement-outside-grid", "root"]]);
  });

  it("checks a placed CONTAINER under a grid like any other node", () => {
    const base = exp([]);
    const section: ContainerNode = {
      id: "sec",
      order: "B",
      kind: "container",
      direction: "column",
      span: 6,
      column: 9,
      title: { key: "sec.title", fallback: "Section" },
      children: [],
    };
    const withSection = { ...base, root: { ...base.root, children: [section] } };
    expect(codes(withSection)).toEqual([["placement-out-of-range", "sec"]]);
    const shifted = {
      ...base,
      root: { ...base.root, children: [{ ...section, column: 7 }] },
    };
    expect(codes(shifted)).toEqual([]);
  });
});

describe("validateExperience — layout roles (Blueprint IR 2.2.0, loom ADR 0099 D4)", () => {
  const withRole = (role: unknown): Experience => {
    const base = exp([]);
    const section = {
      id: "sec",
      order: "B",
      kind: "container",
      direction: "column",
      span: 12,
      role,
      children: [],
    } as unknown as ContainerNode;
    return { ...base, root: { ...(base.root as ContainerNode), children: [section] } };
  };

  it("a well-formed role — known to some renderer or not — is no finding", () => {
    for (const role of ["stepped", "a", "x".repeat(64), "a--b"])
      expect(validateExperience(withRole(role), testCatalog, "web").findings, role).toEqual([]);
  });

  it("a malformed role is loom's role-invalid, a WARN against the container — ok stays true", () => {
    for (const role of ["", "Stepped", "step_one", "stepped\n", "x".repeat(65), 7]) {
      const v = validateExperience(withRole(role), testCatalog, "web");
      expect(v.ok).toBe(true);
      expect(v.findings).toEqual([
        expect.objectContaining({ code: "role-invalid", severity: "warn", nodeId: "sec" }),
      ]);
    }
  });

  it("the message echoes a hostile role bounded, with its length", () => {
    const huge = "Q".repeat(10_000);
    const [f] = validateExperience(withRole(huge), testCatalog, "web").findings;
    expect(f?.message.length).toBeLessThan(400);
    expect(f?.message).toContain("10000");
  });
});
