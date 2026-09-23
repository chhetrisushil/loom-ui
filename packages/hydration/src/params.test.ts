import type { MCPToolNode } from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { describe, expect, it } from "vitest";
import {
  applyParams,
  checkParams,
  paramsKey,
  prepareArguments,
  providerParams,
  resolveTimeToken,
  resolveTimeTokens,
} from "./params";
import { executeProvider } from "./provider";
import { FakeInvoker, mcpStep, providerSpec } from "./testing.test-support";

type McpIn = { toolName: string; args: Record<string, unknown>; expectedSchemaHash: string };
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const ranged = (extra: Partial<MCPToolNode> = {}): MCPToolNode => ({
  ...mcpStep("s", "temps", { from: "$now-1h", to: "$now", station: "ridge" }),
  overridable: ["from", "to", "station"],
  ...extra,
});

describe("resolveTimeToken", () => {
  it("resolves $now and signed offsets in s m h d w against the given instant", () => {
    expect(resolveTimeToken("$now", NOW)).toBe("2026-09-23T12:00:00.000Z");
    expect(resolveTimeToken("$now-7d", NOW)).toBe("2026-09-16T12:00:00.000Z");
    expect(resolveTimeToken("$now-1h", NOW)).toBe("2026-09-23T11:00:00.000Z");
    expect(resolveTimeToken("$now+30m", NOW)).toBe("2026-09-23T12:30:00.000Z");
    expect(resolveTimeToken("$now-2w", NOW)).toBe("2026-09-09T12:00:00.000Z");
    expect(resolveTimeToken("$now-15s", NOW)).toBe("2026-09-23T11:59:45.000Z");
  });

  it("is undefined for anything else, including an offset past the representable range", () => {
    for (const t of ["now", "$now-7", "$now-7y", "$now - 7d", "$now-999999999w"])
      expect(resolveTimeToken(t, NOW)).toBeUndefined();
  });
});

describe("resolveTimeTokens", () => {
  it("resolves tokens at any depth and leaves other strings — templates included — alone", () => {
    const r = resolveTimeTokens(
      {
        range: { from: "$now-1d", to: "$now" },
        list: ["$now-1h", "x"],
        t: "{{steps.a.output}}",
        n: 3,
        word: "$nowcast",
      },
      NOW,
      'step "s"'
    );
    expect(r).toEqual({
      ok: true,
      value: {
        range: { from: "2026-09-22T12:00:00.000Z", to: "2026-09-23T12:00:00.000Z" },
        list: ["2026-09-23T11:00:00.000Z", "x"],
        t: "{{steps.a.output}}",
        n: 3,
        word: "$nowcast",
      },
    });
  });

  it("refuses a malformed token rather than sending it to a tool", () => {
    for (const bad of ["$now-7y", "$now - 7d", "$now-"]) {
      const r = resolveTimeTokens({ from: bad }, NOW, 'step "s"');
      expect(!r.ok && r.finding.code).toBe("invalid-time-token");
    }
  });
});

