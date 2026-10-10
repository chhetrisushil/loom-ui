import { RendererRegistry } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { defineSemanticCatalog } from "./catalog";
import { type CompileOptions, compile } from "./compile";
import { type CompileMemo, createCompileMemo, defaultCompileMemo } from "./compileMemo";
import { declareHandle } from "./declareHandle.test-support";
import { genesis } from "./experience";
import { seal } from "./log";
import type { SemanticNode } from "./node";
import { replay } from "./operations";
import { testCatalog } from "./testCatalog.test-support";

const meta = { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" };
const metric = (id: string, handle: string, sensitivity?: "secret"): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 4,
  props: {},
  label: { key: `l.${id}`, fallback: `Label ${id}` },
  binding: { handle, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const build = (objective: string, secret = false) => {
  const r = replay(genesis({ experienceId: "e", intent: { objective, source: "user" }, meta }), [
    declareHandle("h1"),
    declareHandle("h2"),
    { type: "insertNode", parentId: "root", node: metric("a", "h1") },
    {
      type: "insertNode",
      parentId: "root",
      node: metric("b", "h2", secret ? "secret" : undefined),
    },
  ]);
  if (!r.ok) throw new Error(r.finding.message);
  return seal(r.value);
};
const exp = build("one");
const KEY = "0123456789abcdef0123456789abcdef";
const base = (memo: CompileMemo): CompileOptions => ({
  surface: "web",
  catalog: testCatalog,
  hydrationProjectionId: "hydration",
  hydrationProjectionVersion: "1.0.0",
  viewer: { clearance: "secret" },
  placeholderKey: KEY,
  memo,
});

describe("compile memo", () => {
  it("hits on the same version and options, and equals an uncached compile", () => {
    const memo = createCompileMemo();
    const first = compile(exp, base(memo));
    const second = compile(exp, base(memo));
    expect([memo.hits, memo.misses, memo.size]).toEqual([1, 1, 1]);
    expect(second).toEqual(first);
    expect(second).toEqual(compile(exp, { ...base(memo), memo: false }));
  });

  it("memo: false never touches a memo; the default memo is used when unset", () => {
    const memo = createCompileMemo();
    compile(exp, { ...base(memo), memo: false });
    compile(exp, { ...base(memo), memo: false });
    expect([memo.hits, memo.misses, memo.size]).toEqual([0, 0, 0]);
    const before = defaultCompileMemo.hits + defaultCompileMemo.misses;
    const { memo: _m, ...noMemo } = base(memo);
    compile(exp, noMemo);
    expect(defaultCompileMemo.hits + defaultCompileMemo.misses).toBe(before + 1);
  });

  it("an unsealed experience is never memoized", () => {
    const memo = createCompileMemo();
    const unsealed = { ...exp, versionHash: "" };
    compile(unsealed, base(memo));
    compile(unsealed, base(memo));
    expect([memo.hits, memo.misses, memo.size]).toEqual([0, 0, 0]);
  });

  describe("misses on every key component", () => {
    const miss = (change: (memo: CompileMemo) => CompileOptions, e = exp) => {
      const memo = createCompileMemo();
      compile(exp, base(memo));
      const other = compile(e, change(memo));
      expect(memo.hits).toBe(0);
      expect(memo.misses).toBe(2);
      return other;
    };
    it("version", () => {
      const next = build("two");
      const r = miss((m) => base(m), next);
      expect(r.blueprint.title).toBe("two");
    });
    it("surface", () => void miss((m) => ({ ...base(m), surface: "terminal" })));
    it("catalog identity", () =>
      void miss((m) => ({ ...base(m), catalog: defineSemanticCatalog({ ...testCatalog }) })));
    it("hydration projection id and version", () => {
      miss((m) => ({ ...base(m), hydrationProjectionId: "other" }));
      miss((m) => ({ ...base(m), hydrationProjectionVersion: "2.0.0" }));
    });
    it("viewer clearance (a restricted viewer never gets the privileged copy)", () => {
      const sec = build("one", true);
      const memo = createCompileMemo();
      const full = compile(sec, base(memo));
      const low = compile(sec, { ...base(memo), viewer: { clearance: "internal" } });
      const { viewer: _v, ...noViewer } = base(memo);
      const none = compile(sec, noViewer);
      expect(memo.hits).toBe(0);
      expect(JSON.stringify(low.blueprint)).not.toEqual(JSON.stringify(full.blueprint));
      expect(low.restrictedHandles).toEqual(["h2"]);
      expect(none.findings.some((f) => f.code === "viewer-not-supplied")).toBe(true);
    });
    it("placeholderKey bytes", () => {
      const sec = build("one", true);
      const memo = createCompileMemo();
      const low = { ...base(memo), viewer: { clearance: "internal" as const } };
      const a = compile(sec, low);
      const b = compile(sec, { ...low, placeholderKey: "fedcba9876543210fedcba9876543210" });
      expect(memo.hits).toBe(0);
      expect(a.fingerprint.placeholderNodes).not.toEqual(b.fingerprint.placeholderNodes);
    });
    it("title, restrictedLabel, undeclared, requirePlaceholderKey", () => {
      miss((m) => ({ ...base(m), title: { key: "t", fallback: "T" } }));
      miss((m) => ({ ...base(m), title: { omit: true } }));
      miss((m) => ({ ...base(m), restrictedLabel: { key: "r", fallback: "R" } }));
      miss((m) => ({ ...base(m), undeclared: "deny", declaredToolClasses: {} }));
      miss((m) => ({ ...base(m), requirePlaceholderKey: true }));
    });
    it("declaredToolClasses by CONTENT, not identity", () => {
      const memo = createCompileMemo();
      const table: Record<string, "secret"> = {};
      compile(exp, { ...base(memo), declaredToolClasses: table });
      compile(exp, { ...base(memo), declaredToolClasses: { ...table } });
      expect(memo.hits).toBe(1); // an equal rebuilt table is the same input
      compile(exp, { ...base(memo), declaredToolClasses: { other: "secret" } });
      expect(memo.hits).toBe(1);
    });
    it("projections by content", () => {
      miss((m) => ({
        ...base(m),
        projections: [{ id: "p", version: "1" } as never],
      }));
    });
    it("a custom resolveLabel is memoized only with a resolveLabelKey, per key", () => {
      const memo = createCompileMemo();
      const upper = (l: { fallback: string }) => l.fallback.toUpperCase();
      compile(exp, { ...base(memo), resolveLabel: upper });
      compile(exp, { ...base(memo), resolveLabel: upper });
      expect(memo.size).toBe(0); // opaque function, no key: not memoized
      compile(exp, { ...base(memo), resolveLabel: upper, resolveLabelKey: "en" });
      compile(exp, { ...base(memo), resolveLabel: upper, resolveLabelKey: "en" });
      expect(memo.hits).toBe(1);
      compile(exp, {
        ...base(memo),
        resolveLabel: (l) => `[fr] ${l.fallback}`,
        resolveLabelKey: "fr",
      });
      expect(memo.hits).toBe(1);
      expect(memo.size).toBe(2);
    });
    it("the same resolveLabelKey on two DIFFERENT resolvers never cross-serves", () => {
      const memo = createCompileMemo();
      const a = compile(exp, {
        ...base(memo),
        resolveLabel: (l) => `A ${l.fallback}`,
        resolveLabelKey: "en",
      });
      const b = compile(exp, {
        ...base(memo),
        resolveLabel: (l) => `B ${l.fallback}`,
        resolveLabelKey: "en",
      });
      expect(memo.hits).toBe(0);
      expect(JSON.stringify(a.blueprint)).toContain("A Label");
      expect(JSON.stringify(b.blueprint)).toContain("B Label");
      expect(JSON.stringify(b.blueprint)).not.toContain("A Label");
    });
    it("a registry disables the memo", () => {
      const memo = createCompileMemo();
      const registry = new RendererRegistry<unknown>();
      compile(exp, { ...base(memo), registry });
      compile(exp, { ...base(memo), registry });
      expect(memo.size).toBe(0);
    });
  });

  it("a reloaded-equal copy is a plain compile and does not evict the held object's entry", () => {
    const memo = createCompileMemo();
    compile(exp, base(memo));
    const reloaded = structuredClone(exp);
    const r = compile(reloaded, base(memo));
    expect([memo.hits, memo.misses]).toEqual([0, 2]);
    expect(r).toEqual(compile(exp, { ...base(memo), memo: false }));
    compile(exp, base(memo)); // the holder still hits
    expect(memo.hits).toBe(1);
  });

  it("a stale-hash spread cannot displace the genuine entry", () => {
    const memo = createCompileMemo();
    compile(exp, base(memo));
    compile({ ...exp, intent: { objective: "forged", source: "user" as const } }, base(memo));
    compile(exp, base(memo));
    expect(memo.hits).toBe(1);
  });

  it("a stale-hash spread (same hash, different content) is a miss, not a stale hit", () => {
    const memo = createCompileMemo();
    compile(exp, base(memo));
    const forged = { ...exp, intent: { objective: "forged", source: "user" as const } };
    const r = compile(forged, base(memo));
    expect(memo.hits).toBe(0);
    expect(r.blueprint.title).toBe("forged");
  });

  it("evicts the least recently used entry past max", () => {
    const memo = createCompileMemo({ max: 2 });
    const [a, b, c] = ["a", "b", "c"].map((o) => build(o));
    if (!a || !b || !c) throw new Error("fixture");
    compile(a, base(memo));
    compile(b, base(memo));
    compile(a, base(memo)); // a is now the most recent
    expect(memo.hits).toBe(1);
    compile(c, base(memo)); // evicts b
    expect(memo.size).toBe(2);
    compile(a, base(memo));
    expect(memo.hits).toBe(2);
    compile(b, base(memo));
    expect(memo.hits).toBe(2); // b was evicted
  });

  it("a bad max falls back to the default cap", () => {
    expect(createCompileMemo({ max: 0 }).max).toBe(32);
    expect(createCompileMemo().max).toBe(32);
  });

  it("a caller mutating a result cannot poison the cache or another caller", () => {
    const memo = createCompileMemo();
    const first = compile(exp, base(memo)); // the miss
    const pristine = JSON.stringify(first);
    (first.findings as unknown[]).push({ code: "poison" });
    (first.fingerprint.placeholderNodes as string[]).push("x");
    (first.blueprint as { title: string }).title = "hacked";
    const second = compile(exp, base(memo)); // a hit
    expect(JSON.stringify(second)).toBe(
      JSON.stringify(compile(exp, { ...base(memo), memo: false }))
    );
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
    (second.blueprint as { title: string }).title = "hacked2";
    const third = compile(exp, base(memo));
    expect(JSON.stringify(third)).toBe(pristine);
    expect(third.blueprint).not.toBe(second.blueprint);
  });

  it("a throw is never remembered", () => {
    const memo = createCompileMemo();
    const sec = build("one", true);
    const { placeholderKey: _k, ...rest } = base(memo);
    const o = { ...rest, viewer: { clearance: "internal" as const }, requirePlaceholderKey: true };
    expect(() => compile(sec, o)).toThrow();
    expect(() => compile(sec, o)).toThrow();
    expect(memo.size).toBe(0);
  });
});
