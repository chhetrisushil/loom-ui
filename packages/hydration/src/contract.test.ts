import {
  type ContainerNode,
  type Experience,
  type ProviderSpec,
  type SemanticNode,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HydrationCache } from "./cache";
import { HydrationController } from "./controller";
import { HydrationStore } from "./projection";
import { executeProvider } from "./provider";
import { outputShapeHashOf } from "./reshape";
import { FakeInvoker, flush, mcpStep, providerSpec } from "./testing.test-support";

const replying = (value: unknown) => new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => value);
const series = (points: Array<{ timestamp: string; value: number }>) => ({
  series: [{ label: "temperature", points }],
});
const contract = (over: Partial<ProviderSpec> = {}): ProviderSpec =>
  providerSpec("h", [mcpStep("s", "t")], { outputCheck: "contract", ...over });

describe("output check by contract", () => {
  it("an empty series is healthy under contract, where a shape pin taken on data calls it drift", async () => {
    const pinnedOnData = outputShapeHashOf(
      series([{ timestamp: "2026-09-23T00:00:00Z", value: 1 }])
    );
    const inv = replying(series([]));
    const byShape = await executeProvider(
      providerSpec("h", [mcpStep("s", "t")], { outputShapeHash: pinnedOnData }),
      { invoker: inv }
    );
    expect(!byShape.ok && byShape.finding.code).toBe("output-shape-drift");
    const byContract = await executeProvider(contract({ outputShapeHash: pinnedOnData }), {
      invoker: inv,
      kinds: ["TimeSeries"],
    });
    expect(byContract).toEqual({ ok: true, value: series([]), findings: [] });
  });

  it("a null cell is a healthy table under contract, where the shape pin calls it drift", async () => {
    const full = { columns: ["station", "temp"], rows: [["ridge", 9.5]] };
    const withNull = { columns: ["station", "temp"], rows: [["ridge", null]] };
    const inv = replying(withNull);
    const byShape = await executeProvider(
      providerSpec("h", [mcpStep("s", "t")], { outputShapeHash: outputShapeHashOf(full) }),
      { invoker: inv }
    );
    expect(!byShape.ok && byShape.finding.code).toBe("output-shape-drift");
    expect(await executeProvider(contract(), { invoker: inv, kinds: ["Table"] })).toEqual({
      ok: true,
      value: withNull,
      findings: [],
    });
  });

  it("a value the widget cannot render IS drift, naming the kind whose contract failed", async () => {
    const raw = { series: "not-a-list" };
    const r = await executeProvider(contract(), {
      invoker: replying(raw),
      kinds: ["TimeSeries"],
      captureSample: true,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe("output-contract-drift");
    expect(r.finding.message).toContain('kind "TimeSeries"');
    expect(r.drift).toHaveLength(1);
    expect(r.drift[0]).toMatchObject({
      kind: "output",
      handle: "h",
      expected: "contract:TimeSeries",
      contractKind: "TimeSeries",
      observed: outputShapeHashOf(raw),
      observedShape: { series: "string" },
      observedRawShape: { series: "string" },
    });
    expect(r.drift[0]?.observedSample).toBeDefined();
  });

  it("a handle feeding several kinds must satisfy every one; the first failing kind is named", async () => {
    const number = await executeProvider(contract(), {
      invoker: replying(5),
      kinds: ["MetricCard", "Kpi"],
    });
    expect(!number.ok && number.drift[0]?.contractKind).toBe("Kpi"); // sorted: Kpi < MetricCard
    const object = await executeProvider(contract(), {
      invoker: replying({ value: 5 }),
      kinds: ["MetricCard", "Kpi"],
    });
    expect(!object.ok && object.drift[0]?.contractKind).toBe("MetricCard");
    const both = await executeProvider(contract(), {
      invoker: replying(5),
      kinds: ["MetricCard", "ProgressBar"],
    });
    expect(both).toEqual({ ok: true, value: 5, findings: [] });
  });

  it("a multi-step provider's contract-drift record also carries the TERMINAL step's id (G4/P14)", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, (input) => {
      const i = input as { toolName: string };
      return i.toolName === "db.list" ? { ids: ["a"] } : { series: "not-a-list" };
    });
    const spec = providerSpec(
      "h",
      [
        mcpStep("list", "db.list"),
        mcpStep("stats", "db.stats", { id: "{{steps.list.output.ids[0]}}" }, ["list"]),
      ],
      { outputCheck: "contract" }
    );
    const r = await executeProvider(spec, { invoker: inv, kinds: ["TimeSeries"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.finding.code).toBe("output-contract-drift");
    expect(r.drift[0]?.stepId).toBe("stats");
  });

  it("refuses to check with no kinds: a contract over nothing would pass everything", async () => {
    const r = await executeProvider(contract(), { invoker: replying({ series: [] }) });
    expect(!r.ok && r.finding.code).toBe("output-contract-unbound");
    expect(!r.ok && r.drift).toEqual([]);
  });

  it("an undefined value is drift even for a kind whose contract accepts anything", async () => {
    const r = await executeProvider(contract(), {
      invoker: replying(undefined),
      kinds: ["A2UIView"],
    });
    expect(!r.ok && r.finding.code).toBe("output-contract-drift");
  });

  it("input-schema drift under a contract spec is still a plain 'input' record — no contractKind (D15)", async () => {
    const inv = new FakeInvoker().on(MCP_INVOKE_TOOL_ID, () => {
      throw new TypedFailure("schemaDrift", {
        toolName: "t",
        expectedSchemaHash: "schema-t",
        observedHash: "schema-v2",
      });
    });
    const r = await executeProvider(contract(), { invoker: inv, kinds: ["Kpi"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.drift).toEqual([
      {
        kind: "input",
        handle: "h",
        stepId: "s",
        toolName: "t",
        expected: "schema-t",
        observed: "schema-v2",
      },
    ]);
    expect(r.drift[0]?.contractKind).toBeUndefined();
  });
});

describe("HydrationController with output kinds", () => {
  const catalog = defineSemanticCatalog({
    id: "contract.test.v1",
    entries: [
      {
        name: "Reading",
        version: "1.0.0",
        props: [],
        binding: "required",
        surfaces: { web: { kind: "Kpi", props: [], binding: "required" } },
      },
    ],
  });
  const exp = (): Experience => {
    const g = genesis({
      experienceId: "exp-1",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" },
    });
    const n: SemanticNode = {
      id: "a",
      order: "a",
      kind: "semantic",
      type: "Reading",
      typeVersion: "1.0.0",
      span: 4,
      props: {},
      binding: { handle: "h", priority: "P0" },
    };
    return {
      ...g,
      versionHash: "sha256:v1",
      root: { ...(g.root as ContainerNode), children: [n] },
      providers: { h: contract() },
    };
  };
  const rig = (value: unknown, withKinds: boolean) => {
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const ctl = new HydrationController({
      invoker: replying(value),
      store,
      ...(withKinds && { outputKinds: { catalog, surface: "web" as const } }),
    });
    return { store, ctl };
  };

  it("checks each handle against the kinds its nodes resolve to on the controller's surface", async () => {
    const ok = rig({ value: 3 }, true);
    ok.ctl.load(exp());
    await flush();
    expect(ok.store.status("h")?.state).toBe("ready");
    const bad = rig(3, true);
    bad.ctl.load(exp());
    await flush();
    expect(bad.store.status("h")?.state).toBe("stale");
    expect(bad.store.status("h")?.finding?.code).toBe("output-contract-drift");
  });

  it("a contract provider on a controller given no kinds is an error, never an unchecked ready", async () => {
    const r = rig({ value: 3 }, false);
    r.ctl.load(exp());
    await flush();
    expect(r.store.status("h")?.state).toBe("error");
    expect(r.store.status("h")?.finding?.code).toBe("output-contract-unbound");
  });
});

describe("the cache key includes the checked kinds", () => {
  // "Reading" resolves to Kpi on web and MetricCard on terminal; "Amount" resolves to MetricCard
  // on web only — enough to widen one handle's kinds (web) or split them across two surfaces.
  const catalog = defineSemanticCatalog({
    id: "contract.cache.test.v1",
    entries: [
      {
        name: "Reading",
        version: "1.0.0",
        props: [],
        binding: "required",
        surfaces: {
          web: { kind: "Kpi", props: [], binding: "required" },
          terminal: { kind: "MetricCard", props: [], binding: "required" },
        },
      },
      {
        name: "Amount",
        version: "1.0.0",
        props: [],
        binding: "required",
        surfaces: { web: { kind: "MetricCard", props: [], binding: "required" } },
      },
    ],
  });
  const node = (id: string, type: string): SemanticNode => ({
    id,
    order: id,
    kind: "semantic",
    type,
    typeVersion: "1.0.0",
    span: 4,
    props: {},
    binding: { handle: "h", priority: "P0" },
  });
  const expWith = (nodes: SemanticNode[], spec: ProviderSpec): Experience => {
    const g = genesis({
      experienceId: "exp-1",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" },
    });
    return {
      ...g,
      versionHash: "sha256:v1",
      root: { ...(g.root as ContainerNode), children: nodes },
      providers: { h: spec },
    };
  };

  it("a warm cache checked against narrower kinds is not served after a recompose widens them", async () => {
    // {value:3} satisfies Kpi (the only kind bound at first) and gets cached ttl 60, global.
    const spec = contract();
    const inv = replying({ value: 3 });
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const ctl = new HydrationController({
      invoker: inv,
      store,
      outputKinds: { catalog, surface: "web" },
    });
    ctl.load(expWith([node("a", "Reading")], spec));
    await flush();
    expect(store.status("h")?.state).toBe("ready");
    expect(inv.calls).toHaveLength(1);

    // Recompose adds a MetricCard-bound node on the SAME handle and spec: kinds widen to
    // [Kpi, MetricCard]. {value:3} is not a number, so MetricCard's contract fails it.
    ctl.load(expWith([node("a", "Reading"), node("b", "Amount")], spec));
    await flush();
    expect(inv.calls).toHaveLength(2); // the cache MUST NOT have answered for the new kinds
    expect(store.status("h")?.state).toBe("stale");
    expect(store.status("h")?.finding?.code).toBe("output-contract-drift");
  });

  it("two controllers on different surfaces sharing one cache never serve each other's checked value", async () => {
    const spec = contract();
    const inv = replying({ value: 3 }); // satisfies Kpi (web), fails MetricCard (terminal)
    const cache = new HydrationCache(() => 0);
    const web = new HydrationController({
      invoker: inv,
      store: new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" }),
      outputKinds: { catalog, surface: "web" },
      cache,
    });
    const terminal = new HydrationController({
      invoker: inv,
      store: new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" }),
      outputKinds: { catalog, surface: "terminal" },
      cache,
    });
    web.load(expWith([node("a", "Reading")], spec));
    await flush();
    expect(inv.calls).toHaveLength(1); // web: Kpi accepts {value:3}, cached under kinds [Kpi]

    terminal.load(expWith([node("a", "Reading")], spec));
    await flush();
    expect(inv.calls).toHaveLength(2); // terminal checks kinds [MetricCard]: a DIFFERENT cache entry
  });
});

describe("a shape provider's fingerprint ignores kind changes", () => {
  const catalog = defineSemanticCatalog({
    id: "contract.shape.test.v1",
    entries: [
      {
        name: "Reading",
        version: "1.0.0",
        props: [],
        binding: "required",
        surfaces: { web: { kind: "Kpi", props: [], binding: "required" } },
      },
      {
        name: "Amount",
        version: "1.0.0",
        props: [],
        binding: "required",
        surfaces: { web: { kind: "MetricCard", props: [], binding: "required" } },
      },
    ],
  });
  const node = (id: string, type: string): SemanticNode => ({
    id,
    order: id,
    kind: "semantic",
    type,
    typeVersion: "1.0.0",
    span: 4,
    props: {},
    binding: { handle: "h", priority: "P0" },
  });
  const expWith = (nodes: SemanticNode[], spec: ProviderSpec): Experience => {
    const g = genesis({
      experienceId: "exp-1",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" },
    });
    return {
      ...g,
      versionHash: "sha256:v1",
      root: { ...(g.root as ContainerNode), children: nodes },
      providers: { h: spec },
    };
  };

  it("a recompose that changes a shape provider's bound node kinds does not abort or restart it", async () => {
    // outputCheck unset (shape mode); ttl 0 so the cache can never mask what's under test — the
    // only thing that can stop a second run is `schedule`'s "same question already asked" check.
    const spec = providerSpec("h", [mcpStep("s", "t")], {
      cachePolicy: { ttlSeconds: 0, scope: "global" },
    });
    const inv = replying({ anything: 1 });
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    const ctl = new HydrationController({
      invoker: inv,
      store,
      outputKinds: { catalog, surface: "web" },
    });
    ctl.load(expWith([node("a", "Reading")], spec)); // kinds resolve to [Kpi]
    await flush();
    expect(store.status("h")?.state).toBe("ready");
    expect(inv.calls).toHaveLength(1);

    // The bound node's resolved kind changes ([Kpi] → [MetricCard]) but the SPEC is unchanged and
    // is not checked by contract: the handle must not be treated as a new question.
    ctl.load(expWith([node("a", "Amount")], spec));
    await flush();
    expect(inv.calls).toHaveLength(1); // no second run
    expect(store.status("h")?.state).toBe("ready");
  });
});

describe("output check by contract — host kinds (U13)", () => {
  const contracts = { SpokenGauge: z.object({ level: z.number() }) };

  it("a host kind's contract is enforced: a bad value is drift naming the kind", async () => {
    const r = await executeProvider(contract(), {
      invoker: replying({ level: "high" }),
      kinds: ["SpokenGauge"],
      contracts,
    });
    expect(!r.ok && r.finding.code).toBe("output-contract-drift");
    expect(!r.ok && r.drift[0]?.contractKind).toBe("SpokenGauge");
  });

  it("a good value for a host kind is ready, with no warning", async () => {
    const r = await executeProvider(contract(), {
      invoker: replying({ level: 3 }),
      kinds: ["SpokenGauge"],
      contracts,
    });
    expect(r).toEqual({ ok: true, value: { level: 3 }, findings: [] });
  });

  it("a kind with NO contract is REFUSED, not passed: no drift to repair, nothing published", async () => {
    const r = await executeProvider(contract(), {
      invoker: replying({ anything: 1 }),
      kinds: ["CustomGauge"],
    });
    expect(!r.ok && r.finding.code).toBe("output-contract-missing");
    expect(!r.ok && r.finding.message).toContain("CustomGauge");
    expect(!r.ok && r.drift).toEqual([]);
  });

  it("one uncontracted kind among contracted ones still refuses (the old pass was only all-or-nothing)", async () => {
    const r = await executeProvider(contract(), {
      invoker: replying({ level: 3 }),
      kinds: ["SpokenGauge", "CustomGauge"],
      contracts,
    });
    expect(!r.ok && r.finding.code).toBe("output-contract-missing");
  });

  it("a registry entry for a framework kind does not loosen it", async () => {
    const r = await executeProvider(contract(), {
      invoker: replying("text"),
      kinds: ["Kpi"],
      contracts: { Kpi: z.unknown() },
    });
    expect(!r.ok && r.finding.code).toBe("output-contract-drift");
  });
});

describe("HydrationController with a host kind (U13)", () => {
  const entry = (value: unknown) => ({
    value,
    catalog: defineSemanticCatalog({
      id: "host.v1",
      entries: [
        {
          name: "Gauge",
          version: "1.0.0",
          props: [],
          binding: "required" as const,
          surfaces: { voice: { kind: "SpokenGauge", props: [], binding: "required" as const } },
        },
      ],
      valueContracts: { SpokenGauge: z.object({ level: z.number() }) },
    }),
  });
  const run = async (value: unknown, withContracts: boolean) => {
    const e = entry(value);
    const catalog = withContracts
      ? e.catalog
      : defineSemanticCatalog({ id: e.catalog.id, entries: e.catalog.entries });
    const g = genesis({
      experienceId: "exp-1",
      intent: { objective: "x", source: "user" },
      meta: { author: "a", createdAt: "2026-09-23T00:00:00Z", sourceKind: "test" },
    });
    const n: SemanticNode = {
      id: "a",
      order: "a",
      kind: "semantic",
      type: "Gauge",
      typeVersion: "1.0.0",
      span: 4,
      props: {},
      binding: { handle: "h", priority: "P0" },
    };
    const exp: Experience = {
      ...g,
      versionHash: "sha256:v1",
      root: { ...(g.root as ContainerNode), children: [n] },
      providers: { h: contract() },
    };
    const store = new HydrationStore(new InMemoryProjectionRuntime(), { experienceId: "exp-1" });
    new HydrationController({
      invoker: replying(value),
      store,
      outputKinds: { catalog, surface: "voice" },
    }).load(exp);
    await flush();
    return store.status("h");
  };

  it("checks a host kind's value through the catalogue's valueContracts", async () => {
    expect((await run({ level: 3 }, true))?.state).toBe("ready");
    const bad = await run({ level: "x" }, true);
    expect(bad?.state).toBe("stale");
    expect(bad?.finding?.code).toBe("output-contract-drift");
  });

  it("without a declared contract the load is an error — never an unchecked ready", async () => {
    const s = await run({ level: 3 }, false);
    expect(s?.state).toBe("error");
    expect(s?.finding?.code).toBe("output-contract-missing");
  });
});
