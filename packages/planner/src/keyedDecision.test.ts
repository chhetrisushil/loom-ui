import { inspect } from "node:util";
import { genesis, replay } from "@loomwork/ui-core";
import { seal } from "@loomwork/ui-core/log";
import { describe, expect, it } from "vitest";
import { MIN_DECISION_KEY_BYTES, planDecisionId } from "./decision";
import { ReferencePlanner } from "./reference";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
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
// Fixed random-looking bytes (not a repeated character): the tests must not model a weak key.
const bytesFromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const KEY_A_HEX = "9f3ac1d27be40856a1c97d3e5b02f48e6d71a3c58e9b04f2173d6ca8e5b09d41";
const KEY_B_HEX = "2be7d905f4a1386cc07e5d93a8b4126fe3590ad7c46b81f20e9d37a5c1648bd3";
const keyA = bytesFromHex(KEY_A_HEX);
const keyB = bytesFromHex(KEY_B_HEX);
// A string key is still accepted (UTF-8, 32 bytes of ASCII here).
const stringKey = "k7Qz2vXr9LmN4pTw8YbC1dHs6FjG3aEu";

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
    expect(planDecisionId("compose", input, { key: new Uint8Array(keyA) })).toBe(a);
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
  it("still accepts a 32-byte string key, UTF-8 encoded", () => {
    const viaString = planDecisionId("compose", input, { key: stringKey });
    expect(viaString).toMatch(/^plan:compose:k:[0-9a-f]{32}$/);
    expect(planDecisionId("compose", input, { key: new TextEncoder().encode(stringKey) })).toBe(
      viaString
    );
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
    expect(() => planDecisionId("compose", input, { key: "a" })).toThrow(/random key material/);
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

describe("ReferencePlanner keeps its secrets private", () => {
  const secret = "bucket-secret-should-never-leak-9c1e";
  const forms = (bytes: Uint8Array) => [
    Buffer.from(bytes).toString("hex"),
    Buffer.from(bytes).toString("base64"),
    Buffer.from(bytes).toString("base64url"),
    JSON.stringify(Array.from(bytes)),
  ];
  it("neither JSON.stringify nor util.inspect of the planner contains the decision key or bucket secret", () => {
    const planner = new ReferencePlanner({
      model: scriptedModel([goodDraft]),
      modelId: "m",
      decisionKey: keyA,
      variants: {
        rollout: {
          source: { resolve: () => undefined } as never,
          policyId: "p",
          resolve: (() => undefined) as never,
          bucketSecret: secret,
        },
        variants: { flat: { guidance: "flat" } },
      },
    });
    const dumps = [JSON.stringify(planner), inspect(planner, { depth: Number.POSITIVE_INFINITY })];
    for (const d of dumps) {
      for (const f of [...forms(keyA), KEY_A_HEX.toUpperCase(), secret]) expect(d).not.toContain(f);
    }
    const stringKeyed = new ReferencePlanner({
      model: scriptedModel([goodDraft]),
      modelId: "m",
      decisionKey: stringKey,
    });
    for (const d of [
      JSON.stringify(stringKeyed),
      inspect(stringKeyed, { depth: Number.POSITIVE_INFINITY }),
    ]) {
      expect(d).not.toContain(stringKey);
      for (const f of forms(new TextEncoder().encode(stringKey))) expect(d).not.toContain(f);
    }
  });
  it("copies the key at construction: zeroing the caller's buffer does not change the id", async () => {
    const mine = new Uint8Array(keyA);
    const planner = new ReferencePlanner({
      model: scriptedModel([goodDraft]),
      modelId: "m",
      decisionKey: mine,
    });
    mine.fill(0);
    const r = await planner.compose(input, recordingContext());
    expect(r.report.decisionId).toBe(planDecisionId("compose", input, { key: keyA }));
    expect(r.report.decisionId).not.toBe(
      planDecisionId("compose", input, { key: new Uint8Array(32) })
    );
  });
});

describe("ReferencePlanner revise records a keyed base", () => {
  const sealed = () => {
    const exp = replay(
      genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture }),
      []
    );
    if (!exp.ok) throw new Error(exp.finding.message);
    return seal(exp.value);
  };
  const run = async (decisionKey?: Uint8Array) => {
    const exp = sealed();
    const ctx = recordingContext();
    const r = await new ReferencePlanner({
      model: scriptedModel([goodDraft]),
      modelId: "m",
      ...(decisionKey && { decisionKey }),
    }).revise(
      {
        experience: exp,
        request: { text: "add an insight" },
        catalog: planningCatalog,
        capabilities: capabilitiesFixture,
      },
      ctx
    );
    return { exp, context: ctx.opts.get(r.report.decisionId)?.context as { base: string } };
  };
  it("keyed: the recorded context holds a k:-marked HMAC, never the raw versionHash", async () => {
    const { exp, context } = await run(keyA);
    expect(context.base).toMatch(/^k:[0-9a-f]{32}$/);
    expect(JSON.stringify(context)).not.toContain(exp.versionHash);
    expect(JSON.stringify(context)).not.toContain(exp.versionHash.replace(/^sha256:/, ""));
    expect((await run(keyB)).context.base).not.toBe(context.base);
    expect((await run(keyA)).context.base).toBe(context.base);
  });
  it("unkeyed: the recorded context is the versionHash, as before", async () => {
    const { exp, context } = await run();
    expect(context.base).toBe(exp.versionHash);
  });
});
