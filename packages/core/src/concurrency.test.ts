import { canonicalJson } from "@loom/core";
import { describe, expect, it } from "vitest";
import { genesis } from "./experience";
import { mintVersionHash, seal } from "./log";
import type { ContainerNode, SemanticNode } from "./node";
import { type Operation, type RecordedOperation, apply, applyAt, replay } from "./operations";
import { orderKeyAfterAll, orderKeyBetween } from "./order";

const meta = { author: "alice", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const g = genesis({ experienceId: "exp-1", intent: { objective: "x", source: "user" }, meta });
const metric = (id: string, order: string): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
});
const ids = (e: { root: { kind: string } }) =>
  ((e.root as ContainerNode).children as SemanticNode[]).map((c) => c.id);

describe("concurrent order keys", () => {
  it("two authors minting for the same gap get distinct keys, both strictly between", () => {
    const [a, b] = ["a", "c"] as const;
    const alice = orderKeyBetween(a, b, { salt: "alice" });
    const bob = orderKeyBetween(a, b, { salt: "bob" });
    expect(alice).not.toBe(bob);
    for (const k of [alice, bob]) {
      expect(k > a && k < b).toBe(true);
      expect(k).toMatch(/^[0-9A-Za-z]+$/);
    }
    // deterministic per author
    expect(orderKeyBetween(a, b, { salt: "alice" })).toBe(alice);
  });
  it("salted keys stay strictly between across many gaps and authors, and can be split again", () => {
    const gaps: Array<[string | null, string | null]> = [
      [null, null],
      [null, "1"],
      ["a", "b"],
      ["a", "a1"],
      ["Vz", "W"],
      ["y", null],
    ];
    for (const [a, b] of gaps)
      for (const salt of ["alice", "bob", "agent-7", "x"]) {
        const k = orderKeyBetween(a, b, { salt });
        expect(a === null || k > a).toBe(true);
        expect(b === null || k < b).toBe(true);
        // a later insert at either side of the minted key still works
        const lo = orderKeyBetween(a, k, { salt: "other" });
        const hi = orderKeyBetween(k, b, { salt: "other" });
        expect(a === null || lo > a).toBe(true);
        expect(lo < k && k < hi).toBe(true);
        expect(b === null || hi < b).toBe(true);
      }
  });
  it("no salt keeps the legacy key exactly", () => {
    expect(orderKeyBetween("a", "c")).toBe("b");
    expect(orderKeyBetween("a", "c", {})).toBe("b");
    expect(orderKeyBetween("a", "c", { salt: "" })).toBe("b");
    expect(orderKeyAfterAll([])).toBe(orderKeyBetween(null, null));
  });
  it("orderKeyAfterAll takes a salt", () => {
    const sib = [{ order: "V" }];
    expect(orderKeyAfterAll(sib, { salt: "alice" })).not.toBe(
      orderKeyAfterAll(sib, { salt: "bob" })
    );
    expect(orderKeyAfterAll(sib, { salt: "alice" }) > "V").toBe(true);
  });
  it("both concurrent inserts into one gap survive, in a stable order", () => {
    const base = replay(g, [
      { type: "insertNode", parentId: "root", node: metric("l", "a") },
      { type: "insertNode", parentId: "root", node: metric("r", "c") },
    ]);
    if (!base.ok) throw new Error("base");
    const x = metric("x", orderKeyBetween("a", "c", { salt: "alice" }));
    const y = metric("y", orderKeyBetween("a", "c", { salt: "bob" }));
    const xy = replay(base.value, [
      { type: "insertNode", parentId: "root", node: x },
      { type: "insertNode", parentId: "root", node: y },
    ]);
    const yx = replay(base.value, [
      { type: "insertNode", parentId: "root", node: y },
      { type: "insertNode", parentId: "root", node: x },
    ]);
    if (!xy.ok || !yx.ok) throw new Error("fold");
    expect(ids(xy.value)).toEqual(ids(yx.value));
    expect(mintVersionHash(xy.value)).toBe(mintVersionHash(yx.value));
    expect(ids(xy.value)[0]).toBe("l");
    expect(ids(xy.value)[3]).toBe("r");
  });
  it("an experience built from old-format keys seals to its pinned versionHash", () => {
    const r = replay(g, [
      { type: "insertNode", parentId: "root", node: metric("m1", "V") },
      { type: "insertNode", parentId: "root", node: metric("m2", orderKeyBetween("V", null)) },
    ]);
    if (!r.ok) throw new Error("fold");
    expect(seal(r.value).versionHash).toBe(
      "sha256:b6b4d7285a534d79e8999a058f4cd6dc72fa7659e5f3d504ed54ad92d0b56a32"
    );
  });
});

