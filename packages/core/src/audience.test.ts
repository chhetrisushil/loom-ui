import { type Layout, type Widget, validateBlueprint } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { compileFingerprint } from "./action";
import { defineSemanticCatalog } from "./catalog";
import { describeChange } from "./change";
import { compile } from "./compile";
import { createCompileMemo } from "./compileMemo";
import { genesis } from "./experience";
import { loomCatalogFor } from "./loomCatalog";
import type { ContainerNode, SemanticNode } from "./node";
import type { Operation, RecordedOperation } from "./operations";
import { emptyLedger, explainNode, foldProvenance } from "./provenance";
import { redactSeen, snapshotSeen } from "./seen";
import { testCatalog } from "./testCatalog.test-support";
import { effectiveViewer, isBroadcast } from "./viewer";

// ── Audience (slice 7) ─────────────────────────────────────────────────────────
// `audience: "broadcast"` is the least-privileged ceiling for a surface many viewers see. A node
// withheld on it compiles to loom's IR 2.5.0 redacted widget, and NOTHING of the node survives.

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const KEY = "audience-test-placeholder-key-0123456789";
const catalog = defineSemanticCatalog({
  ...testCatalog,
  entries: testCatalog.entries.map((en) =>
    en.name === "Explainer"
      ? { ...en, surfaces: { web: { kind: "Note", props: ["text"], binding: "none" as const } } }
      : en
  ),
});
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
const grid = (
  id: string,
  children: ContainerNode["children"],
  extra: Partial<ContainerNode> = {}
) =>
  ({
    id,
    order: id,
    kind: "container",
    direction: "grid",
    span: 12,
    children,
    ...extra,
  }) as ContainerNode;
