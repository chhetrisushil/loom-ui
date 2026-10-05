import { genesis } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { limitInvoker } from "@loom-ui/hydration";
import { TypedFailure } from "@loom/core";
import { describe, expect, it } from "vitest";
import { checkPlannerConformance } from "./conformance";
import * as pkg from "./index";
import { ReferencePlanner } from "./reference";
import { scopeInvoker } from "./scope";
import type { Planner, PlannerModel } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  stampingScope,
} from "./testing.test-support";

const input = {
  intent: intentFixture,
  catalog: planningCatalog,
  capabilities: capabilitiesFixture,
};

// Shaped like loom's classes (structural: `name`), not imported — the planner must not depend on
// one copy of the error class.
const named = (name: string, message: string): Error => {
  const e = new Error(message);
  e.name = name;
  return e;
};
const denied = () => named("CapabilityDeniedError", 'Capability denied: effect "llm.complete"');
const quota = () => named("QuotaExceededError", "Quota exceeded: tokens");
const aborted = () => new DOMException("aborted", "AbortError");

const scopedPlanner = () =>
  new ReferencePlanner({
    modelId: "scoped",
    model: (scope): PlannerModel => ({
      complete: (req) => scope.invokeTransient("llm.complete", req),
    }),
  });

describe("control-plane errors propagate out of the decider", () => {
  for (const [label, make] of [
    ["capability denial", denied],
    ["abort", aborted],
    ["quota refusal", quota],
    [
      "loom's ExecutionCancelledError",
      () => named("ExecutionCancelledError", "Execution cancelled"),
    ],
    ["loom's DecideScopeClosedError", () => named("DecideScopeClosedError", "decider settled")],
    ["EffectModeViolationError", () => named("EffectModeViolationError", "journaled effect")],
    ["ExecutionDeniedError", () => named("ExecutionDeniedError", "denied")],
    ["CapabilityInvokeDeniedError", () => named("CapabilityInvokeDeniedError", "denied")],
    ["EgressDeniedError", () => named("EgressDeniedError", "egress")],
    ["SafetyViolationError", () => named("SafetyViolationError", "unsafe")],
    ["UntrustedContentError", () => named("UntrustedContentError", "untrusted")],
    // loom R9: the control plane's rate / kill-switch / spawn-budget refusals
    ["RateLimitExceededError", () => named("RateLimitExceededError", "rate limit")],
    ["KillSwitchEngagedError", () => named("KillSwitchEngagedError", "kill switch")],
    ["SpawnLimitExceededError", () => named("SpawnLimitExceededError", "spawn limit")],
  ] as const) {
    it(`${label}: compose rejects once, with no retry and nothing recorded`, async () => {
      const error = make();
      const scope = stampingScope("exec-1", () => {
        throw error;
      });
      const ctx = recordingContext(scope);
      await expect(scopedPlanner().compose(input, ctx)).rejects.toBe(error);
      expect(scope.calls).toHaveLength(1);
      expect(ctx.decisions.size).toBe(0);
    });
  }

  it("an aborted signal's own reason propagates by identity: nothing recorded, one call", async () => {
    const ac = new AbortController();
    ac.abort();
    const reason = ac.signal.reason;
    expect(reason).toMatchObject({ name: "AbortError" });
    const scope = stampingScope("e", () => {
      throw reason;
    });
    const ctx = recordingContext(scope);
    await expect(scopedPlanner().compose(input, ctx)).rejects.toBe(reason);
    expect(scope.calls).toHaveLength(1);
    expect(ctx.decisions.size).toBe(0);
  });

  it("a thrown non-Error value (a bare string reason) is NOT classified: it is a plain model failure", async () => {
    const scope = stampingScope("e", () => {
      throw "stop";
    });
    const ctx = recordingContext(scope);
    const plan = await scopedPlanner().compose(input, ctx);
    expect(scope.calls).toHaveLength(2);
    expect(plan.findings.map((f) => f.code)).toContain("model-error");
    expect(ctx.decisions.size).toBe(1);
  });

  // `@loom-ui/hydration` resolves to its BUILT dist here (as a consumer gets it), so this proves
  // the composed behaviour after a build; the AbortError naming itself is pinned at source by
  // hydration's own invokers.test.ts.
  it("limitInvoker over the scope with an already-aborted signal propagates: scope never reached, nothing recorded", async () => {
    const ac = new AbortController();
    ac.abort();
    const scope = stampingScope("e", () => ({ content: "{}" }));
    const ctx = recordingContext(scope);
    const planner = new ReferencePlanner({
      modelId: "limited",
      model: (s): PlannerModel => {
        const limited = limitInvoker(scopeInvoker(s), 1);
        return {
          complete: (req) => limited.invokeTransient("llm.complete", req, { signal: ac.signal }),
        };
      },
    });
    await expect(planner.compose(input, ctx)).rejects.toMatchObject({ name: "AbortError" });
    expect(scope.calls).toHaveLength(0);
    expect(ctx.decisions.size).toBe(0);
  });

  it("a denial thrown by the model factory propagates too", async () => {
    const planner = new ReferencePlanner({
      modelId: "m",
      model: () => {
        throw denied();
      },
    });
    const ctx = recordingContext();
    await expect(planner.compose(input, ctx)).rejects.toMatchObject({
      name: "CapabilityDeniedError",
    });
    expect(ctx.decisions.size).toBe(0);
  });

  it("revise propagates a denial as well", async () => {
    const scope = stampingScope("e", () => {
      throw denied();
    });
    const ctx = recordingContext(scope);
    const experience = seal(
      genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture })
    );
    await expect(
      scopedPlanner().revise(
        {
          experience,
          request: { text: "tweak" },
          catalog: planningCatalog,
          capabilities: capabilitiesFixture,
        },
        ctx
      )
    ).rejects.toMatchObject({ name: "CapabilityDeniedError" });
    expect(scope.calls).toHaveLength(1);
    expect(ctx.decisions.size).toBe(0);
  });

  it("a plain model error keeps today's behaviour: finding, retry, recorded failed plan", async () => {
    const scope = stampingScope("e", () => {
      throw new Error("provider 503");
    });
    const ctx = recordingContext(scope);
    const plan = await scopedPlanner().compose(input, ctx);
    expect(scope.calls).toHaveLength(2);
    expect(plan.findings.map((f) => f.code)).toContain("model-error");
    expect(ctx.decisions.size).toBe(1);
  });

  it("a TypedFailure is a plain model failure, not a control-plane refusal", async () => {
    const scope = stampingScope("e", () => {
      throw new TypedFailure("rateLimited", { retryAfterMs: 10 });
    });
    const ctx = recordingContext(scope);
    const plan = await scopedPlanner().compose(input, ctx);
    expect(scope.calls).toHaveLength(2);
    expect(plan.findings.map((f) => f.code)).toContain("model-error");
  });
});

