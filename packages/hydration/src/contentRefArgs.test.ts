import {
  type ContainerNode,
  type ContentRefTable,
  type Experience,
  type ProviderSpec,
  STEP_TEMPLATE_SOURCE,
  type SemanticNode,
  genesis,
} from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationCache } from "./cache";
import { checkContentRefs, contentRefEnv } from "./contentRefs";
import { ContentRefConfigError } from "./contentRefs";
import { HydrationController } from "./controller";
import { prepareArguments } from "./params";
import { STEP_TEMPLATE } from "./plan";
import { HydrationStore } from "./projection";
import { type ExecuteOptions, executeProvider } from "./provider";
import { serveHandle, serveHandles } from "./split/index";
import { FakeInvoker, flush, mcpStep, providerSpec } from "./testing.test-support";

// U9b. A marked content-reference argument must be a PROVEN reference (a step reference to an output its
// tool declares a content reference, a host-gated param) or absent, NEVER a literal the composer wrote.
// The check runs before the call AND before any cache lookup, so a refused step costs no invocation and
// a cached value is never served around the gate.

const ADDR = "sha256:00112233445566778899aabbccddeeff";
const table: ContentRefTable = {
  args: { describe: [["image"], ["gallery", null]] },
  produces: { up: [["addr"]] },
};
const reply = () => new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: true }));
type Extra = Partial<ExecuteOptions>;
const run = (args: Record<string, unknown>, extra: Extra = {}, overridable?: string[]) => {
  const inv = reply();
  const step = { ...mcpStep("s1", "describe", args), ...(overridable && { overridable }) };
  return executeProvider(providerSpec("h", [step]), {
    invoker: inv,
    contentRefArgs: table,
    ...extra,
  }).then((r) => ({ r, inv }));
};
const codesOf = (r: Awaited<ReturnType<typeof run>>["r"]) =>
  (r.ok ? [] : r.findings).map((f) => f.code);

