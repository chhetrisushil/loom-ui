import {
  type ContainerNode,
  type Experience,
  type ProviderSpec,
  type SemanticNode,
  defineSemanticCatalog,
  genesis,
  mediaCatalogEntries,
} from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import { FakeInvoker, flush, mcpStep, providerSpec } from "./testing.test-support";

// U9. A handle that feeds a media widget is checked against the MediaRef contract WHATEVER its
// provider declared (`outputCheck` unset = "shape", which would pass any value of the pinned shape):
// otherwise inline bytes or a locator could be published into the store (and from there into a seen
// log or a split-hydration payload). A restricted media handle is never called at all.

const catalog = defineSemanticCatalog({ id: "media", entries: mediaCatalogEntries() });
const GOOD = { address: "sha256:00ff11", mediaType: "image/png", size: 12, name: "a.png" };
const replying = (value: unknown) => new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => value);

const exp = (spec: ProviderSpec, sensitivity?: "secret"): Experience => {
  const g = genesis({
    experienceId: "exp-1",
    intent: { objective: "x", source: "user" },
    meta: { author: "a", createdAt: "2026-10-08T00:00:00Z", sourceKind: "test" },
  });
  const n: SemanticNode = {
    id: "pic",
    order: "a",
    kind: "semantic",
    type: "Image",
    typeVersion: "1.0.0",
    span: 6,
    props: {},
    binding: { handle: "h", priority: "P0", ...(sensitivity && { sensitivity }) },
  };
  return {
    ...g,
    versionHash: "sha256:v1",
    root: { ...(g.root as ContainerNode), children: [n] },
    providers: { h: spec },
  };
};
const rig = (value: unknown, viewer?: { clearance?: "secret" }) => {
  const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
  const inv = replying(value);
  const ctl = new HydrationController({
    invoker: inv,
    store,
    outputKinds: { catalog, surface: "web" },
    ...(viewer !== undefined && { viewer }),
  });
  return { store, inv, ctl };
};
// A SHAPE provider (no outputCheck): before U9 this passed any value.
const shapeSpec = () => providerSpec("h", [mcpStep("s", "t")]);

describe("U9 hydration of media handles", () => {
  it("publishes a well-formed MediaRef", async () => {
    const r = rig(GOOD);
    r.ctl.load(exp(shapeSpec()));
    await flush();
    expect(r.store.status("h")?.state).toBe("ready");
    expect(r.store.value("h")).toEqual(GOOD);
  });

  it.each([
    ["inline bytes", { ...GOOD, data: "A".repeat(100_000) }],
    ["a locator as the address", { ...GOOD, address: "https://internal.corp/secret" }],
    ["a bare string", "sha256:00ff11"],
    ["the wrong media family", { ...GOOD, mediaType: "audio/mpeg" }],
  ])("a shape-mode provider returning %s is never published", async (_l, bad) => {
    const r = rig(bad);
    r.ctl.load(exp(shapeSpec()));
    await flush();
    expect(r.store.status("h")?.state).not.toBe("ready");
    expect(r.store.value("h")).toBeUndefined();
    expect(JSON.stringify(r.store.state())).not.toContain("AAAA");
    expect(JSON.stringify(r.store.state())).not.toContain("internal.corp");
  });

  it("a restricted media handle is never invoked, and its address is nowhere in the store", async () => {
    const r = rig(GOOD, {});
    r.ctl.load(exp(shapeSpec(), "secret"));
    await flush();
    expect(r.inv.calls).toHaveLength(0);
    expect(JSON.stringify(r.store.state())).not.toContain(GOOD.address);
    // ...and a cleared viewer does get it (the test above is not vacuous).
    const ok = rig(GOOD, { clearance: "secret" });
    ok.ctl.load(exp(shapeSpec(), "secret"));
    await flush();
    expect(JSON.stringify(ok.store.state())).toContain(GOOD.address);
  });
});

// ── fix round 1 (P2-1): the split server and the no-outputKinds path ────────────────────────────
import { serveHandle } from "./split/index";

const BAD = {
  address: "sha256:00ff11",
  mediaType: "image/png",
  data: "A".repeat(5000),
  url: "https://internal.corp/x",
};
const serve = (value: unknown, withKinds: boolean, spec = shapeSpec()) => {
  const e = exp(spec);
  const inv = replying(value);
  return serveHandle(
    e,
    { experienceId: e.experienceId, versionHash: e.versionHash, handle: "h", params: {} },
    {
      invoker: inv,
      now: 1,
      ...(withKinds && { outputKinds: { catalog, surface: "web" as const } }),
    }
  );
};

describe("U9 split server: a media handle is contract-checked whatever the provider declared", () => {
  for (const withKinds of [true, false]) {
    it(`never serves a shape-mode value carrying bytes or a locator (outputKinds ${withKinds ? "given" : "ABSENT: fail closed by node type"})`, async () => {
      const r = await serve(BAD, withKinds);
      expect(r.state).not.toBe("ready");
      expect(JSON.stringify(r)).not.toContain("AAAA");
      expect(JSON.stringify(r)).not.toContain("internal.corp");
    });
    it(`serves a well-formed ref (outputKinds ${withKinds ? "given" : "absent"})`, async () => {
      const r = await serve(GOOD, withKinds);
      expect(r).toMatchObject({ state: "ready", value: GOOD });
    });
  }
  it("the forced contract does not leak through the cache: a bad value is not cached as ready", async () => {
    const { HydrationCache } = await import("./cache");
    const cache = new HydrationCache(() => 0);
    const e = exp(shapeSpec());
    const base = {
      experienceId: e.experienceId,
      versionHash: e.versionHash,
      handle: "h",
      params: {},
    };
    await serveHandle(e, base, {
      invoker: replying(BAD),
      now: 1,
      cache,
      outputKinds: { catalog, surface: "web" },
    });
    const again = await serveHandle(e, base, {
      invoker: replying(GOOD),
      now: 1,
      cache,
      outputKinds: { catalog, surface: "web" },
    });
    expect(again).toMatchObject({ state: "ready", value: GOOD });
  });
});

describe("U9 controller without outputKinds: fail closed by node type, with a dev warning", () => {
  it("never publishes a bad media value and warns that outputKinds is missing", async () => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const ctl = new HydrationController({ invoker: replying(BAD), store });
    const { findings } = ctl.load(exp(shapeSpec()));
    await flush();
    expect(store.status("h")?.state).not.toBe("ready");
    expect(store.value("h")).toBeUndefined();
    expect(findings.map((f) => f.code)).toContain("media-output-kinds-missing");
    const ok = new HydrationController({
      invoker: replying(GOOD),
      store: new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" }),
    });
    ok.load(exp(shapeSpec()));
    await flush();
  });
});
