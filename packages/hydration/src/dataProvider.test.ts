import type { MCPToolNode, ProviderSpec } from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { SANDBOX_TOOL_ID } from "@loom/plugin-sandbox";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkDataProviderConformance, defineDataProviders, mcpProvider } from "./dataProvider";
import { LOOM_EFFECT_KIND, effectPin, loomEffectProvider } from "./loomEffectProvider";
import { executeProvider } from "./provider";
import { remapOperation } from "./repair";
import { publicFinding } from "./split/index";
import { FakeInvoker, fakeRuntime, mcpStep, providerSpec } from "./testing.test-support";

// U3: a step names a data-provider KIND; MCP is the default one, `loom-effect` is the second.

const effectStep = (
  stepId: string,
  target: string,
  args: Record<string, unknown> = {},
  dependsOn: string[] = [],
  pin = `pin-${target}`
): MCPToolNode => ({
  stepId,
  kind: LOOM_EFFECT_KIND,
  toolName: target,
  toolVersion: "1",
  toolSchemaHash: pin,
  arguments: args,
  dependsOn,
  idempotent: true,
});
const ambient = { mode: "ambient", kind: "tool" } as const;
const effects = loomEffectProvider({
  runtime: fakeRuntime({ "orders.list": ambient, "orders.get": ambient }),
  effects: {
    "orders.list": { pin: "pin-orders.list" },
    "orders.get": { pin: "pin-orders.get" },
  },
});
const registry = defineDataProviders([mcpProvider, effects]);
const spec = (steps: MCPToolNode[], over: Partial<ProviderSpec> = {}) =>
  providerSpec("h", steps, over);

describe("a non-MCP step hydrates", () => {
  it("invokes the effect id directly through the transient invoker, with the caller's principal and signal", async () => {
    const inv = new FakeInvoker().on("orders.list", () => ({ rows: [1, 2] }));
    const ac = new AbortController();
    const principal = { id: "p" } as never;
    const r = await executeProvider(
      spec([effectStep("s", "orders.list", { limit: 2 })], {
        reshaping: { engine: "JSONPath", scriptRef: "rows" },
      }),
      { invoker: inv, providers: registry, principal, signal: ac.signal }
    );
    expect(r).toMatchObject({ ok: true, value: [1, 2] });
    expect(inv.calls).toHaveLength(1);
    expect(inv.calls[0]).toMatchObject({ toolId: "orders.list", input: { limit: 2 } });
    expect(inv.calls[0]?.opts?.principal).toBe(principal);
    expect(inv.calls[0]?.opts?.signal).toBe(ac.signal);
    expect(inv.calls[0]?.opts?.label).toBe("loom-ui.hydrate");
  });

  it("a graph may mix kinds: an MCP step feeds an effect step through a template", async () => {
    const inv = new FakeInvoker()
      .on(MCP_INVOKE_TOOL_ID, () => ({ id: "o-7" }))
      .on("orders.get", (i) => ({ got: (i as { id: string }).id }));
    const r = await executeProvider(
      spec(
        [
          mcpStep("a", "db.pick"),
          effectStep("b", "orders.get", { id: "{{steps.a.output.id}}" }, ["a"]),
        ],
        { reshaping: { engine: "JSONPath", scriptRef: "got" } }
      ),
      { invoker: inv, providers: registry }
    );
    expect(r).toMatchObject({ ok: true, value: "o-7" });
    expect(inv.calls.map((c) => c.toolId)).toEqual([MCP_INVOKE_TOOL_ID, "orders.get"]);
  });

  it("a target the host did not list is refused and nothing runs", async () => {
    const inv = new FakeInvoker().on("payments.charge", () => "charged");
    const r = await executeProvider(spec([effectStep("s", "payments.charge")]), {
      invoker: inv,
      providers: registry,
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("tool-targetUnregistered");
    expect(inv.calls).toHaveLength(0);
  });
});

describe("an unknown kind is a finding, not a throw", () => {
  it("fails the whole provider before ANY step runs (the MCP step before it never calls)", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({}));
    const odd = { ...effectStep("b", "x", {}, ["a"]), kind: "no-such-kind" };
    const r = await executeProvider(spec([mcpStep("a", "t"), odd]), { invoker: inv });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.finding.code).toBe("provider-kind-unregistered");
    expect(!r.ok && r.finding.message).toContain('"no-such-kind"');
    expect(inv.calls).toHaveLength(0);
  });
  it("with no registry given, a loom-effect step is unregistered (MCP is the only default)", async () => {
    const inv = new FakeInvoker();
    const r = await executeProvider(spec([effectStep("s", "orders.list")]), { invoker: inv });
    expect(!r.ok && r.finding.code).toBe("provider-kind-unregistered");
  });
  it("the public finding is a fixed text that names neither the kind nor the target", () => {
    const f = publicFinding("h", {
      code: "provider-kind-unregistered",
      severity: "error",
      message: 'steps of kind "secret-kind"',
    });
    expect(f.code).toBe("provider-kind-unregistered");
    expect(JSON.stringify(f)).not.toContain("secret-kind");
    const t = publicFinding("h", {
      code: "tool-targetUnregistered",
      severity: "error",
      message: "payments.charge",
    });
    expect(t.code).toBe("tool-targetUnregistered");
    expect(JSON.stringify(t)).not.toContain("payments");
  });
});

