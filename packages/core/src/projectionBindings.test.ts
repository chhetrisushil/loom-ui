import type { Layout, Widget } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { defineSemanticCatalog, validateExperience } from "./catalog";
import { compile } from "./compile";
import { genesis } from "./experience";
import { experienceHandles } from "./handles";
import { mintVersionHash } from "./log";
import type { ContainerNode, ProjectionBinding, SemanticNode } from "./node";
import { ExperienceNode } from "./node";
import { Operation, apply, replay } from "./operations";
import { testCatalog } from "./testCatalog.test-support";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const catalog = defineSemanticCatalog({
  ...testCatalog,
  entries: testCatalog.entries.map((en) =>
    en.name === "Explainer"
      ? { ...en, surfaces: { web: { kind: "Note", props: ["text"], binding: "none" as const } } }
      : en
  ),
});
const proj = (extra: Partial<ProjectionBinding> = {}): ProjectionBinding => ({
  id: "agent-status",
  path: "agents.a1.state",
  statusPath: "agents.a1.status",
  version: "2",
  ...extra,
});
const pnode = (id: string, extra: Partial<SemanticNode> = {}): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Status",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  projection: proj(),
  ...extra,
});
const handleNode = (id: string, binding: NonNullable<SemanticNode["binding"]>): SemanticNode => {
  const { projection: _p, ...rest } = pnode(id);
  return { ...rest, binding };
};
const build = (children: SemanticNode[]) => {
  const root: ContainerNode = {
    id: "root",
    order: "V",
    kind: "container",
    direction: "grid",
    span: 12,
    children,
  };
  return {
    ...genesis({ experienceId: "e", intent: { objective: "obj", source: "user" }, meta }),
    versionHash: "sha256:abc",
    root,
  };
};
const offered = [
  { id: "agent-status", version: "2" },
  { id: "approvals", version: "1", sensitivity: "sensitive" as const },
];
const opts = {
  surface: "web" as const,
  catalog,
  hydrationProjectionId: "hydration",
  hydrationProjectionVersion: "1.0.0",
  projections: offered,
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
const codes = (r: ReturnType<typeof compile>) => r.findings.map((f) => f.code);

describe("projection bindings: schema", () => {
  it("a node with a projection binding parses; both a missing version and an empty path are refused", () => {
    expect(ExperienceNode.safeParse(pnode("a")).success).toBe(true);
    expect(
      ExperienceNode.safeParse(pnode("a", { projection: proj({ version: "" }) })).success
    ).toBe(false);
    expect(ExperienceNode.safeParse(pnode("a", { projection: proj({ path: "" }) })).success).toBe(
      false
    );
  });
  it("a node carrying both a handle binding and a projection is a validateExperience error, never a throw", () => {
    const exp = build([pnode("a", { binding: { handle: "h", priority: "P1" } })]);
    const f = validateExperience(exp, catalog, "web").findings;
    expect(f.some((x) => x.code === "binding-conflict" && x.severity === "error")).toBe(true);
  });
  it("a projection satisfies a type that requires a binding, and is unexpected on one that takes none", () => {
    const ok = validateExperience(build([pnode("a")]), catalog, "web").findings;
    expect(ok.map((x) => x.code)).not.toContain("missing-binding");
    const bad = validateExperience(
      build([pnode("a", { type: "Explainer" })]),
      catalog,
      "web"
    ).findings;
    expect(bad.map((x) => x.code)).toContain("unexpected-binding");
  });
});

describe("projection bindings: compile", () => {
  it("emits the binding, its status channel, and declares the projection with its pinned version", () => {
    const r = compile(build([pnode("a")]), opts);
    expect(r.ok).toBe(true);
    expect(widgets(r)[0]?.binding).toEqual({
      projectionId: "agent-status",
      path: "agents.a1.state",
      status: { path: "agents.a1.status" },
    });
    expect(r.blueprint.projections).toEqual(["hydration", "agent-status"]);
    expect(r.blueprint.projectionVersions).toEqual({ hydration: "1.0.0", "agent-status": "2" });
  });
  it("omits the status channel when none is declared", () => {
    const r = compile(build([pnode("a", { projection: proj({ statusPath: undefined }) })]), opts);
    expect(widgets(r)[0]?.binding).toEqual({
      projectionId: "agent-status",
      path: "agents.a1.state",
    });
  });
  it("declares each projection once, sorted, however many nodes bind it", () => {
    const r = compile(
      build([
        pnode("a"),
        pnode("b", { projection: proj({ path: "agents.a2.state" }) }),
        pnode("c", {
          projection: proj({ id: "approvals", version: "1", sensitivity: "sensitive" }),
        }),
      ]),
      { ...opts, viewer: { clearance: "secret" } }
    );
    expect(r.blueprint.projections).toEqual(["hydration", "agent-status", "approvals"]);
  });
  it("an unknown projection is a finding and the node compiles to the restricted placeholder, never faked", () => {
    const r = compile(build([pnode("a", { projection: proj({ id: "nope" }) })]), opts);
    expect(codes(r)).toContain("projection-unknown");
    expect(r.ok).toBe(false);
    expect(widgets(r).map((w) => w.kind)).toEqual(["Note"]);
    expect(widgets(r)[0]?.binding).toBeUndefined();
    expect(r.blueprint.projections).toEqual(["hydration"]);
  });
  it("no catalogue offers nothing (fail-closed)", () => {
    const { projections: _p, ...bare } = opts;
    const r = compile(build([pnode("a")]), bare);
    expect(codes(r)).toContain("projection-unknown");
    expect(widgets(r).map((w) => w.kind)).toEqual(["Note"]);
  });
  it("a pin that differs from the offered version is projection-version-mismatch", () => {
    const r = compile(build([pnode("a", { projection: proj({ version: "1" }) })]), opts);
    expect(codes(r)).toContain("projection-version-mismatch");
    expect(widgets(r).map((w) => w.kind)).toEqual(["Note"]);
  });
  it("binding the hydration projection through `projection` is refused", () => {
    const r = compile(
      build([pnode("a", { projection: proj({ id: "hydration", version: "1.0.0" }) })]),
      { ...opts, projections: [...offered, { id: "hydration", version: "1.0.0" }] }
    );
    expect(codes(r)).toContain("projection-reserved");
    expect(widgets(r)).toHaveLength(0);
  });
  it("a hostile projection id cannot reach the prototype", () => {
    const r = compile(
      build([pnode("a", { projection: proj({ id: "__proto__", version: "1" }) })]),
      { ...opts, projections: [{ id: "__proto__", version: "1" }] }
    );
    // `__proto__` is a reserved projection id: the node is refused, nothing is declared.
    expect(Object.hasOwn(r.blueprint.projectionVersions ?? {}, "__proto__")).toBe(false);
    expect(r.blueprint.projections).toEqual(["hydration"]);
    expect(({} as Record<string, unknown>).version).toBeUndefined();
  });
  it("a handle-and-projection node is omitted with a binding-conflict finding", () => {
    const r = compile(build([pnode("a", { binding: { handle: "h", priority: "P1" } })]), opts);
    expect(codes(r)).toContain("binding-conflict");
    expect(widgets(r)).toHaveLength(0);
  });
  it("an experience with no projection bindings compiles exactly as before (no extra declarations)", () => {
    const r = compile(build([]), opts);
    expect(r.blueprint.projections).toEqual(["hydration"]);
    expect(r.blueprint.projectionVersions).toEqual({ hydration: "1.0.0" });
  });
  it("the compiled blueprint passes loom's own validation (the projection is declared)", () => {
    const r = compile(build([pnode("a")]), opts);
    expect(codes(r).filter((c) => c.startsWith("loom:"))).toEqual([]);
  });
});

describe("projection bindings: viewer redaction", () => {
  const classified = pnode("q", {
    projection: proj({ id: "approvals", path: "queue", statusPath: undefined, version: "1" }),
  });
  it("a catalogue-classified projection is redacted for a viewer without clearance, leaking nothing", () => {
    const r = compile(build([classified]), { ...opts, viewer: { clearance: "internal" } });
    const w = widgets(r);
    expect(w).toHaveLength(1);
    expect(w[0]?.kind).toBe("Note");
    expect(w[0]?.binding).toBeUndefined();
    expect(codes(r)).toContain("node-restricted");
    expect(JSON.stringify(r.blueprint)).not.toContain("approvals");
    expect(r.blueprint.projections).toEqual(["hydration"]);
    expect(r.blueprint.projectionVersions).toEqual({ hydration: "1.0.0" });
  });
  it("no viewer is the most restrictive viewer, with one viewer-not-supplied warn", () => {
    const r = compile(build([classified]), opts);
    expect(widgets(r)[0]?.kind).toBe("Note");
    expect(codes(r).filter((c) => c === "viewer-not-supplied")).toHaveLength(1);
  });
  it("a cleared viewer sees it, and the class rides on the binding", () => {
    const r = compile(build([classified]), { ...opts, viewer: { clearance: "sensitive" } });
    expect(widgets(r)[0]?.binding?.sensitivity).toBe("sensitive");
    expect(r.blueprint.projections).toContain("approvals");
  });
  it("the node's own declared class can raise, never lower, the catalogue's", () => {
    const own = pnode("q", { projection: proj({ sensitivity: "secret" }) });
    const r = compile(build([own]), { ...opts, viewer: { clearance: "sensitive" } });
    expect(widgets(r)[0]?.kind).toBe("Note");
    const lowered = compile(build([classified]), {
      ...opts,
      projections: [{ id: "approvals", version: "1", sensitivity: "secret" }],
      viewer: { clearance: "sensitive" },
    });
    expect(widgets(lowered)[0]?.kind).toBe("Note");
  });
  it("an unknown projection looks exactly like a restricted one (the placeholder), so it cannot be probed", () => {
    const r = compile(build([pnode("a", { projection: proj({ id: "secret-thing" }) })]), {
      ...opts,
      viewer: { clearance: "internal" },
    });
    expect(widgets(r).map((w) => w.kind)).toEqual(["Note"]);
  });
  it("hydration never sees a projection-bound node: it contributes no handle", () => {
    const exp = build([
      pnode("a"),
      pnode("q", { projection: proj({ id: "approvals", version: "1" }) }),
    ]);
    expect(experienceHandles(exp)).toEqual([]);
  });
});

describe("projection bindings: operations and content addresses", () => {
  const base = build([handleNode("a", { handle: "h", priority: "P1" })]);
  it("bindProjection swaps a handle binding for a projection, keeping the handle's sticky class", () => {
    const classedBase = {
      ...base,
      root: {
        ...base.root,
        children: [handleNode("a", { handle: "h", priority: "P1", sensitivity: "secret" })],
      },
    } as typeof base;
    const r = apply(classedBase, { type: "bindProjection", nodeId: "a", projection: proj() });
    if (!r.ok) throw new Error(r.finding.message);
    const n = (r.value.root as ContainerNode).children[0] as SemanticNode;
    expect(n.binding).toBeUndefined();
    expect(n.projection?.id).toBe("agent-status");
    expect(n.projection?.sensitivity).toBe("secret");
    expect(r.value.handleClasses).toEqual({ h: "secret" });
  });
  it("re-binding a classified projection cannot declassify it", () => {
    const b1 = apply(base, {
      type: "bindProjection",
      nodeId: "a",
      projection: proj({ sensitivity: "sensitive" }),
    });
    if (!b1.ok) throw new Error("b1");
    const b2 = apply(b1.value, { type: "bindProjection", nodeId: "a", projection: proj() });
    if (!b2.ok) throw new Error("b2");
    expect(
      ((b2.value.root as ContainerNode).children[0] as SemanticNode).projection?.sensitivity
    ).toBe("sensitive");
    const b3 = apply(b2.value, { type: "bindProvider", nodeId: "a", handle: "h2" });
    if (!b3.ok) throw new Error("b3");
    const n = (b3.value.root as ContainerNode).children[0] as SemanticNode;
    expect(n.projection).toBeUndefined();
    expect(n.binding?.sensitivity).toBe("sensitive");
  });
  it("refuses a missing node, a container, and a malformed op without throwing", () => {
    const missing = apply(base, { type: "bindProjection", nodeId: "zz", projection: proj() });
    expect(!missing.ok && missing.finding.code).toBe("missing-node");
    const container = apply(base, { type: "bindProjection", nodeId: "root", projection: proj() });
    expect(!container.ok && container.finding.code).toBe("not-semantic");
    expect(
      Operation.safeParse({ type: "bindProjection", nodeId: "a", projection: {} }).success
    ).toBe(false);
  });
  it("replays deterministically", () => {
    const ops: Operation[] = [{ type: "bindProjection", nodeId: "a", projection: proj() }];
    const a = replay(base, ops);
    const b = replay(base, ops);
    if (!a.ok || !b.ok) throw new Error("replay");
    expect(mintVersionHash(a.value)).toBe(mintVersionHash(b.value));
  });
  it("an experience with no projection binding hashes exactly as before: no key is added", () => {
    // Same pinned literal as hashStability.test.ts's folded experience would assert; here the
    // direct claim is that the schema adds nothing to a node that has no projection.
    const parsed = ExperienceNode.parse({ ...base.root.children?.[0] });
    expect(Object.keys(parsed)).not.toContain("projection");
  });
});
