import { describe, expect, it } from "vitest";
import { checkPlannerConformance } from "./conformance";
import { reviseForDrift } from "./drift";
import { REACH_DECLARATION, declarePlannerReach, readPlannerReach } from "./reach";
import { ReferencePlanner } from "./reference";
import type { Planner } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  stampingScope,
} from "./testing.test-support";

const compose = JSON.stringify({
  summary: "s",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders",
      span: 4,
      props: {},
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0",
      },
    },
  ],
});
const revise = JSON.stringify({
  summary: "s",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders",
      span: 4,
      props: {},
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0",
      },
    },
    { id: "why", type: "Insight", label: "Why", span: 12, props: {} },
  ],
});

const KEY = Symbol.for("loom.verify.reach");

describe("declared reach (loom L32)", () => {
  const mk = (reach?: { transient?: string[]; run?: string[] }) =>
    new ReferencePlanner({
      modelId: "m",
      model: (scope) => ({ complete: (req) => scope.invokeTransient("llm.complete", req) }),
      ...(reach && { reach }),
    });
  const run = (planner: Planner, extra: object = {}) => {
    const replies = [compose, revise];
    const scope = stampingScope("exec-1", () => ({ content: replies.shift() as string }));
    return checkPlannerConformance(planner, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add an insight" },
      ctx: recordingContext(scope),
      scopeProbe: { identity: "exec-1", calls: () => scope.calls },
      ...extra,
    });
  };

  it("the well-known key is Symbol.for('loom.verify.reach')", () => {
    expect(REACH_DECLARATION).toBe(KEY);
  });
  it("a planner built with `reach` carries a non-enumerable structural declaration", () => {
    const p = mk({ transient: ["llm.complete"] });
    expect((p as unknown as Record<symbol, unknown>)[KEY]).toEqual({ transient: ["llm.complete"] });
    expect(Object.keys(p)).not.toContain(String(KEY));
    expect(Object.getOwnPropertySymbols(p)).toContain(KEY);
    expect(Object.getOwnPropertyDescriptor(p, KEY)?.enumerable).toBe(false);
    expect(readPlannerReach(p)).toEqual({ transient: ["llm.complete"] });
  });
  it("no `reach` option means NO declaration (undeclared, never partial)", () => {
    expect(readPlannerReach(mk())).toBeUndefined();
  });
  it("the declaration is a copy: mutating the option array afterwards changes nothing", () => {
    const t = ["llm.complete"];
    const p = mk({ transient: t });
    t.push("evil");
    expect(readPlannerReach(p)?.transient).toEqual(["llm.complete"]);
  });
  it("readPlannerReach rejects malformed declarations", () => {
    expect(readPlannerReach(declarePlannerReach({}, { transient: [1] as never }))).toBeUndefined();
    expect(readPlannerReach(null)).toBeUndefined();
    expect(readPlannerReach("x")).toBeUndefined();
  });
  it("the declaration is reachable through reviseForDrift's planner argument too", () => {
    const p = mk({ transient: ["llm.complete"] });
    expect(readPlannerReach(p)).toBeDefined();
    expect(typeof reviseForDrift).toBe("function");
  });

  describe("conformance (checkReach)", () => {
    it("passes when every scope toolId is declared", async () => {
      expect(await run(mk({ transient: ["llm.complete"] }), { checkReach: true })).toEqual([]);
    });
    it("NEGATIVE: an undeclared planner that calls a tool fails reach-undeclared", async () => {
      const f = await run(mk(), { checkReach: true });
      expect(f.map((x) => x.code)).toContain("reach-undeclared");
    });
    it("NEGATIVE: a declaration that omits the called tool fails reach-undeclared", async () => {
      const f = await run(mk({ transient: ["something.else"] }), { checkReach: true });
      const hit = f.find((x) => x.code === "reach-undeclared");
      expect(hit?.message).toContain("llm.complete");
    });
    it("NEGATIVE: listing the tool under `run` does not cover a transient call", async () => {
      const f = await run(mk({ run: ["llm.complete"] }), { checkReach: true });
      expect(f.map((x) => x.code)).toContain("reach-undeclared");
    });
    it("not opted in: reach is not checked", async () => {
      expect(await run(mk())).toEqual([]);
    });
    it("NEGATIVE: checkReach without a scopeProbe is reach-unprobed, never a silent pass", async () => {
      const replies = [compose, revise];
      const scope = stampingScope("exec-1", () => ({ content: replies.shift() as string }));
      const f = await checkPlannerConformance(mk({ transient: ["llm.complete"] }), {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        meta: metaFixture,
        revision: { text: "add an insight" },
        ctx: recordingContext(scope),
        checkReach: true,
      });
      expect(f.map((x) => x.code)).toContain("reach-unprobed");
    });
  });
});
