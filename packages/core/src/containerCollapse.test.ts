import { describe, expect, it } from "vitest";
import { compileFingerprint } from "./action";
import { describeChange, inspectExperience } from "./change";
import { type CompileResult, compile } from "./compile";
import { genesis } from "./experience";
import type { ContainerNode, ExperienceNode, SemanticNode } from "./node";
import { walk } from "./node";
import { emptyLedger, explainNode } from "./provenance";
import { testCatalog } from "./testCatalog.test-support";

// A container none of whose children a viewer may see is a BARE placeholder — its id only, exactly
// like a restricted node — on every viewer-facing path.

const meta = { author: "a", createdAt: "2026-10-07T00:00:00Z", sourceKind: "prompt" };
const sem = (id: string, sensitivity?: "secret" | "internal"): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle: `h-${id}`, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const box = (
  id: string,
  children: ExperienceNode[],
  extra: Partial<ContainerNode> = {}
): ContainerNode => ({
  id,
  order: id,
  kind: "container",
  direction: "column",
  span: 12,
  title: { key: `t.${id}`, fallback: `Title ${id}` },
  children,
  ...extra,
});
const spec = (handle: string) => ({
  handle,
  executionGraph: [],
  reshaping: { engine: "JSONPath" as const, scriptRef: "sha256:s" },
  outputShapeHash: "sha256:o",
  cachePolicy: { ttlSeconds: 60, scope: "global" as const },
});
const build = (children: ExperienceNode[], hash = "sha256:v") => {
  const root: ContainerNode = {
    id: "root",
    order: "V",
    kind: "container",
    direction: "column",
    span: 12,
    title: { key: "t.root", fallback: "Title root" },
    children,
  };
  const providers: Record<string, ReturnType<typeof spec>> = {};
  walk(root, (n) => {
    if (n.kind === "semantic" && n.binding) providers[n.binding.handle] = spec(n.binding.handle);
  });
  return {
    ...genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta }),
    versionHash: hash,
    root,
    providers,
  };
};
const opts = {
  surface: "web" as const,
  catalog: testCatalog,
  hydrationProjectionId: "hydration",
  hydrationProjectionVersion: "1.0.0",
};
const low = { clearance: "internal" as const };
const high = { clearance: "secret" as const };
const json = (r: CompileResult) => JSON.stringify(r.blueprint.layout);
const find = (r: CompileResult, id: string) => {
  let out: unknown;
  type N = { id?: string; children?: N[]; node?: N };
  const visit = (n: N): void => {
    if (n.id === id) out = n;
    for (const c of n.children ?? []) visit(c);
    if (n.node) visit(n.node);
  };
  visit(r.blueprint.layout as N);
  return out as { kind?: string; title?: string; props?: unknown; role?: string } | undefined;
};

