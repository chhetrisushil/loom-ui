import {
  type Operation,
  type ProviderSpec,
  type RecordedOperation,
  type SemanticNode,
  genesis,
  snapshotSeen,
} from "@loom-ui/core";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { Lineage, type LineageResult } from "./lineage";
import { SeenLog, type SeenResult } from "./seen";
import { InMemorySeenKeyStore } from "./seenCrypto";
import { InMemoryLineageStore } from "./store";

// U10b: the host's declared class per tool floors a node stored UNCLASSIFIED, in lineage's
// `explain` and in the seen log's record / read.

const user = { source: "user" as const };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const at = "2026-10-06T00:00:00Z";
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
const node = (id: string, handle: string): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle, priority: "P1" },
});
const rec = (op: Operation): RecordedOperation => ({ op, by: user, at });
function ok<T>(r: LineageResult<T> | SeenResult<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  return r.value;
}
const declaredToolClasses = { "payroll.read": "secret" } as const;
const low = { clearance: "internal" } as const;
const high = { clearance: "secret" } as const;

async function setup() {
  const content = new InMemoryContentStore();
  const lineage = new Lineage({ events: new InMemoryLineageStore(), content });
  const v1 = ok(
    await lineage.start(
      genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta }),
      user
    )
  );
  const v2 = ok(
    await lineage.compose({
      experienceId: "e",
      expectedHead: v1.experience.versionHash,
      ops: [
        rec({ type: "remapProvider", handle: "hpay", spec: spec("hpay", "payroll.read") }),
        rec({ type: "insertNode", parentId: "root", node: node("pay", "hpay") }),
      ],
      by: user,
    })
  );
  return { content, lineage, exp: v2.experience };
}

describe("lineage with declaredToolClasses", () => {
  it("explain: unavailable to a low viewer, identical to an unknown id", async () => {
    const { lineage } = await setup();
    const open = ok(await lineage.explain("e", "pay", { viewer: low }));
    expect((open as { available: boolean }).available).toBe(true);
    const hidden = ok(await lineage.explain("e", "pay", { viewer: low, declaredToolClasses }));
    const unknown = ok(await lineage.explain("e", "ghost", { viewer: low, declaredToolClasses }));
    expect(hidden).toEqual({ available: false });
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(unknown));
    const shown = ok(await lineage.explain("e", "pay", { viewer: high, declaredToolClasses }));
    expect((shown as { available: boolean }).available).toBe(true);
  });

  it("SeenLog.record / read: the entry is dropped for a low recorder and withheld from a low reader", async () => {
    const { content, lineage, exp } = await setup();
    const log = new SeenLog({
      keys: new InMemorySeenKeyStore(),
      events: new InMemoryLineageStore(),
      content,
      lineage,
    });
    const snapshot = snapshotSeen(exp, {
      viewer: high,
      read: () => ({ found: true, value: { pay: 1 }, status: "ready" }),
    });
    // a low RECORDER with the table: the unclassified-looking entry is dropped before it is stored
    ok(
      await log.record({
        experienceId: "e",
        viewerId: "low",
        snapshot,
        viewer: low,
        declaredToolClasses,
      })
    );
    const stored = ok(await log.read({ experienceId: "e", viewerId: "low", reader: high }));
    expect(stored.views.flatMap((v) => v.entries)).toEqual([]);
    // a cleared recorder stores it; a low READER with the table is not shown it, one without is
    ok(await log.record({ experienceId: "e", viewerId: "hi", snapshot, viewer: high }));
    const seen = (reader: typeof low | typeof high, table?: typeof declaredToolClasses) =>
      log.read({
        experienceId: "e",
        viewerId: "hi",
        reader,
        ...(table !== undefined && { declaredToolClasses: table }),
      });
    expect(ok(await seen(low)).views.flatMap((v) => v.entries)).toHaveLength(1);
    const withTable = ok(await seen(low, declaredToolClasses));
    expect(withTable.views.flatMap((v) => v.entries)).toEqual([]);
    expect(JSON.stringify(withTable)).not.toContain("hpay");
    expect(ok(await seen(high, declaredToolClasses)).views.flatMap((v) => v.entries)).toHaveLength(
      1
    );
  });
});
