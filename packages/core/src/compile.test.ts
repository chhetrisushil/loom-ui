import {
  type Blueprint,
  type FlexLayout,
  type GridCell,
  type GridLayout,
  type Layout,
  RendererRegistry,
  type Widget,
  validateBlueprint,
} from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { defineSemanticCatalog } from "./catalog";
import {
  type CompileResult,
  HYDRATION_STATUS_PREFIX,
  HYDRATION_VALUES_PREFIX,
  compile,
  hydrationPath,
  hydrationStatusPath,
} from "./compile";
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
/** `sem` with the binding key ABSENT — under exactOptionalPropertyTypes "unbound" is a missing
 * key, never a present-and-undefined one. */
const unbound = (n: SemanticNode): SemanticNode => {
  const { binding: _binding, ...rest } = n;
  return rest;
};
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

/** A grid's children are `GridCell`s in IR 2.0.0 — every fixture rooted at `root` is a grid. */
const cells = (r: CompileResult): readonly GridCell[] =>
  (r.blueprint.layout as GridLayout).children;
const nodes = (r: CompileResult) => cells(r).map((c) => c.node);

/** Every widget in a compiled blueprint, reading grid children through their cells. */
const widgetsOf = (bp: Blueprint): Widget[] => {
  const out: Widget[] = [];
  const visit = (n: Widget | Layout): void => {
    if ("_tag" in n) {
      out.push(n);
      return;
    }
    if (n.type === "grid") for (const c of n.children) visit(c.node);
    else for (const child of n.children) visit(child);
  };
  visit(bp.layout);
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
          span: 6,
          node: {
            _tag: "Widget",
            id: "p99",
            kind: "MetricCard",
            title: "p99 latency",
            props: { unit: "ms" },
            source: { type: "Metric", version: "1.0.0" },
            binding: {
              projectionId: "hydration",
              path: "values.h-p99",
              status: { path: "status.h-p99" },
            },
          },
        },
        {
          span: 12,
          node: {
            type: "flex",
            direction: "row",
            children: [
              {
                _tag: "Widget",
                id: "phase",
                kind: "StatusBadge",
                props: {},
                source: { type: "Status", version: "1.0.0" },
                binding: {
                  projectionId: "hydration",
                  path: "values.h-phase",
                  status: { path: "status.h-phase" },
                },
              },
              {
                _tag: "Widget",
                id: "top",
                kind: "DataTable",
                props: { columns: ["db", "p99"] },
                source: { type: "Collection", version: "1.0.0" },
                binding: {
                  projectionId: "hydration",
                  path: "values.h-top",
                  status: { path: "status.h-top" },
                },
              },
            ],
          },
        },
      ],
    });
  });
  it("is deterministic: two compiles over equal inputs are JSON-identical, and the artifact hash is not consulted", () => {
    const a = compile(exp, opts);
    const b = compile({ ...exp, root: { ...root, children: [...root.children] } }, opts);
    expect(JSON.stringify(a.blueprint)).toBe(JSON.stringify(b.blueprint));
  });
  // IR 2.0.0 D1: a grid child's width is an edge from the grid to the child, so it rides in a
  // `GridCell` — never in `props`, where it was both a reserved key in every derived contract and
  // an `undeclared-prop` against loom's own catalogue.
  it("spans ride in grid cells, never in props", () => {
    const { blueprint } = compile(exp, opts);
    expect(blueprint.layout.type).toBe("grid");
    const children = (blueprint.layout as GridLayout).children;
    for (const c of children) expect("node" in c).toBe(true);
    const p99 = children.find((c) => (c.node as { id?: string }).id === "p99");
    expect(p99?.span).toBe(6);
    const widgets = widgetsOf(blueprint);
    expect(widgets).toHaveLength(3);
    for (const w of widgets) expect(Object.keys(w.props)).not.toContain("span");
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
    const widgetOf = (r: typeof web) => nodes(r)[0] as Widget;
    expect(widgetOf(web).kind).toBe("TimeSeries");
    expect(widgetOf(term).kind).toBe("DataTable");
    // IR 2.0.0 D3: `source` says what the widget STANDS FOR, and the chain that got it there.
    // On web the type resolves natively, so there is no `degradedFrom` key at all.
    expect(widgetOf(web).source).toEqual({ type: "Trend", version: "1.0.0" });
    expect(widgetOf(term).source).toEqual({
      type: "Trend",
      version: "1.0.0",
      degradedFrom: [{ type: "Collection", version: "1.0.0" }],
    });
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
    expect(nodes(r).map((c) => (c as { id: string }).id)).toEqual(["aId", "bId"]);
  });
  it("omits an unresolvable node, records the finding, and still emits the rest", () => {
    const e = withRoot(exp, {
      ...root,
      children: [unbound(sem("x", "Explainer")), sem("p99", "Metric", { props: { unit: "ms" } })],
    });
    const r = compile(e, { ...opts, surface: "terminal" });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual(["unresolvable-on-surface"]);
    expect(nodes(r).map((c) => (c as { id: string }).id)).toEqual(["p99"]);
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
    expect((nodes(upper)[0] as { title?: string }).title).toBe("LATENCY.P99");
    const flex = nodes(compile(exp, opts))[1] as {
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
  // IR 2.0.0 D4: a binding's confidentiality class is DECLARED on the artifact an audience check
  // will later read. The compiler carries it through; it enforces nothing.
  it("carries a binding's sensitivity class onto the compiled binding, and omits the key when absent", () => {
    const e = withRoot(exp, {
      ...root,
      children: [
        sem("secretMetric", "Metric", {
          props: { unit: "ms" },
          binding: { handle: "h-secret", priority: "P1", sensitivity: "sensitive" },
        }),
        sem("plainMetric", "Metric", { props: { unit: "ms" } }),
      ],
    });
    const r = compile(e, opts);
    expect(r.findings).toEqual([]);
    const byId = new Map(widgetsOf(r.blueprint).map((w) => [w.id, w] as const));
    expect(byId.get("secretMetric")?.binding).toEqual({
      projectionId: "hydration",
      path: hydrationPath("h-secret"),
      status: { path: hydrationStatusPath("h-secret") },
      sensitivity: "sensitive",
    });
    const plain = byId.get("plainMetric")?.binding;
    expect(plain).toEqual({
      projectionId: "hydration",
      path: hydrationPath("h-plainMetric"),
      status: { path: hydrationStatusPath("h-plainMetric") },
    });
    expect(plain && "sensitivity" in plain).toBe(false);
    // loom validates the class it is handed; an unknown one would be `sensitivity-unknown`.
    expect(validateBlueprint(r.blueprint, loomCatalogFor(testCatalog, "web").catalog).ok).toBe(
      true
    );
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
    // sorted semantic props, and nothing framework-owned among them — the span rides in the cell
    expect(JSON.stringify(a.blueprint)).toContain('"props":{"format":"short","unit":"ms"}');
    expect(JSON.stringify(a.blueprint)).toContain('"span":6');
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
  // I2, closed by IR 2.0.0: a nested container's span used to have nowhere to go and was
  // reported as `span-not-rendered`. A `GridCell` carries it, so the loss — and the finding —
  // are both gone.
  it("a nested container's span rides in its cell, with no span-not-rendered finding", () => {
    const e = withRoot(exp, {
      ...root,
      children: [
        {
          id: "narrow",
          order: "A",
          kind: "container",
          direction: "row",
          span: 6,
          children: [sem("phase", "Status")],
        },
      ],
    });
    const r = compile(e, opts);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(cells(r)).toHaveLength(1);
    expect(cells(r)[0]?.span).toBe(6);
    expect((cells(r)[0]?.node as { type?: string }).type).toBe("flex");
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
      children: [unbound(sem("x", "X", { props: { secret: 1 } }))],
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

describe("hydrationPath / hydrationStatusPath", () => {
  // No inverse: IR 2.0.0 puts the status channel on the artifact, so a renderer reads
  // `binding.status.path` rather than parsing a handle back out of `binding.path`.
  it("names a handle's value and status channels under distinct prefixes", () => {
    for (const handle of ["latency-p99", "a.b", "values", "x:h"]) {
      expect(hydrationPath(handle)).toBe(`${HYDRATION_VALUES_PREFIX}.${handle}`);
      expect(hydrationStatusPath(handle)).toBe(`${HYDRATION_STATUS_PREFIX}.${handle}`);
    }
    expect(HYDRATION_VALUES_PREFIX).not.toBe(HYDRATION_STATUS_PREFIX);
  });
});

describe("text props", () => {
  const textCatalog = defineSemanticCatalog({
    id: "text.v1",
    entries: [
      {
        name: "Callout",
        version: "1.0.0",
        props: ["text", "caption"],
        textProps: ["text"],
        binding: "none",
        surfaces: {
          web: { kind: "Note", props: ["text", "caption"], binding: "none" },
          // A degrade target whose contract has no "text" — the prop is dropped, not rendered.
          terminal: { degradeTo: { name: "PlainCallout", version: "1.0.0" } },
        },
      },
      {
        name: "PlainCallout",
        version: "1.0.0",
        props: [],
        binding: "none",
        surfaces: { terminal: { kind: "Note", props: [], binding: "none" } },
      },
    ],
  });
  const topts = { ...opts, catalog: textCatalog };
  const callout = (props: Record<string, unknown>) =>
    withRoot(exp, { ...root, children: [unbound(sem("c", "Callout", { props }))] });
  const widget = (r: CompileResult) => nodes(r)[0] as Widget;

  it("resolves a LocalizedText in a declared text prop through resolveLabel, like a label", () => {
    const e = callout({ text: { key: "note.intro", fallback: "Hello" } });
    const upper = compile(e, { ...topts, resolveLabel: (l) => l.key.toUpperCase() });
    expect(upper.findings).toEqual([]);
    expect(widget(upper).props.text).toBe("NOTE.INTRO");
    expect(widget(compile(e, topts)).props.text).toBe("Hello");
  });
  it("passes a plain string through, and leaves a LocalizedText in an undeclared-as-text prop untouched", () => {
    const r = compile(callout({ text: "Plain", caption: { key: "k", fallback: "f" } }), topts);
    expect(r.ok).toBe(true);
    expect(widget(r).props).toEqual({ caption: { key: "k", fallback: "f" }, text: "Plain" });
  });
  it("a compiled Blueprint never carries a message key for a text prop", () => {
    const r = compile(callout({ text: { key: "secret.key", fallback: "Shown" } }), topts);
    expect(JSON.stringify(r.blueprint)).not.toContain("secret.key");
  });
  // Deferred from Task 8's review: a text prop can be dropped by a degrade target's surface
  // contract, same as any other prop. The allow-list filter runs BEFORE `resolveText` — so a
  // dropped text prop's raw `LocalizedText` (message key included) never reaches `resolveText`,
  // let alone the emitted widget's props. This pins that ordering rather than relying on it.
  it("a text prop the degrade target drops is filtered before resolveText ever sees it: the raw LocalizedText never reaches props", () => {
    const e = callout({ text: { key: "secret.key", fallback: "Shown" } });
    const r = compile(e, { ...topts, surface: "terminal" });
    expect(r.findings).toEqual([
      {
        code: "prop-not-rendered",
        severity: "warn",
        message: 'prop "text" of "Callout@1.0.0" is not rendered by "Note" on "terminal"',
        nodeId: "c",
      },
    ]);
    expect(widget(r).props).toEqual({});
    expect(JSON.stringify(r.blueprint)).not.toContain("secret.key");
  });
});

describe("compile — placement and section titles (Blueprint IR 2.1.0, loom ADR 0098)", () => {
  const placedRoot: ContainerNode = {
    id: "root",
    order: "V",
    kind: "container",
    direction: "grid",
    span: 12,
    title: { key: "board.title", fallback: "Overview" },
    children: [
      { ...sem("b", "Metric", { span: 4, row: 1, column: 9 }), order: "A" },
      { ...sem("a", "Metric", { span: 8, row: 1, rowSpan: 2, column: 1 }), order: "B" },
      { ...sem("c", "Metric", { span: 6 }), order: "C" },
      {
        id: "sec",
        order: "D",
        kind: "container",
        direction: "row",
        span: 12,
        row: 3,
        column: 1,
        title: { key: "board.detail", fallback: "Detail" },
        children: [sem("d", "Status")],
      },
    ],
  };

  it("a cell carries exactly the grid lines its node sets; an unplaced cell carries its span only", () => {
    const r = compile(withRoot(exp, placedRoot), opts);
    expect(r.findings).toEqual([]);
    const layout = r.blueprint.layout as GridLayout;
    expect(layout.children.map(({ node: _node, ...edge }) => edge)).toStrictEqual([
      { span: 4, row: 1, column: 9 },
      { span: 8, row: 1, rowSpan: 2, column: 1 },
      { span: 6 },
      { span: 12, row: 3, column: 1 },
    ]);
  });

  it("a container's title is resolved through resolveLabel onto its compiled layout, root included", () => {
    const r = compile(withRoot(exp, placedRoot), opts);
    const layout = r.blueprint.layout as GridLayout;
    expect(layout.title).toBe("Overview");
    const detail = layout.children[3]?.node as FlexLayout;
    expect(detail.type).toBe("flex");
    expect(detail.title).toBe("Detail");
    const de = compile(withRoot(exp, placedRoot), {
      ...opts,
      resolveLabel: (l) => (l.key === "board.title" ? "Übersicht" : l.fallback),
    });
    expect((de.blueprint.layout as GridLayout).title).toBe("Übersicht");
    expect(JSON.stringify(de.blueprint)).not.toContain("board.title");
  });

  it("a title that resolves to empty text emits no title key; an untitled container emits none either", () => {
    const blank = { ...placedRoot, title: { key: "board.title", fallback: "" } };
    const layout = compile(withRoot(exp, blank), opts).blueprint.layout as GridLayout;
    expect("title" in layout).toBe(false);
    expect("title" in (compile(exp, opts).blueprint.layout as GridLayout)).toBe(false);
  });

  it("an off-grid placement is ONE finding and compiles to an unplaced cell — never loom's duplicate", () => {
    const off: ContainerNode = {
      ...placedRoot,
      children: [{ ...sem("x", "Metric", { span: 6, column: 10 }), order: "A" }],
    };
    const r = compile(withRoot(exp, off), opts);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => [f.code, f.nodeId])).toEqual([["placement-out-of-range", "x"]]);
    const cell = (r.blueprint.layout as GridLayout).children[0];
    expect(cell && Object.keys(cell).sort()).toEqual(["node", "span"]);
  });

  it("placement under a row container is reported and the child still compiles into the flex row", () => {
    const rowParent: ContainerNode = {
      ...placedRoot,
      children: [
        {
          id: "r",
          order: "A",
          kind: "container",
          direction: "row",
          span: 12,
          children: [sem("y", "Metric", { row: 1 })],
        },
      ],
    };
    const r = compile(withRoot(exp, rowParent), opts);
    expect(r.findings.map((f) => [f.code, f.nodeId])).toEqual([["placement-outside-grid", "y"]]);
    const flexRow = (r.blueprint.layout as GridLayout).children[0]?.node as FlexLayout;
    expect(flexRow.children.map((w) => ("_tag" in w ? w.id : w.type))).toEqual(["y"]);
  });
});