describe("drift detection holds for a non-MCP kind", () => {
  const stale = effectStep("s", "orders.list", {}, [], "pin-OLD");
  it("a moved pin is input drift carrying the observed pin and the kind; the effect never runs", async () => {
    const inv = new FakeInvoker().on("orders.list", () => ({}));
    const r = await executeProvider(spec([stale]), { invoker: inv, providers: registry });
    expect(!r.ok && r.finding.code).toBe("schema-drift");
    expect(!r.ok && r.drift).toEqual([
      {
        kind: "input",
        handle: "h",
        stepId: "s",
        toolName: "orders.list",
        providerKind: LOOM_EFFECT_KIND,
        expected: "pin-OLD",
        observed: "pin-orders.list",
      },
    ]);
    expect(inv.calls).toHaveLength(0);
  });
  it("report-and-proceed retries ONCE with the observed pin and still returns the drift", async () => {
    const inv = new FakeInvoker().on("orders.list", () => ({ ok: 1 }));
    const r = await executeProvider(spec([stale]), {
      invoker: inv,
      providers: registry,
      inputDrift: "report-and-proceed",
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.drift).toHaveLength(1);
    expect(inv.calls).toHaveLength(1);
  });
  it("remapOperation repairs a loom-effect step's pin and keeps its kind", async () => {
    const inv = new FakeInvoker();
    const s = spec([stale]);
    const r = await executeProvider(s, { invoker: inv, providers: registry });
    const op = remapOperation(s, r.drift ?? []);
    expect(op.ok).toBe(true);
    if (!op.ok || op.op.type !== "remapProvider") throw new Error("expected remapProvider");
    const step = op.op.spec.executionGraph[0];
    expect(step?.toolSchemaHash).toBe("pin-orders.list");
    expect(step?.kind).toBe(LOOM_EFFECT_KIND);
  });
  it("an MCP drift record is unchanged: no providerKind key", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
      throw new TypedFailure("schemaDrift", { observedHash: "v2" });
    });
    const r = await executeProvider(spec([mcpStep("s", "t")]), { invoker: inv });
    expect(!r.ok && "providerKind" in (r.drift[0] ?? {})).toBe(false);
  });
});

