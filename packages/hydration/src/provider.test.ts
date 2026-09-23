import { isTainted, taintOf, unwrapTainted } from "@loom/classify";
import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { SANDBOX_TOOL_ID } from "@loom/plugin-sandbox";
import { describe, expect, it } from "vitest";
import { executeProvider } from "./provider";
import { outputShapeHashOf } from "./reshape";
import { FakeInvoker, mcpStep, providerSpec } from "./testing.test-support";

type McpIn = { toolName: string; args: Record<string, unknown>; expectedSchemaHash: string };

describe("executeProvider", () => {
  it("runs the graph in waves with pinned schema hashes, templates arguments, and reshapes the terminal output", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
      const i = input as McpIn;
      if (i.toolName === "db.list") return { ids: ["a", "b"] };
      if (i.toolName === "db.stats") return { for: i.args.id, p99: 412 };
      throw new Error("unexpected");
    });
    const spec = providerSpec(
      "h",
      [
        mcpStep("list", "db.list"),
        mcpStep("stats", "db.stats", { id: "{{steps.list.output.ids[0]}}" }, ["list"]),
      ],
      { reshaping: { engine: "JSONPath", scriptRef: "p99" } }
    );
    const r = await executeProvider(spec, { invoker: inv });
    expect(r).toMatchObject({ ok: true, value: 412 });
    expect(r.ok && r.findings.map((f) => f.code)).toEqual(["output-shape-unpinned"]);
    expect(inv.calls.map((c) => (c.input as McpIn).toolName)).toEqual(["db.list", "db.stats"]);
    expect((inv.calls[1]?.input as McpIn).args).toEqual({ id: "a" });
    expect((inv.calls[1]?.input as McpIn).expectedSchemaHash).toBe("schema-db.stats");
  });

  it("schema drift makes the outcome stale-able: a drift record, NO re-run, no value", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
      throw new TypedFailure("schemaDrift", {
        toolName: "db.list",
        expectedSchemaHash: "schema-db.list",
        observedHash: "schema-v2",
      });
    });
    const r = await executeProvider(providerSpec("h", [mcpStep("list", "db.list")]), {
      invoker: inv,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe("schema-drift");
    expect(r.drift).toEqual([
      {
        kind: "input",
        handle: "h",
        stepId: "list",
        toolName: "db.list",
        expected: "schema-db.list",
        observed: "schema-v2",
      },
    ]);
    expect(inv.calls).toHaveLength(1);
  });

  it("a pinned output shape that matches is ready with no warn; one that differs is output drift", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ p99: 1 }));
    const good = providerSpec("h", [mcpStep("s", "t")], {
      outputShapeHash: outputShapeHashOf({ p99: 1 }),
    });
    const r1 = await executeProvider(good, { invoker: inv });
    expect(r1).toEqual({ ok: true, value: { p99: 1 }, findings: [] });
    const bad = providerSpec("h", [mcpStep("s", "t")], {
      outputShapeHash: outputShapeHashOf({ p99: "string-now" }),
    });
    const r2 = await executeProvider(bad, { invoker: inv });
    expect(!r2.ok && r2.finding.code).toBe("output-shape-drift");
    expect(!r2.ok && r2.drift).toEqual([
      {
        kind: "output",
        handle: "h",
        expected: outputShapeHashOf({ p99: "string-now" }),
        observed: outputShapeHashOf({ p99: 1 }),
        observedShape: { p99: "number" },
        // This spec's reshaping is the identity (`scriptRef: ""`), so raw and reshaped coincide.
        observedRawShape: { p99: "number" },
      },
    ]);
  });

  it("other tool failures: typed → tool-<channel>; thrown → tool-failed; a graph cycle → graph-cycle before any call", async () => {
    const typed = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
      throw new TypedFailure("toolNotFound", { toolName: "t" });
    });
    const r1 = await executeProvider(providerSpec("h", [mcpStep("s", "t")]), { invoker: typed });
    expect(!r1.ok && r1.findings.map((f) => f.code)).toEqual(["tool-toolNotFound"]);
    const plain = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
      throw new Error("net");
    });
    const r2 = await executeProvider(providerSpec("h", [mcpStep("s", "t")]), { invoker: plain });
    expect(!r2.ok && r2.findings.map((f) => f.code)).toEqual(["tool-failed"]);
    const cyc = new FakeInvoker();
    const r3 = await executeProvider(
      providerSpec("h", [mcpStep("a", "t", {}, ["b"]), mcpStep("b", "t", {}, ["a"])]),
      { invoker: cyc }
    );
    expect(!r3.ok && r3.finding.code).toBe("graph-cycle");
    expect(cyc.calls).toEqual([]);
  });

  it("several terminal steps yield a record keyed by stepId; QuickJS reshaping goes through the sandbox; an abort is 'aborted'", async () => {
    const inv = new FakeInvoker()
      .on(MCP_INVOKE_TOOL_ID, (input) => ({ from: (input as McpIn).toolName }))
      .on(SANDBOX_TOOL_ID, (input) => ({ wrapped: (input as { input: unknown }).input }));
    const spec = providerSpec("h", [mcpStep("x", "tx"), mcpStep("y", "ty")], {
      reshaping: { engine: "QuickJS", scriptRef: "sha256:s" },
    });
    const r = await executeProvider(spec, { invoker: inv });
    expect(r).toMatchObject({
      ok: true,
      value: { wrapped: { x: { from: "tx" }, y: { from: "ty" } } },
    });
    const ac = new AbortController();
    ac.abort();
    const r2 = await executeProvider(providerSpec("h", [mcpStep("s", "t")]), {
      invoker: inv,
      signal: ac.signal,
    });
    expect(!r2.ok && r2.findings.map((f) => f.code)).toEqual(["aborted"]);
  });

  it("an empty graph is a finding, not an invocation", async () => {
    const r = await executeProvider(providerSpec("h", []), { invoker: new FakeInvoker() });
    expect(!r.ok && r.finding.code).toBe("empty-graph");
  });
});

