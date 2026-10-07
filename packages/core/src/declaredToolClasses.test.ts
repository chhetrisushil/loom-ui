import { describe, expect, it } from "vitest";
import { actionFreshness, compileFingerprint } from "./action";
import { placeholderAlias } from "./alias";
import { defineSemanticCatalog } from "./catalog";
import { describeChange, experienceClassFloor, inspectExperience } from "./change";
import { mergeDeclaredToolClasses } from "./classes";
import { compile } from "./compile";
import { type Experience, type ProviderSpec, genesis } from "./experience";
import { experienceHandles } from "./handles";
import type { ContainerNode, SemanticNode } from "./node";
import { emptyLedger, explainNode } from "./provenance";
import { redactSeen, snapshotSeen } from "./seen";
import { testCatalog } from "./testCatalog.test-support";

// U10b: the host's DECLARED class per tool is a read-time floor under every handle calling that
// tool, on EVERY read path — so a node an older planner (or a raw op) left unclassified is still
// hidden from a viewer the tool's declared class excludes. Each test stores an UNCLASSIFIED node.

const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const spec = (handle: string, tool: string, kind?: string): ProviderSpec => ({
  handle,
  executionGraph: [
    {
      stepId: "s",
      ...(kind !== undefined && { kind }),
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
const metric = (id: string, handle: string): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: { unit: "usd" },
  binding: { handle, priority: "P1" },
});
const build = (): Experience => {
  const root: ContainerNode = {
    id: "root",
    order: "V",
    kind: "container",
    direction: "grid",
    span: 12,
    children: [metric("pay", "h-pay"), metric("open", "h-open")],
  };
  return {
    ...genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta }),
    versionHash: "sha256:v",
    root,
    providers: { "h-pay": spec("h-pay", "payroll.read"), "h-open": spec("h-open", "status.read") },
  };
};
const declared = { "payroll.read": "secret" } as const;
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
const KEY = "policy-test-placeholder-key-0123456789";
const al = (id: string) => placeholderAlias(KEY, "e", id);
const copts = {
  placeholderKey: KEY,
  surface: "web" as const,
  catalog: noteCatalog,
  hydrationProjectionId: "hydration",
  hydrationProjectionVersion: "1.0.0",
};
const kindOf = (r: ReturnType<typeof compile>, id: string): string | undefined => {
  const walkW = (n: unknown): string | undefined => {
    const o = n as { id?: string; kind?: string; children?: unknown[]; node?: unknown };
    if ((o.id === id || o.id === al(id)) && o.kind !== undefined) return o.kind;
    for (const c of o.children ?? []) {
      const f = walkW((c as { node?: unknown }).node ?? c);
      if (f !== undefined) return f;
    }
    return undefined;
  };
  return walkW(r.blueprint.layout);
};