const build = (children: ContainerNode["children"], sensitivity?: "secret") => {
  const root = grid("root", children);
  const handles: string[] = [];
  const visit = (n: ContainerNode["children"][number]): void => {
    if (n.kind === "container") n.children.forEach(visit);
    else if (n.binding) handles.push(n.binding.handle);
  };
  children.forEach(visit);
  return {
    ...genesis({
      experienceId: "e",
      intent: {
        objective: "Wallboard objective",
        source: "user",
        ...(sensitivity && { sensitivity }),
      },
      meta,
    }),
    versionHash: "sha256:abc",
    root,
    providers: Object.fromEntries(handles.map((h) => [h, spec(h)])),
  };
};
const opts = {
  surface: "web" as const,
  catalog,
  hydrationProjectionId: "hydration",
  hydrationProjectionVersion: "1.0.0",
  placeholderKey: KEY,
  memo: false as const,
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

// The hidden node is the ONLY Status, with a label, handle, prop-free kind and id found nowhere else,
// so a leak of any of them is a grep over the result.
const secretNode = sem("payroll", "Status", {
  label: { key: "k.payroll", fallback: "Executive payroll" },
  span: 4,
  column: 3,
  binding: { handle: "h-payroll", priority: "P0", sensitivity: "secret" },
});
const plainNode = sem("latency", "Metric", {
  label: { key: "k.latency", fallback: "Latency" },
  props: { unit: "ms" },
});
const exp = build([plainNode, secretNode]);
const LEAKS = ["payroll", "Executive", "StatusBadge", "Status", "secret", "k.payroll"];

describe("audience: ceiling semantics", () => {
  it("isBroadcast / effectiveViewer: viewer and absent pass through; anything else is the no-clearance viewer", () => {
    const v = { clearance: "secret" as const };
    expect(effectiveViewer(v, undefined)).toBe(v);
    expect(effectiveViewer(v, "viewer")).toBe(v);
    expect(effectiveViewer(v, "broadcast")).toEqual({});
    expect(effectiveViewer(v, "wallboard" as never)).toEqual({});
    expect(isBroadcast(undefined)).toBe(false);
    expect(isBroadcast("viewer")).toBe(false);
    expect(isBroadcast("broadcast")).toBe(true);
    expect(isBroadcast(null)).toBe(true);
  });

  it('"viewer" is today\'s output, byte for byte: absent === "viewer", and a cleared viewer sees the node', () => {
    const absent = compile(exp, { ...opts, viewer: { clearance: "secret" } });
    const explicit = compile(exp, { ...opts, viewer: { clearance: "secret" }, audience: "viewer" });
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(absent));
    expect(widgets(absent).some((w) => w.id === "payroll" && w.kind === "StatusBadge")).toBe(true);
    expect(widgets(absent).some((w) => w.source?.redacted === true)).toBe(false);
  });

  it("a viewer-restricted placeholder on a viewer surface is unchanged: Note, 'Restricted', not redacted", () => {
    const r = compile(exp, { ...opts, viewer: { clearance: "internal" } });
    const ph = widgets(r).find((w) => w.id !== "latency");
    expect(ph?.kind).toBe("Note");
    expect(ph?.title).toBe("Restricted");
    expect(ph?.source).toBeUndefined();
    expect(codes(r)).toContain("node-restricted");
    expect(codes(r)).not.toContain("audience-withheld");
  });

  it("broadcast withholds a node the (fully cleared) viewer could see, as the IR 2.5.0 redacted widget", () => {
    const r = compile(exp, { ...opts, viewer: { clearance: "secret" }, audience: "broadcast" });
    expect(r.ok).toBe(true);
    const ws = widgets(r);
    expect(ws).toHaveLength(2);
    const red = ws.find((w) => w.source?.redacted === true);
    expect(red).toBeDefined();
    expect(red?.kind).toBe("Note");
    expect(red?.source).toEqual({ type: "redacted", version: "1", redacted: true });
    expect(red?.id).toMatch(/^r_/);
    expect(red?.id).not.toBe("payroll");
    expect(red?.binding).toBeUndefined();
    expect(red?.title).toBeUndefined();
    expect(red?.props).toEqual({});
    // The unclassified sibling is untouched, and the redacted widget keeps its grid cell.
    expect(ws.find((w) => w.id === "latency")?.kind).toBe("MetricCard");
    const layout = r.blueprint.layout as {
      children: Array<{ node: Widget; span: number; column?: number }>;
    };
    const cell = layout.children.find((c) => c.node === red);
    expect([cell?.span, cell?.column]).toEqual([4, 3]);
    expect(codes(r)).toContain("audience-withheld");
    expect(codes(r)).not.toContain("node-restricted");
    expect(codes(r)).not.toContain("viewer-not-supplied");
  });

  it("loom's validateBlueprint accepts the redacted widget (the catalogue declares the placeholder kind)", () => {
    const r = compile(exp, { ...opts, audience: "broadcast" });
    const derived = loomCatalogFor(catalog, "web");
    expect(derived.catalog.entries.some((e) => e.kind === "Note")).toBe(true);
    const rep = validateBlueprint(r.blueprint, derived.catalog);
    expect(rep.findings.filter((f) => f.code === "redacted-invalid")).toEqual([]);
    expect(r.findings.some((f) => f.code.startsWith("loom:"))).toBe(false);
    // The check really runs for the compiled placeholder: a tampered copy is caught.
    const forged = structuredClone(r.blueprint) as {
      layout: { children: Array<{ node: Widget }> };
    };
    const w = forged.layout.children.map((c) => c.node).find((n) => n.source?.redacted === true);
    if (w) w.title = "Executive payroll";
    expect(
      validateBlueprint(forged as never, derived.catalog).findings.map((f) => f.code)
    ).toContain("redacted-invalid");
  });

  it("the Blueprint says one thing for both reasons: a no-clearance viewer's broadcast is the cleared viewer's, byte for byte", () => {
    const cleared = compile(exp, {
      ...opts,
      viewer: { clearance: "secret" },
      audience: "broadcast",
    });
    const none = compile(exp, { ...opts, viewer: {}, audience: "broadcast" });
    const absent = compile(exp, { ...opts, audience: "broadcast" });
    expect(JSON.stringify(none.blueprint)).toBe(JSON.stringify(cleared.blueprint));
    expect(JSON.stringify(absent.blueprint)).toBe(JSON.stringify(cleared.blueprint));
    // Only the (server-side) finding tells the reasons apart.
    expect(codes(cleared)).toContain("audience-withheld");
    expect(codes(none)).toContain("node-restricted");
    expect(codes(absent)).not.toContain("viewer-not-supplied");
  });

  it("fails closed: an unrecognised class is withheld; an unrecognised audience is broadcast; unclassified stays", () => {
    const odd = build([
      plainNode,
      sem("odd", "Status", {
        binding: { handle: "h-odd", priority: "P1", sensitivity: "top-secret" as never },
      }),
    ]);
    const r = compile(odd, {
      ...opts,
      viewer: { clearance: "secret" },
      audience: "wallboard" as never,
    });
    expect(
      widgets(r)
        .map((w) => w.id)
        .includes("odd")
    ).toBe(false);
    expect(widgets(r).filter((w) => w.source?.redacted === true)).toHaveLength(1);
    expect(widgets(r).some((w) => w.id === "latency")).toBe(true);
    expect(r.restrictedHandles).toEqual(["h-odd"]);
  });

  it("a container of nothing but withheld nodes collapses to ONE redacted widget (no title, role or count)", () => {
    const inner = grid(
      "hr-block",
      [
        sem("a", "Status", {
          binding: { handle: "h-a", priority: "P1", sensitivity: "sensitive" },
        }),
        sem("b", "Status", { binding: { handle: "h-b", priority: "P1", sensitivity: "secret" } }),
      ],
      {
        title: { key: "t", fallback: "Compensation" },
        role: "tabs",
      }
    );
    const e = build([plainNode, inner]);
    const r = compile(e, { ...opts, viewer: { clearance: "secret" }, audience: "broadcast" });
    const ws = widgets(r);
    expect(ws).toHaveLength(2);
    expect(ws.filter((w) => w.source?.redacted === true)).toHaveLength(1);
    const j = JSON.stringify(r.blueprint);
    for (const s of ["Compensation", "hr-block", "tabs", "StatusBadge", '"h-a"', '"h-b"'])
      expect(j).not.toContain(s);
    expect(r.findings.filter((f) => f.code === "audience-withheld")).toHaveLength(1);
    expect(r.findings.filter((f) => f.code === "node-restricted")).toHaveLength(0);
  });

  it("a classified intent objective is not the broadcast title, even for a cleared viewer", () => {
    const e = build([plainNode], "secret");
    const viewerView = compile(e, { ...opts, viewer: { clearance: "secret" } });
    expect(viewerView.blueprint.title).toBe("Wallboard objective");
    const wall = compile(e, { ...opts, viewer: { clearance: "secret" }, audience: "broadcast" });
    expect(wall.blueprint.title).toBe("");
    expect(JSON.stringify(wall)).not.toContain("Wallboard objective");
    expect(codes(wall)).toContain("title-restricted");
  });

  it("a projection-bound node the viewer may see is withheld on broadcast (audience-withheld), by id alias", () => {
    const { binding: _unused, ...bare } = sem("approvals", "Status");
    const pn: SemanticNode = {
      ...bare,
      projection: {
        id: "approvals",
        path: "queue.state",
        statusPath: "queue.status",
        version: "1",
      },
    };
    const e = build([plainNode, pn]);
    const withProjections = {
      ...opts,
      projections: [{ id: "approvals", version: "1", sensitivity: "sensitive" as const }],
    };
    const viewerView = compile(e, { ...withProjections, viewer: { clearance: "sensitive" } });
    expect(widgets(viewerView).some((w) => w.id === "approvals" && w.binding !== undefined)).toBe(
      true
    );
    const wall = compile(e, {
      ...withProjections,
      viewer: { clearance: "sensitive" },
      audience: "broadcast",
    });
    const red = widgets(wall).find((w) => w.source?.redacted === true);
    expect(red).toBeDefined();
    expect(codes(wall)).toContain("audience-withheld");
    expect(wall.blueprint.projections).toEqual(["hydration"]);
    const j = JSON.stringify(wall.blueprint);
    for (const s of ["approvals", "queue", "StatusBadge"]) expect(j).not.toContain(s);
  });
});

