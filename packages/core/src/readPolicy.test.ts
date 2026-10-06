import { describe, expect, it } from "vitest";
import { defineSemanticCatalog } from "./catalog";
import { describeChange, experienceClassFloor, inspectExperience } from "./change";
import { UNDECLARED_TOOL_CLASS, mergeReadPolicy } from "./classes";
import { compile } from "./compile";
import { type Experience, type ProviderSpec, genesis } from "./experience";
import { experienceHandles } from "./handles";
import type { ContainerNode, SemanticNode } from "./node";
import { apply } from "./operations";
import { emptyLedger, explainNode } from "./provenance";
import { redactSeen, snapshotSeen } from "./seen";
import { testCatalog } from "./testCatalog.test-support";

// U10b round 2: `undeclared: "deny"` (a tool the declared table does not list reads as a class no
// viewer clears), `mergeReadPolicy` (a bound policy that per-call values may only add to), and the
// declared table beating `declassifyHandle`. Every node below is stored UNCLASSIFIED.

const meta = { author: "a", createdAt: "2026-10-07T00:00:00Z", sourceKind: "prompt" };
const spec = (handle: string, tool: string): ProviderSpec => ({
  handle,
  executionGraph: [
    {
      stepId: "s",
      toolName: tool,
      toolVersion: "1",
      toolSchemaHash: "x",
      arguments: {},
      dependsOn: [],
      idempotent: true,
    },
  ],
  reshaping: { engine: "JSONPath", scriptRef: "$" },
  outputShapeHash: "",
  cachePolicy: { ttlSeconds: 1, scope: "global" },
});
const metric = (id: string, handle: string, sensitivity?: "secret"): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: { unit: "usd" },
  binding: { handle, priority: "P1", ...(sensitivity !== undefined && { sensitivity }) },
});
// `listed` is in the table (declared "internal": a low viewer may see it); `surprise` is NOT listed.
const build = (): Experience => {
  const root: ContainerNode = {
    id: "root",
    order: "V",
    kind: "container",
    direction: "grid",
    span: 12,
    children: [metric("listed", "h-listed"), metric("surprise", "h-surprise")],
  };
  return {
    ...genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta }),
    versionHash: "sha256:v",
    root,
    providers: {
      "h-listed": spec("h-listed", "known.read"),
      "h-surprise": spec("h-surprise", "unlisted.read"),
    },
  };
};
const table = { "known.read": "internal" } as const;
const low = { clearance: "internal" } as const;
const high = { clearance: "secret" } as const;
const noteCatalog = defineSemanticCatalog({
  ...testCatalog,
  entries: testCatalog.entries.map((e) =>
    e.name === "Explainer"
      ? { ...e, surfaces: { web: { kind: "Note", props: ["text"], binding: "none" as const } } }
      : e
  ),
});
const copts = {
  surface: "web" as const,
  catalog: noteCatalog,
  hydrationProjectionId: "hydration",
  hydrationProjectionVersion: "1.0.0",
};
const kindOf = (r: ReturnType<typeof compile>, id: string): string | undefined => {
  const walkW = (n: unknown): string | undefined => {
    const o = n as { id?: string; kind?: string; children?: unknown[]; node?: unknown };
    if (o.id === id && o.kind !== undefined) return o.kind;
    for (const c of o.children ?? []) {
      const f = walkW((c as { node?: unknown }).node ?? c);
      if (f !== undefined) return f;
    }
    return undefined;
  };
  return walkW(r.blueprint.layout);
};

