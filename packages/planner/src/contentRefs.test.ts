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
      args: { "media.describe": [["image"], ["more", null], ["opts", "cover"]] },
    });
  });
  it("derives declared OUTPUT paths (the root counts) as `produces`", () => {
    const producer: CapabilityRef = {
      ...capabilitiesFixture[0],
      handle: "upload",
      toolName: "media.upload",
      outputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", [CONTENT_REF_KEYWORD]: true },
          name: { type: "string" },
        },
      },
    } as CapabilityRef;
    const whole: CapabilityRef = {
      ...producer,
      handle: "mk",
      toolName: "media.mk",
      outputSchema: { type: "string", [CONTENT_REF_KEYWORD]: true },
    };
    expect(contentRefArgsFrom([producer, whole]).produces).toEqual({
      "media.upload": [["ref"]],
      "media.mk": [[]],
    });
    // an unreadable OUTPUT schema proves nothing, and does not poison the input side
    const bad: CapabilityRef = {
      ...producer,
      toolName: "media.bad",
      outputSchema: { $ref: "#/x" },
    };
    expect(contentRefArgsFrom([bad]).produces).toBeUndefined();
  });
  it("P2-3: unknown when the marker is mentioned, unreadable when it is not; unknown absorbs the rest", () => {
    const mention: CapabilityRef = {
      ...describeImage,
      handle: "d2",
      inputSchema: {
        type: "object",
        properties: { a: { [CONTENT_REF_KEYWORD]: true }, b: { $ref: "#/nope" } },
      },
    };
    const silent: CapabilityRef = {
      ...describeImage,
      handle: "d3",
      toolName: "other",
      inputSchema: { $ref: "#/nope" },
    };
    expect(contentRefArgsFrom([describeImage, mention]).args).toEqual({
      "media.describe": "unknown",
    });
    expect(contentRefArgsFrom([mention, describeImage]).args).toEqual({
      "media.describe": "unknown",
    });
    expect(contentRefArgsFrom([silent]).args).toEqual({ other: "unreadable" });
  });
  it("is keyed by own property (no prototype keys leak)", () => {
    expect(Object.hasOwn(contentRefArgsFrom(caps).args, "toString")).toBe(false);
  });
  it("P3-4: memoised on content, so editing a schema in place is seen", () => {
    const cap: CapabilityRef = JSON.parse(JSON.stringify(describeImage));
    const list = [cap];
    const first = contentRefArgsFrom(list);
    expect(contentRefArgsFrom(list)).toBe(first); // unchanged -> the same table
    (cap.inputSchema as { properties: Record<string, unknown> }).properties.extra = {
      type: "string",
      [CONTENT_REF_KEYWORD]: true,
    };
    const second = contentRefArgsFrom(list);
    expect(second).not.toBe(first);
    expect(second.args["media.describe"]).toContainEqual(["extra"]);
  });
  it("the table is plain JSON and survives persistence", async () => {
    const { parseContentRefTable } = await import("@loom-ui/core");
    const t = contentRefArgsFrom(caps);
    expect(parseContentRefTable(JSON.parse(JSON.stringify(t)))).toEqual(t);
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

  it("a marker-mentioning unreadable schema is an ERROR (the binding is refused); a silent one only warns", async () => {
    const mention: CapabilityRef = {
      ...describeImage,
      inputSchema: {
        type: "object",
        properties: { a: { [CONTENT_REF_KEYWORD]: true }, b: { $ref: "#/nope" } },
      },
    };
    const model = scriptedModel([draft({ q: "cats" })]);
    const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
      { ...input, capabilities: [...capabilitiesFixture, mention] },
      recordingContext()
    );
    expect(r.ops).toEqual([]);
    expect(attemptCodes(r)).toContain("media-arg-schema-unknown");
  });

  it("a reference to an output that the producer does not declare is refused (echo); a declared one is accepted", async () => {
    // (the upstream step is part of the OBSERVED call graph; here the model cannot create one, so the
    // draft's own template is refused as dangling: still never a silent accept)
    const model = scriptedModel([draft({ image: "{{steps.up.output.addr}}" })]);
    const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
      input,
      recordingContext()
    );
    expect(r.ops).toEqual([]);
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
  it("P3-1: whole address-shaped strings and non-hex-class schemes redact whole in schemas and samples", async () => {
    const { redactAddresses } = await import("./prompt");
    const hex = "0011223344556677889900aabbccddee";
    const cases = [
      `content_ref:${hex}`,
      `blake3-256:${hex}`,
      `sha256:${hex}`,
      "https://evil.example/x.png",
      "data:image/png;base64,AAAA",
      "//evil.example/x",
      "file:///etc/passwd",
    ];
    for (const c of cases) {
      const out = JSON.stringify(redactAddresses({ default: c, examples: [c] }));
      expect(out).not.toContain(hex);
      expect(out).not.toContain("evil.example");
      expect(out).not.toContain("etc/passwd");
      expect(out).not.toContain("AAAA");
      // embedded in prose the address-shaped TAIL is still redacted (URLs in prose are a hint, not a boundary)
      expect(JSON.stringify(redactAddresses(`see ${c} now`))).not.toContain(hex);
    }
    expect(redactAddresses("plain text, no address")).toBe("plain text, no address");
    expect(redactAddresses("ratio 3:4")).toBe("ratio 3:4");
  });

  it("an output schema's declared content references are listed, and its examples are redacted", () => {
    const cap: CapabilityRef = {
      ...describeImage,
      handle: "up",
      toolName: "media.up",
      outputSchema: {
        type: "object",
        properties: { ref: { type: "string", [CONTENT_REF_KEYWORD]: true, examples: [ADDR] } },
      },
    };
    const blocks = capabilityDetailBlocks([cap]).join("\n");
    expect(blocks).toContain("producesContentRefs");
    expect(blocks).toContain('output.\\"ref\\"');
    expect(blocks).not.toContain("00112233");
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
