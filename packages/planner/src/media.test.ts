import { defineSemanticCatalog, mediaCatalogEntries } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { checkPlannerConformance } from "./conformance";
import { describeCatalog } from "./prompt";
import { ReferencePlanner } from "./reference";
import type { Planner } from "./spi";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";

// U9. A media node's reference comes from its BINDING, never from the model: the framework's own
// allow-list refuses an address / URL / source / autoplay prop whatever the catalogue declares, and a
// planner is offered media only if the catalogue includes the media entries.

const withMedia = defineSemanticCatalog({
  id: "test.planning.media.v1",
  entries: [...planningCatalog.entries, ...mediaCatalogEntries()],
});
const media = (props: Record<string, unknown>, type = "Image") =>
  JSON.stringify({
    summary: "s",
    nodes: [
      {
        id: "pic",
        type,
        label: "Chart",
        span: 6,
        props,
        binding: {
          capability: "orders_summary",
          arguments: {},
          path: "totals.count",
          priority: "P1",
        },
      },
    ],
  });
const input = { intent: intentFixture, catalog: withMedia, capabilities: capabilitiesFixture };
const codes = (r: Awaited<ReturnType<ReferencePlanner["compose"]>>) =>
  r.findings.map((f) => f.code);

describe("the reference planner and media", () => {
  it("offers media guidance only when the catalogue includes media entries", () => {
    expect(describeCatalog(withMedia)).toContain("NEVER write an address");
    expect(describeCatalog(withMedia)).toContain("static upload control");
    expect(describeCatalog(planningCatalog)).not.toMatch(/media|upload/i);
  });

  it("a catalogue without the media entries cannot compose a media node at all", async () => {
    const model = scriptedModel([media({})], undefined);
    const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
      { ...input, catalog: planningCatalog },
      recordingContext()
    );
    expect(r.ops).toEqual([]);
    expect(r.findings.some((f) => f.severity === "error")).toBe(true);
  });

  it.each([
    ["a URL in a `src` prop", { src: "https://evil.example/x.png" }],
    ["an address in an `address` prop", { address: "sha256:0123456789abcdef0123" }],
    ["a `data:` literal in the caption", { caption: "data:image/png;base64,AAAA" }],
    ["a bare address in the caption", { caption: "sha256:0123456789abcdef0123" }],
    ["an autoplay flag", { autoplay: true }],
  ])("refuses %s: the model never authors a media reference", async (_l, props) => {
    const model = scriptedModel([media(props)]);
    const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
      input,
      recordingContext()
    );
    expect(r.ops).toEqual([]);
    expect(codes(r)).toContain("plan-failed");
    const attemptCodes = r.report.attempts.flatMap((a) => a.findings.map((f) => f.code));
    expect(
      attemptCodes.some((c) => c === "media-literal-ref" || c === "model-output-invalid")
    ).toBe(true);
    expect(model.calls).toBe(2); // the finding was fed back; the model kept refusing
  });

  it("even a catalogue that DECLARES src/address/autoplay props cannot admit them: the framework allow-list refuses", async () => {
    const lax = defineSemanticCatalog({
      id: "lax",
      entries: mediaCatalogEntries().map((e) =>
        e.name === "Image"
          ? {
              ...e,
              props: [...e.props, "src", "address", "autoplay"],
              surfaces: {
                web: {
                  kind: "Image",
                  props: [...e.props, "src", "address", "autoplay"],
                  binding: "required" as const,
                },
              },
            }
          : e
      ),
    });
    for (const props of [
      { src: "https://evil.example/x.png" },
      { address: "sha256:0123456789abcdef0123" },
      { autoplay: true },
    ]) {
      const model = scriptedModel([media(props)]);
      const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
        { ...input, catalog: lax },
        recordingContext()
      );
      expect(r.ops).toEqual([]);
      const all = r.report.attempts.flatMap((a) => a.findings.map((f) => f.code));
      expect(all).toContain("media-prop-forbidden");
    }
  });

  it("feeds the media finding back and accepts a draft that only carries text props and a binding", async () => {
    const model = scriptedModel([
      media({ src: "https://evil.example/x.png" }),
      media({ alt: "Orders chart", caption: "Q3" }),
    ]);
    const r = await new ReferencePlanner({ model, modelId: "m" }).compose(
      input,
      recordingContext()
    );
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.ops.length).toBeGreaterThan(0);
    expect(r.report.firstAttemptValid).toBe(false);
  });

  it("an unbound media node is refused (media-unbound / missing-binding): a reference comes only from data", async () => {
    const unbound = JSON.stringify({
      summary: "s",
      nodes: [{ id: "pic", type: "Image", label: "x", props: {} }],
    });
    const r = await new ReferencePlanner({
      model: scriptedModel([unbound]),
      modelId: "m",
      maxAttempts: 1,
    }).compose(input, recordingContext());
    expect(r.ops).toEqual([]);
  });
});