describe("runtime refusal of a literal content reference", () => {
  it("the template grammar is the same one core checks against", () => {
    expect(STEP_TEMPLATE.source).toBe(new RegExp(STEP_TEMPLATE_SOURCE).source);
  });

  it("a step id outside [A-Za-z0-9_-] is not a reference at all (P3-6)", () => {
    expect(STEP_TEMPLATE.test("{{steps.a b.output}}")).toBe(false);
    expect(STEP_TEMPLATE.test("{{steps.a.b.output}}")).toBe(false);
    expect(STEP_TEMPLATE.test("{{steps.a_b-1.output.x}}")).toBe(true);
  });

  it.each([
    ["a literal address", { image: ADDR }],
    ["a URL", { image: "https://evil.example/x" }],
    ["a time token", { image: "$now" }],
    ["an address in an array element", { gallery: [ADDR] }],
  ])("%s at a marked path: refused, the call is not made", async (_l, args) => {
    const { r, inv } = await run(args);
    expect(r.ok).toBe(false);
    expect(codesOf(r)).toContain("media-arg-literal");
    expect(inv.calls).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain("00112233");
    expect(JSON.stringify(r)).not.toContain("evil.example");
  });

  it("without a table the same literal is NOT checked (the check is the host's opt-in)", async () => {
    const inv = reply();
    const r = await executeProvider(
      providerSpec("h", [mcpStep("s1", "describe", { image: ADDR })]),
      {
        invoker: inv,
      }
    );
    expect(r.ok).toBe(true);
    expect(inv.calls).toHaveLength(1);
  });

  describe("an unreadable schema", () => {
    it("without the marker mentioned: refuses an address-shaped string anywhere, lets other text through", async () => {
      const t: ContentRefTable = { args: { describe: "unreadable" } };
      const bad = await run({ q: ADDR }, { contentRefArgs: t });
      expect(bad.r.ok).toBe(false);
      expect(bad.inv.calls).toHaveLength(0);
      expect((await run({ q: "cats" }, { contentRefArgs: t })).r.ok).toBe(true);
    });

    it.each([
      ["a path-shaped string", { key: "uploads/other-user/secret.png" }],
      ["a nested object", { loc: { store: "s3", key: "u/1" } }],
      ["plain text", { q: "cats" }],
    ])("with the marker mentioned: %s is refused, nothing is called", async (_l, args) => {
      const t: ContentRefTable = { args: { describe: "unknown" } };
      const { r, inv } = await run(args, { contentRefArgs: t });
      expect(r.ok).toBe(false);
      expect(inv.calls).toHaveLength(0);
    });

    it("with the marker mentioned: references, time tokens and numbers pass; EVERY replaced param is gated", async () => {
      const t: ContentRefTable = { args: { describe: "unknown" } };
      const ok = await run(
        { n: 3, from: "$now-7d", up: "{{steps.s0.output}}" },
        { contentRefArgs: t }
      );
      expect(ok.r.ok).toBe(false); // s0 is not in the graph -> unresolved at run time, but NOT a literal refusal
      expect(codesOf(ok.r)).not.toContain("media-arg-literal");
      const gated = await run({}, { contentRefArgs: t, params: { anything: "x" } }, ["anything"]);
      expect(gated.r.ok).toBe(false);
      expect(gated.inv.calls).toHaveLength(0);
      const allowed = await run(
        {},
        { contentRefArgs: t, params: { anything: "x" }, acceptContentRefParam: () => true },
        ["anything"]
      );
      expect(allowed.r.ok).toBe(true);
    });
  });

  describe("step references must be PROVEN (P2-2)", () => {
    const graph = (upTool: string, args: Record<string, unknown>) =>
      providerSpec("h", [mcpStep("up", upTool), mcpStep("s1", "describe", args, ["up"])]);
    const go = async (spec: ProviderSpec) => {
      const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
        const i = input as { toolName: string; args: Record<string, unknown> };
        return i.toolName === "describe" ? { ok: true } : { addr: ADDR, text: ADDR };
      });
      const r = await executeProvider(spec, { invoker: inv, contentRefArgs: table });
      return { r, inv };
    };

    it("a reference to a declared producer's declared output path is accepted and called", async () => {
      const { r, inv } = await go(graph("up", { image: "{{steps.up.output.addr}}" }));
      expect(r.ok).toBe(true);
      expect((inv.calls[1]?.input as { args: unknown }).args).toEqual({ image: ADDR });
    });

    it.each([
      ["an undeclared path of a declared producer (echo)", "up", "{{steps.up.output.text}}"],
      ["the whole output of a producer that declares a sub-path", "up", "{{steps.up.output}}"],
      ["an undeclared tool (concat/echo)", "echo", "{{steps.up.output.addr}}"],
      ["a dangling step", "up", "{{steps.nope.output.addr}}"],
      ["itself", "up", "{{steps.s1.output.addr}}"],
    ])("%s: refused at run time, the marked tool is not called", async (_l, tool, ref) => {
      const { r, inv } = await go(graph(tool, { image: ref }));
      expect(r.ok).toBe(false);
      expect((r.ok ? [] : r.findings).map((f) => f.code)).toContain("media-arg-unproven-ref");
      expect(
        inv.calls.every((c) => (c.input as { toolName: string }).toolName !== "describe")
      ).toBe(true);
    });
  });

  describe("params", () => {
    it("a param filling a marked argument is refused with no gate", async () => {
      const { r, inv } = await run({}, { params: { image: ADDR } }, ["image"]);
      expect(r.ok).toBe(false);
      expect(inv.calls).toHaveLength(0);
    });

    it("a gate that returns anything but true refuses; a throwing gate refuses", async () => {
      for (const gate of [
        () => false,
        () => 1 as never,
        () => {
          throw new Error("boom");
        },
      ]) {
        const { r, inv } = await run({}, { params: { image: ADDR }, acceptContentRefParam: gate }, [
          "image",
        ]);
        expect(r.ok).toBe(false);
        expect(inv.calls).toHaveLength(0);
      }
    });

    it("a host-accepted param is called; the gate sees the param, step, value AND the principal (P3-3)", async () => {
      const seen: unknown[] = [];
      const { r, inv } = await run(
        {},
        {
          params: { image: ADDR },
          principalId: "alice",
          acceptContentRefParam: (c) => {
            seen.push(c);
            return true;
          },
        },
        ["image"]
      );
      expect(r.ok).toBe(true);
      expect(inv.calls).toHaveLength(1);
      expect(seen).toEqual([
        {
          handle: "h",
          stepId: "s1",
          toolName: "describe",
          param: "image",
          value: ADDR,
          principalId: "alice",
        },
      ]);
    });

    it("a literal default in the composed arguments is still refused when no param replaces it", async () => {
      const { r, inv } = await run({ image: ADDR }, { acceptContentRefParam: () => true }, [
        "image",
      ]);
      expect(r.ok).toBe(false);
      expect(inv.calls).toHaveLength(0);
    });

    it("a param on an UNMARKED argument needs no gate", async () => {
      const { r } = await run({}, { params: { q: "cats" } }, ["q"]);
      expect(r.ok).toBe(true);
    });

    it("P3-5: a top-level additionalProperties marker (path [null]) cannot be filled by a gated param: fail closed", async () => {
      const t: ContentRefTable = { args: { describe: [[null]] } };
      const { r, inv } = await run(
        {},
        { contentRefArgs: t, params: { k: ADDR }, acceptContentRefParam: () => true },
        ["k"]
      );
      // The gate is never asked for a [null] path (no named top-level key), so the replaced value is
      // judged as a literal at a marked position.
      expect(r.ok).toBe(false);
      expect(inv.calls).toHaveLength(0);
    });
  });

  it("the argument hook runs after the check and is the host's own word", async () => {
    const { r, inv } = await run({}, { argumentHook: (a) => ({ ...a, image: ADDR }) });
    expect(r.ok).toBe(true);
    expect((inv.calls[0]?.input as { args: unknown }).args).toEqual({ image: ADDR });
  });

  it("JSON null at a marked position is stripped before the call (Q2)", async () => {
    const { r, inv } = await run({ image: null, q: "x", gallery: [null, "{{steps.s0.output}}"] });
    // gallery's second element is an unproven reference: refused; use a clean case for the strip
    expect(r.ok).toBe(false);
    const clean = await run({ image: null, q: "x", gallery: [null] });
    expect(clean.r.ok).toBe(true);
    expect((clean.inv.calls[0]?.input as { args: unknown }).args).toEqual({ q: "x", gallery: [] });
    expect(inv.calls).toHaveLength(0);
  });

  it("prepareArguments is linear on a 100 KB adversarial argument (generous absolute bound)", () => {
    const t0 = Date.now();
    const node = mcpStep("s1", "describe", { q: "a.".repeat(50_000), image: "x".repeat(100_000) });
    const env = contentRefEnv(table, providerSpec("h", [node]), undefined, {});
    const out = prepareArguments(node, new Map(), {
      handle: "h",
      params: {},
      now: 0,
      guard: (n, applied) => checkContentRefs(n, applied, env).finding,
    });
    expect(out.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

// ── the controller and the split server both thread it ────────────────────────────────────────

const exp = (spec: ProviderSpec): Experience => {
  const g = genesis({
    experienceId: "exp-1",
    intent: { objective: "x", source: "user" },
    meta: { author: "a", createdAt: "2026-10-08T00:00:00Z", sourceKind: "test" },
  });
  const n: SemanticNode = {
    id: "n",
    order: "a",
    kind: "semantic",
    type: "Metric",
    typeVersion: "1.0.0",
    span: 6,
    props: {},
    binding: { handle: "h", priority: "P0" },
  };
  return {
    ...g,
    versionHash: "sha256:v1",
    root: { ...(g.root as ContainerNode), children: [n] },
    providers: { h: spec },
  };
};
const literalSpec = () => providerSpec("h", [mcpStep("s1", "describe", { image: ADDR })]);
const paramSpec = (scope: "global" | "principal") =>
  providerSpec("h", [{ ...mcpStep("s1", "describe", {}), overridable: ["image"] }], {
    cachePolicy: { ttlSeconds: 600, scope },
  });
const req = (e: Experience, params: Record<string, unknown> = {}) => ({
  experienceId: e.experienceId,
  versionHash: e.versionHash,
  handle: "h",
  params,
});

describe("threading", () => {
  it("HydrationController: a literal is refused, the handle is not ready, no call", async () => {
    const inv = reply();
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const ctl = new HydrationController({ invoker: inv, store, contentRefArgs: table });
    ctl.load(exp(literalSpec()));
    await flush();
    expect(inv.calls).toHaveLength(0);
    expect(store.status("h")?.state).not.toBe("ready");
    expect(JSON.stringify(store.state())).not.toContain("00112233");
  });

  it("serveHandle: same refusal, and a client-supplied param cannot fill a marked argument", async () => {
    const inv = reply();
    const e = exp(literalSpec());
    const out = await serveHandle(e, req(e), { invoker: inv, now: 1, contentRefArgs: table });
    expect(out.state).toBe("error");
    expect(inv.calls).toHaveLength(0);

    const e2 = exp(paramSpec("global"));
    const inv2 = reply();
    const out2 = await serveHandle(e2, req(e2, { image: ADDR }), {
      invoker: inv2,
      now: 1,
      contentRefArgs: table,
    });
    expect(out2.state).toBe("error");
    expect(inv2.calls).toHaveLength(0);
    const inv3 = reply();
    await serveHandle(e2, req(e2, { image: ADDR }), {
      invoker: inv3,
      now: 1,
      contentRefArgs: table,
      acceptContentRefParam: (c) => c.value === ADDR,
    });
    expect(inv3.calls).toHaveLength(1);
  });
});

// ── P1: the cache never serves around the gate ─────────────────────────────────────────────────

describe("the cache and the content-reference gate (P1)", () => {
  const serve = (
    e: Experience,
    inv: FakeInvoker,
    cache: HydrationCache,
    principalId: string,
    allow: () => boolean
  ) =>
    serveHandle(e, req(e, { image: ADDR }), {
      invoker: inv,
      now: 1,
      cache,
      principalId,
      contentRefArgs: table,
      acceptContentRefParam: allow,
    });

  it.each(["global", "principal"] as const)(
    "scope %s: principal B, whose gate refuses, is NOT served principal A's cached value",
    async (scope) => {
      const e = exp(paramSpec(scope));
      const cache = new HydrationCache(() => 0);
      const inv = reply();
      const a = await serve(e, inv, cache, "alice", () => true);
      expect(a.state).toBe("ready");
      const b = await serve(e, inv, cache, "bob", () => false);
      expect(b.state).toBe("error");
      expect(inv.calls).toHaveLength(1); // B made no call and got no cached value
    }
  );

  it("the same principal after revocation is refused, not served from the cache", async () => {
    const e = exp(paramSpec("principal"));
    const cache = new HydrationCache(() => 0);
    const inv = reply();
    let allowed = true;
    expect((await serve(e, inv, cache, "alice", () => allowed)).state).toBe("ready");
    expect((await serve(e, inv, cache, "alice", () => allowed)).state).toBe("ready"); // cache hit
    expect(inv.calls).toHaveLength(1);
    allowed = false;
    expect((await serve(e, inv, cache, "alice", () => allowed)).state).toBe("error");
    expect(inv.calls).toHaveLength(1);
  });

  it("a param-filled result is cached per principal even when the spec says global", async () => {
    const e = exp(paramSpec("global"));
    const cache = new HydrationCache(() => 0);
    const inv = reply();
    await serve(e, inv, cache, "alice", () => true);
    // bob's gate accepts too, but alice's entry must not answer him: he runs his own call.
    await serve(e, inv, cache, "bob", () => true);
    expect(inv.calls).toHaveLength(2);
  });

  it("without a param filling a guarded argument, global caching is unchanged", async () => {
    const spec = providerSpec("h", [mcpStep("s1", "describe", { q: "x" })], {
      cachePolicy: { ttlSeconds: 600, scope: "global" },
    });
    const e = exp(spec);
    const cache = new HydrationCache(() => 0);
    const inv = reply();
    const go = (p: string) =>
      serveHandle(e, req(e), {
        invoker: inv,
        now: 1,
        cache,
        principalId: p,
        contentRefArgs: table,
      });
    await go("alice");
    await go("bob");
    expect(inv.calls).toHaveLength(1);
  });

  it("controller: the in-process path asks the gate before its cache too (revocation)", async () => {
    const e = exp(paramSpec("principal"));
    const cache = new HydrationCache(() => 0);
    const inv = reply();
    let allowed = true;
    const mk = () => {
      const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
      const ctl = new HydrationController({
        invoker: inv,
        store,
        cache,
        principal: { id: "alice" },
        contentRefArgs: table,
        defaultParams: { image: ADDR },
        acceptContentRefParam: () => allowed,
      });
      return { store, ctl };
    };
    const c1 = mk();
    c1.ctl.load(e);
    await flush();
    expect(c1.store.status("h")?.state).toBe("ready");
    expect(inv.calls).toHaveLength(1);
    const c1b = mk(); // a second controller sharing the cache: served from it while the gate allows
    c1b.ctl.load(e);
    await flush();
    expect(c1b.store.status("h")?.state).toBe("ready");
    expect(inv.calls).toHaveLength(1);
    allowed = false; // revoked
    const c2 = mk();
    c2.ctl.load(e);
    await flush();
    expect(c2.store.status("h")?.state).not.toBe("ready");
    expect(c2.store.value("h")).toBeUndefined();
    expect(inv.calls).toHaveLength(1);
  });
});

// ── F1: a missing or malformed contentRefArgs is a configuration error, never "none" ─────────────

describe("contentRefArgs is required at every entry point", () => {
  const bads: Array<[string, unknown]> = [
    ["omitted", undefined],
    ["null", null],
    ["a bare object without args", {}],
    ["parseContentRefTable()'s undefined", undefined],
    ["a table with a malformed entry", { args: { describe: "nope" } }],
    ["an array", []],
  ];
  it.each(bads)("HydrationController throws when it is %s", (_l, v) => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    expect(
      () => new HydrationController({ invoker: reply(), store, contentRefArgs: v as never })
    ).toThrow(ContentRefConfigError);
  });

  it.each(bads)(
    "serveHandle and serveHandles reject when it is %s, and make no call",
    async (_l, v) => {
      const e = exp(providerSpec("h", [mcpStep("s1", "describe")]));
      const inv = reply();
      const opts = { invoker: inv, now: 1, contentRefArgs: v as never };
      await expect(serveHandle(e, req(e), opts)).rejects.toThrow(ContentRefConfigError);
      await expect(serveHandles(e, [req(e)], opts)).rejects.toThrow(ContentRefConfigError);
      expect(inv.calls).toHaveLength(0);
    }
  );

  it("'none' and a well-formed table are accepted", async () => {
    const e = exp(providerSpec("h", [mcpStep("s1", "describe")]));
    for (const v of ["none", { args: {} }, table] as const) {
      const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
      expect(
        () => new HydrationController({ invoker: reply(), store, contentRefArgs: v })
      ).not.toThrow();
      expect(
        (await serveHandle(e, req(e), { invoker: reply(), now: 1, contentRefArgs: v })).state
      ).toBe("ready");
    }
  });
});

// ── F5: a refusal is told to the client as its own public code, and the finding codes tell the cases apart ──

describe("a content-reference refusal has its own public code", () => {
  it("a literal is `media-arg-literal` in the findings and `content-ref-refused` as the outcome's finding", async () => {
    const { r } = await run({ image: ADDR });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe("content-ref-refused");
    expect(codesOf(r)).toContain("media-arg-literal");
    expect(codesOf(r)).not.toContain("media-arg-param-refused");
  });

  it("a foreign param the gate refuses is `media-arg-param-refused`, not `media-arg-literal`", async () => {
    const { r } = await run({}, { params: { image: ADDR }, acceptContentRefParam: () => false }, [
      "image",
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe("content-ref-refused");
    expect(codesOf(r)).toContain("media-arg-param-refused");
    expect(codesOf(r)).not.toContain("media-arg-literal");
  });

  it("a refusal mixed with another failure stays provider-failed", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
      throw new Error("down");
    });
    const r = await executeProvider(
      providerSpec("h", [mcpStep("s1", "describe", { image: ADDR }), mcpStep("s2", "other", {})]),
      { invoker: inv, contentRefArgs: table }
    );
    expect(!r.ok && r.finding.code).toBe("provider-failed");
  });

  it("serveHandle tells the client `content-ref-refused` (same text for a literal and a foreign param); onFinding gets the real code", async () => {
    const seen: string[] = [];
    const onFinding = (_h: string, f: { code: string }) => void seen.push(f.code);
    const e = exp(literalSpec());
    const lit = await serveHandle(e, req(e), {
      invoker: reply(),
      now: 1,
      contentRefArgs: table,
      onFinding,
    });
    const e2 = exp(paramSpec("global"));
    const par = await serveHandle(e2, req(e2, { image: ADDR }), {
      invoker: reply(),
      now: 1,
      contentRefArgs: table,
      onFinding,
    });
    for (const out of [lit, par]) {
      expect(out.state).toBe("error");
      if (out.state !== "error") continue;
      expect(out.finding.code).toBe("content-ref-refused");
      expect(JSON.stringify(out)).not.toContain("00112233");
    }
    expect(lit.state === "error" && par.state === "error" && lit.finding.message).toBe(
      par.state === "error" ? par.finding.message : ""
    );
    expect(seen).toContain("media-arg-literal");
    expect(seen).toContain("media-arg-param-refused");
  });
});
