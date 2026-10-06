import { isContainer } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { checkPlannerConformance } from "./conformance";
import { ReferencePlanner } from "./reference";
import type { Planner } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
  stampingScope,
  streamingScriptedModel,
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

describe("checkPlannerConformance", () => {
  it("the reference planner on a scripted model passes with zero findings", async () => {
    const model = scriptedModel([compose, revise]);
    const planner = new ReferencePlanner({ model, modelId: "m" });
    const findings = await checkPlannerConformance(planner, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add an insight" },
      ctx: recordingContext(),
      modelCalls: () => model.calls,
    });
    expect(findings).toEqual([]);
  });
  it("a planner that returns an experience-shaped blob instead of ops fails with op-invalid", async () => {
    const bad: Planner = {
      compose: async () => ({
        ops: [{ type: "setExperience" } as never],
        findings: [],
        report: { decisionId: "x", attempts: [], firstAttemptValid: true, modelId: "bad" },
      }),
      revise: async () => ({
        ops: [],
        findings: [],
        report: { decisionId: "y", attempts: [], firstAttemptValid: true, modelId: "bad" },
      }),
    };
    const findings = await checkPlannerConformance(bad, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    expect(findings.map((f) => f.code)).toContain("op-invalid");
  });
  it("a revise that returns primitives instead of one prompt op fails with revise-not-prompt; a prompt whose materialized does not reproduce the artifact fails with prompt-replay-mismatch", async () => {
    const primitives: Planner = {
      compose: (i, ctx) =>
        new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" }).compose(i, ctx),
      revise: async (input) => {
        const root = input.experience.root;
        if (!isContainer(root)) throw new Error("experience root is not a container");
        return {
          ops: [{ type: "removeNode", nodeId: root.children[0]!.id }],
          findings: [],
          report: { decisionId: "y", attempts: [], firstAttemptValid: true, modelId: "m" },
        };
      },
    };
    const f1 = await checkPlannerConformance(primitives, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    expect(f1.map((f) => f.code)).toContain("revise-not-prompt");
    const lying: Planner = {
      compose: (i, ctx) =>
        new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" }).compose(i, ctx),
      // A prompt op whose materialized list is empty while the planner CLAIMS a change happened cannot be detected by replay alone;
      // the detectable lie is a materialized list that fails to apply.
      revise: async () => ({
        ops: [
          {
            type: "prompt",
            text: "x",
            materialized: [{ type: "removeNode", nodeId: "does-not-exist" }],
          },
        ],
        findings: [],
        report: { decisionId: "y", attempts: [], firstAttemptValid: true, modelId: "m" },
      }),
    };
    const f2 = await checkPlannerConformance(lying, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    expect(f2.map((f) => f.code)).toContain("prompt-replay-failed");
  });
  it("a planner that keeps a summary over an unclassified sample, or stamps below a capability's class, fails summary-class-unsound", async () => {
    const lax = {
      compose: async (inp, ctx) => {
        const r = await new ReferencePlanner({
          model: scriptedModel([compose]),
          modelId: "m",
        }).compose({ ...inp, contextClass: "internal" }, ctx);
        const { summaryClass: _drop, ...rest } = r;
        return rest;
      },
      revise: (inp, ctx) =>
        new ReferencePlanner({ model: scriptedModel([revise]), modelId: "m" }).revise(inp, ctx),
    } as Planner;
    const found = await checkPlannerConformance(lax, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add an insight" },
      ctx: recordingContext(),
    });
    expect(found.some((f) => f.code === "summary-class-unsound")).toBe(true);
  });

  it("a planner whose second compose calls the model again fails replay-recalled-model", async () => {
    const model = scriptedModel([compose, revise, compose]);
    const noDecide: Planner = {
      // Bypasses ctx.decide on purpose.
      compose: async (input) => {
        await model.complete({ messages: [] });
        return new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" }).compose(
          input,
          recordingContext()
        );
      },
      revise: (i, ctx) =>
        new ReferencePlanner({ model: scriptedModel([revise]), modelId: "m" }).revise(i, ctx),
    };
    const findings = await checkPlannerConformance(noDecide, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add" },
      ctx: recordingContext(),
      modelCalls: () => model.calls,
    });
    expect(findings.map((f) => f.code)).toContain("replay-recalled-model");
  });
  it("a revision that drops a node fails dropped-node unless the fixture expects removal", async () => {
    const dropping = JSON.stringify({
      summary: "s",
      nodes: [{ id: "why", type: "Insight", label: "Why", span: 12, props: {} }],
    });
    const planner = new ReferencePlanner({
      model: scriptedModel([compose, dropping]),
      modelId: "m",
    });
    const f1 = await checkPlannerConformance(planner, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "replace" },
      ctx: recordingContext(),
    });
    expect(f1.map((f) => f.code)).toContain("dropped-node");
    const planner2 = new ReferencePlanner({
      model: scriptedModel([compose, dropping]),
      modelId: "m",
    });
    const f2 = await checkPlannerConformance(planner2, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "replace", expectRemoval: true },
      ctx: recordingContext(),
    });
    expect(f2).toEqual([]);
  });
  it("a planner whose report does not describe its own attempts fails report-invalid, and the rest of the contract is still checked", async () => {
    const reference = () => new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" });
    const lyingReport: Planner = {
      compose: async (i, ctx) => ({
        ...(await reference().compose(i, ctx)),
        // No attempts, no model named, and "clean on the first call" over zero calls.
        report: { decisionId: "x", attempts: [], firstAttemptValid: true, modelId: "" },
      }),
      revise: async (i, ctx) => {
        const r = await new ReferencePlanner({
          model: scriptedModel([revise]),
          modelId: "m",
        }).revise(i, ctx);
        return {
          ...r,
          report: {
            ...r.report,
            // Two attempts that both parsed, still claiming first-attempt-clean.
            attempts: [
              { parsed: true, findings: [] },
              { parsed: true, findings: [] },
            ],
            firstAttemptValid: true,
          },
        };
      },
    };
    const findings = await checkPlannerConformance(lyingReport, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add an insight" },
      ctx: recordingContext(),
    });
    const invalid = findings.filter((f) => f.code === "report-invalid");
    expect(invalid).toHaveLength(4); // compose: empty attempts, empty modelId, bad flag; revise: bad flag
    expect(invalid.map((f) => f.message).join("\n")).toContain("report.attempts is empty");
    expect(invalid.map((f) => f.message).join("\n")).toContain("report.modelId is empty");
    // Nothing else about this planner is wrong, so report-invalid is ALL that is reported.
    expect(findings.map((f) => f.code)).toEqual([
      "report-invalid",
      "report-invalid",
      "report-invalid",
      "report-invalid",
    ]);
  });
  it("a planner whose compose rejects resolves with a planner-threw finding naming the error, never a rejection", async () => {
    const throwing: Planner = {
      compose: async () => {
        throw new Error("boom");
      },
      revise: async () => ({
        ops: [],
        findings: [],
        report: { decisionId: "y", attempts: [], firstAttemptValid: true, modelId: "m" },
      }),
    };
    const findings = await checkPlannerConformance(throwing, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    const finding = findings.find((f) => f.code === "planner-threw");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("boom");
  });
  const fixtureWith = (ctx = recordingContext()) => ({
    intent: intentFixture,
    catalog: planningCatalog,
    capabilities: capabilitiesFixture,
    meta: metaFixture,
    revision: { text: "add an insight" },
    ctx,
  });
  it("the reference planner on a model that reports usage passes with zero findings", async () => {
    const model = scriptedModel([compose, revise], { inputTokens: 50, outputTokens: 10 });
    const planner = new ReferencePlanner({ model, modelId: "m" });
    expect(
      await checkPlannerConformance(planner, { ...fixtureWith(), modelCalls: () => model.calls })
    ).toEqual([]);
  });
  it("a planner whose replayed compose loses its usage fails usage-not-replayed — usage must live inside the decision", async () => {
    const reference = new ReferencePlanner({
      model: scriptedModel([compose, revise], { inputTokens: 50, outputTokens: 10 }),
      modelId: "m",
    });
    let calls = 0;
    const forgetful: Planner = {
      compose: async (i, ctx) => {
        const r = await reference.compose(i, ctx);
        if (calls++ === 0) return r;
        // The second call re-derives the report outside the decision and forgets the tokens.
        const { decisionId, attempts, firstAttemptValid, modelId } = r.report;
        return { ...r, report: { decisionId, attempts, firstAttemptValid, modelId } };
      },
      revise: (i, ctx) => reference.revise(i, ctx),
    };
    const findings = await checkPlannerConformance(forgetful, fixtureWith());
    expect(findings.map((f) => f.code)).toEqual(["usage-not-replayed"]);
  });
  it("a usage that is not two non-negative integers, or that disagrees with its attempts, is report-invalid", async () => {
    const reference = () =>
      new ReferencePlanner({
        model: scriptedModel([compose, revise], { inputTokens: 50, outputTokens: 10 }),
        modelId: "m",
      });
    const lying: Planner = {
      compose: async (i, ctx) => {
        const r = await reference().compose(i, ctx);
        return { ...r, report: { ...r.report, usage: { inputTokens: -5, outputTokens: 1 } } };
      },
      revise: async (i, ctx) => {
        // D2 (preflight): a fresh reference() planner here would hand `revise` a MODEL that has
        // never been called, so its first (and only) reply is the COMPOSE script entry — an
        // empty materialization that trips prompt-replay-mismatch. `revise` gets its own
        // single-entry script instead.
        const r = await new ReferencePlanner({
          model: scriptedModel([revise], { inputTokens: 50, outputTokens: 10 }),
          modelId: "m",
        }).revise(i, ctx);
        return { ...r, report: { ...r.report, usage: { inputTokens: 1, outputTokens: 1 } } };
      },
    };
    const findings = await checkPlannerConformance(lying, fixtureWith());
    expect(findings.map((f) => f.code)).toEqual(["report-invalid", "report-invalid"]);
    expect(findings[0]?.message).toContain("compose: report.usage");
    expect(findings[1]?.message).toContain("revise: report.usage");
  });
  it("the reference planner still passes when an attempt's usage is refused for overflowing the plan total (two attempts, both at MAX_SAFE_INTEGER)", async () => {
    // Attempt 1 fails to parse but reports MAX_SAFE_INTEGER input tokens — recorded. Attempt 2
    // parses but would push the plan total past MAX_SAFE_INTEGER — refused (usage-invalid warning,
    // not recorded). The reference planner's own report.usage must still equal the sum of what WAS
    // recorded (attempt 1 alone), which is exactly what the kit checks.
    let calls = 0;
    const overflowing = {
      async complete() {
        calls += 1;
        if (calls === 1)
          return {
            content: "not json",
            usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
          };
        if (calls === 2) return { content: compose, usage: { inputTokens: 1, outputTokens: 0 } };
        return { content: revise, usage: { inputTokens: 50, outputTokens: 10 } };
      },
    };
    const planner = new ReferencePlanner({ model: overflowing, modelId: "m" });
    expect(
      await checkPlannerConformance(planner, { ...fixtureWith(), modelCalls: () => calls })
    ).toEqual([]);
  });
  it("the reference planner still passes when no attempt reports usage (an absent total, not {0,0})", async () => {
    const model = scriptedModel([compose, revise]);
    const planner = new ReferencePlanner({ model, modelId: "m" });
    const findings = await checkPlannerConformance(planner, {
      ...fixtureWith(),
      modelCalls: () => model.calls,
    });
    expect(findings).toEqual([]);
  });
  it("never throws on a hostile report.usage (a getter that throws); it reports a finding instead", async () => {
    const reference = () => new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" });
    const hostile: Planner = {
      compose: async (i, ctx) => {
        const r = await reference().compose(i, ctx);
        return {
          ...r,
          report: {
            ...r.report,
            usage: Object.defineProperty({ outputTokens: 1 }, "inputTokens", {
              enumerable: true,
              get() {
                throw new Error("hostile getter");
              },
            }) as unknown as { inputTokens: number; outputTokens: number },
          },
        };
      },
      revise: (i, ctx) =>
        new ReferencePlanner({ model: scriptedModel([revise]), modelId: "m" }).revise(i, ctx),
    };
    // The call itself must not throw or reject (a hostile report.usage is a finding, not a crash).
    const findings = await checkPlannerConformance(hostile, fixtureWith());
    expect(findings.map((f) => f.code)).toContain("report-invalid");
  });
  describe("report.usage is read ONCE per report, through a guard", () => {
    const withUsageGetter = (get: (read: number) => unknown, reads: number[]): Planner => ({
      compose: async (i, ctx) => {
        const r = await new ReferencePlanner({
          model: scriptedModel([compose], { inputTokens: 5, outputTokens: 1 }),
          modelId: "m",
        }).compose(i, ctx);
        const slot = reads.push(0) - 1;
        const report = Object.defineProperty({ ...r.report }, "usage", {
          enumerable: true,
          get() {
            reads[slot] = (reads[slot] as number) + 1;
            return get(reads[slot] as number);
          },
        });
        return { ...r, report };
      },
      revise: (i, ctx) =>
        new ReferencePlanner({ model: scriptedModel([revise]), modelId: "m" }).revise(i, ctx),
    });
    it("a report.usage getter that throws is a report-invalid finding, not a throw", async () => {
      const reads: number[] = [];
      const planner = withUsageGetter(() => {
        throw new Error("hostile report");
      }, reads);
      const findings = await checkPlannerConformance(planner, fixtureWith());
      expect(findings.filter((f) => f.code === "report-invalid").map((f) => f.message)).toEqual([
        "compose: report.usage is not two non-negative integer token counts",
      ]);
      for (const f of findings) expect(f.message).not.toMatch(/hostile/);
      expect(reads).toEqual([1, 1]);
    });
    it("a getter that changes between reads is judged on its FIRST value only (invalid, then valid)", async () => {
      const reads: number[] = [];
      const planner = withUsageGetter(
        (n) =>
          n === 1 ? { inputTokens: -1, outputTokens: 1 } : { inputTokens: 5, outputTokens: 1 },
        reads
      );
      const findings = await checkPlannerConformance(planner, fixtureWith());
      expect(findings.filter((f) => f.code === "report-invalid").map((f) => f.message)).toEqual([
        "compose: report.usage is not two non-negative integer token counts",
      ]);
      // Each compose report's usage was read exactly once — the check and the replay comparison
      // both used that one snapshot.
      expect(reads).toEqual([1, 1]);
    });
  });
  describe("never throws on a malformed ATTEMPT usage; reports it by kind, never by content", () => {
    const revoked = (() => {
      const { proxy, revoke } = Proxy.revocable({ inputTokens: 1, outputTokens: 1 }, {});
      revoke();
      return proxy;
    })();
    const throwingGetter = Object.defineProperty({ outputTokens: 1 }, "inputTokens", {
      enumerable: true,
      get() {
        throw new Error("hostile getter");
      },
    });
    const cases: readonly [string, (a: object) => object][] = [
      ["null", (a) => ({ ...a, usage: null })],
      ["a string", (a) => ({ ...a, usage: "x" })],
      ["a number", (a) => ({ ...a, usage: 7 })],
      ["a non-integer count", (a) => ({ ...a, usage: { inputTokens: "a", outputTokens: 1 } })],
      ["an object whose count getter throws", (a) => ({ ...a, usage: throwingGetter })],
      ["a revoked proxy", (a) => ({ ...a, usage: revoked })],
      [
        "a usage PROPERTY whose getter throws",
        (a) =>
          Object.defineProperty({ ...a }, "usage", {
            enumerable: true,
            get() {
              throw new Error("hostile attempt");
            },
          }),
      ],
    ];
    for (const [name, corrupt] of cases)
      it(name, async () => {
        const hostile: Planner = {
          compose: async (i, ctx) => {
            // A valid report.usage too, so the kit reaches the sum-of-attempts comparison.
            const r = await new ReferencePlanner({
              model: scriptedModel([compose], { inputTokens: 5, outputTokens: 1 }),
              modelId: "m",
            }).compose(i, ctx);
            const attempts = r.report.attempts.map((a) => corrupt(a)) as typeof r.report.attempts;
            return { ...r, report: { ...r.report, attempts } };
          },
          revise: (i, ctx) =>
            new ReferencePlanner({ model: scriptedModel([revise]), modelId: "m" }).revise(i, ctx),
        };
        const findings = await checkPlannerConformance(hostile, fixtureWith());
        const invalid = findings.filter((f) => f.code === "report-invalid");
        expect(invalid.map((f) => f.message)).toEqual([
          "compose: attempt #0 usage is not two non-negative integer token counts",
        ]);
        for (const f of findings) expect(f.message).not.toMatch(/NaN|0a|hostile/);
      });
  });
  it("a planner whose compose works but whose revise rejects reports planner-threw, not revise-not-prompt", async () => {
    const composeOkReviseThrows: Planner = {
      compose: (i, ctx) =>
        new ReferencePlanner({ model: scriptedModel([compose]), modelId: "m" }).compose(i, ctx),
      revise: async () => {
        throw new Error("boom");
      },
    };
    const findings = await checkPlannerConformance(composeOkReviseThrows, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "x" },
      ctx: recordingContext(),
    });
    expect(findings.map((f) => f.code)).toContain("planner-threw");
    expect(findings.map((f) => f.code)).not.toContain("revise-not-prompt");
  });
  describe("decide scope", () => {
    const scopedPlanner = (use: boolean) =>
      new ReferencePlanner({
        modelId: "m",
        model: (scope) => ({
          complete: async (req) => {
            if (use) return scope.invokeTransient("llm.complete", req);
            return { content: replies.shift() as string };
          },
        }),
      });
    let replies: string[] = [];
    const run = (planner: Planner, scope: ReturnType<typeof stampingScope>, identity: string) =>
      checkPlannerConformance(planner, {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        meta: metaFixture,
        revision: { text: "add an insight" },
        ctx: recordingContext(scope),
        scopeProbe: { identity, calls: () => scope.calls },
      });
    it("a planner that calls through the scope as the deciding execution passes", async () => {
      replies = [compose, revise];
      const scope = stampingScope("exec-1", () => ({ content: replies.shift() as string }));
      expect(await run(scopedPlanner(true), scope, "exec-1")).toEqual([]);
    });
    it("a planner that never uses the scope fails scope-unused", async () => {
      replies = [compose, revise];
      const scope = stampingScope("exec-1", () => ({ content: "" }));
      const f = await run(scopedPlanner(false), scope, "exec-1");
      expect(f.map((x) => x.code)).toContain("scope-unused");
    });
    it("calls stamped as a different execution fail scope-identity-mismatch", async () => {
      replies = [compose, revise];
      const scope = stampingScope("transient", () => ({ content: replies.shift() as string }));
      const f = await run(scopedPlanner(true), scope, "exec-1");
      expect(f.map((x) => x.code)).toContain("scope-identity-mismatch");
    });
    it("a planner that makes an extra scope call outside ctx.decide on every compose fails replay-recalled-scope (live calls array)", async () => {
      replies = [compose, revise];
      const scope = stampingScope("exec-1", () => ({ content: replies.shift() as string }));
      const inner = scopedPlanner(true);
      // Reaches the scope outside the decision on EVERY compose, replay included.
      const leaky: Planner = {
        compose: async (i, c) => {
          const r = await inner.compose(i, c);
          await scope.invokeTransient("side.effect", {});
          return r;
        },
        revise: (i, c) => inner.revise(i, c),
      };
      const f = await run(leaky, scope, "exec-1"); // probe.calls returns the LIVE scope.calls
      expect(f.map((x) => x.code)).toContain("replay-recalled-scope");
    });
    it("a scope call stamped as another execution during revise fails scope-identity-mismatch", async () => {
      replies = [compose, revise];
      const scope = stampingScope("exec-1", () => ({ content: replies.shift() as string }));
      const inner = scopedPlanner(true);
      const extra: { identity: string }[] = [];
      const planner: Planner = {
        compose: (i, c) => inner.compose(i, c),
        revise: async (i, c) => {
          const r = await inner.revise(i, c);
          extra.push({ identity: "someone-else" });
          return r;
        },
      };
      const f = await checkPlannerConformance(planner, {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        meta: metaFixture,
        revision: { text: "add an insight" },
        ctx: recordingContext(scope),
        scopeProbe: { identity: "exec-1", calls: () => [...scope.calls, ...extra] },
      });
      expect(f.map((x) => x.code)).toContain("scope-identity-mismatch");
    });
    it("a planner that never calls ctx.decide is scope-unused, not blamed on the fixture", async () => {
      replies = [compose, revise, compose, revise];
      const scope = stampingScope("exec-1", () => ({ content: replies.shift() as string }));
      const inner = scopedPlanner(false);
      // Decides on a private context of its own: the fixture's ctx is never asked.
      const bypass: Planner = {
        compose: (input) => inner.compose(input, recordingContext(scope)),
        revise: (input) => inner.revise(input, recordingContext(scope)),
      };
      const f = await run(bypass, scope, "exec-1");
      const codes = f.map((x) => x.code);
      expect(codes).toContain("scope-unused");
      expect(codes).not.toContain("fixture-ctx-not-fresh");
      expect(f.find((x) => x.code === "scope-unused")?.message).toMatch(/ctx\.decide/);
    });

    it("a compose mismatch does not hide a separate revise mismatch", async () => {
      replies = [compose, revise];
      let n = 0;
      // Every call is stamped as some other execution, in both phases.
      const scope = stampingScope("exec-other", () => {
        n += 1;
        return { content: replies.shift() as string };
      });
      const f = await run(scopedPlanner(true), scope, "exec-1");
      const mismatches = f.filter((x) => x.code === "scope-identity-mismatch");
      expect(n).toBeGreaterThan(1);
      expect(mismatches.map((m) => m.message)).toEqual([
        expect.stringMatching(/^a scope call was stamped/),
        expect.stringMatching(/during revise/),
      ]);
    });

    it("a pre-populated ctx is a fixture error, not scope-unused", async () => {
      replies = [compose, revise, compose, revise];
      const scope = stampingScope("exec-1", () => ({ content: replies.shift() as string }));
      const ctx = recordingContext(scope);
      const planner = scopedPlanner(true);
      await planner.compose(
        {
          intent: intentFixture,
          catalog: planningCatalog,
          capabilities: capabilitiesFixture,
          surface: "web",
        },
        ctx
      );
      const f = await checkPlannerConformance(planner, {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        meta: metaFixture,
        revision: { text: "add an insight" },
        ctx,
        scopeProbe: { identity: "exec-1", calls: () => scope.calls },
      });
      const codes = f.map((x) => x.code);
      expect(codes).toContain("fixture-ctx-not-fresh");
      expect(codes).not.toContain("scope-unused");
    });
  });
});

