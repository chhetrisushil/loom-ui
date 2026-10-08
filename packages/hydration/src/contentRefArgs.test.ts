import { type ContentRefTable, STEP_TEMPLATE_SOURCE, genesis } from "@loom-ui/core";
import type { ContainerNode, Experience, ProviderSpec, SemanticNode } from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { checkContentRefs } from "./contentRefs";
import { HydrationController } from "./controller";
import { prepareArguments } from "./params";
import { STEP_TEMPLATE } from "./plan";
import { HydrationStore } from "./projection";
import { executeProvider } from "./provider";
import { serveHandle } from "./split/index";
import { FakeInvoker, flush, mcpStep, providerSpec } from "./testing.test-support";

// U9b. A marked content-reference argument must be a resolved reference (a step template, a
// host-accepted param) or absent, NEVER a literal the composer wrote. The check runs before the
// call, so a refused step costs no invocation. Defence in depth behind validateExperience.

const ADDR = "sha256:00112233445566778899aabbccddeeff";
const table: ContentRefTable = { describe: [["image"], ["gallery", null]] };
const reply = () => new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => ({ ok: true }));
const run = (
  args: Record<string, unknown>,
  extra: Partial<Parameters<typeof executeProvider>[1]> = {},
  overridable?: string[]
) => {
  const inv = reply();
  const step = { ...mcpStep("s1", "describe", args), ...(overridable && { overridable }) };
  return executeProvider(providerSpec("h", [step]), {
    invoker: inv,
    contentRefArgs: table,
    ...extra,
  }).then((r) => ({ r, inv }));
};

describe("runtime refusal of a literal content reference", () => {
  it("the template grammar is the same one core checks against", () => {
    expect(STEP_TEMPLATE.source).toBe(new RegExp(STEP_TEMPLATE_SOURCE).source);
  });

  it.each([
    ["a literal address", { image: ADDR }],
    ["a URL", { image: "https://evil.example/x" }],
    ["a time token", { image: "$now" }],
    ["an address in an array element", { gallery: ["{{steps.s0.output}}", ADDR] }],
  ])("%s at a marked path: refused, the call is not made", async (_l, args) => {
    const { r, inv } = await run(args);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.findings.map((f) => f.code)).toContain("media-arg-literal");
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

  it("an unreadable schema refuses an address-shaped literal anywhere and lets other text through", async () => {
    const bad = await run({ q: ADDR }, { contentRefArgs: { describe: "unknown" } });
    expect(bad.r.ok).toBe(false);
    expect(bad.inv.calls).toHaveLength(0);
    const fine = await run({ q: "cats" }, { contentRefArgs: { describe: "unknown" } });
    expect(fine.r.ok).toBe(true);
  });

  it("a step reference resolved from an upstream step is accepted and called", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) =>
      (input as { toolName: string }).toolName === "up" ? { addr: ADDR } : { ok: true }
    );
    const r = await executeProvider(
      providerSpec("h", [
        mcpStep("up", "up"),
        mcpStep("s1", "describe", { image: "{{steps.up.output.addr}}" }, ["up"]),
      ]),
      { invoker: inv, contentRefArgs: table }
    );
    expect(r.ok).toBe(true);
    expect(inv.calls).toHaveLength(2);
    expect((inv.calls[1]?.input as { args: unknown }).args).toEqual({ image: ADDR });
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

    it("a host-accepted param is called, and the gate sees the param, step and value", async () => {
      const seen: unknown[] = [];
      const { r, inv } = await run(
        {},
        {
          params: { image: ADDR },
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
        { handle: "h", stepId: "s1", toolName: "describe", param: "image", value: ADDR },
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
  });

  it("the argument hook runs after the check and is the host's own word", async () => {
    const { r, inv } = await run({}, { argumentHook: (a) => ({ ...a, image: ADDR }) });
    expect(r.ok).toBe(true);
    expect((inv.calls[0]?.input as { args: unknown }).args).toEqual({ image: ADDR });
  });

  it("prepareArguments is linear on a 100 KB adversarial argument (generous absolute bound)", () => {
    const t0 = Date.now();
    const node = mcpStep("s1", "describe", { q: "a.".repeat(50_000), image: "x".repeat(100_000) });
    const out = prepareArguments(node, new Map(), {
      handle: "h",
      params: {},
      now: 0,
      guard: (n, applied) =>
        checkContentRefs(n, applied, { handle: "h", contentRefs: [["image"]] }),
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
    const out = await serveHandle(
      e,
      { experienceId: e.experienceId, versionHash: e.versionHash, handle: "h", params: {} },
      { invoker: inv, now: 1, contentRefArgs: table }
    );
    expect(out.state).toBe("error");
    expect(inv.calls).toHaveLength(0);

    const spec = providerSpec("h", [{ ...mcpStep("s1", "describe", {}), overridable: ["image"] }]);
    const e2 = exp(spec);
    const inv2 = reply();
    const out2 = await serveHandle(
      e2,
      {
        experienceId: e2.experienceId,
        versionHash: e2.versionHash,
        handle: "h",
        params: { image: ADDR },
      },
      { invoker: inv2, now: 1, contentRefArgs: table }
    );
    expect(out2.state).toBe("error");
    expect(inv2.calls).toHaveLength(0);
    // ...and the host's gate lets exactly the value it vouches for through.
    const inv3 = reply();
    await serveHandle(
      e2,
      {
        experienceId: e2.experienceId,
        versionHash: e2.versionHash,
        handle: "h",
        params: { image: ADDR },
      },
      {
        invoker: inv3,
        now: 1,
        contentRefArgs: table,
        acceptContentRefParam: (c) => c.value === ADDR,
      }
    );
    expect(inv3.calls).toHaveLength(1);
  });
});
