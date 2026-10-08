import { describe, expect, it } from "vitest";
import { validateExperience } from "./catalog";
import {
  CONTENT_REF_KEYWORD,
  type ContentRefTable,
  MAX_ARG_DEPTH,
  MAX_LITERAL_FINDINGS,
  MAX_SCHEMA_NODES,
  contentRefArgFindings,
  contentRefPaths,
  mergeContentRefEntries,
  parseContentRefTable,
  parseStepReference,
  pathCovers,
  stripNullContentRefs,
} from "./contentRefArgs";
import { type Experience, genesis } from "./experience";
import { toolKey } from "./steps";
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

  it.each([
    [
      "Draft-07 object-form dependencies",
      {
        type: "object",
        dependencies: { a: { properties: { pic: M } } },
        properties: { a: { type: "string" } },
      },
      "ok",
    ],
    [
      "a $dynamicRef",
      { type: "object", properties: { a: { $dynamicRef: "#node" }, pic: M } },
      "unknown",
    ],
    [
      "a $recursiveRef",
      { type: "object", properties: { a: { $recursiveRef: "#" }, pic: M } },
      "unknown",
    ],
    [
      "a marker under propertyNames (a keyword the walker does not read)",
      { type: "object", propertyNames: M },
      "unknown",
    ],
    [
      "a marker under contentSchema",
      { type: "object", properties: { a: { type: "string", contentSchema: M } } },
      "unknown",
    ],
    [
      "a marker in an unreferenced definition",
      { type: "object", $defs: { Unused: M }, properties: {} },
      "unknown",
    ],
  ])("P2-1: %s", (_l, schema, status) => {
    const r = contentRefPaths(schema);
    expect(r.status).toBe(status);
    if (r.status === "ok") expect(r.paths).toEqual([["pic"]]);
  });

  it("P2-1: a dynamic-ref keyword WITHOUT the marker anywhere is harmless", () => {
    expect(contentRefPaths({ type: "object", properties: { a: { $dynamicRef: "#n" } } })).toEqual({
      status: "ok",
      paths: [],
    });
  });

  it("P2-3: unknown reports whether the marker was mentioned", () => {
    expect(contentRefPaths({ $ref: "#/nope" })).toMatchObject({
      status: "unknown",
      markerMentioned: false,
    });
    expect(
      contentRefPaths({ type: "object", properties: { a: M, b: { $ref: "https://x.example/s" } } })
    ).toMatchObject({ status: "unknown", markerMentioned: true });
  });

  it("an output schema may mark its root (allowRoot), an input schema may not", () => {
    expect(contentRefPaths(M, { allowRoot: true })).toEqual({ status: "ok", paths: [[]] });
    expect(contentRefPaths(M).status).toBe("unknown");
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
  // a producer proof: only `s0`'s output (any path) is a declared content reference here
  const proven = (id: string) => id === "s0";
  const f = (args: unknown) => contentRefArgFindings(args, marked, "step s1", { proven });

  it.each([
    ["a literal address at a top-level path", { image: ADDR }],
    ["a URL at a top-level path", { image: "https://evil.example/x.png" }],
    ["a plain word (any literal)", { image: "cat" }],
    ["a time token", { image: "$now" }],
    ["a number", { image: 7 }],
    ["an object", { image: { address: ADDR } }],
    ["a template EMBEDDED in a longer string", { image: "x{{steps.s0.output.a}}" }],
    ["a template with trailing text", { image: "{{steps.s0.output.a}} " }],
    ["a template with an id outside [A-Za-z0-9_-]", { image: "{{steps.s 0.output}}" }],
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
    ["a whole-string reference to a proven step", { image: "{{steps.s0.output}}" }],
    ["a reference with a path", { image: "{{steps.s0.output.items[0].addr}}" }],
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

  it("P2-2: a reference the producer table does not prove is media-arg-unproven-ref; with no `proven` nothing is", () => {
    const out = contentRefArgFindings({ image: "{{steps.echo.output.text}}" }, marked, "s", {
      proven,
    });
    expect(codes(out)).toEqual(["media-arg-unproven-ref"]);
    expect(codes(contentRefArgFindings({ image: "{{steps.s0.output}}" }, marked, "s"))).toEqual([
      "media-arg-unproven-ref",
    ]);
    // a malformed path proves nothing even for a proven step
    expect(
      codes(
        contentRefArgFindings({ image: "{{steps.s0.output.a[}}" }, marked, "s", {
          proven: () => true,
        })
      )
    ).toEqual(["media-arg-unproven-ref"]);
  });

  it("P3-2: findings are capped per step and the rest are counted", () => {
    const many = { gallery: Array.from({ length: 500 }, () => ADDR) };
    const out = f(many);
    expect(out).toHaveLength(MAX_LITERAL_FINDINGS + 1);
    expect(out.at(-1)?.message).toContain(`and ${500 - MAX_LITERAL_FINDINGS} more`);
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

  it("an unreadable schema (no marker mentioned) refuses a wholly address-shaped string anywhere and nothing else", () => {
    const bad = contentRefArgFindings({ a: { b: [ADDR] } }, "unreadable", "s");
    expect(codes(bad)).toEqual(["media-arg-literal"]);
    expect(contentRefArgFindings({ q: "show cats", t: "$now" }, "unreadable", "s")).toEqual([]);
  });

  it.each([
    ["a path-shaped key", { key: "uploads/other-user/secret.png" }],
    ["an object locator", { loc: { store: "s3", key: "u/1" } }],
    ["plain text", { q: "cats" }],
    ["a string deep in an array", { a: [[["x"]]] }],
  ])("P2-3: a marker-mentioning unreadable schema refuses %s", (_l, args) => {
    expect(codes(contentRefArgFindings(args, "unknown", "s"))).toContain("media-arg-literal");
  });

  it("P2-3: ... but lets references, time tokens, numbers, booleans and null through", () => {
    expect(
      contentRefArgFindings(
        { r: "{{steps.s0.output}}", t: "$now-7d", n: 3, b: true, z: null, e: [1, 2] },
        "unknown",
        "s"
      )
    ).toEqual([]);
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
      `{{steps.s.output.${"a[".repeat(50_000)}`,
      "$now".repeat(25_000),
      `${"a".repeat(100_000)}:${"0".repeat(10)}`,
    ];
    for (const s of evil) {
      contentRefArgFindings({ image: s, q: s, gallery: [s] }, marked, "s", { suspect: true });
      contentRefArgFindings({ q: s }, "unknown", "s");
      contentRefArgFindings({ q: s }, "unreadable", "s");
      parseStepReference(s);
    }
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("references and paths", () => {
  it("parseStepReference reads the id and the output path (indices are null)", () => {
    expect(parseStepReference("{{steps.a.output}}")).toEqual({ stepId: "a", path: [] });
    expect(parseStepReference("{{steps.a.output.items[0].addr}}")).toEqual({
      stepId: "a",
      path: ["items", null, "addr"],
    });
    expect(parseStepReference("{{steps.a.output.m[0][1]}}")?.path).toEqual(["m", null, null]);
    expect(parseStepReference("{{steps.a.output.x[}}")?.path).toBeUndefined();
    expect(parseStepReference("x{{steps.a.output}}")).toBeUndefined();
    expect(parseStepReference(7)).toBeUndefined();
  });
  it("pathCovers: a null marked segment covers any key or index; lengths must match", () => {
    expect(pathCovers([], [])).toBe(true);
    expect(pathCovers(["a", null, "b"], ["a", null, "b"])).toBe(true);
    expect(pathCovers(["a", null], ["a", "anykey"])).toBe(true);
    expect(pathCovers(["a", "b"], ["a", null])).toBe(false);
    expect(pathCovers(["a"], ["a", "b"])).toBe(false);
  });
});

describe("stripNullContentRefs (Q2)", () => {
  it("drops JSON null at marked paths only, leaving the input untouched", () => {
    const input = {
      image: null,
      other: null,
      gallery: [null, "x", null],
      meta: { cover: null, k: 1 },
    };
    const out = stripNullContentRefs(input, [["image"], ["gallery", null], ["meta", "cover"]]);
    expect(out).toEqual({ other: null, gallery: ["x"], meta: { k: 1 } });
    expect(input.image).toBeNull();
  });
});

describe("mergeContentRefEntries", () => {
  it("unions paths; unreadable absorbs paths; unknown absorbs everything", () => {
    expect(mergeContentRefEntries([["a"]], [["a"], ["b"]])).toEqual([["a"], ["b"]]);
    expect(mergeContentRefEntries([["a"]], "unknown")).toBe("unknown");
    expect(mergeContentRefEntries("unknown", [["a"]])).toBe("unknown");
    expect(mergeContentRefEntries("unreadable", [["a"]])).toBe("unreadable");
    expect(mergeContentRefEntries("unreadable", "unknown")).toBe("unknown");
  });
});

describe("parseContentRefTable", () => {
  it("round-trips JSON and rejects anything that is not exactly a table", () => {
    const t: ContentRefTable = {
      args: { a: [["x", null]], b: "unknown", c: "unreadable" },
      produces: { p: [[]] },
    };
    expect(parseContentRefTable(JSON.parse(JSON.stringify(t)))).toEqual(t);
    for (const bad of [
      null,
      [],
      "x",
      {},
      { args: [] },
      { args: { a: "nope" } },
      { args: { a: [[1]] } },
      { args: {}, produces: 3 },
      { args: {}, produces: { p: "unknown" } },
    ])
      expect(parseContentRefTable(bad)).toBeUndefined();
  });
});

describe("validateExperience: media-arg-literal / unproven-ref / suspect / schema-unknown", () => {
  const exp = (
    args: Record<string, unknown>,
    overridable?: string[],
    upstream?: string
  ): Experience => {
    const g = genesis({
      experienceId: "e",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-10-08T00:00:00Z", sourceKind: "test" },
    });
    const step = (
      stepId: string,
      toolName: string,
      a: Record<string, unknown>,
      deps: string[]
    ) => ({
      stepId,
      toolName,
      toolVersion: "1",
      toolSchemaHash: "x",
      arguments: a,
      dependsOn: deps,
      idempotent: true,
      ...(overridable && stepId === "s1" && { overridable }),
    });
    return {
      ...g,
      providers: {
        h: {
          handle: "h",
          executionGraph: [
            ...(upstream ? [step("up", upstream, {}, [])] : []),
            step("s1", "describe_image", args, upstream ? ["up"] : []),
          ],
          reshaping: { engine: "JSONPath", scriptRef: "" },
          outputShapeHash: "",
          cachePolicy: { ttlSeconds: 1, scope: "principal" },
        },
      },
    };
  };
  const table: ContentRefTable = {
    args: { describe_image: [["image"]] },
    produces: { producer: [["addr"]] },
  };
  const run = (e: Experience, contentRefArgs?: ContentRefTable) =>
    validateExperience(e, testCatalog, "web", contentRefArgs ? { contentRefArgs } : {});

  it("refuses a literal at a marked path (error; ok=false)", () => {
    const v = run(exp({ image: ADDR }), table);
    expect(v.ok).toBe(false);
    expect(codes(v.findings)).toContain("media-arg-literal");
  });

  it("P2-2: accepts a reference to a declared producer's declared path; refuses echo / wrong path / dangling / self", () => {
    const ok = run(exp({ image: "{{steps.up.output.addr}}" }, undefined, "producer"), table);
    expect(ok.findings.filter((f) => f.code.startsWith("media-arg"))).toEqual([]);
    for (const [args, up] of [
      [{ image: "{{steps.up.output.addr}}" }, "echo"],
      [{ image: "{{steps.up.output.text}}" }, "producer"],
      [{ image: "{{steps.up.output}}" }, "producer"],
      [{ image: "{{steps.nope.output.addr}}" }, "producer"],
      [{ image: "{{steps.s1.output.addr}}" }, "producer"],
    ] as const) {
      const v = run(exp({ ...args }, undefined, up), table);
      expect(v.ok).toBe(false);
      expect(codes(v.findings)).toContain("media-arg-unproven-ref");
    }
  });

  it("accepts an absent argument and an overridable param slot", () => {
    for (const e of [exp({}), exp({ q: "x" }, ["image"])])
      expect(run(e, table).findings.filter((f) => f.code.startsWith("media-arg"))).toEqual([]);
  });

  it("without a table nothing is marked: an address-shaped argument is only a warning", () => {
    const v = run(exp({ image: ADDR }));
    expect(v.ok).toBe(true);
    expect(codes(v.findings)).toContain("media-arg-suspect");
  });

  it("P2-3: an unreadable schema WITHOUT the marker warns and refuses an address-shaped literal anywhere", () => {
    const t: ContentRefTable = { args: { describe_image: "unreadable" } };
    const v = run(exp({ q: ADDR }), t);
    expect(codes(v.findings)).toEqual(
      expect.arrayContaining(["media-arg-schema-unknown", "media-arg-literal"])
    );
    expect(v.findings.find((f) => f.code === "media-arg-schema-unknown")?.severity).toBe("warn");
    expect(run(exp({ q: "cats" }), t).ok).toBe(true);
  });

  it("P2-3: a schema that MENTIONS the marker but is unreadable is an ERROR: the binding is refused, even with no arguments", () => {
    const t: ContentRefTable = { args: { describe_image: "unknown" } };
    const v = run(exp({}), t);
    expect(v.ok).toBe(false);
    expect(v.findings.find((f) => f.code === "media-arg-schema-unknown")?.severity).toBe("error");
    expect(codes(run(exp({ key: "uploads/other-user/secret.png" }), t).findings)).toContain(
      "media-arg-literal"
    );
  });

  it("a table entry is looked up by own key only (no prototype lookups)", () => {
    expect(run(exp({ image: ADDR }), { args: {} }).ok).toBe(true);
    expect(toolKey({ toolName: "toString" })).toBe("toString");
    expect(
      run(exp({ image: ADDR }), { args: Object.create({ describe_image: [["image"]] }) }).ok
    ).toBe(true);
  });
});
