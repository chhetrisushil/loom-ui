import type { HeadSignal, Operation, ProviderSpec } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { LineageChangeFeed } from "./feed";
import { by, g, ins, makeLineage, manualTimer, node } from "./harness.test-support";
import { pollingHeadSignal } from "./signal";

// U10b: the host's declared class per tool floors a node stored UNCLASSIFIED, in `describe`.

const spec = (handle: string, tool: string): ProviderSpec => ({
  handle,
  executionGraph: [
    {
      stepId: "s",
      toolName: tool,
      toolVersion: "1",
      toolSchemaHash: "x",
      arguments: {},
      dependsOn: [],
      idempotent: true,
    },
  ],
  reshaping: { engine: "JSONPath", scriptRef: "$" },
  outputShapeHash: "",
  cachePolicy: { ttlSeconds: 1, scope: "global" },
});
const remap = (handle: string, tool: string) => ({
  op: { type: "remapProvider", handle, spec: spec(handle, tool) } as Operation,
  by,
  at: "2026-10-06T00:00:00Z",
});
const declaredToolClasses = { "payroll.read": "secret" } as const;

const setup = async (feedDeclared?: typeof declaredToolClasses) => {
  const l = makeLineage();
  const timer = manualTimer();
  const signal: HeadSignal = pollingHeadSignal(l.events, { schedule: timer.schedule });
  const feed = new LineageChangeFeed({
    lineage: l.lineage,
    events: l.events,
    signal,
    ...(feedDeclared !== undefined && { declaredToolClasses: feedDeclared }),
  });
  const v1 = await l.lineage.start(g("e"), by);
  if (!v1.ok) throw new Error("setup");
  const c = await l.lineage.compose({
    experienceId: "e",
    expectedHead: v1.value.experience.versionHash,
    ops: [remap("hpay", "payroll.read"), ins(node("payroll", "hpay"))],
    by,
    summary: "Added the payroll tile",
  });
  if (!c.ok) throw new Error("setup");
  const r = await feed.read("e");
  if (!r.ok) throw new Error("read");
  return { feed, event: r.events[1] as never };
};
const low = { clearance: "internal" } as const;

describe("LineageChangeFeed.describe with declaredToolClasses", () => {
  it("without the table the unclassified node is described to a low viewer", async () => {
    const { feed, event } = await setup();
    const d = await feed.describe(event, { viewer: low });
    expect(d.ok && d.description.entries[0]?.kind).toBe("node-added");
  });
  it("a feed-level table makes the change restricted and the summary withheld for a low viewer", async () => {
    const { feed, event } = await setup(declaredToolClasses);
    const d = await feed.describe(event, { viewer: low });
    expect(d.ok && d.description.entries).toEqual([{ kind: "restricted-changed" }]);
    expect(d.ok && d.description.summary).toBeUndefined();
    expect(JSON.stringify(d)).not.toMatch(/payroll|hpay/);
    const cleared = await feed.describe(event, { viewer: { clearance: "secret" } });
    expect(cleared.ok && cleared.description.entries[0]?.nodeId).toBe("payroll");
  });
  it("a per-call table does the same", async () => {
    const { feed, event } = await setup();
    const d = await feed.describe(event, { viewer: low, declaredToolClasses });
    expect(d.ok && d.description.entries).toEqual([{ kind: "restricted-changed" }]);
  });
});