describe("audience: nothing withheld survives anywhere a client can read", () => {
  it("no withheld value, label, handle, id, provider, kind or type in the blueprint or its fingerprint", () => {
    const r = compile(exp, { ...opts, viewer: { clearance: "secret" }, audience: "broadcast" });
    // `fingerprint` is what a viewer's stamp carries; `findings` and `restricted*` are server-side.
    const clientVisible = JSON.stringify({ blueprint: r.blueprint, fingerprint: r.fingerprint });
    for (const leak of LEAKS) expect(clientVisible, `leaked "${leak}"`).not.toContain(leak);
    // The control: the viewer surface for the same cleared viewer DOES carry them, so the grep is not vacuous.
    const cleared = JSON.stringify(
      compile(exp, { ...opts, viewer: { clearance: "secret" } }).blueprint
    );
    for (const leak of ["payroll", "Executive", "StatusBadge"]) expect(cleared).toContain(leak);
    // Server-side lists do name the real handle (that is what they are for).
    expect(r.restrictedHandles).toEqual(["h-payroll"]);
    expect(r.blueprint.projections).toEqual(["hydration"]);
  });

  it("is deterministic: same inputs, byte-identical broadcast output", () => {
    const o = { ...opts, viewer: { clearance: "secret" as const }, audience: "broadcast" as const };
    expect(JSON.stringify(compile(exp, o))).toBe(JSON.stringify(compile(exp, o)));
  });
});