describe("applyAt base-version precondition", () => {
  const sealed = seal(g);
  const op: Operation = { type: "insertNode", parentId: "root", node: metric("m1", "V") };
  it("a matching base applies", () => {
    const r = applyAt(sealed, op, { baseVersion: sealed.versionHash });
    expect(r.ok).toBe(true);
  });
  it("a stale base is a finding, never a throw, and the experience is unchanged", () => {
    const before = JSON.stringify(sealed);
    const r = applyAt(sealed, op, { baseVersion: "sha256:old" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.finding.code).toBe("stale-base-version");
      expect(r.finding.severity).toBe("error");
    }
    expect(JSON.stringify(sealed)).toBe(before);
  });
  it("a declared base against an unsealed artifact is refused", () => {
    const mid = apply(sealed, op);
    if (!mid.ok) throw new Error("apply");
    const r = applyAt(mid.value, op, { baseVersion: sealed.versionHash });
    expect(r.ok === false && r.finding.code).toBe("stale-base-version");
  });
  it("no base declared = last-writer-wins, identical to apply", () => {
    const a = applyAt(sealed, op);
    const b = apply(sealed, op);
    expect(a).toEqual(b);
    expect(applyAt(sealed, op, {})).toEqual(b);
  });
  it("two authors on one base: the second, now stale, is refused", () => {
    const first = applyAt(sealed, op, { baseVersion: sealed.versionHash });
    if (!first.ok) throw new Error("first");
    const v2 = seal(first.value);
    const second = applyAt(
      v2,
      { type: "removeNode", nodeId: "m1" },
      { baseVersion: sealed.versionHash }
    );
    expect(second.ok).toBe(false);
  });
  it("replay of a recorded op log reproduces the same experience and hash", () => {
    const log: Operation[] = [
      op,
      { type: "insertNode", parentId: "root", node: metric("m2", "W") },
      { type: "setProps", nodeId: "m1", patch: { unit: "ms" } },
    ];
    const a = replay(g, log);
    const b = replay(g, JSON.parse(JSON.stringify(log)));
    if (!a.ok || !b.ok) throw new Error("replay");
    expect(a.value).toEqual(b.value);
    expect(mintVersionHash(a.value)).toBe(mintVersionHash(b.value));
  });
});

describe("RecordedOperation.baseVersion in the op log", () => {
  const op: Operation = { type: "removeNode", nodeId: "m1" };
  const by = { kind: "user", id: "alice" } as unknown as RecordedOperation["by"];
  it("an undefined baseVersion encodes byte-identically to an absent one; a declared one is carried", () => {
    const absent: RecordedOperation = { op, by, at: "2026-09-21T00:00:00Z" };
    const undef = { ...absent, baseVersion: undefined } as unknown as RecordedOperation;
    expect(canonicalJson(undef)).toBe(canonicalJson(absent));
    expect(canonicalJson([undef])).toBe(canonicalJson([absent]));
    expect(canonicalJson({ ...absent, baseVersion: "sha256:a" })).toContain('"baseVersion"');
  });
});
