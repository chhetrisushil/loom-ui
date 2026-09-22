import { genesis, isContainer, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import type { DriftRecord } from "@loom-ui/hydration";
import { tainted } from "@loom/classify";
import { describe, expect, it } from "vitest";
import { driftCapabilities, driftRequest, reviseForDrift } from "./drift";
import { materialize } from "./materialize";
import { ReferencePlanner } from "./reference";
import {
  capabilitiesFixture,
  intentFixture,
  metaFixture,
  planningCatalog,
  recordingContext,
  scriptedModel,
} from "./testing.test-support";

const composedDraft = {
  summary: "s",
  nodes: [
    {
      id: "orders",
      type: "Metric",
      label: "Orders",
      span: 4,
      props: {},
      binding: {
        capability: "orders_summary",
        arguments: { window: "7d" },
        path: "totals.count",
        priority: "P0" as const,
      },
    },
  ],
};
const exp = (() => {
  const g = genesis({ experienceId: "e", intent: intentFixture, meta: metaFixture });
  const r = replay(g, materialize(composedDraft, g, planningCatalog, capabilitiesFixture).ops);
  if (!r.ok) throw new Error(r.finding.message);
  return seal(r.value);
})();
const handle = Object.keys(exp.providers)[0] as string;
// The tool now nests the count: { totals: { count: { value: 412 } } }
const drift: DriftRecord[] = [
  {
    kind: "output",
    handle,
    expected: exp.providers[handle]!.outputShapeHash,
    observed: "fnv1a64:deadbeef",
    observedShape: { totals: { count: { value: "number" } }, window: "string" },
    observedSample: tainted(
      { window: "7d", totals: { count: { value: 412 } } },
      `provider:${handle}`
    ),
  },
];

describe("drift → revision", () => {
  it("driftRequest names the handle, the bound nodes, expected vs observed, and the observed shape; scope = the bound nodes", () => {
    const req = driftRequest(exp, drift);
    expect(req.scopeNodeIds).toEqual(["orders"]);
    expect(req.text).toContain(handle);
    expect(req.text).toContain("orders");
    expect(req.text).toContain('"value": "number"');
    expect(req.text).toContain(exp.providers[handle]!.outputShapeHash);
  });

  it("driftCapabilities swaps the drifted provider's tool sample for the UNWRAPPED observed sample and leaves other capabilities alone", () => {
    const caps = driftCapabilities(capabilitiesFixture, exp, drift);
    const orders = caps.find((c) => c.handle === "orders_summary");
    expect(orders?.sampleOutput).toEqual({ window: "7d", totals: { count: { value: 412 } } });
    expect(caps.find((c) => c.handle === "incidents_open")?.sampleOutput).toBeUndefined();
  });

  it("a drift record without a sample leaves the capability's own sample in place (the planner can still re-author from the shape text)", () => {
    const noSample = drift.map(({ observedSample: _s, ...rest }) => rest);
    const caps = driftCapabilities(capabilitiesFixture, exp, noSample);
    expect(caps.find((c) => c.handle === "orders_summary")?.sampleOutput).toEqual(
      capabilitiesFixture[0]!.sampleOutput
    );
  });

  it("reviseForDrift yields one prompt op whose remapProvider pins the NEW output shape from the observed sample and keeps node ids", async () => {
    const reauthored = JSON.stringify({
      summary: "re-pathed",
      nodes: [
        {
          ...composedDraft.nodes[0],
          binding: { ...composedDraft.nodes[0]!.binding, path: "totals.count.value" },
        },
      ],
    });
    const planner = new ReferencePlanner({ model: scriptedModel([reauthored]), modelId: "m" });
    const result = await reviseForDrift(
      planner,
      { experience: exp, drift, catalog: planningCatalog, capabilities: capabilitiesFixture },
      recordingContext()
    );
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.ops).toHaveLength(1);
    const op = result.ops[0] as {
      type: "prompt";
      materialized: Array<{
        type: string;
        spec?: { outputShapeHash: string; reshaping: { scriptRef: string } };
      }>;
    };
    expect(op.materialized.map((o) => o.type)).toEqual(["remapProvider", "bindProvider"]);
    const remap = op.materialized[0]!;
    expect(remap.spec?.reshaping.scriptRef).toBe("totals.count.value");
    expect(remap.spec?.outputShapeHash).toBe(exp.providers[handle]!.outputShapeHash); // 412 is still a number → same pinned shape
    const after = replay(exp, result.ops);
    expect(
      after.ok && isContainer(after.value.root) && after.value.root.children.map((c) => c.id)
    ).toEqual(["orders"]);
  });
});
