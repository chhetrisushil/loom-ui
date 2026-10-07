import type { GridLayout, Layout, Widget } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { defineSemanticCatalog } from "./catalog";
import { compile } from "./compile";
import { genesis } from "./experience";
import { experienceHandles } from "./handles";
import type { ContainerNode, SemanticNode } from "./node";
import { testCatalog } from "./testCatalog.test-support";
import { mayView, strictestClass } from "./viewer";

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
const spec = (handle: string) => ({
  handle,
  executionGraph: [],
  reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
  outputShapeHash: "sha256:o",
  cachePolicy: { ttlSeconds: 60, scope: "global" as const },
});
const build = (children: SemanticNode[], objective = "Q3 layoffs plan", sensitivity?: "secret") => {
  const root: ContainerNode = {
    id: "root",
    order: "V",
    kind: "container",
    direction: "grid",
    span: 12,
    children,
  };
  return {
    ...genesis({
      experienceId: "e",
      intent: { objective, source: "user", ...(sensitivity && { sensitivity }) },
      meta,
    }),
    versionHash: "sha256:abc",
    root,
    providers: Object.fromEntries(
      children.flatMap((c) => (c.binding ? [[c.binding.handle, spec(c.binding.handle)]] : []))
    ),
  };
};
// The shared test catalogue's `Note` declares no props; a real one declares `text`.
const noteWithText = defineSemanticCatalog({
  ...testCatalog,
  entries: testCatalog.entries.map((en) =>
    en.name === "Explainer"
      ? { ...en, surfaces: { web: { kind: "Note", props: ["text"], binding: "none" as const } } }
      : en
  ),
});
const opts = {
  surface: "web" as const,
  catalog: noteWithText,
  hydrationProjectionId: "hydration",
  hydrationProjectionVersion: "1.0.0",
};
const widgets = (r: ReturnType<typeof compile>): Widget[] => {
  const out: Widget[] = [];
  const visit = (n: Widget | Layout): void => {
    if ("_tag" in n) out.push(n);
    else if (n.type === "grid") for (const c of n.children) visit(c.node);
    else for (const c of n.children) visit(c);
  };
  visit(r.blueprint.layout);
  return out;
};

const salary = sem("salary", "Metric", {
  label: { key: "k", fallback: "Executive salaries" },
  props: { unit: "usd" },
  binding: { handle: "h-salary", priority: "P1", sensitivity: "sensitive" },
  span: 4,
  column: 3,
});
const plain = sem("plain", "Metric", { props: { unit: "ms" } });

describe("mayView", () => {
  it("orders secret > sensitive > internal; unclassified is always visible; no clearance sees nothing classified", () => {
    expect(mayView(undefined, undefined)).toBe(true);
    expect(mayView({}, undefined)).toBe(true);
    expect(mayView(undefined, "internal")).toBe(false);
    expect(mayView({}, "internal")).toBe(false);
    expect(mayView({ clearance: "internal" }, "internal")).toBe(true);
    expect(mayView({ clearance: "internal" }, "sensitive")).toBe(false);
    expect(mayView({ clearance: "sensitive" }, "internal")).toBe(true);
    expect(mayView({ clearance: "sensitive" }, "secret")).toBe(false);
    expect(mayView({ clearance: "secret" }, "secret")).toBe(true);
  });
  it("fails closed on a malformed viewer or an unknown class instead of throwing", () => {
    expect(mayView({ clearance: "root" } as never, "internal")).toBe(false);
    expect(mayView({ clearance: "secret" }, "top-secret" as never)).toBe(false);
    expect(mayView(null as never, "internal")).toBe(false);
    const hostile = {
      get clearance(): never {
        throw new Error("boom");
      },
    };
    expect(mayView(hostile, "internal")).toBe(false);
    expect(strictestClass("internal", "secret")).toBe("secret");
    expect(strictestClass(undefined, "internal")).toBe("internal");
  });
});