describe("checkPlannerConformance and media", () => {
  const goodMedia = media({ alt: "Orders chart" });
  const revise = JSON.stringify({
    summary: "s",
    nodes: [
      JSON.parse(goodMedia).nodes[0],
      { id: "why", type: "Insight", label: "Why", span: 12, props: {} },
    ],
  });
  const fixture = () => ({
    intent: intentFixture,
    catalog: defineSemanticCatalog({
      id: "m",
      entries: [...planningCatalog.entries, ...mediaCatalogEntries()],
    }),
    capabilities: capabilitiesFixture,
    meta: metaFixture,
    revision: { text: "add an insight" },
    ctx: recordingContext(),
  });

  it("the reference planner composing a media node passes with zero findings", async () => {
    const planner = new ReferencePlanner({
      model: scriptedModel([goodMedia, revise]),
      modelId: "m",
    });
    expect(await checkPlannerConformance(planner, fixture())).toEqual([]);
  });

  it("a planner that smuggles a literal reference into a media node's props is reported", async () => {
    const inner = new ReferencePlanner({ model: scriptedModel([goodMedia, revise]), modelId: "m" });
    const tamper = (r: Awaited<ReturnType<Planner["compose"]>>) => ({
      ...r,
      ops: r.ops.map((op) =>
        op.type === "insertNode" && op.node.kind === "semantic" && op.node.type === "Image"
          ? {
              ...op,
              node: { ...op.node, props: { ...op.node.props, src: "https://evil.example/x.png" } },
            }
          : op
      ),
    });
    const rogue: Planner = {
      compose: async (i, c) => tamper(await inner.compose(i, c)),
      revise: (i, c) => inner.revise(i, c),
    };
    const found = await checkPlannerConformance(rogue, fixture());
    expect(found.map((f) => f.code)).toContain("compose-invalid:media-prop-forbidden");
  });
});

describe("fix round 1: raw capability samples do not hand the model real addresses", () => {
  it("redacts address-shaped strings in samples, keeping them strings", async () => {
    const { composeMessages, redactAddresses } = await import("./prompt");
    const cap = {
      ...capabilitiesFixture[0],
      sampleOutput: {
        image: { address: "sha256:0123456789abcdef0123456789abcdef", mediaType: "image/png" },
        list: [
          "see sha256:0123456789abcdef0123456789abcdef now",
          "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
        ],
        n: 3,
      },
    };
    const msg =
      composeMessages({ ...input, capabilities: [cap as never] }).messages[0]?.content ?? "";
    expect(msg).not.toContain("0123456789abcdef");
    expect(msg).not.toContain("bafybeig");
    expect(msg).toContain("[address]");
    expect(msg).toContain("image/png");
    expect(redactAddresses({ a: ["Q3 report"] })).toEqual({ a: ["Q3 report"] });
  });
  it("embedded references in a media caption are refused and fed back", async () => {
    const model = scriptedModel([media({ caption: "chart from https://evil.example/x.png" })]);
    const r = await new ReferencePlanner({ model, modelId: "m", maxAttempts: 2 }).compose(
      input,
      recordingContext()
    );
    expect(r.ops).toEqual([]);
    expect(r.report.attempts.flatMap((a) => a.findings.map((f) => f.code))).toContain(
      "media-embedded-ref"
    );
  });
});