describe('undeclared: "deny" — a tool the table does not list is unreadable', () => {
  const exp = build();
  const deny = { declaredToolClasses: table, undeclared: "deny" as const };

  it("experienceHandles: allow (default) is unchanged; deny reads the unlisted tool as restricted", () => {
    const allow = experienceHandles(exp, table);
    expect(allow.find((u) => u.handle === "h-surprise")?.sensitivity).toBeUndefined();
    expect(experienceHandles(exp, table, "allow").find((u) => u.handle === "h-surprise")).toEqual(
      allow.find((u) => u.handle === "h-surprise")
    );
    const denied = experienceHandles(exp, table, "deny");
    expect(denied.find((u) => u.handle === "h-surprise")?.sensitivity).toBe(UNDECLARED_TOOL_CLASS);
    expect(denied.find((u) => u.handle === "h-listed")?.sensitivity).toBe("internal");
  });

  it("deny with NO table is an EMPTY table: every tool-bound handle is restricted (fails closed)", () => {
    for (const h of ["h-surprise", "h-listed"])
      expect(
        experienceHandles(exp, undefined, "deny").find((u) => u.handle === h)?.sensitivity
      ).toBe(UNDECLARED_TOOL_CLASS);
    expect(mergeReadPolicy({ undeclared: "deny" })).toEqual({
      declaredToolClasses: {},
      undeclared: "deny",
    });
    // and a later table cannot open it
    expect(
      mergeReadPolicy({ undeclared: "deny" }, { declaredToolClasses: { "known.read": "internal" } })
        .declaredToolClasses
    ).toEqual({});
  });

  it("compile: allow shows it, deny hides it from EVERY viewer, even a fully cleared one", () => {
    const base = { ...copts, declaredToolClasses: table };
    expect(kindOf(compile(exp, { ...base, viewer: low }), "surprise")).toBe("MetricCard");
    for (const viewer of [low, high]) {
      const r = compile(exp, { ...base, undeclared: "deny", viewer });
      expect(kindOf(r, "surprise")).toBe("Note");
      expect(kindOf(r, "listed")).toBe("MetricCard");
      expect(r.restrictedHandles).toEqual(["h-surprise"]);
      expect(JSON.stringify(r.blueprint)).not.toContain("h-surprise");
    }
  });

  it("inspectExperience / experienceClassFloor", () => {
    expect(inspectExperience(exp, { declaredToolClasses: table }).nodes.get("surprise")?.cls).toBe(
      undefined
    );
    expect(inspectExperience(exp, deny).nodes.get("surprise")?.cls).toBe(UNDECLARED_TOOL_CLASS);
    expect(experienceClassFloor(exp, undefined, table)).toBe("internal");
    expect(experienceClassFloor(exp, undefined, table, "deny")).toBe(UNDECLARED_TOOL_CLASS);
  });

  it("describeChange: a change to the unlisted-tool node is restricted under deny only", () => {
    const next = build();
    const edited = {
      ...(next.root as ContainerNode),
      children: [
        metric("listed", "h-listed"),
        { ...metric("surprise", "h-surprise"), props: { unit: "eur" } },
      ],
    };
    const b = { ...next, root: edited, versionHash: "sha256:w" };
    expect(describeChange(exp, b, { viewer: high, declaredToolClasses: table }).restricted).toBe(
      false
    );
    const closed = describeChange(exp, b, { viewer: high, ...deny });
    expect(closed.restricted).toBe(true);
    expect(JSON.stringify(closed)).not.toContain("surprise");
  });

  it("explainNode: unavailable under deny (to everyone), available under allow", () => {
    const o = { ledger: emptyLedger(null), declaredToolClasses: table };
    expect(explainNode(exp, "surprise", { ...o, viewer: high }).available).toBe(true);
    expect(explainNode(exp, "surprise", { ...o, viewer: high, undeclared: "deny" }).available).toBe(
      false
    );
    expect(explainNode(exp, "listed", { ...o, viewer: low, undeclared: "deny" }).available).toBe(
      true
    );
  });

  it("snapshotSeen / redactSeen: an unlisted-tool value is never read and a stored entry is withheld", () => {
    const calls: string[] = [];
    const reader = (s: { kind: string; handle?: string }) => {
      calls.push(s.handle ?? "");
      return { found: true, value: { v: s.handle }, status: "ready" };
    };
    snapshotSeen(exp, { viewer: high, read: reader, declaredToolClasses: table });
    expect(calls).toContain("h-surprise");
    calls.length = 0;
    const snap = snapshotSeen(exp, { viewer: high, read: reader, ...deny });
    expect(calls).not.toContain("h-surprise");
    expect(calls).toContain("h-listed");
    expect(snap.restricted).toBe(true);
    const stored = snapshotSeen(exp, { viewer: high, read: reader, declaredToolClasses: table });
    const r = redactSeen(stored.entries, exp, { viewer: high, ...deny });
    expect(r.entries.some((e) => JSON.stringify(e).includes("h-surprise"))).toBe(false);
    expect(r.restricted).toBe(true);
    expect(
      redactSeen(stored.entries, exp, { viewer: high, declaredToolClasses: table }).restricted
    ).toBe(false);
  });
});