describe("conformance: denialProbe", () => {
  const compose = JSON.stringify({
    summary: "s",
    nodes: [{ id: "i", type: "Insight", label: "x", props: { tone: "neutral" } }],
  });
  const run = (planner: Planner, error: Error) => {
    const refusing = recordingContext(
      stampingScope("exec-1", () => {
        throw error;
      })
    );
    return checkPlannerConformance(planner, {
      intent: intentFixture,
      catalog: planningCatalog,
      capabilities: capabilitiesFixture,
      meta: metaFixture,
      revision: { text: "add" },
      ctx: recordingContext(),
      denialProbe: { ctx: refusing, error, decisions: () => refusing.decisions.size },
    });
  };
  it("a planner that propagates the refusal passes the denial check", async () => {
    const f = await run(scopedPlanner(), denied());
    expect(f.map((x) => x.code).filter((c) => c.startsWith("denial-"))).toEqual([]);
  });
  it("a planner that swallows the refusal into a returned plan fails denial-swallowed", async () => {
    const swallowing: Planner = {
      compose: async (_i, ctx) => {
        await ctx.decide("d", async (scope) => {
          try {
            await scope.invokeTransient("llm.complete", {});
          } catch {
            /* the defect */
          }
          return { ok: true };
        });
        return {
          ops: [],
          findings: [],
          report: { decisionId: "d", attempts: [], firstAttemptValid: false, modelId: "m" },
        };
      },
      revise: () => Promise.reject(new Error("unused")),
    };
    const f = await run(swallowing, denied());
    expect(f.map((x) => x.code)).toContain("denial-swallowed");
    expect(f.map((x) => x.code)).toContain("denial-recorded");
  });
});

describe("isControlPlaneError is public", () => {
  // A host planner that wraps its own effect calls (sandbox proofs, MCP samples) must apply the
  // SAME classification as ReferencePlanner, so the package root exports it.
  it("is exported from the package root and classifies by name", () => {
    expect(typeof pkg.isControlPlaneError).toBe("function");
    const denied = Object.assign(new Error("no"), { name: "CapabilityDeniedError" });
    expect(pkg.isControlPlaneError(denied)).toBe(true);
    expect(pkg.isControlPlaneError(new Error("model said no"))).toBe(false);
  });
});
