import { describe, expect, it } from "vitest";
import { carryClasses } from "./classes";
import { genesis } from "./experience";
import type { SemanticNode } from "./node";
import { type Operation, replay } from "./operations";

const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const base = () => genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta });
const node = (id: string, handle: string, sensitivity?: "secret" | "internal"): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const run = (ops: Operation[]) => {
  const r = replay(base(), ops);
  if (!r.ok) throw new Error(r.finding.message);
  return r.value;
};
const ins = (n: SemanticNode): Operation => ({ type: "insertNode", parentId: "root", node: n });

describe("carryClasses", () => {
  it("writes a class held only by the source's LIVE nodes into the target's sticky map", () => {
    const from = run([ins(node("a", "h", "secret"))]);
    const onto = run([]);
    expect(carryClasses(from, onto).handleClasses).toEqual({ h: "secret" });
  });

  it("never lowers: the stricter of the two wins, either way round", () => {
    const strict = run([ins(node("a", "h", "secret"))]);
    const lax = run([ins(node("a", "h", "internal"))]);
    expect(carryClasses(lax, strict).handleClasses).toEqual({ h: "secret" });
    expect(carryClasses(strict, lax).handleClasses).toEqual({ h: "secret" });
  });

  it("returns `onto` itself when the source adds nothing", () => {
    const onto = run([ins(node("a", "h", "secret"))]);
    expect(carryClasses(run([]), onto)).toBe(onto);
  });

  it("does not mutate either argument", () => {
    const from = run([ins(node("a", "h", "secret"))]);
    const onto = run([]);
    const snap = JSON.stringify([from, onto]);
    carryClasses(from, onto);
    expect(JSON.stringify([from, onto])).toBe(snap);
  });
});