describe("experienceHandles carries the strictest class per handle", () => {
  it("a handle shared by an unclassified and a classified node is classified", () => {
    const shared = sem("b", "Metric", {
      binding: { handle: "h-x", priority: "P0", sensitivity: "secret" },
    });
    const open = sem("a", "Metric", { binding: { handle: "h-x", priority: "P1" } });
    const uses = experienceHandles(build([open, shared]));
    expect(uses).toHaveLength(1);
    expect(uses[0]?.sensitivity).toBe("secret");
    expect(experienceHandles(build([plain]))[0]).not.toHaveProperty("sensitivity");
  });
});

describe("compile for a viewer (U10)", () => {
  const e = build([plain, salary]);
  const restricted = compile(e, { ...opts, viewer: { clearance: "internal" } });
  const cleared = compile(e, { ...opts, viewer: { clearance: "sensitive" } });

  it("redacts a node above the viewer's clearance: no value path, props, label, type or handle survive", () => {
    const w = widgets(restricted).find((x) => x.id === "salary") as Widget;
    expect(w.kind).toBe("Note");
    expect(w.binding).toBeUndefined();
    expect(w.source).toBeUndefined();
    expect(w.props).toEqual({ text: "Restricted" });
    expect(w.title).toBe("Restricted");
    const json = JSON.stringify(restricted.blueprint);
    for (const leak of ["h-salary", "Executive salaries", "usd", "sensitive", "values.h-"].slice(
      0,
      4
    ))
      expect(json).not.toContain(leak);
  });
  it("a cleared viewer sees the node as before, with its class carried", () => {
    const w = widgets(cleared).find((x) => x.id === "salary") as Widget;
    expect(w.kind).not.toBe("Note");
    expect(w.binding?.sensitivity).toBe("sensitive");
    expect(w.title).toBe("Executive salaries");
    expect(cleared.findings).toEqual([]);
  });
  it("keeps ids, order and the grid cell stable, so nothing reflows", () => {
    const cellsOf = (r: typeof restricted) =>
      (r.blueprint.layout as GridLayout).children.map((c) => [
        (c.node as Widget).id,
        c.span,
        c.column,
      ]);
    expect(cellsOf(restricted)).toEqual(cellsOf(cleared));
    expect(cellsOf(restricted)[1]).toEqual(["salary", 4, 3]);
  });
  it("is deterministic and the blueprint validates against its own catalogue", () => {
    expect(
      JSON.stringify(compile(e, { ...opts, viewer: { clearance: "internal" } }).blueprint)
    ).toBe(JSON.stringify(restricted.blueprint));
    expect(restricted.ok).toBe(true);
    expect(restricted.findings.map((f) => f.code)).toEqual(["node-restricted"]);
    expect(restricted.findings[0]?.message).not.toContain("h-salary");
  });
  it("leaves unclassified content untouched", () => {
    const only = build([plain]);
    const a = compile(only, opts);
    const b = compile(only, { ...opts, viewer: { clearance: "secret" } });
    expect(a.findings).toEqual([]);
    expect(JSON.stringify(a.blueprint)).toBe(JSON.stringify(b.blueprint));
  });
  it("redacts every node bound to a handle the viewer may not see, even an unclassified sibling", () => {
    const sibling = sem("sib", "Metric", { binding: { handle: "h-salary", priority: "P1" } });
    // `keep` is visible: a root whose children are ALL restricted collapses to one placeholder.
    const { binding: _b, ...unbound } = sem("keep", "Explainer");
    const r = compile(build([salary, sibling, unbound]), {
      ...opts,
      viewer: { clearance: "internal" },
    });
    expect(widgets(r).map((w) => w.kind)).toEqual(["Note", "Note", "Note"]);
    expect(widgets(r).map((w) => w.id)).toEqual(["keep", "salary", "sib"]);
    expect(widgets(r).find((w) => w.id === "keep")?.props).toEqual({});
  });
  it("uses a custom restricted label through the same resolver", () => {
    const r = compile(e, {
      ...opts,
      viewer: {},
      restrictedLabel: { key: "r", fallback: "x" },
      resolveLabel: (l) => (l.key === "r" ? "Eingeschränkt" : l.fallback),
    });
    expect(widgets(r).find((w) => w.id === "salary")?.props).toEqual({ text: "Eingeschränkt" });
  });
});

