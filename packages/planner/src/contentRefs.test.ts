import { CONTENT_REF_KEYWORD } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { checkPlannerConformance } from "./conformance";
import { contentRefArgsFrom } from "./contentRefs";
import { capabilityDetailBlocks, composeMessages } from "./prompt";
import { ReferencePlanner } from "./reference";
import type { CapabilityRef, Planner } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";

// U9b. A capability whose input schema marks a field `x-content-ref: true` never receives a
// model-authored literal there: composition refuses it (and feeds it back), the conformance kit
// reports it, and the prompt says so.

const ADDR = "sha256:00112233445566778899aabbccddeeff";
const describeImage: CapabilityRef = {
  handle: "describe_image",
  toolName: "media.describe",
  toolVersion: "1.0.0",
  toolSchemaHash: "sha256:describe-1",
  description: "Describe an image",
  inputSchema: {
    type: "object",
    properties: {
      image: { type: "string", [CONTENT_REF_KEYWORD]: true, examples: [ADDR], default: ADDR },
      more: { type: "array", items: { type: "string", [CONTENT_REF_KEYWORD]: true } },
      opts: { type: "object", properties: { cover: { [CONTENT_REF_KEYWORD]: true } } },
      q: { type: "string" },
    },
  },
  sampleOutput: { caption: "a cat", n: 3 },
};
const caps = [...capabilitiesFixture, describeImage];

const draft = (args: Record<string, unknown>) =>
  JSON.stringify({
    summary: "s",
    nodes: [
      {
        id: "cap",
        type: "Metric",
        label: "Caption",
        span: 6,
        props: {},
        binding: { capability: "describe_image", arguments: args, path: "n", priority: "P1" },
      },
    ],
  });
const input = { intent: intentFixture, catalog: planningCatalog, capabilities: caps };
const attemptCodes = (r: Awaited<ReturnType<ReferencePlanner["compose"]>>) =>
  r.report.attempts.flatMap((a) => a.findings.map((f) => f.code));

describe("contentRefArgsFrom", () => {
  it("derives marked paths per tool, nothing for unmarked or schema-less capabilities", () => {
    expect(contentRefArgsFrom(caps)).toEqual({
      "media.describe": [["image"], ["more", null], ["opts", "cover"]],
    });
  });
  it("an unreadable schema is unknown and absorbs a readable one for the same tool", () => {
    const bad: CapabilityRef = { ...describeImage, handle: "d2", inputSchema: { $ref: "#/nope" } };
    expect(contentRefArgsFrom([describeImage, bad])).toEqual({ "media.describe": "unknown" });
    expect(contentRefArgsFrom([bad, describeImage])).toEqual({ "media.describe": "unknown" });
  });
  it("is keyed by own property (no prototype keys leak)", () => {
    expect(Object.hasOwn(contentRefArgsFrom(caps), "toString")).toBe(false);
  });
});

describe("the reference planner refuses a literal content reference", () => {
  it.each([
    ["a literal address", { image: ADDR }],
    ["a URL", { image: "https://evil.example/x.png" }],
    ["a nested path", { opts: { cover: ADDR } }],
    ["an array element", { more: [ADDR] }],
  ])("%s: no ops, fed back as media-arg-literal", async (_l, args) => {
    const model = scriptedModel([draft(args)]);
    const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
      input,
      recordingContext()
    );
    expect(r.ops).toEqual([]);
    expect(attemptCodes(r)).toContain("media-arg-literal");
  });

  it("accepts the argument left out, and an unrelated text argument", async () => {
    const model = scriptedModel([draft({ q: "describe the cat" })]);
    const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
      input,
      recordingContext()
    );
    expect(r.ops.length).toBeGreaterThan(0);
    expect(r.findings.some((f) => f.code === "media-arg-literal")).toBe(false);
  });

  it("an UNMARKED text argument that looks like an address is only a warning", async () => {
    const model = scriptedModel([draft({ q: ADDR })]);
    const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
      input,
      recordingContext()
    );
    expect(r.ops.length).toBeGreaterThan(0);
    const hint = r.findings.find((f) => f.code === "media-arg-suspect");
    expect(hint?.severity).toBe("warn");
  });

  it("an unreadable schema warns and refuses an address-shaped literal anywhere", async () => {
    const bad: CapabilityRef = { ...describeImage, inputSchema: { $ref: "#/nope" } };
    const model = scriptedModel([draft({ q: ADDR })]);
    const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
      { ...input, capabilities: [...capabilitiesFixture, bad] },
      recordingContext()
    );
    expect(r.ops).toEqual([]);
    expect(attemptCodes(r)).toContain("media-arg-literal");
  });
});

describe("checkPlannerConformance reports a planner that writes a literal content reference", () => {
  const fixture = () => ({
    intent: intentFixture,
    catalog: planningCatalog,
    capabilities: caps,
    meta: metaFixture,
    revision: { text: "again" },
    ctx: recordingContext(),
  });
  const good = draft({ q: "x" });
  const revise = JSON.stringify({
    summary: "s",
    nodes: [
      JSON.parse(good).nodes[0],
      { id: "why", type: "Insight", label: "Why", span: 12, props: {} },
    ],
  });

  it("a planner that binds the argument to nothing passes", async () => {
    const planner = new ReferencePlanner({ model: scriptedModel([good, revise]), modelId: "m" });
    expect(await checkPlannerConformance(planner, fixture())).toEqual([]);
  });

  it("a rogue planner that rewrites the call's arguments after the fact is reported", async () => {
    const inner = new ReferencePlanner({ model: scriptedModel([good, revise]), modelId: "m" });
    const rogue: Planner = {
      compose: async (i, c) => {
        const r = await inner.compose(i, c);
        return {
          ...r,
          ops: r.ops.map((op) => {
            if (op.type !== "remapProvider") return op;
            const clone = JSON.parse(JSON.stringify(op));
            clone.spec.executionGraph[0].arguments = { image: ADDR };
            return clone;
          }),
        };
      },
      revise: (i, c) => inner.revise(i, c),
    };
    const found = await checkPlannerConformance(rogue, fixture());
    expect(found.map((f) => f.code)).toContain("compose-invalid:media-arg-literal");
  });
});

describe("the prompt", () => {
  it("says marked arguments are never written, lists them, and redacts schema examples and defaults", () => {
    const msg = composeMessages(input).messages[0]?.content ?? "";
    const sys = composeMessages(input).system;
    expect(sys).toContain("CONTENT REFERENCE");
    expect(msg).toContain("contentRefArguments");
    expect(msg).toContain('arguments.\\"image\\"');
    expect(msg).not.toContain("00112233");
    expect(msg).toContain("[address]");
    expect(msg).toContain("x-content-ref");
  });
  it("an unreadable schema is said to be unknown, and a schema past the redaction depth is dropped, not leaked", () => {
    let deep: unknown = { examples: [ADDR] };
    for (let i = 0; i < 40; i++) deep = { properties: { a: deep } };
    const blocks = capabilityDetailBlocks([
      { ...describeImage, inputSchema: deep as Record<string, unknown> },
      { ...describeImage, handle: "d3", inputSchema: { $ref: "#/x" } },
    ]).join("\n");
    expect(blocks).not.toContain("00112233");
    expect(blocks).toContain("could not be read");
  });
});