describe("executeProvider is total: a value it cannot inspect is a finding, never a throw", () => {
  it("an output the shape hash cannot walk fails as output-shape-unhashable with no drift record", async () => {
    // Deeper than `shapeOf`'s 1024 cap — a tool server can return this, and a throw here would
    // escape `executeProvider` as a rejection with no finding attached to the handle.
    let deep: unknown = { leaf: 1 };
    for (let i = 0; i < 1100; i++) deep = { n: deep };
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => deep);
    const spec = providerSpec("h", [mcpStep("s", "t")], {
      outputShapeHash: outputShapeHashOf({ leaf: 1 }),
    });
    const r = await executeProvider(spec, { invoker: inv });
    expect(!r.ok && r.finding.code).toBe("output-shape-unhashable");
    expect(!r.ok && r.findings.map((f) => f.code)).toEqual(["output-shape-unhashable"]);
    // Unverifiable is not the same as drifted: nothing here is a pin the app could remap.
    expect(!r.ok && r.drift).toEqual([]);
  });

  it("a typed failure whose payload cannot be serialized still produces its tool-<channel> finding", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
      throw new TypedFailure("rateLimited", cyclic);
    });
    const r = await executeProvider(providerSpec("h", [mcpStep("s", "t")]), { invoker: inv });
    expect(!r.ok && r.findings.map((f) => f.code)).toEqual(["tool-rateLimited"]);
    expect(!r.ok && r.findings[0]?.message).toContain("[unserializable payload]");
  });
});

describe("output drift carries both shapes, and a RAW sample only on opt-in", () => {
  const specPinnedToNumber = providerSpec("h", [mcpStep("s", "t")], {
    outputShapeHash: outputShapeHashOf({ count: 1 }),
  });
  // A NON-identity reshaping, so "the sample is raw" is actually observable: the tool now nests
  // the count it used to return flat, and the planner re-authors `totals.count` → the new path.
  const specWithPath = providerSpec("h", [mcpStep("s", "t")], {
    reshaping: { engine: "JSONPath", scriptRef: "totals.count" },
    outputShapeHash: outputShapeHashOf(412),
  });
  const nestedReply = { totals: { count: { value: 412 } } };
  const invokerReturning = (output: unknown): FakeInvoker =>
    new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => output);
  const spec = providerSpec("h", [mcpStep("list", "db.list")]);
  const invokerThrowingSchemaDrift = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
    throw new TypedFailure("schemaDrift", {
      toolName: "db.list",
      expectedSchemaHash: "schema-db.list",
      observedHash: "schema-v2",
    });
  });

  it("records observedShape (loom shapeOf) and no sample by default", async () => {
    const outcome = await executeProvider(specPinnedToNumber, {
      invoker: invokerReturning({ count: "412" }),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const d = outcome.drift.find((r) => r.kind === "output");
      expect(d?.observedShape).toEqual({ count: "string" });
      expect(d?.observedRawShape).toEqual({ count: "string" }); // identity reshaping
      expect(d?.observedSample).toBeUndefined();
    }
  });

  it("captures the RAW terminal output as a TAINTED sample when captureSample is set, with the reshaped shape AND the raw shape beside it", async () => {
    const outcome = await executeProvider(specWithPath, {
      invoker: invokerReturning(nestedReply),
      captureSample: true,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const d = outcome.drift.find((r) => r.kind === "output");
      expect(isTainted(d?.observedSample)).toBe(true);
      // The RAW reply, NOT the reshaped `{ value: 412 }`: a planner authors a path against raw.
      expect(unwrapTainted(d?.observedSample)).toEqual(nestedReply);
      expect(taintOf(d?.observedSample)?.origin).toBe(`provider:${specWithPath.handle}`);
      expect(d?.observedShape).toEqual({ value: "number" }); // what failed the pin
      expect(d?.observedRawShape).toEqual({ totals: { count: { value: "number" } } });
    }
  });

  it("without a sample the raw shape alone still says where the value moved to", async () => {
    const outcome = await executeProvider(specWithPath, {
      invoker: invokerReturning(nestedReply),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const d = outcome.drift.find((r) => r.kind === "output");
      expect(d?.observedSample).toBeUndefined();
      expect(d?.observedRawShape).toEqual({ totals: { count: { value: "number" } } });
    }
  });

  it("input drift records are unchanged (no shape, no sample)", async () => {
    const outcome = await executeProvider(spec, {
      invoker: invokerThrowingSchemaDrift,
      captureSample: true,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      const d = outcome.drift.find((r) => r.kind === "input");
      expect(d?.observedShape).toBeUndefined();
      expect(d?.observedRawShape).toBeUndefined();
      expect(d?.observedSample).toBeUndefined();
    }
  });
});

describe("executeProvider finding order", () => {
  it("lists findings in GRAPH order, not in the order the steps happened to fail", async () => {
    // `slow` is declared first and settles last; `fast` throws synchronously. Completion order
    // is [fast, slow]; the findings must still read [slow, fast].
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, async (input) => {
      const t = (input as McpIn).toolName;
      if (t === "fast") throw new TypedFailure("fast", { t });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      throw new TypedFailure("slow", { t });
    });
    const r = await executeProvider(
      providerSpec("h", [mcpStep("a", "slow"), mcpStep("b", "fast")]),
      { invoker: inv }
    );
    expect(!r.ok && r.findings.map((f) => f.code)).toEqual(["tool-slow", "tool-fast"]);
  });
});
