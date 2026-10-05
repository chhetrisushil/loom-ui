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
