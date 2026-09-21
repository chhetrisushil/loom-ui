import { RendererRegistry, validateBlueprint } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { defineSemanticCatalog } from "./catalog";
import { HYDRATION_VALUES_PREFIX, compile, handleFromPath, hydrationPath } from "./compile";
import { genesis } from "./experience";
import { loomCatalogFor } from "./loomCatalog";
import {
  type ContainerNode,
  type ExperienceNode,
  MAX_TREE_DEPTH,
  type SemanticNode,
  walk,
} from "./node";
import { testCatalog } from "./testCatalog.test-support";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const sem = (id: string, type: string, extra: Partial<SemanticNode> = {}): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type,
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle: `h-${id}`, priority: "P1" },
  ...extra,
});
const root: ContainerNode = {
  id: "root",
  order: "V",
  kind: "container",
  direction: "grid",
  span: 12,
  gap: 8,
  children: [
    {
      ...sem("p99", "Metric", {
        props: { unit: "ms" },
        label: { key: "latency.p99", fallback: "p99 latency" },
      }),
      order: "A",
    },
    {
      id: "row",
      order: "B",
      kind: "container",
      direction: "row",
      span: 12,
      children: [
        sem("phase", "Status"),
        sem("top", "Collection", { props: { columns: ["db", "p99"] } }),
      ],
    },
  ],
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
// so every fixture declares one per handle its tree binds. Filtering the warn out of the
// assertions instead would have left the new check asserted nowhere.
const providersFor = (node: ExperienceNode) => {
  const out: Record<string, ReturnType<typeof providerSpec>> = {};
  walk(node, (n) => {
    if (n.kind === "semantic" && n.binding) out[n.binding.handle] = providerSpec(n.binding.handle);
  });
  return out;
};
const withRoot = (base: typeof exp, next: ContainerNode) => ({
  ...base,
  root: next,
  providers: providersFor(next),
});
const exp = {
  ...genesis({
    experienceId: "exp-1",
    intent: { objective: "Investigate checkout latency", source: "user" },
    meta,
  }),
  versionHash: "sha256:abc",
  root,
  providers: providersFor(root),
};
const opts = {
  surface: "web" as const,
  catalog: testCatalog,
  hydrationProjectionId: "hydration",
  hydrationProjectionVersion: "1.0.0",
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

describe("compile", () => {
  it("emits a loom Blueprint with node ids preserved, bindings into the hydration projection, and the pin", () => {
    const { blueprint, findings, ok } = compile(exp, opts);
    expect(ok).toBe(true);
    expect(findings).toEqual([]);
    expect(blueprint._tag).toBe("Blueprint");
    expect(blueprint.id).toBe("exp-1@sha256:abc");
    expect(blueprint.title).toBe("Investigate checkout latency");
    expect(blueprint.projections).toEqual(["hydration"]);
    expect(blueprint.projectionVersions).toEqual({ hydration: "1.0.0" });
    expect(blueprint.layout).toEqual({
      type: "grid",
      columns: 12,
      gap: 8,
      children: [
        {
          _tag: "Widget",
          id: "p99",
          kind: "MetricCard",
          title: "p99 latency",
          props: { unit: "ms", span: 6 },
          binding: { projectionId: "hydration", path: "values.h-p99" },
        },
        {
          type: "flex",
          direction: "row",
          children: [
            {
              _tag: "Widget",
              id: "phase",
              kind: "StatusBadge",
              props: { span: 6 },
              binding: { projectionId: "hydration", path: "values.h-phase" },
            },
            {
              _tag: "Widget",
              id: "top",
              kind: "DataTable",
              props: { columns: ["db", "p99"], span: 6 },
              binding: { projectionId: "hydration", path: "values.h-top" },
            },
          ],
        },
      ],
    });
  });
  it("is deterministic: two compiles over equal inputs are JSON-identical, and the artifact hash is not consulted", () => {
    const a = compile(exp, opts);
    const b = compile({ ...exp, root: { ...root, children: [...root.children] } }, opts);
    expect(JSON.stringify(a.blueprint)).toBe(JSON.stringify(b.blueprint));
  });
  it("passes loom's own validateBlueprint against the derived catalogue — span is declared, not smuggled", () => {
    const { blueprint } = compile(exp, opts);
    const report = validateBlueprint(blueprint, loomCatalogFor(testCatalog, "web").catalog);
    expect(report.ok).toBe(true);
    expect(report.widgets).toBe(3);
  });
  it("resolves a degrade chain per surface: Trend becomes a DataTable on terminal and a TimeSeries on web", () => {
    const e = withRoot(exp, {
      ...root,
      children: [sem("t", "Trend", { props: { series: ["a"] } })],
    });
    const web = compile(e, opts);
    const term = compile(e, { ...opts, surface: "terminal" });
    expect(web.ok && term.ok).toBe(true);
    const kindOf = (r: typeof web) => (r.blueprint.layout.children[0] as { kind: string }).kind;
    expect(kindOf(web)).toBe("TimeSeries");
    expect(kindOf(term)).toBe("DataTable");
    expect(web.findings).toEqual([]);
    expect(term.findings).toEqual([
      {
        code: "prop-not-rendered",
        severity: "warn",
        message: 'prop "series" of "Trend@1.0.0" is not rendered by "DataTable" on "terminal"',
        nodeId: "t",
      },
    ]);
  });
  it("sibling order follows the order key, not array position", () => {
    const e = withRoot(exp, {
      ...root,
      children: [
        { ...sem("bId", "Status"), order: "b" },
        { ...sem("aId", "Status"), order: "a" },
      ],
    });
    const r = compile(e, opts);
    expect(r.blueprint.layout.children.map((c) => (c as { id: string }).id)).toEqual([
      "aId",
      "bId",
    ]);
  });
  it("omits an unresolvable node, records the finding, and still emits the rest", () => {
    const e = withRoot(exp, {
      ...root,
      children: [
        sem("x", "Explainer", { binding: undefined }),
        sem("p99", "Metric", { props: { unit: "ms" } }),
      ],
    });
    const r = compile(e, { ...opts, surface: "terminal" });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual(["unresolvable-on-surface"]);
    expect(r.blueprint.layout.children.map((c) => (c as { id: string }).id)).toEqual(["p99"]);
  });
  it("a semantic defect surfaces as a finding and the blueprint is still produced for degradation", () => {
    const e = withRoot(exp, {
      ...root,
      children: [sem("p99", "Metric", { props: { rows: [1] } })],
    });
    const r = compile(e, opts);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual(["undeclared-prop"]);
    expect(r.blueprint.layout.children).toHaveLength(1);
  });
  it("uses resolveLabel when given and the fallback otherwise; an unlabeled node has no title", () => {
    const upper = compile(exp, { ...opts, resolveLabel: (l) => l.key.toUpperCase() });
    expect((upper.blueprint.layout.children[0] as { title?: string }).title).toBe("LATENCY.P99");
    const flex = compile(exp, opts).blueprint.layout.children[1] as {
      children: Array<{ title?: string }>;
    };
    expect(flex.children[0]?.title).toBeUndefined();
  });
  it("reports renderer coverage gaps as findings when a registry is supplied", () => {
    const reg = new RendererRegistry<string>()
      .register("MetricCard", "r")
      .register("StatusBadge", "r")
      .register("DataTable", "r"); // leaves Note and TimeSeries uncovered
    const r = compile(exp, { ...opts, registry: reg });
    expect(r.findings.map((f) => f.code)).toEqual(["renderer-coverage", "renderer-coverage"]);
    expect(r.findings.map((f) => f.message).join(" ")).toMatch(/TimeSeries/);
    expect(r.findings.map((f) => f.message).join(" ")).toMatch(/Note/);
    expect(r.ok).toBe(false);
  });
  // C1, compiler half: `JSON.stringify` walks insertion order, so two structurally equal
  // experiences whose props were written in different orders used to emit different BYTES from a
  // compiler whose headline claim is determinism.
  it("emits props in sorted key order, so props written {a,b} and {b,a} compile identically", () => {
    const withAB = withRoot(exp, {
      ...root,
      children: [sem("m", "Metric", { props: { format: "short", unit: "ms" } })],
    });
    const withBA = withRoot(exp, {
      ...root,
      children: [sem("m", "Metric", { props: { unit: "ms", format: "short" } })],
    });
    const a = compile(withAB, opts);
    const b = compile(withBA, opts);
    expect(JSON.stringify(a.blueprint)).toBe(JSON.stringify(b.blueprint));
    // sorted semantic props, then the framework-owned `span` last — a fixed position, not the
    // author's insertion order
    expect(JSON.stringify(a.blueprint)).toContain(
      '"props":{"format":"short","unit":"ms","span":6}'
    );
  });
  // I1. `validateExperience`, `normalize` and the compile walk are all recursive; the probe runs
  // before any of them, and a blueprint still comes back so a caller can degrade.
  it("reports a tree past the cap as a finding and still returns a blueprint", () => {
    const r = compile({ ...exp, root: chain(300) }, opts);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual(["tree-too-deep"]);
    expect(r.blueprint.layout.children).toEqual([]);
    expect(MAX_TREE_DEPTH).toBe(256);
  });
  it("compiles a tree under the cap", () => {
    expect(compile({ ...exp, root: chain(200) }, opts).ok).toBe(true);
  });
  // I2. loom's `Layout` has no per-child span field, so a nested container's span is dropped on
  // the floor — silently, until now.
  it("warns that a nested container's span is not rendered, and does not warn for the root", () => {
    const e = withRoot(exp, {
      ...root,
      children: [
        {
          id: "narrow",
          order: "A",
          kind: "container",
          direction: "row",
          span: 3,
          children: [sem("phase", "Status")],
        },
      ],
    });
    const r = compile(e, opts);
    expect(r.ok).toBe(true); // a warn, not an error
    expect(r.findings).toEqual([
      {
        code: "span-not-rendered",
        severity: "warn",
        message:
          'container "narrow" declares span 3, and loom\'s layouts carry no per-child span — it is not rendered',
        nodeId: "narrow",
      },
    ]);
    // the root is span 12 in this fixture; a root of any span is full-width by definition
    expect(compile(withRoot(exp, { ...root, span: 6, children: [] }), opts).findings).toEqual([]);
  });
  // I3. `validateExperience` and loom's `validateBlueprint` both see a binding on a none-binding
  // kind. Without the dedupe the composer got the same defect twice under two different codes.
  it("reports a binding on a none-binding type exactly once, semantically", () => {
    const e = withRoot(exp, { ...root, children: [sem("note", "Explainer")] });
    const r = compile(e, opts);
    expect(r.findings.map((f) => f.code)).toEqual(["unexpected-binding"]);
    expect(r.findings.map((f) => f.code)).not.toContain("loom:unexpected-binding");
  });
  it("an unpersisted experience compiles to an id marked as such", () => {
    expect(compile({ ...exp, versionHash: "" }, opts).blueprint.id).toBe("exp-1@unsealed");
  });
  it("a resolved kind with no derived contract is omitted with a finding, never emitted with unfiltered props", () => {
    const malformed = defineSemanticCatalog({
      id: "malformed",
      entries: [
        {
          name: "X",
          version: "1.0.0",
          props: ["secret"],
          binding: "none",
          surfaces: { web: { kind: "Mystery" } },
        },
      ],
    });
    const root2: ContainerNode = {
      id: "root2",
      order: "V",
      kind: "container",
      direction: "column",
      span: 12,
      children: [sem("x", "X", { props: { secret: 1 }, binding: undefined })],
    };
    const e = {
      ...genesis({ experienceId: "exp-2", intent: { objective: "test", source: "user" }, meta }),
      versionHash: "sha256:def",
      root: root2,
    };
    const r = compile(e, { ...opts, catalog: malformed });
    expect(r.ok).toBe(false);
    expect(r.blueprint.layout.children).toEqual([]);
    expect(r.findings.map((f) => f.code).sort()).toEqual([
      "kind-without-contract",
      "undeclared-kind-contract",
    ]);
    expect(JSON.stringify(r.blueprint)).not.toContain("secret");
  });
});

describe("hydrationPath / handleFromPath", () => {
  it("round-trips a handle through the binding path, both directions", () => {
    for (const handle of ["latency-p99", "a.b", "values", "x:h"]) {
      expect(handleFromPath(hydrationPath(handle))).toBe(handle);
    }
    expect(hydrationPath("h")).toBe(`${HYDRATION_VALUES_PREFIX}.h`);
  });
  it("a path this projection does not hydrate has no handle", () => {
    expect(handleFromPath("other.h")).toBeUndefined();
    expect(handleFromPath(HYDRATION_VALUES_PREFIX)).toBeUndefined(); // no separator, no handle
    expect(handleFromPath(`${HYDRATION_VALUES_PREFIX}.`)).toBeUndefined(); // empty handle
    expect(handleFromPath("")).toBeUndefined();
  });
});