describe("audience: the compile memo never crosses audiences", () => {
  it("viewer and broadcast of one experience and one viewer never share an entry", () => {
    const memo = createCompileMemo();
    const v = { clearance: "secret" as const };
    const viewerFirst = compile(exp, { ...opts, memo, viewer: v });
    const wall = compile(exp, { ...opts, memo, viewer: v, audience: "broadcast" });
    expect([memo.hits, memo.misses, memo.size]).toEqual([0, 2, 2]);
    expect(JSON.stringify(wall.blueprint)).not.toBe(JSON.stringify(viewerFirst.blueprint));
    // Both orders: the broadcast entry is never served to the viewer surface either.
    const memo2 = createCompileMemo();
    const wall2 = compile(exp, { ...opts, memo: memo2, viewer: v, audience: "broadcast" });
    const viewer2 = compile(exp, { ...opts, memo: memo2, viewer: v });
    expect(memo2.hits).toBe(0);
    expect(widgets(viewer2).some((w) => w.id === "payroll")).toBe(true);
    expect(widgets(wall2).some((w) => w.id === "payroll")).toBe(false);
    // Each is then served from its own entry.
    compile(exp, { ...opts, memo: memo2, viewer: v, audience: "broadcast" });
    compile(exp, { ...opts, memo: memo2, viewer: v });
    expect([memo2.hits, memo2.size]).toEqual([2, 2]);
  });

  it('absent and "viewer" share an entry; a value compile reads as broadcast shares the broadcast one', () => {
    const memo = createCompileMemo();
    const v = { clearance: "secret" as const };
    compile(exp, { ...opts, memo, viewer: v });
    compile(exp, { ...opts, memo, viewer: v, audience: "viewer" });
    expect([memo.hits, memo.size]).toEqual([1, 1]);
    compile(exp, { ...opts, memo, viewer: v, audience: "broadcast" });
    compile(exp, { ...opts, memo, viewer: v, audience: "wallboard" as never });
    expect([memo.hits, memo.size]).toEqual([2, 2]);
  });
});

