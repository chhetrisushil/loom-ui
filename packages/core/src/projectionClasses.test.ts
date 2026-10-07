import type { Layout, Widget } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { compileFingerprint } from "./action";
import { placeholderAlias } from "./alias";
import { defineSemanticCatalog } from "./catalog";
import { compile } from "./compile";
import { type Experience, genesis } from "./experience";
import { mintVersionHash } from "./log";
import type { ContainerNode, ProjectionBinding, SemanticNode } from "./node";
import { type Operation, apply, replay } from "./operations";
import { testCatalog } from "./testCatalog.test-support";

// U2 fix round 1: a projection's class belongs to the PROJECTION (like a handle's), not to a node.
const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const catalog = defineSemanticCatalog(testCatalog);
const proj = (extra: Partial<ProjectionBinding> = {}): ProjectionBinding => ({
  id: "agent-status",
  path: "agents.a1.state",
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
const KEEP: SemanticNode = {
  id: "keep",
  order: "0",
  kind: "semantic",
  type: "Explainer",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
};
const build = (children: SemanticNode[]) => {
  const root: ContainerNode = {
    id: "root",
    order: "V",
    kind: "container",
    direction: "grid",
    span: 12,
    // A visible sibling: a root whose children are ALL restricted collapses to one bare placeholder.
    children: [KEEP, ...children],
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
const KEY = "projection-test-placeholder-key-0123456789";
const UNALIAS = new Map(["a", "b", "x", "y"].map((id) => [placeholderAlias(KEY, "e", id), id]));
const opts = {
  placeholderKey: KEY,
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
const kinds = (r: ReturnType<typeof compile>) =>
  widgets(r)
    .filter((w) => w.id !== "keep")
    .map((w) => `${UNALIAS.get(w.id) ?? w.id}:${w.kind}`);
const codes = (r: ReturnType<typeof compile>) => r.findings.map((f) => f.code);
const run = (ops: Operation[], from: Experience = build([]), o?: { allowDeclassify?: boolean }) => {
  let e = from;
  for (const op of ops) {
    const r = apply(e, op, o);
    if (!r.ok) throw new Error(`${op.type}: ${r.finding.message}`);
    e = r.value;
  }
  return e;
};
const ins = (n: SemanticNode): Operation => ({ type: "insertNode", parentId: "root", node: n });
const viewer = {};

describe("P1-a: the class is per PROJECTION, strictest over every node binding it", () => {
  it("one classified node redacts every node on that projection, and the projection is not declared", () => {
    const exp = build([pnode("a", { projection: proj({ sensitivity: "secret" }) }), pnode("b")]);
    const r = compile(exp, { ...opts, viewer });
    expect(kinds(r)).toEqual(["a:Note", "b:Note"]);
    expect(r.blueprint.projections).toEqual(["hydration"]);
    expect(JSON.stringify(r.blueprint)).not.toContain("agents.a1.state");
  });
  it("a cleared viewer sees both", () => {
    const exp = build([pnode("a", { projection: proj({ sensitivity: "secret" }) }), pnode("b")]);
    const r = compile(exp, { ...opts, viewer: { clearance: "secret" } });
    expect(kinds(r)).toEqual(["a:StatusBadge", "b:StatusBadge"]);
  });
});

describe("P1-b: the class is sticky on the Experience", () => {
  it("removing the only classified node does not declassify a later node on that projection", () => {
    const e = run([
      ins(pnode("x", { projection: proj({ sensitivity: "secret" }) })),
      { type: "removeNode", nodeId: "x" },
      ins(pnode("y")),
    ]);
    expect(e.projectionClasses).toEqual({ "agent-status": "secret" });
    expect(kinds(compile(e, { ...opts, viewer }))).toEqual(["y:Note"]);
  });
  it("moving the classified node to another projection leaves the first one classified", () => {
    const e = run([
      ins(pnode("a", { projection: proj({ sensitivity: "secret" }) })),
      {
        type: "bindProjection",
        nodeId: "a",
        projection: proj({ id: "approvals", version: "1", path: "q" }),
      },
      ins(pnode("b")),
    ]);
    expect(kinds(compile(e, { ...opts, viewer })).find((k) => k.startsWith("b:"))).toBe("b:Note");
  });
  it("a node rebound to a handle leaves its class on the projection", () => {
    const e = run([
      ins(pnode("a", { projection: proj({ sensitivity: "secret" }) })),
      { type: "bindProvider", nodeId: "a", handle: "h" },
      ins(pnode("b")),
    ]);
    expect(e.projectionClasses).toEqual({ "agent-status": "secret" });
  });
  it("an insertNode of a classified subtree is recorded", () => {
    const e = run([ins(pnode("a", { projection: proj({ sensitivity: "sensitive" }) }))]);
    expect(e.projectionClasses).toEqual({ "agent-status": "sensitive" });
  });
  it("lowering needs allowDeclassify and the explicit op", () => {
    const e = run([
      ins(pnode("a", { projection: proj({ sensitivity: "secret" }) })),
      { type: "removeNode", nodeId: "a" },
    ]);
    const denied = apply(e, { type: "declassifyProjection", projection: "agent-status" });
    expect(!denied.ok && denied.finding.code).toBe("declassify-not-allowed");
    const nested = apply(e, {
      type: "prompt",
      text: "t",
      materialized: [{ type: "declassifyProjection", projection: "agent-status" }],
    });
    expect(!nested.ok && nested.finding.code).toBe("declassify-in-prompt");
    const lowered = run([{ type: "declassifyProjection", projection: "agent-status" }], e, {
      allowDeclassify: true,
    });
    expect(lowered.projectionClasses).toBeUndefined();
    const withNode = run([ins(pnode("b"))], lowered);
    expect(kinds(compile(withNode, { ...opts, viewer }))).toEqual(["b:StatusBadge"]);
  });
  it("declassifyProjection also lowers live nodes' own class", () => {
    const e = run(
      [
        ins(pnode("a", { projection: proj({ sensitivity: "secret" }) })),
        { type: "declassifyProjection", projection: "agent-status" },
      ],
      build([]),
      { allowDeclassify: true }
    );
    expect(kinds(compile(e, { ...opts, viewer }))).toEqual(["a:StatusBadge"]);
  });
  it("hash: no key when live nodes imply every class; a residue changes it; replay is deterministic", () => {
    const live = run([ins(pnode("a", { projection: proj({ sensitivity: "secret" }) }))]);
    const plain = run([ins(pnode("a"))]);
    expect(live.projectionClasses).toBeDefined();
    const gone = run([{ type: "removeNode", nodeId: "a" }], live);
    expect(mintVersionHash(gone)).not.toBe(
      mintVersionHash(run([{ type: "removeNode", nodeId: "a" }], plain))
    );
    // live-implied: stripping the stored map must not change the hash
    const { projectionClasses: _p, ...stripped } = live;
    expect(mintVersionHash(stripped as typeof live)).toBe(mintVersionHash(live));
    const ops: Operation[] = [
      ins(pnode("a", { projection: proj({ sensitivity: "secret" }) })),
      { type: "removeNode", nodeId: "a" },
    ];
    const a = replay(build([]), ops);
    const b = replay(build([]), ops);
    if (!a.ok || !b.ok) throw new Error("replay");
    expect(mintVersionHash(a.value)).toBe(mintVersionHash(b.value));
  });
});

describe("P2-a: unknown / mismatched / restricted are indistinguishable to the viewer", () => {
  const one = (p: ProjectionBinding, v?: { clearance?: "secret" }) =>
    compile(build([pnode("a", { projection: p })]), { ...opts, viewer: v ?? viewer });
  it("all three compile to the Note placeholder", () => {
    const restricted = one(proj({ id: "approvals", version: "1" }));
    const unknown = one(proj({ id: "nope" }));
    const mismatch = one(proj({ id: "approvals", version: "999" }));
    for (const r of [restricted, unknown, mismatch]) expect(kinds(r)).toEqual(["a:Note"]);
    const blueprints = [restricted, unknown, mismatch].map((r) =>
      JSON.stringify(r.blueprint.layout)
    );
    expect(new Set(blueprints).size).toBe(1);
  });
  it("the host still gets the error findings", () => {
    expect(codes(one(proj({ id: "nope" })))).toContain("projection-unknown");
    expect(codes(one(proj({ version: "9" })))).toContain("projection-version-mismatch");
  });
  it("a viewer who may not see the class never gets the offered version in a message", () => {
    const r = one(proj({ id: "approvals", version: "999" }));
    expect(JSON.stringify(r.findings)).not.toMatch(/offers "1"/);
  });
  it("a cleared viewer may be told the offered version", () => {
    const r = one(proj({ id: "approvals", version: "999" }), { clearance: "secret" });
    expect(r.findings.find((f) => f.code === "projection-version-mismatch")?.message).toContain(
      '"1"'
    );
  });
});

describe("P2-b: duplicate catalogue ids merge, never first-wins", () => {
  it("the strictest class wins whichever order", () => {
    for (const projections of [
      [
        { id: "agent-status", version: "2" },
        { id: "agent-status", version: "2", sensitivity: "secret" as const },
      ],
      [
        { id: "agent-status", version: "2", sensitivity: "secret" as const },
        { id: "agent-status", version: "2" },
      ],
    ])
      expect(kinds(compile(build([pnode("a")]), { ...opts, projections, viewer }))).toEqual([
        "a:Note",
      ]);
  });
  it("differing versions are a finding and the projection is refused", () => {
    const r = compile(build([pnode("a")]), {
      ...opts,
      projections: [
        { id: "agent-status", version: "2" },
        { id: "agent-status", version: "3" },
      ],
      viewer: { clearance: "secret" },
    });
    expect(codes(r)).toContain("projection-catalog-conflict");
    expect(kinds(r)).toEqual(["a:Note"]);
    expect(r.blueprint.projections).toEqual(["hydration"]);
  });
});

describe("P3: the compile fingerprint covers restricted projections and catalogue versions", () => {
  it("CompileResult exposes the restricted projection nodes", () => {
    const r = compile(
      build([pnode("a", { projection: proj({ sensitivity: "secret" }) }), pnode("b")]),
      { ...opts, viewer }
    );
    expect(r.restrictedProjectionNodes).toEqual(["a", "b"]);
    expect(compile(build([pnode("a")]), { ...opts, viewer }).restrictedProjectionNodes).toEqual([]);
  });
  it("they and the declared versions move the fingerprint, only when present", () => {
    const base = compileFingerprint({ clearance: "internal" });
    expect(compileFingerprint({ clearance: "internal", restrictedProjectionNodes: [] })).toBe(base);
    expect(compileFingerprint({ clearance: "internal", projectionVersions: {} })).toBe(base);
    const a = compileFingerprint({ clearance: "internal", restrictedProjectionNodes: ["a"] });
    expect(a).not.toBe(base);
    expect(
      compileFingerprint({ clearance: "internal", restrictedProjectionNodes: ["b", "a"] })
    ).not.toBe(a);
    expect(
      compileFingerprint({ clearance: "internal", restrictedProjectionNodes: ["b", "a"] })
    ).toBe(compileFingerprint({ clearance: "internal", restrictedProjectionNodes: ["a", "b"] }));
    const v2 = compileFingerprint({ clearance: "internal", projectionVersions: { x: "2" } });
    expect(v2).not.toBe(base);
    expect(compileFingerprint({ clearance: "internal", projectionVersions: { x: "3" } })).not.toBe(
      v2
    );
  });
});

describe("minor: projection binding length caps", () => {
  it("an oversized id/path/statusPath is a projection-binding-invalid finding, never a throw", () => {
    for (const p of [
      proj({ id: "x".repeat(129) }),
      proj({ path: "x".repeat(513) }),
      proj({ statusPath: "x".repeat(513) }),
    ]) {
      const r = compile(build([pnode("a", { projection: p })]), {
        ...opts,
        projections: [...offered, { id: p.id, version: "2" }],
      });
      expect(codes(r)).toContain("projection-binding-invalid");
      expect(kinds(r)).toEqual([]);
    }
  });
});
