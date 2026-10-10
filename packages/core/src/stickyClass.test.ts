import { describe, expect, it } from "vitest";
import { declareHandle } from "./declareHandle.test-support";
import { genesis } from "./experience";
import { experienceHandles } from "./handles";
import { mintVersionHash } from "./log";
import type { SemanticNode } from "./node";
import { type Operation, apply, replay } from "./operations";
import { strictestClass } from "./viewer";

const PRE_CHANGE_HASH = "sha256:6d15255230885709f86cafd13f44a2fbeb9491b8f117e3ef18d905ea6f516a41";
const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
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
const ins = (n: SemanticNode): Operation => ({ type: "insertNode", parentId: "root", node: n });
const run = (ops: Operation[], from = base()) => {
  const r = replay(from, ops, { allowDeclassify: true }); // the trusted caller
  if (!r.ok) throw new Error(r.finding.message);
  return r.value;
};
const classOf = (e: ReturnType<typeof base>, h: string) =>
  experienceHandles(e).find((u) => u.handle === h)?.sensitivity;

describe("a handle's class is sticky (U10 fix round 1)", () => {
  it("survives removing every node that bound it, then a plain re-insert", () => {
    let e = run([ins(node("a", "h", "secret"))]);
    e = run([{ type: "removeNode", nodeId: "a" }], e); // separate apply
    e = run([ins(node("b", "h"))], e);
    expect(classOf(e, "h")).toBe("secret");
  });

  it("insert-then-remove in the other order loses nothing either", () => {
    const e = run([
      ins(node("a", "h", "secret")),
      ins(node("b", "h")),
      { type: "removeNode", nodeId: "a" },
    ]);
    expect(classOf(e, "h")).toBe("secret");
  });

  it("an insert onto a classified handle with a weaker class keeps the stronger", () => {
    const e = run([ins(node("a", "h", "secret")), ins(node("b", "h", "internal"))]);
    expect(classOf(e, "h")).toBe("secret");
  });

  it("a rebind away from a classified handle leaves that handle classified", () => {
    let e = run([ins(node("a", "h", "secret"))]);
    e = run([declareHandle("h2"), { type: "bindProvider", nodeId: "a", handle: "h2" }], e);
    e = run([ins(node("c", "h"))], e);
    expect(classOf(e, "h")).toBe("secret");
  });

  it("removing a container removes its subtree's classes into the map", () => {
    const e0 = run([
      {
        type: "insertNode",
        parentId: "root",
        node: {
          id: "box",
          order: "a",
          kind: "container",
          direction: "grid",
          span: 12,
          children: [node("a", "h", "secret")],
        },
      },
      { type: "removeNode", nodeId: "box" },
      ins(node("b", "h")),
    ]);
    expect(classOf(e0, "h")).toBe("secret");
  });

  it("only the explicit declassifyHandle op lowers it, on the handle and its binders", () => {
    let e = run([ins(node("a", "h", "secret")), ins(node("b", "h"))]);
    e = run([{ type: "declassifyHandle", handle: "h", to: "internal" }], e);
    expect(classOf(e, "h")).toBe("internal");
    e = run([{ type: "declassifyHandle", handle: "h" }], e);
    expect(classOf(e, "h")).toBeUndefined();
    e = run([{ type: "removeNode", nodeId: "a" }], e);
    e = run([ins(node("c", "h"))], e);
    expect(classOf(e, "h")).toBeUndefined();
    expect(e.handleClasses).toBeUndefined();
  });

  it("a prompt op cannot smuggle a declassify (also nested)", () => {
    const e = run([ins(node("a", "h", "secret"))]);
    const decl: Operation = { type: "declassifyHandle", handle: "h" };
    for (const op of [
      { type: "prompt", text: "x", materialized: [decl] },
      {
        type: "prompt",
        text: "x",
        materialized: [{ type: "prompt", text: "y", materialized: [decl] }],
      },
    ] as Operation[]) {
      const r = apply(e, op);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.finding.code).toBe("declassify-in-prompt");
    }
  });

  it("hash compat: no class map = the pre-change hash; a map changes identity", () => {
    const e = run([ins(node("a", "h"))]);
    expect(e.handleClasses).toBeUndefined();
    expect(mintVersionHash(e)).toBe(PRE_CHANGE_HASH);
    const classified = run([ins(node("a", "h", "secret")), { type: "removeNode", nodeId: "a" }]);
    expect(mintVersionHash(classified)).not.toBe(mintVersionHash(run([])));
  });
});

describe("strictestClass is monotone for unknown classes (fail-closed)", () => {
  it("an unknown class outranks every known one", () => {
    expect(strictestClass("bogus" as never, "internal")).toBe("bogus");
    expect(strictestClass("secret", "bogus" as never)).toBe("bogus");
  });
});
