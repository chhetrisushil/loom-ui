import type { HeadSignal, Operation, ProviderSpec, ReadPolicy } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { LineageChangeFeed, type LineageChangeFeedOptions } from "./feed";
import { by, g, ins, makeLineage, manualTimer, node } from "./harness.test-support";
import { pollingHeadSignal } from "./signal";

// U10b round 2: the feed takes the SAME ReadPolicy as every other reader, inherits its lineage's,
// and a per-call `describe` value can only add.

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
  at: "2026-10-07T00:00:00Z",
});
const bound: ReadPolicy = { declaredToolClasses: { "payroll.read": "secret" } };
const low = { clearance: "internal" } as const;
const high = { clearance: "secret" } as const;

const setup = async (opts: {
  feed?: Partial<LineageChangeFeedOptions>;
  lineage?: ReadPolicy;
  tool?: string;
}) => {
  const l = makeLineage(undefined, opts.lineage);
  const timer = manualTimer();
  const signal: HeadSignal = pollingHeadSignal(l.events, { schedule: timer.schedule });
  const feed = new LineageChangeFeed({
    lineage: l.lineage,
    events: l.events,
    signal,
    ...opts.feed,
  });
  const v1 = await l.lineage.start(g("e"), by);
  if (!v1.ok) throw new Error("setup");
  const c = await l.lineage.compose({
    experienceId: "e",
    expectedHead: v1.value.experience.versionHash,
    ops: [remap("hx", opts.tool ?? "payroll.read"), ins(node("tile", "hx"))],
    by,
    summary: "Added the tile",
  });
  if (!c.ok) throw new Error("setup");
  const r = await feed.read("e");
  if (!r.ok) throw new Error("read");
  return { feed, event: r.events[1] as never };
};
const restricted = [{ kind: "restricted-changed" }];

describe("LineageChangeFeed with a bound readPolicy", () => {
  for (const where of ["feed readPolicy", "lineage readPolicy"] as const) {
    it(`${where}: describe with NO per-call options hides the declared-secret change`, async () => {
      const { feed, event } = await setup(
        where === "feed readPolicy" ? { feed: { readPolicy: bound } } : { lineage: bound }
      );
      const d = await feed.describe(event, { viewer: low });
      expect(d.ok && d.description.entries).toEqual(restricted);
      expect(d.ok && d.description.summary).toBeUndefined();
      const cleared = await feed.describe(event, { viewer: high });
      expect(cleared.ok && cleared.description.entries[0]?.nodeId).toBe("tile");
    });
  }
  it("per-call {} / undefined / a lower table cannot lower it", async () => {
    const { feed, event } = await setup({ feed: { readPolicy: bound } });
    for (const perCall of [
      {},
      { declaredToolClasses: undefined },
      { declaredToolClasses: {} },
      { declaredToolClasses: { "payroll.read": "internal" as const } },
      { undeclared: "allow" as const },
    ]) {
      const d = await feed.describe(event, { viewer: low, ...perCall } as never);
      expect(d.ok && d.description.entries).toEqual(restricted);
    }
  });
  it("a bound projections catalogue is not replaced by a per-call one", async () => {
    // No catalogue bound: a per-call one is used. Bound: the per-call one is ignored (it could lower).
    const { feed, event } = await setup({
      feed: { readPolicy: { ...bound, projections: { offered: "bound" } as never } },
    });
    const d = await feed.describe(event, {
      viewer: low,
      projections: { offered: "other" } as never,
    });
    expect(d.ok && d.description.entries).toEqual(restricted);
  });
  it('bound undeclared: "deny" restricts a tool the table omits, for every viewer; allow does not', async () => {
    const strict = await setup({
      feed: { readPolicy: { ...bound, undeclared: "deny" } },
      tool: "newtool.read",
    });
    const d = await strict.feed.describe(strict.event, { viewer: high });
    expect(d.ok && d.description.entries).toEqual(restricted);
    const lax = await setup({ feed: { readPolicy: bound }, tool: "newtool.read" });
    const l = await lax.feed.describe(lax.event, { viewer: high });
    expect(l.ok && l.description.entries[0]?.nodeId).toBe("tile");
    // per-call deny adds
    const added = await lax.feed.describe(lax.event, { viewer: high, undeclared: "deny" });
    expect(added.ok && added.description.entries).toEqual(restricted);
  });
  it("the legacy top-level options still bind (declaredToolClasses on the feed)", async () => {
    const { feed, event } = await setup({
      feed: { declaredToolClasses: bound.declaredToolClasses! },
    });
    const d = await feed.describe(event, { viewer: low });
    expect(d.ok && d.description.entries).toEqual(restricted);
  });
});