describe("a container whose children are all restricted collapses to a bare placeholder", () => {
  const section = build([
    box("sec", [sem("a", "secret"), sem("b", "secret")], { role: "card" as never }),
    sem("pub"),
  ]);

  it("leaks no title, role, child ids or child count to a low viewer", () => {
    const r = compile(section, { ...opts, viewer: low });
    const s = json(r);
    expect(s).not.toContain("Title sec");
    expect(s).not.toContain('"a"');
    expect(s).not.toContain('"b"');
    const sec = find(r, "sec");
    expect(sec?.kind).toBe("Note"); // the restricted node's placeholder
    expect(find(r, "a")).toBeUndefined();
    expect(find(r, "pub")?.kind).toBe("MetricCard");
  });

  it("is identical in shape to a restricted node's placeholder", () => {
    const r = compile(section, { ...opts, viewer: low });
    const lone = compile(build([sem("sec", "secret"), sem("pub")]), { ...opts, viewer: low });
    expect(find(r, "sec")).toEqual(find(lone, "sec"));
  });

  it("is untouched for a viewer who may see a child", () => {
    const r = compile(section, { ...opts, viewer: high });
    expect(json(r)).toContain("Title sec");
    expect(find(r, "a")?.kind).toBe("MetricCard");
  });

  it("keeps its title when at least one descendant is visible", () => {
    const mixed = build([box("sec", [sem("a", "secret"), sem("c")])]);
    const r = compile(mixed, { ...opts, viewer: low });
    expect(json(r)).toContain("Title sec");
    expect(find(r, "a")?.kind).toBe("Note"); // still a per-child placeholder
  });

  it("collapses nested all-restricted containers bottom-up, to ONE placeholder", () => {
    const nested = build([
      box("outer", [box("inner", [sem("a", "secret")]), box("inner2", [sem("b", "secret")])]),
      sem("pub"),
    ]);
    const r = compile(nested, { ...opts, viewer: low });
    const s = json(r);
    expect(s).not.toContain("Title outer");
    expect(s).not.toContain("Title inner");
    expect(find(r, "outer")?.kind).toBe("Note");
    expect(find(r, "inner")).toBeUndefined();
    expect(find(r, "inner2")).toBeUndefined();
  });

  it("does not collapse a nested all-restricted container beside a visible sibling", () => {
    const e = build([box("outer", [box("inner", [sem("a", "secret")]), sem("c")])]);
    const r = compile(e, { ...opts, viewer: low });
    expect(json(r)).toContain("Title outer");
    expect(find(r, "inner")?.kind).toBe("Note");
  });

  it("leaves an EMPTY container as authored (nothing restricted in it)", () => {
    const e = build([box("empty", []), sem("pub")]);
    const r = compile(e, { ...opts, viewer: low });
    expect(json(r)).toContain("Title empty");
  });

  it("collapses a planner-style tabs container: the all-secret panel is a bare placeholder", () => {
    const tabs = build([
      box(
        "tabs",
        [box("p1", [sem("a", "secret")], { role: "card" as never }), box("p2", [sem("c")])],
        { role: "tabs" as never }
      ),
    ]);
    const r = compile(tabs, { ...opts, viewer: low });
    expect(json(r)).not.toContain("Title p1");
    expect(json(r)).toContain("Title p2");
    expect(find(r, "p1")?.kind).toBe("Note");
  });

  it("collapses a root whose children are all restricted to one placeholder in a plain column", () => {
    const e = build([sem("a", "secret"), sem("b", "secret")]);
    const r = compile(e, { ...opts, viewer: low });
    expect(json(r)).not.toContain("Title root");
    expect(r.blueprint.layout.type).toBe("flex");
    expect(find(r, "root")?.kind).toBe("Note");
    expect(find(r, "a")).toBeUndefined();
  });

  it("changes the fingerprint when a RAISED class collapses the container", () => {
    const e = build([box("sec", [sem("a"), sem("b")]), box("pubbox", [])]);
    const step = {
      stepId: "s",
      toolName: "tool",
      toolVersion: "1",
      toolSchemaHash: "x",
      arguments: {},
      dependsOn: [],
      idempotent: true,
    };
    const tooled = {
      ...e,
      providers: Object.fromEntries(
        Object.entries(e.providers).map(([h, p]) => [h, { ...p, executionGraph: [step] }])
      ),
    };
    const before = compile(tooled, { ...opts, viewer: low });
    const after = compile(tooled, {
      ...opts,
      viewer: low,
      declaredToolClasses: { tool: "secret" },
    });
    expect(find(before, "sec")?.title).toBe("Title sec");
    expect(find(after, "sec")?.kind).toBe("Note");
    const fp = (r: CompileResult) =>
      compileFingerprint({
        clearance: "internal",
        restrictedHandles: r.restrictedHandles,
        restrictedProjectionNodes: r.restrictedProjectionNodes,
      });
    expect(fp(after)).not.toBe(fp(before));
  });
});

describe("a collapsed container leaks nothing through the readers", () => {
  const before = build([box("sec", [sem("a", "secret")]), sem("pub")], "sha256:1");
  const after = build(
    [box("sec", [sem("a", "secret"), sem("b", "secret")]), sem("pub")],
    "sha256:2"
  );

  it("inspectExperience classifies it as its most visible child", () => {
    const i = inspectExperience(after);
    expect(i.nodes.get("sec")?.cls).toBe("secret");
    expect(i.nodes.get("root")?.cls).toBeUndefined(); // 'pub' is unclassified
    const mixed = inspectExperience(
      build([box("sec", [sem("a", "secret"), sem("c", "internal")])])
    );
    expect(mixed.nodes.get("sec")?.cls).toBe("internal");
    expect(inspectExperience(build([box("e", [])])).nodes.get("e")?.cls).toBeUndefined();
  });

  it("describeChange says only `restricted-changed` for a hidden container's addition", () => {
    const d = describeChange(
      build([sem("pub")], "sha256:0"),
      build([box("sec", [sem("a", "secret"), sem("b", "secret")]), sem("pub")], "sha256:1"),
      { viewer: low }
    );
    expect(d.entries).toEqual([{ kind: "restricted-changed" }]);
    expect(d.restricted).toBe(true);
    expect(JSON.stringify(d)).not.toContain('"sec"');
  });

  it("describeChange does not name a hidden container's removal or child edit", () => {
    const removed = describeChange(after, build([sem("pub")], "sha256:3"), { viewer: low });
    expect(removed.entries).toEqual([{ kind: "restricted-changed" }]);
    const grown = describeChange(before, after, { viewer: low });
    expect(grown.entries).toEqual([{ kind: "restricted-changed" }]);
    expect(JSON.stringify(grown)).not.toMatch(/"sec"|"a"|"b"/);
  });

  it("describeChange still names a container with a visible child", () => {
    const d = describeChange(
      build([sem("pub")], "sha256:0"),
      build([box("vis", [sem("a", "secret"), sem("c")]), sem("pub")], "sha256:1"),
      { viewer: low }
    );
    expect(d.entries.map((e) => e.kind)).toContain("node-added");
    expect(d.entries.find((e) => e.nodeId === "vis")).toBeDefined();
  });

  it("explainNode answers a bare {available:false} for a collapsed container", () => {
    const ledger = emptyLedger({
      versionHash: "sha256:2",
      at: meta.createdAt,
      by: "a",
    } as never);
    expect(explainNode(after, "sec", { viewer: low, ledger })).toEqual({ available: false });
    expect(explainNode(after, "sec", { viewer: high, ledger }).available).toBe(true);
  });
});