describe("compile with no viewer is the most restrictive viewer (fail-closed)", () => {
  it("redacts classified nodes and says so once; unclassified nodes are unaffected", () => {
    const r = compile(build([plain, salary]), opts);
    expect(widgets(r).map((w) => w.kind)).toEqual(["MetricCard", "Note"]);
    expect(r.findings.map((f) => f.code).sort()).toEqual([
      "node-restricted",
      "viewer-not-supplied",
    ]);
    expect(r.ok).toBe(true);
  });
  it("no advisory when nothing is classified", () => {
    expect(compile(build([plain]), opts).findings).toEqual([]);
  });
});

describe("the default title does not leak a classified objective", () => {
  const classified = build([plain], "Q3 layoffs plan", "secret");
  it("is omitted for an uncleared or absent viewer, shown to a cleared one", () => {
    expect(compile(classified, opts).blueprint.title).toBe("");
    expect(
      compile(classified, { ...opts, viewer: { clearance: "sensitive" } }).blueprint.title
    ).toBe("");
    expect(JSON.stringify(compile(classified, opts).blueprint)).not.toContain("layoffs");
    expect(compile(classified, { ...opts, viewer: { clearance: "secret" } }).blueprint.title).toBe(
      "Q3 layoffs plan"
    );
    expect(compile(classified, opts).findings.map((f) => f.code)).toContain("title-restricted");
  });
  it("an explicit title override is the app's own text and wins", () => {
    expect(
      compile(classified, { ...opts, title: { key: "t", fallback: "Board" } }).blueprint.title
    ).toBe("Board");
  });
  it("an unclassified objective is the title as before, for any viewer", () => {
    const open = build([plain], "Investigate latency");
    expect(compile(open, opts).blueprint.title).toBe("Investigate latency");
  });
  it("also on the too-deep early return", () => {
    let n: ContainerNode = {
      id: "n0",
      order: "V",
      kind: "container",
      direction: "column",
      span: 12,
      children: [],
    };
    for (let i = 1; i < 200; i++)
      n = {
        id: `n${i}`,
        order: "V",
        kind: "container",
        direction: "column",
        span: 12,
        children: [n],
      };
    const deep = { ...classified, root: n, providers: {} };
    expect(compile(deep, opts).blueprint.title).toBe("");
  });
});

describe("a catalogue whose Note declares no text prop", () => {
  it("still redacts (title only) and warns, never emits an undeclared prop", () => {
    const r = compile(build([salary]), { ...opts, catalog: testCatalog, viewer: {} });
    const w = widgets(r)[0] as Widget;
    expect(w.kind).toBe("Note");
    expect(w.props).toEqual({});
    expect(w.title).toBe("Restricted");
    expect(r.findings.map((f) => f.code)).toContain("restricted-placeholder-no-text");
    expect(r.ok).toBe(true);
  });
});

describe("compile for a viewer: tool-level class at read time (U10 round 3)", () => {
  it("a sibling on a classified TOOL is redacted even though its own node is unclassified", () => {
    const onTool = (handle: string) => ({
      ...spec(handle),
      executionGraph: [
        {
          stepId: "s",
          toolName: "hr.payroll",
          toolVersion: "1",
          toolSchemaHash: "x",
          arguments: { a: handle },
          dependsOn: [],
          idempotent: true,
        },
      ],
    });
    const open = sem("open", "Metric", { binding: { handle: "h-open", priority: "P1" } });
    const secretOne = sem("secretOne", "Metric", {
      binding: { handle: "h-secret", priority: "P1", sensitivity: "secret" },
    });
    const { binding: _b, ...keep } = sem("keep", "Explainer");
    const e = {
      ...build([open, secretOne, keep]),
      providers: { "h-open": onTool("h-open"), "h-secret": onTool("h-secret") },
    };
    const r = compile(e, { ...opts, viewer: { clearance: "internal" } });
    const w = widgets(r).find((x) => x.id === "open") as Widget;
    expect(w.kind).toBe("Note");
    expect(w.binding).toBeUndefined();
    expect(JSON.stringify(r.blueprint)).not.toContain("h-open");
    // a cleared viewer still sees it
    const ok = compile(e, { ...opts, viewer: { clearance: "secret" } });
    expect((widgets(ok).find((x) => x.id === "open") as Widget).kind).not.toBe("Note");
  });
});
