import {
  type ContainerNode,
  type Experience,
  type ProviderSpec,
  type SemanticNode,
  defineSemanticCatalog,
  genesis,
} from "@loom-ui/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";
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

  it("refuses to check with no kinds: a contract over nothing would pass everything", async () => {
    const r = await executeProvider(contract(), { invoker: replying({ series: [] }) });
    expect(!r.ok && r.finding.code).toBe("output-contract-unbound");
    expect(!r.ok && r.drift).toEqual([]);
  });

  it("kinds with no contract pass with a warning, never silently", async () => {
    const r = await executeProvider(contract(), {
      invoker: replying({ anything: 1 }),
      kinds: ["CustomGauge"],
    });
    expect(r.ok && r.findings.map((f) => f.code)).toEqual(["output-contract-unchecked"]);
  });

  it("an undefined value is drift even for a kind whose contract accepts anything", async () => {
    const r = await executeProvider(contract(), {
      invoker: replying(undefined),
      kinds: ["A2UIView"],
    });
    expect(!r.ok && r.finding.code).toBe("output-contract-drift");
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
