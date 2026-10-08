import { describe, expect, it } from "vitest";
import { validateExperience } from "./catalog";
import {
  CONTENT_REF_KEYWORD,
  MAX_ARG_DEPTH,
  MAX_SCHEMA_NODES,
  contentRefArgFindings,
  contentRefPaths,
  mergeContentRefEntries,
} from "./contentRefArgs";
import { type Experience, genesis } from "./experience";
import { testCatalog } from "./testCatalog.test-support";

const M = { type: "string", [CONTENT_REF_KEYWORD]: true };
const codes = (f: readonly { code: string }[]) => f.map((x) => x.code);
const ADDR = "sha256:00112233445566778899aabbccddeeff";

describe("contentRefPaths: reading the marker from a JSON Schema", () => {
  it("finds top-level, nested object and array paths", () => {
    const r = contentRefPaths({
      type: "object",
      properties: {
        image: M,
        meta: { type: "object", properties: { cover: M, title: { type: "string" } } },
        gallery: { type: "array", items: M },
        rows: { type: "array", items: { type: "object", properties: { pic: M } } },
        by: { type: "object", additionalProperties: M },
      },
    });
    expect(r).toEqual({
      status: "ok",
      paths: [["image"], ["meta", "cover"], ["gallery", null], ["rows", null, "pic"], ["by", null]],
    });
  });

  it("follows allOf/anyOf/oneOf and local $ref (including $defs)", () => {
    const r = contentRefPaths({
      type: "object",
      properties: {
        a: { oneOf: [{ type: "null" }, M] },
        b: { $ref: "#/$defs/Ref" },
        c: { allOf: [{ $ref: "#/definitions/R2" }] },
      },
      $defs: { Ref: M },
      definitions: { R2: { type: "object", properties: { x: M } } },
    });
    expect(r).toEqual({ status: "ok", paths: [["a"], ["b"], ["c", "x"]] });
  });

  it("no marker -> ok with no paths; no schema -> ok with no paths; false is ignored", () => {
    expect(contentRefPaths({ type: "object", properties: { q: { type: "string" } } })).toEqual({
      status: "ok",
      paths: [],
    });
    expect(contentRefPaths(undefined)).toEqual({ status: "ok", paths: [] });
    expect(
      contentRefPaths({ type: "object", properties: { q: { [CONTENT_REF_KEYWORD]: false } } })
    ).toEqual({ status: "ok", paths: [] });
  });

  it.each([
    ["a string", "nope"],
    ["an array", []],
    ["a number", 3],
    ["a malformed marker", { type: "object", properties: { a: { [CONTENT_REF_KEYWORD]: "yes" } } }],
    ["an external $ref", { type: "object", properties: { a: { $ref: "https://x.example/s" } } }],
    ["a dangling $ref", { type: "object", properties: { a: { $ref: "#/$defs/none" } } }],
    ["a non-string $ref", { type: "object", properties: { a: { $ref: 3 } } }],
    ["a marker on the root", { [CONTENT_REF_KEYWORD]: true }],
    ["a non-schema sub-schema", { type: "object", properties: { a: "str" } }],
  ])("fails closed (unknown) on %s", (_l, schema) => {
    expect(contentRefPaths(schema).status).toBe("unknown");
  });

  it("a $ref cycle is cut: ok when the marker is absent, unknown when the recursive schema carries it", () => {
    const tree = {
      type: "object",
      properties: { kids: { type: "array", items: { $ref: "#" } }, name: { type: "string" } },
    };
    expect(contentRefPaths(tree)).toEqual({ status: "ok", paths: [] });
    const marked = { ...tree, properties: { ...tree.properties, pic: M } };
    expect(contentRefPaths(marked).status).toBe("unknown");
  });

  it("is bounded: a huge or very deep schema is unknown, not a hang or a stack overflow", () => {
    const wide = { type: "object", properties: {} as Record<string, unknown> };
    for (let i = 0; i < MAX_SCHEMA_NODES + 10; i++) wide.properties[`k${i}`] = { type: "string" };
    expect(contentRefPaths(wide).status).toBe("unknown");
    let deep: Record<string, unknown> = M;
    for (let i = 0; i < 100_000; i++) deep = { type: "object", properties: { a: deep } };
    expect(contentRefPaths(deep).status).toBe("unknown");
    // A diamond of $refs cannot explode: the node budget cuts it.
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++)
      defs[`d${i}`] = { allOf: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
    defs.d40 = { type: "string" };
    const t0 = Date.now();
    expect(contentRefPaths({ $defs: defs, $ref: "#/$defs/d0" }).status).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("contentRefArgFindings: the argument grammar", () => {
  const marked = [["image"], ["meta", "cover"], ["gallery", null], ["rows", null, "pic"]] as const;
  const f = (args: unknown) => contentRefArgFindings(args, marked, "step s1");

  it.each([
    ["a literal address at a top-level path", { image: ADDR }],
    ["a URL at a top-level path", { image: "https://evil.example/x.png" }],
    ["a plain word (any literal)", { image: "cat" }],
    ["a time token", { image: "$now" }],
    ["a number", { image: 7 }],
    ["an object", { image: { address: ADDR } }],
    ["a template EMBEDDED in a longer string", { image: "x{{steps.s0.output.a}}" }],
    ["a template with trailing text", { image: "{{steps.s0.output.a}} " }],
    ["a literal in a nested object", { meta: { cover: ADDR } }],
    ["a literal in an array element", { gallery: ["{{steps.s0.output.a}}", ADDR] }],
    [
      "a literal in a nested array-of-objects path",
      { rows: [{ pic: "{{steps.s0.output.a}}" }, { pic: ADDR }] },
    ],
  ])("refuses %s", (_l, args) => {
    const out = f(args);
    expect(codes(out)).toContain("media-arg-literal");
    expect(out.every((x) => x.severity === "error")).toBe(true);
    expect(JSON.stringify(out)).not.toContain("00112233");
    expect(JSON.stringify(out)).not.toContain("evil.example");
  });

  it.each([
    ["absent", {}],
    ["null", { image: null }],
    ["a whole-string step reference", { image: "{{steps.s0.output}}" }],
    ["a step reference with a path", { image: "{{steps.s0.output.items[0].addr}}" }],
    [
      "references in every nested position",
      {
        meta: { cover: "{{steps.s0.output.c}}", title: "plain" },
        gallery: ["{{steps.s0.output.a}}", "{{steps.s0.output.b}}"],
        rows: [{ pic: "{{steps.s0.output.a}}", note: "x" }],
      },
    ],
    ["unmarked text next to a marked path", { image: "{{steps.s0.output}}", q: "show cats" }],
  ])("accepts %s", (_l, args) => {
    expect(f(args)).toEqual([]);
  });

  it("a prototype-named key is a plain key, never a lookup through the prototype", () => {
    const args = JSON.parse('{"__proto__": {"image": "x"}, "image": "{{steps.s0.output}}"}');
    expect(f(args)).toEqual([]);
  });

  it("an unmarked address-shaped string warns (suspect) but is never an error; templates and tokens do not", () => {
    const out = contentRefArgFindings(
      { q: ADDR, url: "see https://a.example/x", from: "$now-7d", ref: "{{steps.s0.output}}" },
      [],
      "step s1",
      { suspect: true }
    );
    expect(codes(out)).toEqual(["media-arg-suspect", "media-arg-suspect"]);
    expect(out.every((x) => x.severity === "warn")).toBe(true);
    expect(contentRefArgFindings({ q: ADDR }, [], "s")).toEqual([]); // opt-in
  });

  it("an unknown schema refuses a wholly address-shaped string anywhere (fail closed) and nothing else", () => {
    const bad = contentRefArgFindings({ a: { b: [ADDR] } }, "unknown", "s");
    expect(codes(bad)).toEqual(["media-arg-literal"]);
    expect(contentRefArgFindings({ q: "show cats", t: "$now" }, "unknown", "s")).toEqual([]);
  });

  it("is bounded in depth and size: refused, not a stack overflow", () => {
    let deep: unknown = ADDR;
    for (let i = 0; i < 100_000; i++) deep = { a: deep };
    expect(codes(contentRefArgFindings(deep, marked, "s"))).toEqual(["media-arg-literal"]);
    expect(MAX_ARG_DEPTH).toBeLessThan(1000);
    const wide = Array.from({ length: 150_000 }, () => 1);
    expect(codes(contentRefArgFindings({ w: wide }, marked, "s"))).toEqual(["media-arg-literal"]);
  });

  it("skipKeys exempts a top-level key a host-accepted param replaced", () => {
    expect(
      contentRefArgFindings({ image: ADDR }, marked, "s", { skipKeys: new Set(["image"]) })
    ).toEqual([]);
  });

  it("is linear on 100 KB adversarial inputs (generous absolute bound)", () => {
    const t0 = Date.now();
    const evil = [
      `${"a.".repeat(50_000)}`,
      `${"a://".repeat(25_000)}`,
      `{{steps.${"x".repeat(100_000)}`,
      `{{steps.s.output.${"{}".repeat(50_000)}`,
      "$now".repeat(25_000),
      `${"a".repeat(100_000)}:${"0".repeat(10)}`,
    ];
    for (const s of evil) {
      contentRefArgFindings({ image: s, q: s, gallery: [s] }, marked, "s", { suspect: true });
      contentRefArgFindings({ q: s }, "unknown", "s");
    }
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("mergeContentRefEntries", () => {
  it("unions paths and lets unknown absorb", () => {
    expect(mergeContentRefEntries([["a"]], [["a"], ["b"]])).toEqual([["a"], ["b"]]);
    expect(mergeContentRefEntries([["a"]], "unknown")).toBe("unknown");
    expect(mergeContentRefEntries("unknown", [["a"]])).toBe("unknown");
  });
});

describe("validateExperience: media-arg-literal / media-arg-suspect / schema-unknown", () => {
  const exp = (args: Record<string, unknown>, overridable?: string[]): Experience => {
    const g = genesis({
      experienceId: "e",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-10-08T00:00:00Z", sourceKind: "test" },
    });
    return {
      ...g,
      providers: {
        h: {
          handle: "h",
          executionGraph: [
            {
              stepId: "s1",
              toolName: "describe_image",
              toolVersion: "1",
              toolSchemaHash: "x",
              arguments: args,
              dependsOn: [],
              idempotent: true,
              ...(overridable && { overridable }),
            },
          ],
          reshaping: { engine: "JSONPath", scriptRef: "" },
          outputShapeHash: "",
          cachePolicy: { ttlSeconds: 1, scope: "principal" },
        },
      },
    };
  };
  const table = { describe_image: [["image"]] as const };
  const run = (
    e: Experience,
    contentRefArgs?: Record<string, never> | typeof table | { describe_image: "unknown" }
  ) =>
    validateExperience(e, testCatalog, "web", contentRefArgs ? ({ contentRefArgs } as never) : {});

  it("refuses a literal at a marked path (error; ok=false)", () => {
    const v = run(exp({ image: ADDR }), table);
    expect(v.ok).toBe(false);
    expect(codes(v.findings)).toContain("media-arg-literal");
  });

  it("accepts a step reference, an absent argument and an overridable param slot", () => {
    for (const e of [exp({ image: "{{steps.s1.output}}" }), exp({}), exp({ q: "x" }, ["image"])])
      expect(run(e, table).findings.filter((f) => f.code.startsWith("media-arg"))).toEqual([]);
  });

  it("without a table nothing is marked: an address-shaped argument is only a warning", () => {
    const v = run(exp({ image: ADDR }));
    expect(v.ok).toBe(true);
    expect(codes(v.findings)).toContain("media-arg-suspect");
  });

  it("an unreadable schema warns and refuses an address-shaped literal anywhere", () => {
    const unknown = { describe_image: "unknown" as const };
    const v = run(exp({ q: ADDR }), unknown);
    expect(codes(v.findings)).toEqual(
      expect.arrayContaining(["media-arg-schema-unknown", "media-arg-literal"])
    );
    expect(v.findings.find((f) => f.code === "media-arg-schema-unknown")?.severity).toBe("warn");
    expect(run(exp({ q: "cats" }), unknown).ok).toBe(true);
  });

  it("a table entry is looked up by own key only (no prototype lookups)", () => {
    expect(run(exp({ image: ADDR }), {} as never).ok).toBe(true);
  });
});
