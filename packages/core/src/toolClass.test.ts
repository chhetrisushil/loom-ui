import { describe, expect, it } from "vitest";
import { type Experience, type ProviderSpec, genesis } from "./experience";
import { experienceHandles } from "./handles";
import { mintVersionHash } from "./log";
import type { ContainerNode, SemanticNode } from "./node";
import { type Operation, apply, applyAt, replay } from "./operations";

// U10 fix round 2: classification is TOOL-LEVEL and FAIL-CLOSED, declassify needs authority, and
// the content address of an experience whose classes its live nodes imply is unchanged.

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
const spec = (handle: string, tool = "pay"): ProviderSpec => ({
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
const ins = (n: SemanticNode): Operation => ({ type: "insertNode", parentId: "root", node: n });
const remap = (handle: string, tool?: string): Operation => ({
  type: "remapProvider",
  handle,
  spec: spec(handle, tool),
});
const run = (ops: Operation[], from = base(), opts?: { allowDeclassify?: boolean }) => {
  const r = replay(from, ops, opts);
  if (!r.ok) throw new Error(r.finding.message);
  return r.value;
};
const classOf = (e: Experience, h: string) =>
  experienceHandles(e).find((u) => u.handle === h)?.sensitivity;

describe("a tool's class sticks to the tool (fail-closed)", () => {
  // classified h1 on `pay`; the node and the provider are then both retired
  const retired = () =>
    run([
      remap("h1"),
      ins(node("a", "h1", "secret")),
      { type: "removeNode", nodeId: "a" },
      { type: "removeProvider", handle: "h1" },
    ]);

  it("a NEW handle on that tool inherits the strictest class, whatever it is called", () => {
    const e = run([remap("h2"), ins(node("b", "h2"))], retired());
    expect(classOf(e, "h2")).toBe("secret");
  });

  it("inherits when the node is inserted before the provider is remapped", () => {
    const e = run([ins(node("b", "h2")), remap("h2")], retired());
    expect(classOf(e, "h2")).toBe("secret");
  });

  it("a handle on a DIFFERENT tool is unaffected", () => {
    const e = run([remap("h3", "other"), ins(node("c", "h3"))], retired());
    expect(classOf(e, "h3")).toBeUndefined();
  });

  it("an existing unclassified handle on the tool is not retroactively classified", () => {
    const e = run([
      remap("pub"),
      ins(node("p", "pub")),
      remap("h1"),
      ins(node("a", "h1", "secret")),
    ]);
    expect(classOf(e, "pub")).toBeUndefined();
    expect(classOf(e, "h1")).toBe("secret");
  });

  it("the class follows a LIVE sibling too (no removal needed)", () => {
    const e = run([remap("h1"), ins(node("a", "h1", "secret")), remap("h2"), ins(node("b", "h2"))]);
    expect(classOf(e, "h2")).toBe("secret");
  });

  it("an explicit declassify of the handle alone is not enough while the tool still carries it", () => {
    let e = run([remap("h2"), ins(node("b", "h2"))], retired());
    e = run([{ type: "declassifyHandle", handle: "h2" }], e, { allowDeclassify: true });
    // the handle's own entry is gone; the tool's class re-applies on the next remap
    e = run([remap("h2")], e);
    expect(classOf(e, "h2")).toBe("secret");
  });

  it("declassify with tool:true lowers the tool: a later new handle is clean", () => {
    let e = run([remap("h2"), ins(node("b", "h2"))], retired());
    e = run([{ type: "declassifyHandle", handle: "h2", tool: true }], e, { allowDeclassify: true });
    expect(classOf(e, "h2")).toBeUndefined();
    e = run([remap("h4"), ins(node("d", "h4"))], e);
    expect(classOf(e, "h4")).toBeUndefined();
  });

  it("tool:true can lower to a class instead of clearing", () => {
    let e = run([remap("h2"), ins(node("b", "h2"))], retired());
    e = run([{ type: "declassifyHandle", handle: "h2", to: "internal", tool: true }], e, {
      allowDeclassify: true,
    });
    e = run([remap("h4"), ins(node("d", "h4"))], e);
    expect(classOf(e, "h4")).toBe("internal");
  });
});

describe("the content address moves only when new information is stored", () => {
  // literals minted by MAIN's dist (no class map, no tool classes) for the same op sequences
  const MAIN_ONE_CLASSIFIED =
    "sha256:4514189e0eb142f01c720bacf22cc9b93e261a509ef3250711cd5623f6a4155d";
  const MAIN_PROVIDER_PLUS_NODES =
    "sha256:5cc4414c711821d2f73b278aaf096ed60e4a000bf3a8f7b6a7a5b3f187961dbc";

  it("genesis + one classified insertNode hashes exactly as on main", () => {
    expect(mintVersionHash(run([ins(node("a", "h", "secret"))]))).toBe(MAIN_ONE_CLASSIFIED);
  });

  it("a provider + classified node + weaker sibling hashes exactly as on main", () => {
    const e = run([remap("h"), ins(node("a", "h", "secret")), ins(node("b", "h"))]);
    expect(mintVersionHash(e)).toBe(MAIN_PROVIDER_PLUS_NODES);
  });

  it("the only case a hash changes: a class that no live node implies any more", () => {
    const kept = run([ins(node("a", "h", "secret")), { type: "removeNode", nodeId: "a" }]);
    expect(mintVersionHash(kept)).not.toBe(mintVersionHash(run([])));
  });
});

describe("declassify needs authority", () => {
  const classified = () => run([ins(node("a", "h", "secret"))]);
  const decl: Operation = { type: "declassifyHandle", handle: "h" };

  it("apply refuses a bare declassify and leaves the experience unchanged", () => {
    const e = classified();
    const r = apply(e, decl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.finding.code).toBe("declassify-not-allowed");
    expect(classOf(e, "h")).toBe("secret");
  });

  it("replay refuses one inside a log (an untrusted planner's PlanResult.ops)", () => {
    const r = replay(classified(), [decl]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.finding.code).toBe("declassify-not-allowed");
  });

  it("applyAt refuses too, and forwards the authority when given", () => {
    expect(applyAt(classified(), decl).ok).toBe(false);
    const r = applyAt(classified(), decl, { allowDeclassify: true });
    expect(r.ok && classOf(r.value, "h")).toBeFalsy();
  });

  it("a trusted caller passing allowDeclassify lowers it", () => {
    const r = apply(classified(), decl, { allowDeclassify: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(classOf(r.value, "h")).toBeUndefined();
  });

  it("a recorded log containing an authorised declassify replays under the same authority", () => {
    const log: Operation[] = [ins(node("a", "h", "secret")), decl, ins(node("b", "h"))];
    expect(replay(base(), log).ok).toBe(false);
    const e = run(log, base(), { allowDeclassify: true });
    expect(classOf(e, "h")).toBeUndefined();
  });

  it("the authority is not an op field: a marker minted in the op is ignored", () => {
    const forged = { ...decl, allowDeclassify: true, authorizedBy: "me" } as unknown as Operation;
    expect(apply(classified(), forged).ok).toBe(false);
  });
});

describe("a LEGACY experience (classified node, no stored class map)", () => {
  const legacy = (): Experience => {
    const b = base();
    return { ...b, root: { ...(b.root as ContainerNode), children: [node("a", "h", "secret")] } };
  };

  it("removeNode keeps the class with the handle", () => {
    const e = run([{ type: "removeNode", nodeId: "a" }, ins(node("b", "h"))], legacy());
    expect(classOf(e, "h")).toBe("secret");
  });

  it("bindProvider away keeps the class on the handle it left", () => {
    const e = run(
      [{ type: "bindProvider", nodeId: "a", handle: "h2" }, ins(node("c", "h"))],
      legacy()
    );
    expect(classOf(e, "h")).toBe("secret");
    expect(classOf(e, "h2")).toBe("secret");
  });
});