describe("the registry and the kinds' contract", () => {
  it("refuses a duplicate or malformed kind", () => {
    expect(() => defineDataProviders([mcpProvider, mcpProvider])).toThrow(/twice/);
    expect(() => defineDataProviders([{ kind: "Bad Kind", invoke: async () => 0 }])).toThrow(
      /valid kind/
    );
    expect(registry.kinds()).toEqual(["loom-effect", "mcp"]);
  });
  it("loomEffectProvider refuses the effects reached through their own plane, and an empty pin", () => {
    const runtime = fakeRuntime({
      x: ambient,
      [MCP_INVOKE_TOOL_ID]: ambient,
      [SANDBOX_TOOL_ID]: ambient,
    });
    expect(() =>
      loomEffectProvider({ runtime, effects: { [MCP_INVOKE_TOOL_ID]: { pin: "p" } } })
    ).toThrow(/own plane/);
    expect(() =>
      loomEffectProvider({ runtime, effects: { [SANDBOX_TOOL_ID]: { pin: "p" } } })
    ).toThrow(/own plane/);
    expect(() => loomEffectProvider({ runtime, effects: { x: { pin: "" } } })).toThrow(
      /non-empty pin/
    );
  });
  it("P2-1: refuses, at construction, an unregistered, undeclared-mode, journaled, human or llm effect", () => {
    const runtime = fakeRuntime({
      undeclared: { kind: "tool" },
      journaled: { mode: "journaled", kind: "tool" },
      person: { mode: "ambient", kind: "human" },
      model: { mode: "ambient", kind: "llm" },
      ok: ambient,
    });
    const pin = { pin: "p" };
    const make = (id: string) => () => loomEffectProvider({ runtime, effects: { [id]: pin } });
    expect(make("ghost")).toThrow(/not registered/);
    expect(make("undeclared")).toThrow(/not declared mode "ambient"/);
    expect(make("journaled")).toThrow(/not declared mode "ambient"/);
    expect(make("person")).toThrow(/human effect/);
    expect(make("model")).toThrow(/llm effect/);
    expect(make("ok")).not.toThrow();
  });
  it("P2-2: a pin computed from the schema drifts when the schema changes, with no edit to the map", async () => {
    const v1 = z.object({ limit: z.number() });
    const v2 = z.object({ limit: z.number(), cursor: z.string() });
    expect(effectPin(v1)).toBe(effectPin(z.object({ limit: z.number() })));
    expect(effectPin(v1)).not.toBe(effectPin(v2));
    const runtime = fakeRuntime({ "orders.list": ambient });
    const stored = effectStep("s", "orders.list", {}, [], effectPin(v1));
    const inv = new FakeInvoker().on("orders.list", () => ({}));
    const same = defineDataProviders([
      loomEffectProvider({ runtime, effects: { "orders.list": { inputSchema: v1 } } }),
    ]);
    expect((await executeProvider(spec([stored]), { invoker: inv, providers: same })).ok).toBe(
      true
    );
    // the effect's schema changed; the host's map is unchanged
    const changed = defineDataProviders([
      loomEffectProvider({ runtime, effects: { "orders.list": { inputSchema: v2 } } }),
    ]);
    const r = await executeProvider(spec([stored]), { invoker: inv, providers: changed });
    expect(!r.ok && r.finding.code).toBe("schema-drift");
    expect(!r.ok && r.drift[0]?.observed).toBe(effectPin(v2));
  });
  it("P3-1: a target that itself raises schemaDrift is a target failure, not pin drift (no oscillation)", async () => {
    const inv = new FakeInvoker().on("orders.list", () => {
      throw new TypedFailure("schemaDrift", { observedHash: "inner-hash" });
    });
    const r = await executeProvider(spec([effectStep("s", "orders.list")]), {
      invoker: inv,
      providers: registry,
      inputDrift: "report-and-proceed",
    });
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("tool-targetFailed");
    expect(!r.ok && r.drift).toEqual([]);
    expect(inv.calls).toHaveLength(1);
  });
  it("P2-3: an argument hook can tell an MCP tool `x` from a loom effect `x`", async () => {
    const seen: Array<string | undefined> = [];
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({})).on("orders.list", () => ({}));
    const hook = (args: Record<string, unknown>, ctx: { kind?: string }) => {
      seen.push(ctx.kind);
      return args;
    };
    await executeProvider(spec([mcpStep("a", "orders.list")]), {
      invoker: inv,
      argumentHook: hook,
    });
    await executeProvider(spec([effectStep("b", "orders.list")]), {
      invoker: inv,
      providers: registry,
      argumentHook: hook,
    });
    expect(seen).toEqual([undefined, LOOM_EFFECT_KIND]);
  });
  it("both shipped kinds pass the conformance check; a kind that ignores the pin does not", async () => {
    const inv = new FakeInvoker().on("orders.list", () => 1);
    expect(
      await checkDataProviderConformance(effects, {
        target: "orders.list",
        pin: "pin-orders.list",
        invoker: inv,
      })
    ).toEqual([]);
    const mcpInv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (i) => {
      const c = i as { expectedSchemaHash: string };
      if (c.expectedSchemaHash !== "p1")
        throw new TypedFailure("schemaDrift", { observedHash: "p1" });
      return 1;
    });
    expect(
      await checkDataProviderConformance(mcpProvider, { target: "t", pin: "p1", invoker: mcpInv })
    ).toEqual([]);
    const lax = { kind: "lax", invoke: async () => 1 };
    expect(
      (await checkDataProviderConformance(lax, { target: "t", pin: "p", invoker: inv })).length
    ).toBeGreaterThan(0);
  });
  it("P3-2: a provider that invokes the target and THEN throws schemaDrift is a violation", async () => {
    const inv = new FakeInvoker().on("t", () => 1);
    const lateDrift = {
      kind: "late",
      invoke: async (
        call: { target: string; args: Record<string, unknown>; expectedPin: string },
        invoker: FakeInvoker
      ) => {
        await invoker.invokeTransient(call.target, call.args);
        if (call.expectedPin !== "p") throw new TypedFailure("schemaDrift", { observedHash: "p" });
        return 1;
      },
    };
    const problems = await checkDataProviderConformance(lateDrift as never, {
      target: "t",
      pin: "p",
      invoker: inv,
    });
    expect(problems).toEqual(["a stale pin reached the target before failing"]);
  });
});
