import { describe, expect, it } from "vitest";
import { validateExperience } from "./catalog";
import { compile } from "./compile";
import { type Experience, genesis } from "./experience";
import { type GraphProvider, type GraphStep, providerGraphFindings } from "./providerGraph";
import { testCatalog } from "./testCatalog.test-support";

const step = (stepId: string, dependsOn: string[] = [], args: unknown = {}): GraphStep => ({
  stepId,
  dependsOn,
  arguments: args,
});
const prov = (handle: string, executionGraph: GraphStep[]): GraphProvider => ({
  handle,
  executionGraph,
});
const codes = (p: Record<string, GraphProvider>) => providerGraphFindings(p).map((f) => f.code);
const tpl = (id: string, path = "") => `{{steps.${id}.output${path}}}`;

describe("providerGraphFindings", () => {
  it("accepts a consistent graph (chain + fan-in + templates on earlier steps)", () => {
    const g = [
      step("a"),
      step("b", ["a"], { x: tpl("a", ".rows[0].id") }),
      step("c", ["a"]),
      step("d", ["b", "c"], { nested: [{ y: tpl("b") }, tpl("c")] }),
    ];
    expect(providerGraphFindings({ H: prov("H", g) })).toEqual([]);
  });

  it("flags a handle mismatch (key vs spec.handle)", () => {
    expect(codes({ H1: prov("H2", [step("a")]) })).toEqual(["provider-handle-mismatch"]);
  });

  it("flags a duplicate step id", () => {
    expect(codes({ H: prov("H", [step("a"), step("a")]) })).toEqual(["provider-step-duplicate"]);
  });

  // case carried over from a consumer's governance suite: an unresolvable dependsOn
  it("flags a dangling dependsOn", () => {
    const f = providerGraphFindings({ H: prov("H", [step("x", ["ghost"])]) });
    expect(f.map((x) => x.code)).toEqual(["provider-dependency-unknown"]);
    // A WARN: the runtime treats an out-of-graph dependsOn as satisfied, so the plan still works.
    expect(f[0]?.severity).toBe("warn");
    expect(f[0]?.message).toContain("ghost");
  });

  it("caps findings per provider: 50k dangling deps -> 8 named + one exact aggregate", () => {
    const n = 50_000;
    const f = providerGraphFindings({
      H: prov("H", [
        step(
          "x",
          Array.from({ length: n }, (_, i) => `ghost${i}`)
        ),
      ]),
    });
    expect(f).toHaveLength(9);
    expect(f[8]?.message).toContain(`and ${n - 8} more`);
    expect(f.every((x) => x.code === "provider-dependency-unknown")).toBe(true);
    expect(providerGraphFindings({ H: prov("H", [step("x", ["g"])]) })).toHaveLength(1);
  });

  it("caps duplicate-step and template findings too, deterministically", () => {
    const dups = Array.from({ length: 30 }, (_, i) => [step(`d${i}`), step(`d${i}`)]).flat();
    const d = providerGraphFindings({ H: prov("H", dups) });
    expect(d).toHaveLength(9);
    expect(d[8]?.message).toContain("and 22 more");
    const refs = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, tpl(`g${i}`)]));
    const t = providerGraphFindings({ H: prov("H", [step("a", [], refs)]) });
    expect(t).toHaveLength(9);
    expect(t[8]?.message).toContain("and 22 more");
    expect(providerGraphFindings({ H: prov("H", [step("a", [], refs)]) })).toEqual(t);
  });

  // case carried over from a consumer's governance suite: a cyclic execution graph
  it("flags a two-step cycle", () => {
    expect(codes({ H: prov("H", [step("x", ["y"]), step("y", ["x"])]) })).toEqual([
      "provider-cycle",
    ]);
  });

  it("flags a self-dependency as a cycle", () => {
    expect(codes({ H: prov("H", [step("x", ["x"])]) })).toEqual(["provider-cycle"]);
  });

  it("reports a cycle once per provider, naming the steps behind it, not the healthy ones", () => {
    const f = providerGraphFindings({
      H: prov("H", [step("ok"), step("x", ["y"]), step("y", ["x"]), step("tail", ["x"])]),
    });
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain('"x"');
    expect(f[0]?.message).toContain('"tail"');
    expect(f[0]?.message).not.toContain('"ok"');
  });

  it("flags a template naming a step outside the graph", () => {
    expect(codes({ H: prov("H", [step("a", [], { q: tpl("ghost") })]) })).toEqual([
      "provider-template-unknown-step",
    ]);
  });

  it("flags a template naming a step that does not run earlier (no dependsOn)", () => {
    const g = [step("a"), step("b", [], { q: tpl("a") })];
    expect(codes({ H: prov("H", g) })).toEqual(["provider-template-unknown-step"]);
  });

  it("flags a self-referencing and a forward-referencing template", () => {
    const g = [
      step("a", [], { q: tpl("a") }),
      step("b", ["a"]),
      step("c", ["b"], { r: tpl("d") }),
      step("d", ["c"]),
    ];
    expect(codes({ H: prov("H", g) })).toEqual([
      "provider-template-unknown-step",
      "provider-template-unknown-step",
    ]);
  });

  it("accepts a transitive upstream reference", () => {
    const g = [step("a"), step("b", ["a"]), step("c", ["b"], { q: tpl("a") })];
    expect(providerGraphFindings({ H: prov("H", g) })).toEqual([]);
  });

  it("does not pile template findings on top of a cycle it already reported", () => {
    const g = [step("x", ["y"], { q: tpl("y") }), step("y", ["x"])];
    expect(codes({ H: prov("H", g) })).toEqual(["provider-cycle"]);
  });

  it("ignores text that is not a whole-string template", () => {
    const g = [step("a", [], { q: `prefix ${tpl("ghost")}`, n: 3, z: null })];
    expect(providerGraphFindings({ H: prov("H", g) })).toEqual([]);
  });

  it("is deterministic regardless of provider key insertion order", () => {
    const bad = (h: string) => prov(h, [step("x", ["y"]), step("y", ["x"])]);
    const a = providerGraphFindings({ B: bad("B"), A: bad("A") });
    const b = providerGraphFindings({ A: bad("A"), B: bad("B") });
    expect(a).toEqual(b);
    expect(a.map((f) => f.message.includes('"A"'))).toEqual([true, false]);
  });

  describe("deep inputs never blow the stack", () => {
    const N = 50_000;
    it("a 50k-step chain is clean; closing it into a ring is one provider-cycle", () => {
      const chain: GraphStep[] = [];
      for (let i = 0; i < N; i++) chain.push(step(`s${i}`, i === 0 ? [] : [`s${i - 1}`]));
      expect(providerGraphFindings({ H: prov("H", chain) })).toEqual([]);
      const ring = [step("s0", [`s${N - 1}`]), ...chain.slice(1)];
      const f = providerGraphFindings({ H: prov("H", ring) });
      expect(f.map((x) => x.code)).toEqual(["provider-cycle"]);
      expect(f[0]?.message).toContain(`${N} step(s)`);
    });

    it("a 50k-deep template argument tree is walked iteratively", () => {
      let args: unknown = tpl("ghost");
      for (let i = 0; i < N; i++) args = i % 2 === 0 ? { k: args } : [args];
      expect(codes({ H: prov("H", [step("a", [], args)]) })).toEqual([
        "provider-template-unknown-step",
      ]);
    });

    it("a wide 50k fan-in is linear and clean", () => {
      const g: GraphStep[] = [];
      const ids: string[] = [];
      for (let i = 0; i < N; i++) {
        g.push(step(`s${i}`));
        ids.push(`s${i}`);
      }
      g.push(step("sink", ids));
      expect(providerGraphFindings({ H: prov("H", g) })).toEqual([]);
    });
  });
});

