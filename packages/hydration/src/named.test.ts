import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { describe, expect, it } from "vitest";
import { executeProvider } from "./provider";
import { defineReshapers, reshape } from "./reshape";
import { FakeInvoker, mcpStep, providerSpec } from "./testing.test-support";

describe("Named reshaping", () => {
  it("runs a host-registered reshaper in-process: no sandbox hop", async () => {
    const inv = new FakeInvoker();
    const reshapers = defineReshapers({ double: (x) => (x as number) * 2 });
    expect(
      await reshape({ engine: "Named", scriptRef: "double" }, 21, { invoker: inv, reshapers })
    ).toEqual({
      ok: true,
      value: 42,
    });
    expect(inv.calls).toHaveLength(0);
  });

  it("an async reshaper is awaited", async () => {
    const reshapers = defineReshapers({ later: async (x) => ({ wrapped: x }) });
    expect(
      await reshape({ engine: "Named", scriptRef: "later" }, 1, {
        invoker: new FakeInvoker(),
        reshapers,
      })
    ).toEqual({ ok: true, value: { wrapped: 1 } });
  });

  it("an unregistered name, a prototype key or no registry at all is a finding, never a fall-through", async () => {
    const inv = new FakeInvoker();
    const reshapers = defineReshapers({ double: (x) => (x as number) * 2 });
    for (const [name, ctx] of [
      ["triple", { invoker: inv, reshapers }],
      ["constructor", { invoker: inv, reshapers }],
      ["double", { invoker: inv }],
    ] as const) {
      const r = await reshape({ engine: "Named", scriptRef: name }, 1, ctx);
      expect(!r.ok && r.finding.code).toBe("reshape-unregistered");
    }
    expect(inv.calls).toHaveLength(0);
  });

  it("a reshaper that throws or rejects is reshape-failed", async () => {
    const reshapers = defineReshapers({
      throws: () => {
        throw new Error("bad row");
      },
      rejects: async () => {
        throw new Error("bad row later");
      },
    });
    for (const name of ["throws", "rejects"]) {
      const r = await reshape({ engine: "Named", scriptRef: name }, 1, {
        invoker: new FakeInvoker(),
        reshapers,
      });
      expect(!r.ok && r.finding.code).toBe("reshape-failed");
      expect(!r.ok && r.finding.message).toContain("bad row");
    }
  });

  it("executeProvider threads the registry to its terminal reshape", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ rows: [{ t: 1 }, { t: 2 }] }));
    const spec = providerSpec("h", [mcpStep("s", "t")], {
      reshaping: { engine: "Named", scriptRef: "count" },
    });
    const r = await executeProvider(spec, {
      invoker: inv,
      reshapers: defineReshapers({ count: (raw) => (raw as { rows: unknown[] }).rows.length }),
    });
    expect(r).toMatchObject({ ok: true, value: 2 });
    expect(inv.calls.map((c) => c.toolId)).toEqual([MCP_INVOKE_TOOL_ID]); // no sandbox call
  });
});