describe("audience: every per-viewer output agrees with compile", () => {
  const secretViewer = { clearance: "secret" as const };
  const sealed = (e: ReturnType<typeof build>, v: string) => ({ ...e, versionHash: v });
  const v0 = sealed(build([plainNode]), "sha256:v0");
  const v1 = sealed(build([plainNode, secretNode]), "sha256:v1");

  it("compile exposes the EFFECTIVE viewer and clearance", () => {
    const wall = compile(exp, { ...opts, viewer: secretViewer, audience: "broadcast" });
    expect(wall.viewer).toEqual({});
    expect(wall.clearance).toBeUndefined();
    const mine = compile(exp, { ...opts, viewer: secretViewer });
    expect(mine.clearance).toBe("secret");
    expect(mine.viewer).toEqual(secretViewer);
  });

  it("describeChange: a broadcast call never describes a classified node, whoever asked", () => {
    const asked = describeChange(v0, v1, { viewer: secretViewer });
    expect(asked.entries.some((e) => JSON.stringify(e).includes("payroll"))).toBe(true);
    const wall = describeChange(v0, v1, { viewer: secretViewer, audience: "broadcast" });
    expect(JSON.stringify(wall)).not.toContain("payroll");
    expect(wall.restricted).toBe(true);
  });

  it("snapshotSeen / redactSeen: a broadcast snapshot never records a classified source as seen", () => {
    const read = (s: { kind: string; handle?: string }) => ({
      found: true,
      value: { v: s.handle },
      status: "ready",
    });
    const asked = snapshotSeen(v1, { viewer: secretViewer, read });
    expect(JSON.stringify(asked)).toContain("h-payroll");
    const wall = snapshotSeen(v1, { viewer: secretViewer, read, audience: "broadcast" });
    expect(JSON.stringify(wall)).not.toContain("h-payroll");
    expect(wall.restricted).toBe(true);
    // The redactor a SeenLog uses on record / read agrees.
    const again = redactSeen(asked.entries, v1, { viewer: secretViewer, audience: "broadcast" });
    expect(JSON.stringify(again.entries)).not.toContain("h-payroll");
    expect(again.restricted).toBe(true);
  });

  it("explainNode: a broadcast call is unavailable for a classified node, available for the plain one", () => {
    const user = { source: "user" as const, agentId: "u" };
    const rec: RecordedOperation = {
      op: { type: "insertNode", parentId: "root", node: secretNode } as Operation,
      by: user,
      at: "2026-10-06T00:00:01Z",
    };
    const ledger = foldProvenance(emptyLedger({ versionHash: "sha256:v1", at: "t", by: user }), [
      { versionHash: "sha256:v1", at: "t", by: user, ops: [rec] },
    ]);
    expect(explainNode(v1, "payroll", { viewer: secretViewer, ledger }).available).toBe(true);
    expect(
      explainNode(v1, "payroll", { viewer: secretViewer, ledger, audience: "broadcast" }).available
    ).toBe(false);
  });

  it("two viewers' broadcast fingerprints are identical when stamped with the result's clearance", () => {
    const stamp = (viewer?: { clearance?: "secret" | "internal" }) => {
      const r = compile(exp, { ...opts, ...(viewer && { viewer }), audience: "broadcast" });
      return compileFingerprint({ clearance: r.clearance, locale: "en", ...r.fingerprint });
    };
    expect(stamp({ clearance: "secret" })).toBe(stamp({ clearance: "internal" }));
    expect(stamp({ clearance: "secret" })).toBe(stamp(undefined));
    // The viewer surface still moves with clearance (control).
    const mine = (clearance: "secret" | "internal") => {
      const r = compile(exp, { ...opts, viewer: { clearance } });
      return compileFingerprint({ clearance: r.clearance, locale: "en", ...r.fingerprint });
    };
    expect(mine("secret")).not.toBe(mine("internal"));
  });

  it("a broadcast stamp differs from a no-clearance viewer's (their IR differs), and two broadcast viewers still match", () => {
    const stampOf = (o: Partial<Parameters<typeof compile>[1]>) => {
      const r = compile(exp, { ...opts, ...o });
      return compileFingerprint({ clearance: r.clearance, locale: "en", ...r.fingerprint });
    };
    const wall = stampOf({ audience: "broadcast", viewer: { clearance: "secret" } });
    const plainViewer = stampOf({ viewer: {} });
    const noViewer = stampOf({});
    expect(wall).not.toBe(plainViewer);
    expect(wall).not.toBe(noViewer);
    expect(stampOf({ audience: "broadcast", viewer: { clearance: "internal" } })).toBe(wall);
    // An explicit "viewer" audience is the default: it does not move the stamp.
    expect(stampOf({ audience: "viewer", viewer: {} })).toBe(plainViewer);
  });
});
