import { describe, expect, it } from "vitest";
import { validateExperience } from "./catalog";
import { describeChange } from "./change";
import { declareHandle } from "./declareHandle.test-support";
import { genesis } from "./experience";
import { mintVersionHash, seal } from "./log";
import { type SemanticNode, findNode } from "./node";
import { type Operation, apply, replay } from "./operations";
import { testCatalog } from "./testCatalog.test-support";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const g = genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta });
const metric = (id: string, extra: Partial<SemanticNode> = {}): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  ...extra,
});
const ins = (n: SemanticNode): Operation => ({ type: "insertNode", parentId: "root", node: n });
const must = (r: ReturnType<typeof apply>) => {
  if (!r.ok) throw new Error(r.finding.message);
  return r.value;
};
const sem = (e: typeof g, id: string) => findNode(e.root, id) as SemanticNode;
const label = { key: "k", fallback: "p99" };

describe("setLabel { label: null } clears", () => {
  it("removes the key, so the node hashes as if it was never labelled", () => {
    const plain = must(replay(g, [ins(metric("m"))]));
    const labelled = must(apply(plain, { type: "setLabel", nodeId: "m", label }));
    const cleared = must(apply(labelled, { type: "setLabel", nodeId: "m", label: null }));
    expect("label" in sem(cleared, "m")).toBe(false);
    expect(mintVersionHash(cleared)).toBe(mintVersionHash(plain));
    expect(mintVersionHash(labelled)).not.toBe(mintVersionHash(plain));
  });
  it("is idempotent on an unlabelled node, and still refuses a container or a missing node", () => {
    const e = must(replay(g, [ins(metric("m"))]));
    expect(apply(e, { type: "setLabel", nodeId: "m", label: null }).ok).toBe(true);
    const onRoot = apply(e, { type: "setLabel", nodeId: "root", label: null });
    expect(!onRoot.ok && onRoot.finding.code).toBe("not-semantic");
    const gone = apply(e, { type: "setLabel", nodeId: "zz", label: null });
    expect(!gone.ok && gone.finding.code).toBe("missing-node");
  });
  it("round-trips through the Operation schema and the log JSON (null survives)", () => {
    const e = must(replay(g, [ins(metric("m", { label }))]));
    const op = JSON.parse(JSON.stringify({ type: "setLabel", nodeId: "m", label: null }));
    expect("label" in sem(must(apply(e, op)), "m")).toBe(false);
  });
  it("describeChange reports the cleared label as an edit", () => {
    const a = seal(must(replay(g, [ins(metric("m", { label }))])));
    const b = seal(must(apply(a, { type: "setLabel", nodeId: "m", label: null })));
    expect(
      describeChange(a, b, { viewer: { clearance: "secret" } }).entries.map((e) => e.kind)
    ).toEqual(["node-edited"]);
  });
});