describe("mergeReadPolicy: the bound policy first, per-call values only add", () => {
  it("undefined / {} add nothing; tables join strictest-wins; deny sticks", () => {
    expect(mergeReadPolicy()).toEqual({});
    const bound = { declaredToolClasses: { a: "secret" } as const, undeclared: "deny" as const };
    for (const perCall of [
      undefined,
      {},
      { declaredToolClasses: {} },
      { undeclared: "allow" as const },
    ]) {
      expect(mergeReadPolicy(bound, perCall)).toEqual(bound);
    }
    expect(
      mergeReadPolicy(bound, { declaredToolClasses: { a: "internal", b: "sensitive" } })
    ).toEqual({ declaredToolClasses: { a: "secret" }, undeclared: "deny" }); // b is NEW after deny: ignored
    expect(
      mergeReadPolicy(
        { declaredToolClasses: { a: "secret" } },
        { declaredToolClasses: { a: "internal", b: "sensitive" } }
      )
    ).toEqual({ declaredToolClasses: { a: "secret", b: "sensitive" } }); // allow: new keys still add
    expect(mergeReadPolicy({}, { undeclared: "deny" }).undeclared).toBe("deny");
  });
  it("deny CLOSES the key set: a later tier may raise a listed tool, never list a new one", () => {
    const bound = { declaredToolClasses: { a: "secret" } as const, undeclared: "deny" as const };
    expect(mergeReadPolicy(bound, { declaredToolClasses: { b: "internal" } })).toEqual(bound);
    expect(mergeReadPolicy(bound, { declaredToolClasses: { b: "internal", a: "secret" } })).toEqual(
      bound
    );
    // a tier that sets deny AND lists keys keeps them; tiers before deny are unrestricted
    expect(
      mergeReadPolicy(
        { declaredToolClasses: { x: "internal" } },
        { declaredToolClasses: { y: "internal" }, undeclared: "deny" },
        { declaredToolClasses: { z: "secret" } }
      ).declaredToolClasses
    ).toEqual({ x: "internal", y: "internal" });
    // idempotent on re-merge: merging a merged (left-folded) policy again changes nothing
    const once = mergeReadPolicy(bound, { declaredToolClasses: { b: "internal" } });
    expect(mergeReadPolicy(once, { declaredToolClasses: { b: "internal" } })).toEqual(once);
  });
  it("end to end: a per-call table naming a NEW tool does not open it, even for a secret-cleared viewer", () => {
    const bound = { declaredToolClasses: table, undeclared: "deny" as const };
    const m = mergeReadPolicy(bound, { declaredToolClasses: { "unlisted.read": "internal" } });
    const classes = experienceHandles(build(), m.declaredToolClasses, m.undeclared);
    expect(classes.find((u) => u.handle === "h-surprise")?.sensitivity).toBe(UNDECLARED_TOOL_CLASS);
    const r = compile(build(), { ...copts, ...m, viewer: high });
    expect(r.restrictedHandles).toEqual(["h-surprise"]);
  });
  it("a per-call projections / hydrationProjectionId does not replace the bound one", () => {
    const cat = { offered: [] } as never;
    const other = { other: true } as never;
    const m = mergeReadPolicy(
      { projections: cat, hydrationProjectionId: "h" },
      { projections: other, hydrationProjectionId: "z" }
    );
    expect(m.projections).toBe(cat);
    expect(m.hydrationProjectionId).toBe("h");
    expect(mergeReadPolicy({}, { projections: other }).projections).toBe(other);
  });
});

describe("the declared table beats declassifyHandle", () => {
  it("a handle declassified (handle AND tool) still reads as the declared class", () => {
    const base = build();
    const root = base.root as ContainerNode;
    const stored: Experience = {
      ...base,
      root: { ...root, children: [metric("pay", "h-listed", "secret"), ...root.children.slice(1)] },
    };
    const lowered = apply(
      stored,
      { type: "declassifyHandle", handle: "h-listed", tool: true },
      { allowDeclassify: true }
    );
    if (!lowered.ok) throw new Error(JSON.stringify(lowered));
    const e = lowered.value;
    // The stored classes are gone: without the host's table it is open.
    expect(experienceHandles(e).find((u) => u.handle === "h-listed")?.sensitivity).toBeUndefined();
    const t = { "known.read": "secret" } as const;
    expect(experienceHandles(e, t).find((u) => u.handle === "h-listed")?.sensitivity).toBe(
      "secret"
    );
    expect(kindOf(compile(e, { ...copts, viewer: low }), "pay")).toBe("MetricCard");
    expect(kindOf(compile(e, { ...copts, viewer: low, declaredToolClasses: t }), "pay")).toBe(
      "Note"
    );
    expect(
      explainNode(e, "pay", {
        ledger: emptyLedger(null),
        viewer: low,
        declaredToolClasses: t,
      }).available
    ).toBe(false);
  });
});
