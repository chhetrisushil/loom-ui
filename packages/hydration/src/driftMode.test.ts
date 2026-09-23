import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { describe, expect, it } from "vitest";
import { executeProvider } from "./provider";
import { outputShapeHashOf } from "./reshape";
import { FakeInvoker, mcpStep, providerSpec } from "./testing.test-support";

type McpIn = { toolName: string; args: Record<string, unknown>; expectedSchemaHash: string };

/** A tool whose CURRENT input-schema hash is `current`: any other pin is a typed schemaDrift. */
const toolAt = (current: string, reply: unknown = { n: 7 }) =>
  new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
    const i = input as McpIn;
    if (i.expectedSchemaHash !== current)
      throw new TypedFailure("schemaDrift", {
        toolName: i.toolName,
        expectedSchemaHash: i.expectedSchemaHash,
        observedHash: current,
      });
    return reply;
  });
const pins = (inv: FakeInvoker) => inv.calls.map((c) => (c.input as McpIn).expectedSchemaHash);

describe("inputDrift", () => {
  it("'report' (the default) records the drift, fails the step and never retries", async () => {
    const inv = toolAt("v2");
    const r = await executeProvider(providerSpec("h", [mcpStep("s", "t")]), { invoker: inv });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.drift).toEqual([
      {
        kind: "input",
        handle: "h",
        stepId: "s",
        toolName: "t",
        expected: "schema-t",
        observed: "v2",
      },
    ]);
    expect(pins(inv)).toEqual(["schema-t"]);
  });

  it("a drift that is not proceeded past is the outcome's finding: schema-drift, not provider-failed", async () => {
    const r = await executeProvider(providerSpec("h", [mcpStep("s", "t")]), {
      invoker: toolAt("v2"),
    });
    expect(!r.ok && r.finding.code).toBe("schema-drift");
    expect(!r.ok && r.finding).toBe(r.findings.find((f) => f.code === "schema-drift"));
  });

  it("several drifted steps: the FIRST in graph order is the outcome's finding", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
      const i = input as McpIn;
      throw new TypedFailure("schemaDrift", {
        toolName: i.toolName,
        expectedSchemaHash: i.expectedSchemaHash,
        observedHash: "v2",
      });
    });
    const r = await executeProvider(providerSpec("h", [mcpStep("a", "ta"), mcpStep("b", "tb")]), {
      invoker: inv,
    });
    expect(!r.ok && r.finding.code).toBe("schema-drift");
    expect(!r.ok && r.finding.message).toContain('step "a"');
  });

  it("a step skipped because a drifted step failed is a consequence: still schema-drift", async () => {
    const r = await executeProvider(
      providerSpec("h", [mcpStep("s", "t"), mcpStep("d", "u", {}, ["s"])]),
      { invoker: toolAt("v2") }
    );
    expect(r.findings.map((f) => f.code)).toEqual(["schema-drift", "dependency-failed"]);
    expect(!r.ok && r.finding.code).toBe("schema-drift");
  });

  it("drift mixed with any other failure stays provider-failed", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
      const i = input as McpIn;
      if (i.toolName === "ta")
        throw new TypedFailure("schemaDrift", {
          toolName: i.toolName,
          expectedSchemaHash: i.expectedSchemaHash,
          observedHash: "v2",
        });
      throw new Error("down");
    });
    const r = await executeProvider(providerSpec("h", [mcpStep("a", "ta"), mcpStep("b", "tb")]), {
      invoker: inv,
    });
    expect(!r.ok && r.finding.code).toBe("provider-failed");
  });

  it("'report-and-proceed' records the drift, retries ONCE with the observed pin and publishes", async () => {
    const inv = toolAt("v2");
    const r = await executeProvider(providerSpec("h", [mcpStep("s", "t")]), {
      invoker: inv,
      inputDrift: "report-and-proceed",
    });
    expect(r).toMatchObject({ ok: true, value: { n: 7 } });
    expect(r.ok && r.drift).toEqual([
      {
        kind: "input",
        handle: "h",
        stepId: "s",
        toolName: "t",
        expected: "schema-t",
        observed: "v2",
      },
    ]);
    expect(r.findings.map((f) => f.code)).toEqual([
      "schema-drift-proceeded",
      "output-shape-unpinned",
    ]);
    expect(pins(inv)).toEqual(["schema-t", "v2"]);
  });

  it("a retry that drifts again is a failure, not a loop", async () => {
    let n = 0;
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
      n += 1;
      throw new TypedFailure("schemaDrift", {
        toolName: (input as McpIn).toolName,
        expectedSchemaHash: (input as McpIn).expectedSchemaHash,
        observedHash: `v${n + 1}`,
      });
    });
    const r = await executeProvider(providerSpec("h", [mcpStep("s", "t")]), {
      invoker: inv,
      inputDrift: "report-and-proceed",
    });
    expect(!r.ok && r.finding.code).toBe("provider-failed");
    expect(r.findings.map((f) => f.code)).toEqual(["tool-schemaDrift"]);
    expect(inv.calls).toHaveLength(2);
  });

  it("output drift is never proceeded past: both drifts are reported", async () => {
    const inv = toolAt("v2", { n: "seven" });
    const r = await executeProvider(
      providerSpec("h", [mcpStep("s", "t")], { outputShapeHash: outputShapeHashOf({ n: 7 }) }),
      { invoker: inv, inputDrift: "report-and-proceed" }
    );
    expect(!r.ok && r.finding.code).toBe("output-shape-drift");
    expect(!r.ok && r.drift.map((d) => d.kind)).toEqual(["input", "output"]);
  });

  it("a downstream step's {{steps.…}} argument sees the RETRIED step's output, not the stale one", async () => {
    // "src" drifts to "v2" on its first call, like `toolAt`, but "sink" (depending on "src")
    // shares the same fake invoker/tool-id dispatch, so it needs its own toolName-keyed handler.
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
      const i = input as McpIn;
      if (i.toolName === "src") {
        if (i.expectedSchemaHash !== "v2")
          throw new TypedFailure("schemaDrift", {
            toolName: i.toolName,
            expectedSchemaHash: i.expectedSchemaHash,
            observedHash: "v2",
          });
        return { n: 9 };
      }
      return { got: i.args.ref };
    });
    const r = await executeProvider(
      providerSpec("h", [
        mcpStep("s", "src"),
        mcpStep("d", "sink", { ref: "{{steps.s.output.n}}" }, ["s"]),
      ]),
      { invoker: inv, inputDrift: "report-and-proceed" }
    );
    // The step that drifted published the RETRIED value (9), so the downstream template — read
    // from the same `outputs` map, in a later wave — resolves against that value, not the drifted
    // call's (nonexistent) reply.
    expect(r).toMatchObject({ ok: true, value: { got: 9 } });
    expect(r.ok && r.drift).toEqual([
      {
        kind: "input",
        handle: "h",
        stepId: "s",
        toolName: "src",
        expected: "schema-src",
        observed: "v2",
      },
    ]);
    expect(r.ok && r.findings.map((f) => f.code)).toEqual([
      "schema-drift-proceeded",
      "output-shape-unpinned",
    ]);
  });
});