describe("declaredToolClasses: a read-time floor on every read path", () => {
  const exp = build();

  it("experienceHandles: the handle reads as the declared class; without the table it is open", () => {
    expect(experienceHandles(exp).find((u) => u.handle === "h-pay")?.sensitivity).toBeUndefined();
    const uses = experienceHandles(exp, declared);
    expect(uses.find((u) => u.handle === "h-pay")?.sensitivity).toBe("secret");
    expect(uses.find((u) => u.handle === "h-open")?.sensitivity).toBeUndefined();
  });

  it("it never lowers: a stored class above the declaration stands", () => {
    const e = build();
    const n = (e.root as ContainerNode).children[0] as SemanticNode;
    const stricter = { ...n, binding: { ...n.binding!, sensitivity: "secret" as const } };
    const e2 = { ...e, root: { ...(e.root as ContainerNode), children: [stricter] } };
    expect(
      experienceHandles(e2, { "payroll.read": "internal" }).find((u) => u.handle === "h-pay")
        ?.sensitivity
    ).toBe("secret");
  });

  it("a kind-qualified tool is keyed `<kind>:<name>`", () => {
    const e = { ...build(), providers: { "h-pay": spec("h-pay", "payroll", "effect") } };
    expect(
      experienceHandles(e, { "payroll.read": "secret" }).find((u) => u.handle === "h-pay")
        ?.sensitivity
    ).toBeUndefined();
    expect(
      experienceHandles(e, { "effect:payroll": "secret" }).find((u) => u.handle === "h-pay")
        ?.sensitivity
    ).toBe("secret");
  });

  it("compile: the node is redacted for a low viewer, shown to a cleared one", () => {
    expect(kindOf(compile(exp, { ...copts, viewer: low }), "pay")).toBe("MetricCard");
    const hidden = compile(exp, { ...copts, viewer: low, declaredToolClasses: declared });
    expect(kindOf(hidden, "pay")).toBe("Note");
    expect(kindOf(hidden, "open")).toBe("MetricCard");
    expect(JSON.stringify(hidden.blueprint)).not.toContain("h-pay");
    const shown = compile(exp, { ...copts, viewer: high, declaredToolClasses: declared });
    expect(kindOf(shown, "pay")).toBe("MetricCard");
  });

  it("inspectExperience / experienceClassFloor: the node's class and the floor carry it", () => {
    expect(inspectExperience(exp).nodes.get("pay")?.cls).toBeUndefined();
    const r = inspectExperience(exp, { declaredToolClasses: declared });
    expect(r.nodes.get("pay")?.cls).toBe("secret");
    expect(r.floor).toBe("secret");
    expect(experienceClassFloor(exp)).toBeUndefined();
    expect(experienceClassFloor(exp, undefined, declared)).toBe("secret");
  });

  it("describeChange: a change to the node is a restricted change for a low viewer", () => {
    const next = build();
    const nextRoot = next.root as ContainerNode;
    const edited = {
      ...nextRoot,
      children: [{ ...metric("pay", "h-pay"), props: { unit: "eur" } }, metric("open", "h-open")],
    };
    const b = { ...next, root: edited, versionHash: "sha256:w" };
    const open = describeChange(exp, b, { viewer: low });
    expect(open.restricted).toBe(false);
    const closed = describeChange(exp, b, { viewer: low, declaredToolClasses: declared });
    expect(closed.restricted).toBe(true);
    expect(JSON.stringify(closed)).not.toContain("pay");
  });

  it("explainNode: unavailable to a low viewer, available to a cleared one", () => {
    const o = { ledger: emptyLedger(null) };
    expect(explainNode(exp, "pay", { ...o, viewer: low }).available).toBe(true);
    expect(
      explainNode(exp, "pay", { ...o, viewer: low, declaredToolClasses: declared }).available
    ).toBe(false);
    expect(
      explainNode(exp, "pay", { ...o, viewer: high, declaredToolClasses: declared }).available
    ).toBe(true);
  });

  const read = (s: { kind: string; handle?: string }) => ({
    found: true,
    value: { v: s.handle },
    status: "ready",
  });
  it("snapshotSeen: the value is never read for a low viewer, and the snapshot is restricted", () => {
    const calls: string[] = [];
    const reader = (s: { kind: string; handle?: string }) => {
      calls.push(s.handle ?? "");
      return read(s);
    };
    snapshotSeen(exp, { viewer: low, read: reader });
    expect(calls).toContain("h-pay");
    calls.length = 0;
    const snap = snapshotSeen(exp, { viewer: low, read: reader, declaredToolClasses: declared });
    expect(calls).not.toContain("h-pay");
    expect(snap.restricted).toBe(true);
    expect(JSON.stringify(snap)).not.toContain("h-pay");
  });

  it("redactSeen: a stored entry for the node is withheld from a low viewer", () => {
    const snap = snapshotSeen(exp, { viewer: high, read });
    const stored = redactSeen(snap.entries, exp, { viewer: low });
    expect(stored.entries.some((e) => JSON.stringify(e).includes("h-pay"))).toBe(true);
    const r = redactSeen(snap.entries, exp, { viewer: low, declaredToolClasses: declared });
    expect(r.entries.some((e) => JSON.stringify(e).includes("h-pay"))).toBe(false);
    expect(r.restricted).toBe(true);
    // restamped: a cleared viewer sees it, at the declared class
    const ok = redactSeen(snap.entries, exp, { viewer: high, declaredToolClasses: declared });
    expect(ok.entries.find((e) => JSON.stringify(e.source).includes("h-pay"))?.class).toBe(
      "secret"
    );
  });
});

describe("mergeDeclaredToolClasses: tables only ever raise", () => {
  it("joins key by key, strictest wins, undefined adds nothing", () => {
    expect(mergeDeclaredToolClasses(undefined, undefined)).toBeUndefined();
    expect(mergeDeclaredToolClasses({ a: "secret" }, {})).toEqual({ a: "secret" });
    expect(mergeDeclaredToolClasses({ a: "secret" }, undefined)).toEqual({ a: "secret" });
    expect(mergeDeclaredToolClasses({ a: "secret" }, { a: "internal", b: "sensitive" })).toEqual({
      a: "secret",
      b: "sensitive",
    });
  });
});

describe("CompileResult.restrictedHandles feeds the fingerprint", () => {
  it("a raised declaration changes restrictedHandles, so a stale stamp is not fresh", () => {
    const exp = build();
    const run = (d?: typeof declared) =>
      compile(exp, { ...copts, viewer: low, ...(d !== undefined && { declaredToolClasses: d }) });
    const before = run();
    const after = run(declared);
    expect(before.restrictedHandles).toEqual([]);
    expect(after.restrictedHandles).toEqual(["h-pay"]);
    const stamp = (r: ReturnType<typeof compile>) =>
      compileFingerprint({ clearance: "internal", ...r.fingerprint });
    expect(stamp(after)).not.toBe(stamp(before));
    const head = { experienceId: "e", versionHash: "sha256:v", compile: stamp(after) };
    const viewed = (r: ReturnType<typeof compile>) => ({
      viewedVersion: {
        blueprintId: "e@sha256:v",
        experienceId: "e",
        versionHash: "sha256:v",
        compile: stamp(r),
      },
    });
    expect(actionFreshness(viewed(before), head)).toBe("stale");
    expect(actionFreshness(viewed(after), head)).toBe("fresh");
  });
});