describe("unbindProvider", () => {
  const bound = () =>
    must(
      replay(g, [
        declareHandle("h"),
        ins(metric("m", { binding: { handle: "h", priority: "P0" } })),
      ])
    );
  it("removes the binding and leaves the provider declared, so removeProvider then succeeds", () => {
    const e = must(apply(bound(), { type: "unbindProvider", nodeId: "m" }));
    expect(sem(e, "m").binding).toBeUndefined();
    expect("binding" in sem(e, "m")).toBe(false);
    expect(Object.keys(e.providers)).toEqual(["h"]);
    expect(apply(bound(), { type: "removeProvider", handle: "h" }).ok).toBe(false);
    expect(apply(e, { type: "removeProvider", handle: "h" }).ok).toBe(true);
  });
  it("a bind then unbind hashes as the never-bound node", () => {
    const plain = must(replay(g, [declareHandle("h"), ins(metric("m"))]));
    const round = must(
      replay(plain, [
        { type: "bindProvider", nodeId: "m", handle: "h" },
        { type: "unbindProvider", nodeId: "m" },
      ])
    );
    expect(mintVersionHash(round)).toBe(mintVersionHash(plain));
  });
  it("never declassifies: the class the node carried stays on the handle", () => {
    const e = must(
      replay(g, [
        declareHandle("h"),
        ins(metric("m", { binding: { handle: "h", priority: "P1", sensitivity: "secret" } })),
        { type: "unbindProvider", nodeId: "m" },
        ins(metric("n", { binding: { handle: "h", priority: "P1" } })),
      ])
    );
    expect(e.handleClasses).toEqual({ h: "secret" });
  });
  it("is refused on a container, a missing node, an unbound node and a projection-bound node", () => {
    const code = (e: typeof g, nodeId: string) => {
      const r = apply(e, { type: "unbindProvider", nodeId });
      return r.ok ? "ok" : r.finding.code;
    };
    const e = bound();
    expect(code(e, "root")).toBe("not-semantic");
    expect(code(e, "zz")).toBe("missing-node");
    const projected = must(
      replay(e, [
        ins(metric("p")),
        {
          type: "bindProjection",
          nodeId: "p",
          projection: { id: "agent-status", version: "1", path: "x" },
        },
      ])
    );
    expect(code(projected, "p")).toBe("not-bound");
    expect(code(must(replay(g, [ins(metric("u"))])), "u")).toBe("not-bound");
  });
  it("describeChange reports a node-rebound", () => {
    const a = seal(bound());
    const b = seal(must(apply(a, { type: "unbindProvider", nodeId: "m" })));
    expect(
      describeChange(a, b, { viewer: { clearance: "secret" } }).entries.map((x) => x.kind)
    ).toContain("node-rebound");
  });
  it("validates as a binding-required node with no binding (a finding, not a throw)", () => {
    const e = must(apply(bound(), { type: "unbindProvider", nodeId: "m" }));
    const f = validateExperience(e, testCatalog, "web").findings;
    expect(f.some((x) => x.nodeId === "m")).toBe(true);
  });
});

describe("bindProvider refuses an undeclared handle", () => {
  const e = must(replay(g, [ins(metric("m"))]));
  it("typed missing-provider, naming the node, and the base is untouched", () => {
    const r = apply(e, { type: "bindProvider", nodeId: "m", handle: "nope" });
    expect(!r.ok && r.finding).toMatchObject({ code: "missing-provider", nodeId: "m" });
    expect(sem(e, "m").binding).toBeUndefined();
  });
  it("a handle declared earlier in the SAME op list is accepted (providers first)", () => {
    const r = replay(e, [declareHandle("h"), { type: "bindProvider", nodeId: "m", handle: "h" }]);
    expect(r.ok && sem(r.value, "m").binding?.handle).toBe("h");
  });
  it("declared AFTER the bind in the list is refused, and replay names the op index", () => {
    const r = replay(e, [{ type: "bindProvider", nodeId: "m", handle: "h" }, declareHandle("h")]);
    expect(!r.ok && r.finding.message).toContain("op #0 (bindProvider)");
  });
  it("inside a prompt's materialized ops it is refused the same way", () => {
    const r = apply(e, {
      type: "prompt",
      text: "t",
      materialized: [{ type: "bindProvider", nodeId: "m", handle: "nope" }],
    });
    expect(!r.ok && r.finding.code).toBe("missing-provider");
  });
  it("an inherited Object.prototype name is not a declared provider", () => {
    const r = apply(e, { type: "bindProvider", nodeId: "m", handle: "toString" });
    expect(!r.ok && r.finding.code).toBe("missing-provider");
  });
  it("a retired provider can no longer be bound", () => {
    const gone = must(replay(e, [declareHandle("h"), { type: "removeProvider", handle: "h" }]));
    expect(apply(gone, { type: "bindProvider", nodeId: "m", handle: "h" }).ok).toBe(false);
  });
});

describe("bindProvider re-pin of the node's current handle", () => {
  it("is accepted on write even when that handle was never declared; a NEW undeclared handle is refused unless legacyBind", () => {
    const legacy = must(
      replay(g, [ins(metric("m", { binding: { handle: "ghost", priority: "P1" } }))])
    );
    const repin = apply(legacy, {
      type: "bindProvider",
      nodeId: "m",
      handle: "ghost",
      priority: "P0",
    });
    expect(repin.ok).toBe(true);
    const fresh = apply(legacy, { type: "bindProvider", nodeId: "m", handle: "other" });
    expect(!fresh.ok && fresh.finding.code).toBe("missing-provider");
    expect(
      apply(legacy, { type: "bindProvider", nodeId: "m", handle: "other" }, { legacyBind: true }).ok
    ).toBe(true);
  });
});
