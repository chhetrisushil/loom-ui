import { apply, experienceHandles, genesis, replay } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import type { PlanDraft } from "./contract";
import { materialize } from "./materialize";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
} from "./testing.test-support";

// The reviewer's probe 2: the caller classifies a planner-composed node, then a revise renames
// it (same capability / args / path = same handle). The class must follow the HANDLE.
const base = () => genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture });
const node = (id: string) => ({
  id,
  type: "Metric",
  label: "Payroll",
  span: 6,
  props: { unit: "usd" },
  binding: {
    capability: "orders_summary",
    arguments: { window: "7d" },
    path: "totals.count",
    priority: "P1" as const,
  },
});
const plan = (...ids: string[]): PlanDraft => ({ summary: "s", nodes: ids.map(node) });
const fold = (e: ReturnType<typeof base>, d: PlanDraft) => {
  const m = materialize(d, e, planningCatalog, capabilitiesFixture);
  const r = replay(e, m.ops);
  if (!r.ok) throw new Error(r.finding.message);
  return { m, exp: r.value };
};

describe("a rename through the planner cannot declassify a handle", () => {
  const composed = () => {
    const { exp } = fold(base(), plan("pay"));
    const h = experienceHandles(exp)[0]!.handle;
    const r = apply(exp, { type: "bindProvider", nodeId: "pay", handle: h, sensitivity: "secret" });
    if (!r.ok) throw new Error("bind");
    return { exp: r.value, h };
  };

  it("the renamed node's handle is still secret", () => {
    const { exp, h } = composed();
    const { m, exp: after } = fold(exp, plan("pay_v2"));
    expect(m.ops.some((o) => o.type === "removeNode")).toBe(true);
    const use = experienceHandles(after).find((u) => u.handle === h);
    expect(use?.sensitivity).toBe("secret");
    expect(m.ops.some((o) => o.type === "declassifyHandle")).toBe(false);
  });

  it("says so: a new node onto a classified handle reports an inherited class", () => {
    const { exp } = composed();
    const { m } = fold(exp, plan("pay", "pay_copy"));
    expect(m.findings.map((f) => f.code)).toContain("sensitivity-inherited");
  });

  it("a draft carrying a declassify attempt yields no declassify op and the class stands", () => {
    const { exp, h } = composed();
    const tampered = {
      summary: "s",
      declassify: [h],
      nodes: [
        {
          ...node("pay"),
          declassify: true,
          binding: { ...node("pay").binding, sensitivity: undefined },
        },
      ],
    } as unknown as PlanDraft;
    const { m, exp: after } = fold(exp, tampered);
    expect(m.ops.some((o) => o.type === "declassifyHandle")).toBe(false);
    expect(experienceHandles(after)[0]?.sensitivity).toBe("secret");
  });
});

// U10 fix round 2 — the reviewer's pa.mjs: a rename PLUS an argument tweak mints a NEW handle id
// (the id hashes the arguments), so a per-handle class cannot follow it. The class is the TOOL's.
describe("a handle-id change cannot declassify (tool-level, fail-closed)", () => {
  const draft = (id: string, args: Record<string, unknown>, path = "totals.count"): PlanDraft => ({
    summary: "s",
    nodes: [
      {
        ...node(id),
        binding: { ...node(id).binding, arguments: args, path },
      },
    ],
  });
  const composed = () => {
    const { exp } = fold(base(), plan("pay"));
    const h = experienceHandles(exp)[0]!.handle;
    const r = apply(exp, { type: "bindProvider", nodeId: "pay", handle: h, sensitivity: "secret" });
    if (!r.ok) throw new Error("bind");
    return { exp: r.value, h };
  };

  it("rename + extra argument: the NEW handle is secret and the planner says so", () => {
    const { exp, h } = composed();
    const { m, exp: after } = fold(exp, draft("pay_v2", { window: "7d", x: 1 }));
    const handles = experienceHandles(after);
    expect(handles).toHaveLength(1);
    expect(handles[0]!.handle).not.toBe(h); // a genuinely different handle id
    expect(handles[0]!.sensitivity).toBe("secret");
    expect(m.findings.map((f) => f.code)).toContain("sensitivity-inherited");
    expect(m.ops.some((o) => o.type === "declassifyHandle")).toBe(false);
  });

  it("a path-only change keeps the class too", () => {
    const { exp, h } = composed();
    const { exp: after } = fold(exp, draft("pay_v2", { window: "7d" }, "totals.revenueCents"));
    const handles = experienceHandles(after);
    expect(handles[0]!.handle).not.toBe(h);
    expect(handles[0]!.sensitivity).toBe("secret");
  });

  it("a node on a DIFFERENT tool is unaffected", () => {
    const { exp } = composed();
    const other = capabilitiesFixture.find((c) => c.handle !== "orders_summary");
    if (other === undefined) return; // fixture offers one tool only
    const d: PlanDraft = {
      summary: "s",
      nodes: [
        node("pay"),
        { ...node("o"), binding: { ...node("o").binding, capability: other.handle } },
      ],
    };
    const { m, exp: after } = fold(exp, d);
    const o = experienceHandles(after).find((u) => u.nodeIds.includes("o"));
    expect(o?.sensitivity).toBeUndefined();
    expect(m.findings.map((f) => f.code)).not.toContain("sensitivity-inherited");
  });
});
