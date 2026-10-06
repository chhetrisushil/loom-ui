import {
  type Operation,
  type ProviderSpec,
  type ReadPolicy,
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

// U10b round 2: a policy bound at construction applies to every read WITHOUT per-call options, and
// a per-call value can only add to it.

const user = { source: "user" as const };
const meta = { author: "a", createdAt: "2026-10-07T00:00:00Z", sourceKind: "prompt" };
const at = "2026-10-07T00:00:00Z";
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
const bound: ReadPolicy = { declaredToolClasses: { "payroll.read": "secret" } };
const low = { clearance: "internal" } as const;
const high = { clearance: "secret" } as const;

async function setup(lineagePolicy?: ReadPolicy) {
  const content = new InMemoryContentStore();
  const lineage = new Lineage({
    events: new InMemoryLineageStore(),
    content,
    ...(lineagePolicy !== undefined && { readPolicy: lineagePolicy }),
  });
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
        rec({ type: "remapProvider", handle: "hnew", spec: spec("hnew", "newtool.read") }),
        rec({ type: "insertNode", parentId: "root", node: node("pay", "hpay") }),
        rec({ type: "insertNode", parentId: "root", node: node("fresh", "hnew") }),
      ],
      by: user,
    })
  );
  return { content, lineage, exp: v2.experience };
}
const avail = (r: unknown) => (r as { available: boolean }).available;

describe("Lineage with a bound readPolicy", () => {
  it("explain hides the declared-secret node from a low viewer with NO per-call options", async () => {
    const open = await setup();
    expect(avail(ok(await open.lineage.explain("e", "pay", { viewer: low })))).toBe(true);
    const { lineage } = await setup(bound);
    expect(ok(await lineage.explain("e", "pay", { viewer: low }))).toEqual({ available: false });
    expect(avail(ok(await lineage.explain("e", "pay", { viewer: high })))).toBe(true);
  });
  it("a per-call {} / undefined / lower table cannot lower it", async () => {
    const { lineage } = await setup(bound);
    for (const perCall of [
      {},
      { declaredToolClasses: undefined },
      { declaredToolClasses: {} },
      { declaredToolClasses: { "payroll.read": "internal" as const } },
      { undeclared: "allow" as const },
    ])
      expect(
        avail(ok(await lineage.explain("e", "pay", { viewer: low, ...perCall } as never)))
      ).toBe(false);
  });
  it("a per-call table adds to a lineage with none", async () => {
    const { lineage } = await setup();
    expect(
      avail(
        ok(
          await lineage.explain("e", "pay", {
            viewer: low,
            declaredToolClasses: bound.declaredToolClasses as never,
          })
        )
      )
    ).toBe(false);
  });
  it('undeclared: "deny" bound once hides a node whose tool the table omits; allow does not', async () => {
    const strict = await setup({ ...bound, undeclared: "deny" });
    expect(avail(ok(await strict.lineage.explain("e", "fresh", { viewer: high })))).toBe(false);
    expect(
      avail(ok(await strict.lineage.explain("e", "fresh", { viewer: high, undeclared: "allow" })))
    ).toBe(false);
    const lax = await setup(bound);
    expect(avail(ok(await lax.lineage.explain("e", "fresh", { viewer: high })))).toBe(true);
    expect(
      avail(ok(await lax.lineage.explain("e", "fresh", { viewer: high, undeclared: "deny" })))
    ).toBe(false);
  });
  it("exposes the bound policy for readers built over it", async () => {
    expect((await setup(bound)).lineage.readPolicy).toEqual(bound);
    expect((await setup()).lineage.readPolicy).toEqual({});
  });
});

describe("SeenLog with a bound readPolicy", () => {
  const mk = async (opts: { lineage?: ReadPolicy; log?: ReadPolicy }) => {
    const { content, lineage, exp } = await setup(opts.lineage);
    const log = new SeenLog({
      keys: new InMemorySeenKeyStore(),
      events: new InMemoryLineageStore(),
      content,
      lineage,
      ...(opts.log !== undefined && { readPolicy: opts.log }),
    });
    const snapshot = snapshotSeen(exp, {
      viewer: high,
      read: () => ({ found: true, value: { pay: 1 }, status: "ready" }),
    });
    return { log, snapshot };
  };
  const entries = async (
    log: SeenLog,
    reader: typeof low | typeof high,
    extra: Record<string, unknown> = {}
  ) =>
    ok(await log.read({ experienceId: "e", viewerId: "hi", reader, ...extra })).views.flatMap(
      (v) => v.entries
    );
  const names = (es: readonly unknown[]) => JSON.stringify(es);

  for (const where of ["log", "lineage"] as const) {
    it(`read and record apply a policy bound on the ${where}, with no per-call options`, async () => {
      const { log, snapshot } = await mk({ [where]: bound });
      // the cleared recorder stores everything; a low READER is not shown the declared-secret entry
      ok(await log.record({ experienceId: "e", viewerId: "hi", snapshot, viewer: high }));
      expect(names(await entries(log, low))).not.toContain("hpay");
      expect(names(await entries(log, high))).toContain("hpay");
      // a low RECORDER stores nothing for it
      ok(await log.record({ experienceId: "e", viewerId: "lo", snapshot, viewer: low }));
      const stored = ok(await log.read({ experienceId: "e", viewerId: "lo", reader: high }));
      expect(names(stored.views.flatMap((v) => v.entries))).not.toContain("hpay");
    });
  }
  it("read applies the policy to a record stored BEFORE the policy existed (the stamp alone does not carry it)", async () => {
    const { content, lineage, exp } = await setup();
    const events = new InMemoryLineageStore();
    const keys = new InMemorySeenKeyStore();
    const before = new SeenLog({ keys, events, content, lineage });
    const snapshot = snapshotSeen(exp, {
      viewer: high,
      read: () => ({ found: true, value: { pay: 1 }, status: "ready" }),
    });
    ok(await before.record({ experienceId: "e", viewerId: "hi", snapshot, viewer: high }));
    expect(names(await entries(before, low))).toContain("hpay");
    const after = new SeenLog({ keys, events, content, lineage, readPolicy: bound });
    expect(names(await entries(after, low))).not.toContain("hpay");
    expect(names(await entries(after, high))).toContain("hpay");
  });
  it("per-call values cannot lower the bound policy", async () => {
    const { log, snapshot } = await mk({ log: bound });
    ok(await log.record({ experienceId: "e", viewerId: "hi", snapshot, viewer: high }));
    for (const perCall of [{}, { declaredToolClasses: undefined }, { declaredToolClasses: {} }])
      expect(names(await entries(log, low, perCall))).not.toContain("hpay");
  });
  it('bound undeclared: "deny" withholds an entry of a tool the table omits', async () => {
    const { log, snapshot } = await mk({ log: { ...bound, undeclared: "deny" } });
    ok(await log.record({ experienceId: "e", viewerId: "hi", snapshot, viewer: high }));
    expect(names(await entries(log, high))).not.toContain("hnew");
    const lax = await mk({ log: bound });
    ok(
      await lax.log.record({
        experienceId: "e",
        viewerId: "hi",
        snapshot: lax.snapshot,
        viewer: high,
      })
    );
    expect(names(await entries(lax.log, high))).toContain("hnew");
  });
});
