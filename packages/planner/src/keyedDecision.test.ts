import { describe, expect, it } from "vitest";
import { MIN_DECISION_KEY_BYTES, planDecisionId } from "./decision";
import { ReferencePlanner } from "./reference";
import {
  capabilitiesFixture,
  intentFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";

const input = {
  intent: intentFixture,
  catalog: planningCatalog,
  capabilities: capabilitiesFixture,
};
const reviseInput = {
  versionHash: "sha256:abc",
  request: "make it bigger" as never,
  catalog: planningCatalog,
  capabilities: capabilitiesFixture,
};
const keyA = "a".repeat(32);
const keyB = "b".repeat(32);

describe("planDecisionId unkeyed (golden)", () => {
  it("is byte-for-byte the id earlier versions recorded (pinned on main before the keyed option)", () => {
    expect(planDecisionId("compose", input)).toBe("plan:compose:4f80edebea0a15d2");
    expect(planDecisionId("revise", reviseInput)).toBe("plan:revise:698220f7ee835b65");
    expect(planDecisionId("compose", input, {})).toBe("plan:compose:4f80edebea0a15d2");
  });
});

describe("planDecisionId keyed", () => {
  it("is deterministic, per key, k:-marked and does not embed the unkeyed digest", () => {
    const unkeyed = planDecisionId("compose", input);
    const a = planDecisionId("compose", input, { key: keyA });
    expect(a).toMatch(/^plan:compose:k:[0-9a-f]{32}$/);
    expect(planDecisionId("compose", input, { key: keyA })).toBe(a);
    expect(planDecisionId("compose", input, { key: new TextEncoder().encode(keyA) })).toBe(a);
    expect(planDecisionId("compose", input, { key: keyB })).not.toBe(a);
    expect(a).not.toBe(unkeyed);
    expect(a).not.toContain(unkeyed.split(":")[2] as string);
    expect(planDecisionId("revise", reviseInput, { key: keyA })).toMatch(
      /^plan:revise:k:[0-9a-f]{32}$/
    );
  });
  it("still changes with the input", () => {
    const other = planDecisionId(
      "compose",
      { ...input, intent: { ...intentFixture, objective: "other" } },
      { key: keyA }
    );
    expect(other).not.toBe(planDecisionId("compose", input, { key: keyA }));
  });
  it("refuses a key shorter than the minimum, as bytes or as a string", () => {
    expect(MIN_DECISION_KEY_BYTES).toBe(32);
    expect(() => planDecisionId("compose", input, { key: "a".repeat(31) })).toThrow(
      /at least 32 bytes/
    );
    expect(() => planDecisionId("compose", input, { key: new Uint8Array(31) })).toThrow(
      /at least 32 bytes/
    );
    expect(() => planDecisionId("compose", input, { key: new Uint8Array(32) })).not.toThrow();
  });
});

const goodDraft = JSON.stringify({
  summary: "Weekly orders",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders (7d)",
      span: 4,
      props: { unit: "orders" },
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0",
      },
    },
  ],
});

describe("ReferencePlanner decisionKey", () => {
  it("refuses a short key at construction", () => {
    expect(
      () =>
        new ReferencePlanner({
          model: scriptedModel([goodDraft]),
          modelId: "m",
          decisionKey: "short",
        })
    ).toThrow(/at least 32 bytes/);
  });
  it("records the keyed id and replays it with the same key and no model call", async () => {
    const model = scriptedModel([goodDraft]);
    const ctx = recordingContext();
    const first = await new ReferencePlanner({ model, modelId: "m", decisionKey: keyA }).compose(
      input,
      ctx
    );
    expect(first.report.decisionId).toBe(planDecisionId("compose", input, { key: keyA }));
    expect([...ctx.decisions.keys()]).toEqual([first.report.decisionId]);
    const second = await new ReferencePlanner({ model, modelId: "m", decisionKey: keyA }).compose(
      input,
      ctx
    );
    expect(second).toEqual(first);
    expect(model.calls).toBe(1);
    expect(ctx.deciderCalls).toBe(1);
  });
  it("a different key (or none) does not match the recorded decision: it re-decides under a new id, never serves the old answer", async () => {
    const model = scriptedModel([goodDraft]);
    const ctx = recordingContext();
    const first = await new ReferencePlanner({ model, modelId: "m", decisionKey: keyA }).compose(
      input,
      ctx
    );
    const rotated = await new ReferencePlanner({ model, modelId: "m", decisionKey: keyB }).compose(
      input,
      ctx
    );
    const unkeyed = await new ReferencePlanner({ model, modelId: "m" }).compose(input, ctx);
    expect(model.calls).toBe(3);
    expect(ctx.decisions.size).toBe(3);
    expect(new Set([first, rotated, unkeyed].map((r) => r.report.decisionId)).size).toBe(3);
  });
});