describe("validateExperience wiring", () => {
  const base = () =>
    genesis({
      experienceId: "e",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-09-21T00:00:00Z", sourceKind: "prompt" },
    });
  const spec = (handle: string, executionGraph: GraphStep[]) => ({
    handle,
    executionGraph: executionGraph.map((s) => ({
      toolName: "t",
      toolVersion: "1",
      toolSchemaHash: "h",
      idempotent: true,
      ...s,
      dependsOn: s.dependsOn ?? [],
      arguments: (s.arguments ?? {}) as Record<string, unknown>,
    })),
    reshaping: { engine: "JSONPath" as const, scriptRef: "$" },
    outputShapeHash: "",
  });
  const withProviders = (providers: Record<string, ReturnType<typeof spec>>): Experience =>
    ({ ...base(), providers }) as Experience;
  const surface = "web" as const;

  it("a clean provider table adds nothing", () => {
    const r = validateExperience(
      withProviders({ H: spec("H", [step("a")]) }),
      testCatalog,
      surface
    );
    expect(r.findings.filter((f) => f.code.startsWith("provider-"))).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("a cycle is an error finding and ok is false", () => {
    const r = validateExperience(
      withProviders({ H: spec("H", [step("x", ["y"]), step("y", ["x"])]) }),
      testCatalog,
      surface
    );
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("provider-cycle");
  });

  it("an out-of-graph dependsOn is a warn: the experience still validates ok", () => {
    const r = validateExperience(
      withProviders({ H: spec("H", [step("x", ["ghost"])]) }),
      testCatalog,
      surface
    );
    const f = r.findings.filter((x) => x.code === "provider-dependency-unknown");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("warn");
    expect(r.ok).toBe(true);
  });

  it("legacy data still loads: a violating experience compiles (ok:false) and still yields a blueprint", () => {
    const e = withProviders({ H: spec("H", [step("x", ["y"]), step("y", ["x"])]) });
    const r = compile(e, {
      catalog: testCatalog,
      surface,
      hydrationProjectionId: "hydration",
      hydrationProjectionVersion: "1",
    } as never);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("provider-cycle");
    expect(r.blueprint).toBeDefined();
  });
});
