import { TypedFailure } from "@loom/core";
import { SANDBOX_TOOL_ID, shapeHash } from "@loom/plugin-sandbox";
import { describe, expect, it } from "vitest";
import { jsonPathSelect, outputShapeHashOf, reshape } from "./reshape";
import { FakeInvoker } from "./testing.test-support";

describe("jsonPathSelect", () => {
  it("identity on '' and '$', dotted paths otherwise, finding when nothing is there", () => {
    const v = { a: { b: [1, 2] } };
    expect(jsonPathSelect(v, "")).toEqual({ ok: true, value: v });
    expect(jsonPathSelect(v, "$")).toEqual({ ok: true, value: v });
    expect(jsonPathSelect(v, "a.b[1]")).toEqual({ ok: true, value: 2 });
    const r = jsonPathSelect(v, "a.zzz");
    expect(!r.ok && r.finding.code).toBe("reshape-failed");
  });
});

describe("reshape", () => {
  it("JSONPath runs inline with no invocation at all", async () => {
    const inv = new FakeInvoker();
    const r = await reshape(
      { engine: "JSONPath", scriptRef: "rows" },
      { rows: [1] },
      { invoker: inv }
    );
    expect(r).toEqual({ ok: true, value: [1] });
    expect(inv.calls).toEqual([]);
  });
  it("QuickJS invokes the sandbox with the content ref and the raw input, forwarding signal and label", async () => {
    const inv = new FakeInvoker().on(SANDBOX_TOOL_ID, (input) => ({
      shaped: (input as { input: unknown }).input,
    }));
    const ac = new AbortController();
    const r = await reshape(
      { engine: "QuickJS", scriptRef: "sha256:abc" },
      { raw: 1 },
      { invoker: inv, signal: ac.signal }
    );
    expect(r).toEqual({ ok: true, value: { shaped: { raw: 1 } } });
    expect(inv.calls[0]).toMatchObject({
      toolId: SANDBOX_TOOL_ID,
      input: { scriptRef: { __loomContent: "sha256:abc" }, input: { raw: 1 } },
    });
    expect(inv.calls[0]?.opts?.signal).toBe(ac.signal);
    expect(inv.calls[0]?.opts?.label).toBe("loom-ui.reshape");
  });
  it("a sandbox typed failure becomes reshape-<channel>; any other throw becomes reshape-failed", async () => {
    const typed = new FakeInvoker().on(SANDBOX_TOOL_ID, () => {
      throw new TypedFailure("limitExceeded", { kind: "cpu" });
    });
    const r1 = await reshape({ engine: "QuickJS", scriptRef: "sha256:x" }, {}, { invoker: typed });
    expect(!r1.ok && r1.finding.code).toBe("reshape-limitExceeded");
    const plain = new FakeInvoker().on(SANDBOX_TOOL_ID, () => {
      throw new Error("boom");
    });
    const r2 = await reshape({ engine: "QuickJS", scriptRef: "sha256:x" }, {}, { invoker: plain });
    expect(!r2.ok && r2.finding.code).toBe("reshape-failed");
  });
});

describe("outputShapeHashOf", () => {
  it("is loom's shapeHash, so the planner pins with the same function", () => {
    const v = { a: 1, b: ["x"] };
    expect(outputShapeHashOf(v)).toBe(shapeHash(v));
    expect(outputShapeHashOf({ a: 2, b: ["y"] })).toBe(outputShapeHashOf(v));
    expect(outputShapeHashOf({ a: "s" })).not.toBe(outputShapeHashOf(v));
  });
});
