import {
  type Provenance,
  type RecordedOperation,
  type SemanticNode,
  genesis,
  snapshotSeen,
} from "@loom-ui/core";
import { InMemoryContentStore, sweepUnpinnedContent } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { Lineage, type LineageResult } from "./lineage";
import { rootsFor } from "./rootsFor";
import { SeenLog } from "./seen";
import { InMemorySeenKeyStore } from "./seenCrypto";
import { InMemoryLineageStore } from "./store";

// U17 fix round: the retention pins feed `sweepUnpinnedContent({ completeScan: true })`, which ERASES.
// Everything here runs loom's REAL sweep, and the races are driven deterministically by hooking the
// content store's `listPage` (the sweep's first read AFTER its roots were computed) or the lineage
// store's `listStreams` (between `pins`' two passes).

const by: Provenance = { source: "user" };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const node = (id: string, props: Record<string, unknown> = {}): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props,
  binding: { handle: `h-${id}`, priority: "P1" },
});
const ins = (n: SemanticNode): RecordedOperation => ({
  op: { type: "insertNode", parentId: "root", node: n },
  by,
  at: "2026-10-06T00:00:00Z",
});
const ok = <T>(r: LineageResult<T>): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.refusal)}`);
  return r.value;
};
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const TTL = 30 * DAY;

async function rig() {
  const clock = { now: NOW - 60 * DAY };
  const content = new InMemoryContentStore({ now: () => clock.now });
  const events = new InMemoryLineageStore();
  const lin = new Lineage({ events, content });
  return { clock, content, events, lin };
}
type Rig = Awaited<ReturnType<typeof rig>>;

async function line(
  lin: Lineage,
  id: string,
  n: number,
  opts: { root?: SemanticNode; extra?: Record<number, RecordedOperation> } = {}
): Promise<string[]> {
  const g = genesis({
    experienceId: id,
    intent: { objective: "o", source: "user" },
    meta,
    ...(opts.root !== undefined && {
      root: {
        id: "root",
        order: "V",
        kind: "container",
        direction: "grid",
        span: 12,
        children: [opts.root],
      },
    }),
  });
  const hashes = [ok(await lin.start(g, by)).version.versionHash];
  for (let i = 1; i < n; i++)
    hashes.push(
      ok(
        await lin.compose({
          experienceId: id,
          expectedHead: hashes.at(-1) as string,
          ops: [opts.extra?.[i] ?? ins(node(`n${i}`))],
          by,
        })
      ).version.versionHash
    );
  return hashes;
}

function sweep(r: Rig, roots: () => AsyncIterable<string>) {
  r.clock.now = NOW;
  return sweepUnpinnedContent({
    eventStores: [],
    contentStore: r.content,
    pinnedEventTypes: [],
    olderThanMs: TTL,
    now: NOW,
    roots,
    reclaimOrphans: { completeScan: true },
  });
}
/** Run `action` when the sweep first lists the content store: its roots are already computed. */
function beforeFirstListPage(r: Rig, action: () => Promise<void>) {
  const orig = r.content.listPage?.bind(r.content);
  if (orig === undefined) throw new Error("rig store has no listPage");
  let fired = false;
  (r.content as { listPage: typeof orig }).listPage = async (o) => {
    if (!fired) {
      fired = true;
      await action();
    }
    return orig(o);
  };
}
const open = async (lin: Lineage, id: string, h: string) => (await lin.get(id, h)).ok;

async function twoLineages() {
  const r = await rig();
  const linB = new Lineage({ events: new InMemoryLineageStore(), content: r.content });
  const a = await line(r.lin, "a", 12);
  const b = await line(linB, "b", 12);
  const log = new SeenLog({
    events: new InMemoryLineageStore(),
    content: r.content,
    lineage: r.lin,
    keys: new InMemorySeenKeyStore(),
  });
  const exp = ok(await r.lin.get("a", a[3] as string));
  const snapshot = snapshotSeen(exp, {
    viewer: {},
    read: (s) =>
      s.kind === "handle" && s.handle === "h-n3"
        ? { found: true, value: { n: 42 }, status: "ready" }
        : { found: false, status: "pending" },
  });
  const rec = await log.record({ experienceId: "a", viewerId: "v", snapshot, viewer: {} });
  if (!rec.ok) throw new Error(JSON.stringify(rec.refusal));
  const polA = { keepLast: 3 };
  const polB = { keepLast: 2 };
  const survivors = async (lin: Lineage, id: string, h: string[]) =>
    (await Promise.all(h.map((x) => open(lin, id, x))))
      .map((v, i) => (v ? i : -1))
      .filter((i) => i >= 0);
  return { r, linA: r.lin, linB, a, b, log, polA, polB, survivors };
}

describe("rootsFor composes every user of a shared store", () => {
  it("keeps each lineage's retained versions and the seen entries; reclaims the rest", async () => {
    const t = await twoLineages();
    await sweep(t.r, () =>
      rootsFor({
        lineages: [
          { lineage: t.linA, policy: t.polA },
          { lineage: t.linB, policy: t.polB },
        ],
        seenLogs: [t.log],
      })
    );
    // a: genesis, newest 3, and the viewed version 3; b: genesis + newest 2
    expect(await t.survivors(t.linA, "a", t.a)).toEqual([0, 3, 9, 10, 11]);
    expect(await t.survivors(t.linB, "b", t.b)).toEqual([0, 10, 11]);
    const read = await t.log.read({ experienceId: "a", viewerId: "v", limit: 50 });
    if (!read.ok) throw new Error("read refused");
    expect(read.value.views[0]?.entries.find((e) => e.state === "seen")?.value).toEqual({ n: 42 });
  });

  it("CONTROL: only lineage A's pins erase lineage B's artifacts (the hazard rootsFor removes)", async () => {
    const t = await twoLineages();
    await sweep(t.r, () => t.linA.pins(t.polA, {}));
    expect(await t.survivors(t.linB, "b", t.b)).toEqual([]);
  });

  it("deduplicates, and includes `extra` (sync or async)", async () => {
    const t = await twoLineages();
    const all: string[] = [];
    for await (const x of rootsFor({
      lineages: [{ lineage: t.linA, policy: t.polA }, { lineage: t.linB }],
      seenLogs: [t.log],
      extra: ["zz-extra", "zz-extra"],
    }))
      all.push(x);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain("zz-extra");
    const viaAsync: string[] = [];
    for await (const x of rootsFor({
      lineages: [{ lineage: t.linA }],
      extra: (async function* () {
        yield "yy";
      })(),
    }))
      viaAsync.push(x);
    expect(viaAsync).toContain("yy");
  });

  it("a throwing source makes the iterator throw before yielding anything, and the sweep deletes nothing", async () => {
    const t = await twoLineages();
    const boom = (async function* () {
      yield "q";
      throw new Error("app table unavailable");
    })();
    const yielded: string[] = [];
    await expect(
      (async () => {
        for await (const x of rootsFor({
          lineages: [
            { lineage: t.linA, policy: t.polA },
            { lineage: t.linB, policy: t.polB },
          ],
          extra: boom,
        }))
          yielded.push(x);
      })()
    ).rejects.toThrow(/app table unavailable/);
    expect(yielded).toEqual([]);

    const boom2 = (async function* () {
      yield "q";
      throw new Error("app table unavailable");
    })();
    await expect(
      sweep(t.r, () =>
        rootsFor({
          lineages: [
            { lineage: t.linA, policy: t.polA },
            { lineage: t.linB, policy: t.polB },
          ],
          extra: boom2,
        })
      )
    ).rejects.toThrow(/app table unavailable/);
    expect(await t.survivors(t.linA, "a", t.a)).toHaveLength(12);
    expect(await t.survivors(t.linB, "b", t.b)).toHaveLength(12);
  });

  it("an unreadable seen log fails closed", async () => {
    const t = await twoLineages();
    const events = new InMemoryLineageStore();
    const bad = new SeenLog({
      events,
      content: t.r.content,
      lineage: t.linA,
      keys: new InMemorySeenKeyStore(),
    });
    await events.append("not-a-seen-stream-key", 0, {
      type: "x",
      at: "2026-10-06T00:00:00Z",
      payload: {},
    });
    await expect(
      sweep(t.r, () =>
        rootsFor({ lineages: [{ lineage: t.linA }, { lineage: t.linB }], seenLogs: [bad] })
      )
    ).rejects.toThrow(/could not be read/);
    expect(await t.survivors(t.linB, "b", t.b)).toHaveLength(12);
  });

  it("validates up front: a bad policy, a duplicate lineage, a seen log over an unlisted lineage", async () => {
    const t = await twoLineages();
    const drain = async (o: Parameters<typeof rootsFor>[0]) => {
      for await (const _ of rootsFor(o)) void _;
    };
    await expect(
      drain({ lineages: [{ lineage: t.linA, policy: { keepLast: -1 } }] })
    ).rejects.toThrow(/keepLast/);
    await expect(drain({ lineages: [{ lineage: t.linA }, { lineage: t.linA }] })).rejects.toThrow(
      /twice/
    );
    await expect(drain({ lineages: [{ lineage: t.linB }], seenLogs: [t.log] })).rejects.toThrow(
      /not in `lineages`/
    );
  });
});

describe("SeenLog.record names why a version was refused", () => {
  it("unknown version vs a reclaimed artifact are different codes", async () => {
    const t = await twoLineages();
    const exp = ok(await t.linA.get("a", t.a[5] as string));
    const snapshot = snapshotSeen(exp, {
      viewer: {},
      read: () => ({ found: false, status: "pending" }),
    });
    const unknown = await t.log.record({
      experienceId: "a",
      viewerId: "w",
      snapshot: { ...snapshot, versionHash: "sha256:nope" },
      viewer: {},
    });
    expect(unknown).toMatchObject({ ok: false, refusal: { code: "seen-version-unknown" } });
    const state = ok(await t.linA.state("a"));
    const ref = state.versions.get(t.a[5] as string)?.ref;
    await t.r.content.delete(ref as never);
    const gone = await t.log.record({ experienceId: "a", viewerId: "w", snapshot, viewer: {} });
    expect(gone).toMatchObject({ ok: false, refusal: { code: "seen-artifact-missing" } });
  });
});