describe("applyParams", () => {
  it("replaces only the arguments the step declares overridable", () => {
    expect(applyParams(ranged(), { station: "harbour", from: "$now-7d", secret: "x" })).toEqual({
      args: { from: "$now-7d", to: "$now", station: "harbour" },
      findings: [],
    });
  });

  it("supplies a declared overridable argument the step left out", () => {
    expect(applyParams(ranged({ arguments: {} }), { to: "$now" }).args).toEqual({ to: "$now" });
  });

  it("never replaces a {{steps.…}} template, and never applies a param that is one", () => {
    const templated: MCPToolNode = {
      ...mcpStep("b", "t", { id: "{{steps.a.output.id}}", q: "x" }, ["a"]),
      overridable: ["id", "q"],
    };
    const r = applyParams(templated, { id: "hijack", q: "{{steps.a.output.secret}}" });
    expect(r.args).toEqual({ id: "{{steps.a.output.id}}", q: "x" });
    expect(r.findings.map((f) => f.code)).toEqual(["param-templated", "param-template-refused"]);
  });

  it("a __proto__ param lands as an own argument, never on a prototype", () => {
    const step: MCPToolNode = { ...mcpStep("s", "t", {}), overridable: ["__proto__"] };
    const params = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const r = applyParams(step, params);
    expect(Object.hasOwn(r.args, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(r.args)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("checkParams / paramsKey / providerParams", () => {
  it("keys are canonical: key order does not matter, values do; {} keys to ''", () => {
    expect(paramsKey({ a: 1, b: "x" })).toBe(paramsKey({ b: "x", a: 1 }));
    expect(paramsKey({ a: 1 })).not.toBe(paramsKey({ a: 2 }));
    expect(paramsKey({})).toBe("");
  });

  it("refuses what cannot be keyed", () => {
    expect(checkParams({ a: Number.NaN })?.code).toBe("invalid-params");
    expect(checkParams([1])?.code).toBe("invalid-params");
    expect(checkParams(null)?.code).toBe("invalid-params");
    expect(checkParams({ a: "$now-1d" })).toBeUndefined();
  });

  it("providerParams is the sorted union of every step's overridable names", () => {
    const spec = providerSpec("h", [
      ranged(),
      { ...mcpStep("t", "x"), overridable: ["region", "from"] },
    ]);
    expect(providerParams(spec)).toEqual(["from", "region", "station", "to"]);
  });
});

describe("prepareArguments", () => {
  it("params, then time tokens, then templates, then the hook — which sees the load's params and instant", () => {
    const node: MCPToolNode = {
      ...mcpStep("b", "t", { from: "$now-1h", id: "{{steps.a.output.id}}" }, ["a"]),
      overridable: ["from"],
    };
    const seen: unknown[] = [];
    const r = prepareArguments(node, new Map([["a", { id: 7 }]]), {
      handle: "h",
      params: { from: "$now-1d" },
      now: NOW,
      hook: (args, ctx) => {
        seen.push(ctx);
        return { ...args, bucket: "1h" };
      },
    });
    expect(r).toEqual({
      ok: true,
      args: { from: "2026-09-22T12:00:00.000Z", id: 7, bucket: "1h" },
      findings: [],
    });
    expect(seen).toEqual([
      { handle: "h", stepId: "b", toolName: "t", params: { from: "$now-1d" }, now: NOW },
    ]);
  });

  it("a hook that throws or returns a non-object fails the step", () => {
    const node = mcpStep("s", "t");
    const throws = prepareArguments(node, new Map(), {
      handle: "h",
      params: {},
      now: NOW,
      hook: () => {
        throw new Error("no");
      },
    });
    expect(!throws.ok && throws.finding.code).toBe("argument-hook-failed");
    const array = prepareArguments(node, new Map(), {
      handle: "h",
      params: {},
      now: NOW,
      hook: () => [] as unknown as Record<string, unknown>,
    });
    expect(!array.ok && array.finding.code).toBe("argument-hook-failed");
  });
});

describe("executeProvider with params", () => {
  it("applies params to overridable arguments, resolves tokens against `now`, warns about params no step declares", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => (input as McpIn).args);
    const r = await executeProvider(providerSpec("h", [ranged()]), {
      invoker: inv,
      now: NOW,
      params: { station: "harbour", colour: "red" },
    });
    expect((inv.calls[0]?.input as McpIn).args).toEqual({
      from: "2026-09-23T11:00:00.000Z",
      to: "2026-09-23T12:00:00.000Z",
      station: "harbour",
    });
    expect(r.ok && r.findings.map((f) => f.code)).toEqual([
      "param-not-overridable",
      "output-shape-unpinned",
    ]);
  });

  it("a malformed token fails its step before any call is made", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({}));
    const r = await executeProvider(providerSpec("h", [ranged()]), {
      invoker: inv,
      now: NOW,
      params: { from: "$now-3y" },
    });
    expect(!r.ok && r.findings.map((f) => f.code)).toEqual(["invalid-time-token"]);
    expect(inv.calls).toHaveLength(0);
  });

  it("the argument hook has the last word before the call", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => (input as McpIn).args);
    await executeProvider(providerSpec("h", [ranged()]), {
      invoker: inv,
      now: NOW,
      argumentHook: (args, ctx) => ({
        ...args,
        bucket: ctx.params.from === undefined ? "5m" : "1h",
      }),
    });
    expect((inv.calls[0]?.input as McpIn).args.bucket).toBe("5m");
  });
});