describe("checkPlannerConformance — streaming (opt-in via fx.streamProbe)", () => {
  const fixture = (planner: Planner, model: { calls: number }) => {
    const abortCtx = recordingContext();
    return {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add an insight" },
      ctx: recordingContext(),
      modelCalls: () => model.calls,
      streamProbe: {
        ctx: recordingContext(),
        abortCtx,
        abortDecisions: () => abortCtx.decisions.size,
      },
    };
  };
  const twoNodes = JSON.stringify({
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

  const revised = JSON.stringify({
    ...JSON.parse(twoNodes),
    nodes: [
      ...JSON.parse(twoNodes).nodes,
      { id: "more", type: "Insight", label: "More", span: 12, props: {} },
    ],
  });
  it("the reference planner on a streaming model passes with zero findings", async () => {
    const model = streamingScriptedModel([twoNodes, revised]);
    const planner = new ReferencePlanner({ model, modelId: "m" });
    expect(await checkPlannerConformance(planner, fixture(planner, model))).toEqual([]);
  });

  it("a planner that ignores the stream options is told so (no partials, abort not honoured)", async () => {
    const model = streamingScriptedModel([twoNodes, revised]);
    const inner = new ReferencePlanner({ model, modelId: "m" });
    const deaf: Planner = {
      compose: (i, c) => inner.compose(i, c),
      revise: (i, c) => inner.revise(i, c),
    };
    const codes = (await checkPlannerConformance(deaf, fixture(deaf, model))).map((f) => f.code);
    expect(codes).toContain("stream-no-partials");
    expect(codes).toContain("stream-abort-ignored");
  });

  it("a planner whose streamed final differs from the whole-reply final is flagged", async () => {
    const model = streamingScriptedModel([twoNodes, revised]);
    const inner = new ReferencePlanner({ model, modelId: "m" });
    const liar: Planner = {
      compose: async (i, c, o) => {
        const r = await inner.compose(i, c, o);
        return o?.onPartial === undefined ? r : { ...r, ops: r.ops.slice(0, 1) };
      },
      revise: (i, c, o) => inner.revise(i, c, o),
    };
    const codes = (await checkPlannerConformance(liar, fixture(liar, model))).map((f) => f.code);
    expect(codes).toContain("stream-final-differs");
  });

  it("a cancelled turn that is still RECORDED is flagged", async () => {
    const model = streamingScriptedModel([twoNodes, revised]);
    const inner = new ReferencePlanner({ model, modelId: "m" });
    const recorder: Planner = {
      compose: (i, c, o) => {
        if (o?.signal?.aborted === true) return c.decide("x", () => inner.compose(i, c));
        return inner.compose(i, c, o);
      },
      revise: (i, c, o) => inner.revise(i, c, o),
    };
    const codes = (await checkPlannerConformance(recorder, fixture(recorder, model))).map(
      (f) => f.code
    );
    expect(codes).toContain("stream-abort-recorded");
  });

  it("a replay that streams again is flagged", async () => {
    const model = streamingScriptedModel([twoNodes, revised]);
    const inner = new ReferencePlanner({ model, modelId: "m" });
    let n = 0;
    const chatty: Planner = {
      compose: async (i, c, o) => {
        const r = await inner.compose(i, c, o);
        if (o?.onPartial !== undefined && ++n > 1)
          o.onPartial({ attempt: 0, ops: r.ops, findings: [], nodes: 1 });
        return r;
      },
      revise: (i, c, o) => inner.revise(i, c, o),
    };
    const codes = (await checkPlannerConformance(chatty, fixture(chatty, model))).map(
      (f) => f.code
    );
    expect(codes).toContain("stream-replay-recalled");
  });

  describe("denial of a STREAMED turn (denialProbe + streamProbe)", () => {
    const denied = Object.assign(new Error("denied"), { name: "CapabilityDeniedError" });
    const denyingScope = () => ({
      invokeTransient: () => Promise.reject(denied),
    });
    type M = ReturnType<typeof streamingScriptedModel>;
    /** Calls through this scope reach the scripted model, deltas and all (a permissive runtime). */
    const permissive = (model: M) => ({
      invokeTransient: (_id: string, req: unknown, o?: { signal?: AbortSignal; onDelta?: never }) =>
        model.complete(req as never, o) as Promise<never>,
    });
    const routedPlanner = () =>
      new ReferencePlanner({
        model: (scope) => ({
          complete: (req, o) => scope.invokeTransient("llm.complete", req, o),
        }),
        modelId: "m",
      });
    const withDenial = (model: M) => {
      const abortCtx = recordingContext();
      const denialCtx = recordingContext(denyingScope());
      return {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        meta: metaFixture,
        revision: { text: "add an insight" },
        ctx: recordingContext(permissive(model)),
        streamProbe: {
          ctx: recordingContext(permissive(model)),
          abortCtx,
          abortDecisions: () => abortCtx.decisions.size,
        },
        denialProbe: { ctx: denialCtx, error: denied, decisions: () => denialCtx.decisions.size },
      };
    };

    it("the reference planner (scope-routed) passes with zero findings", async () => {
      const model = streamingScriptedModel([twoNodes, revised]);
      const planner = routedPlanner();
      expect(await checkPlannerConformance(planner, withDenial(model))).toEqual([]);
    });

    it("a planner that streams AROUND the scope when asked for partials is flagged stream-denial-swallowed", async () => {
      const model = streamingScriptedModel([twoNodes, revised]);
      const governed = routedPlanner();
      const direct = new ReferencePlanner({ model, modelId: "m" }); // never touches the scope
      const bypass: Planner = {
        compose: (i, c, o) =>
          o?.onPartial === undefined ? governed.compose(i, c, o) : direct.compose(i, c, o),
        revise: (i, c, o) => governed.revise(i, c, o),
      };
      const codes = (await checkPlannerConformance(bypass, withDenial(model))).map((f) => f.code);
      expect(codes).toContain("stream-denial-swallowed");
      expect(codes).not.toContain("denial-swallowed"); // the plain turn is governed
    });
  });

  it("without a streamProbe, streaming is not checked", async () => {
    const model = scriptedModel([compose, revise]);
    const planner = new ReferencePlanner({ model, modelId: "m" });
    expect(
      await checkPlannerConformance(planner, {
        intent: intentFixture,
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
        meta: metaFixture,
        revision: { text: "add an insight" },
        ctx: recordingContext(),
      })
    ).toEqual([]);
  });
});