describe("prepareArguments — own-key safety", () => {
  it("an own __proto__ argument stays an own argument end to end, and pollutes nothing", () => {
    const step: MCPToolNode = {
      ...mcpStep("s", "t", JSON.parse('{"__proto__": {"polluted": "$now"}, "q": 1}')),
    };
    const r = prepareArguments(step, new Map(), { handle: "h", params: {}, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.hasOwn(r.args, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(r.args)).toBe(Object.prototype);
    expect((r.args as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(r.args, "__proto__")?.value).toEqual({
      polluted: "2026-09-23T12:00:00.000Z",
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("an own __proto__ param on an overridable argument survives templating too", () => {
    const step: MCPToolNode = {
      ...mcpStep("b", "t", { id: "{{steps.a.output.id}}" }, ["a"]),
      overridable: ["__proto__"],
    };
    const params = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const r = prepareArguments(step, new Map([["a", { id: 7 }]]), {
      handle: "h",
      params,
      now: NOW,
    });
    expect(r.ok && Object.hasOwn(r.args, "__proto__")).toBe(true);
    expect(r.ok && Object.getPrototypeOf(r.args)).toBe(Object.prototype);
    expect(r.ok && r.args.id).toBe(7);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("prepareArguments — a param never cuts the graph", () => {
  it("an overridable argument holding a {{steps.…}} template keeps the upstream output, with a warn", () => {
    const node: MCPToolNode = {
      ...mcpStep("b", "t", { id: "{{steps.a.output.id}}" }, ["a"]),
      overridable: ["id"],
    };
    const r = prepareArguments(node, new Map([["a", { id: 7 }]]), {
      handle: "h",
      params: { id: 99 },
      now: NOW,
    });
    expect(r).toEqual({
      ok: true,
      args: { id: 7 },
      findings: [expect.objectContaining({ code: "param-templated", severity: "warn" })],
    });
  });

  it("a nested template inside an overridable argument is protected too", () => {
    const node: MCPToolNode = {
      ...mcpStep("b", "t", { filter: { id: "{{steps.a.output.id}}" } }, ["a"]),
      overridable: ["filter"],
    };
    const r = applyParams(node, { filter: { id: 1 } });
    expect(r.args).toEqual({ filter: { id: "{{steps.a.output.id}}" } });
    expect(r.findings.map((f) => f.code)).toEqual(["param-templated"]);
  });

  it("a param carrying a template (nested included) is refused, so it cannot read another step's output", () => {
    const node: MCPToolNode = { ...mcpStep("b", "t", { q: "x" }, ["a"]), overridable: ["q"] };
    const r = prepareArguments(node, new Map([["a", { secret: "s" }]]), {
      handle: "h",
      params: { q: ["{{steps.a.output.secret}}"] },
      now: NOW,
    });
    expect(r).toEqual({
      ok: true,
      args: { q: "x" },
      findings: [expect.objectContaining({ code: "param-template-refused", severity: "warn" })],
    });
  });
});

describe("the argument hook carries domain rules, not loom-ui", () => {
  // A host-side rule written ONLY through the generic hook: derive a bucket argument from the
  // span the load's resolved time range covers. loom-ui knows nothing about buckets.
  const bucketFor = (from: string, to: string): string =>
    Date.parse(to) - Date.parse(from) > 86_400_000 ? "1h" : "5m";

  it("a host hook derives an argument from the resolved range", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => (input as McpIn).args);
    await executeProvider(providerSpec("h", [ranged()]), {
      invoker: inv,
      now: NOW,
      params: { from: "$now-7d" },
      argumentHook: (args) => ({
        ...args,
        bucket: bucketFor(String(args.from), String(args.to)),
      }),
    });
    expect((inv.calls[0]?.input as McpIn).args).toMatchObject({
      from: "2026-09-16T12:00:00.000Z",
      bucket: "1h",
    });
  });
});

describe("executeProvider hands the hook only the params a step declares", () => {
  it("an undeclared param is warned about and never reaches the hook", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => (input as McpIn).args);
    const seen: unknown[] = [];
    await executeProvider(providerSpec("h", [ranged()]), {
      invoker: inv,
      now: NOW,
      params: { station: "harbour", colour: "red" },
      argumentHook: (args, ctx) => {
        seen.push(ctx.params);
        return args;
      },
    });
    expect(seen).toEqual([{ station: "harbour" }]);
  });
});
