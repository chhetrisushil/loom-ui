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
import { retainedVersions } from "./retention";
import { SeenLog } from "./seen";
import { InMemorySeenKeyStore } from "./seenCrypto";
import { collectSeenGarbage, collectSeenRoots } from "./seenGc";
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

describe("promote / branch during a sweep (ADR 0055 D6 amendment 2: touch before a citation without a put)", () => {
  it("a version promoted while the sweep is between its roots and its erase survives", async () => {
    const r = await rig();
    const h = await line(r.lin, "e", 12);
    beforeFirstListPage(r, async () => {
      ok(
        await r.lin.promote({
          experienceId: "e",
          versionHash: h[2] as string,
          expectedPromoted: null,
          by,
        })
      );
    });
    await sweep(r, () => r.lin.pins({ keepLast: 3 }));
    expect(ok(await r.lin.resolvePromoted("e")).versionHash).toBe(h[2]);
    expect(await open(r.lin, "e", h[1] as string)).toBe(false); // the sweep did run and reclaim
  });

  it("a branch forked from an old version while the sweep runs keeps its source", async () => {
    const r = await rig();
    const h = await line(r.lin, "e", 12);
    beforeFirstListPage(r, async () => {
      ok(
        await r.lin.branch({
          from: { experienceId: "e", versionHash: h[2] as string },
          experienceId: "fork",
          by,
        })
      );
    });
    await sweep(r, () => r.lin.pins({ keepLast: 3 }));
    expect(await open(r.lin, "e", h[2] as string)).toBe(true);
    expect((await r.lin.resolveLatest("fork")).ok).toBe(true);
    expect(await open(r.lin, "e", h[1] as string)).toBe(false);
  });

  it("a fork made BETWEEN pins' two passes is covered by the touch, not by a re-check", async () => {
    const r = await rig();
    const h = await line(r.lin, "e", 12);
    const orig = r.events.listStreams?.bind(r.events);
    if (orig === undefined) throw new Error("no listStreams");
    let calls = 0;
    (r.events as { listStreams: typeof orig }).listStreams = async function* () {
      if (++calls === 2)
        ok(
          await r.lin.branch({
            from: { experienceId: "e", versionHash: h[2] as string },
            experienceId: "fork",
            by,
          })
        );
      yield* orig();
    };
    await sweep(r, () => r.lin.pins({ keepLast: 3 }));
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(await open(r.lin, "e", h[2] as string)).toBe(true);
    expect(await open(r.lin, "e", h[1] as string)).toBe(false);
  });

  it("promote of a version whose artifact is already gone refuses instead of promoting a hole", async () => {
    const r = await rig();
    const h = await line(r.lin, "e", 12);
    await sweep(r, () => r.lin.pins({ keepLast: 3 }));
    const res = await r.lin.promote({
      experienceId: "e",
      versionHash: h[2] as string,
      expectedPromoted: null,
      by,
    });
    expect(res.ok).toBe(false);
  });

  it("a content store without touch is left alone (loom's sweep refuses to erase through one)", async () => {
    const r = await rig();
    const h = await line(r.lin, "e", 3);
    const bare = Object.create(r.content, { touch: { value: undefined } });
    const lin = new Lineage({ events: r.events, content: bare });
    ok(
      await lin.promote({
        experienceId: "e",
        versionHash: h[1] as string,
        expectedPromoted: null,
        by,
      })
    );
  });
});

describe("pins and the seen log sharing one store", () => {
  async function seenRig() {
    const r = await rig();
    const h = await line(r.lin, "e", 12);
    const log = new SeenLog({
      events: new InMemoryLineageStore(),
      content: r.content,
      lineage: r.lin,
      keys: new InMemorySeenKeyStore(),
    });
    const see = async (versionHash: string, value: unknown) => {
      const exp = ok(await r.lin.get("e", versionHash));
      const snapshot = snapshotSeen(exp, {
        viewer: {},
        read: (s) =>
          s.kind === "handle" && s.handle === "h-n3"
            ? { found: true, value, status: "ready" }
            : { found: false, status: "pending" },
      });
      const rec = await log.record({ experienceId: "e", viewerId: "v", snapshot, viewer: {} });
      if (!rec.ok) throw new Error(JSON.stringify(rec.refusal));
    };
    const readBack = async () => {
      const res = await log.read({ experienceId: "e", viewerId: "v", limit: 50 });
      if (!res.ok) throw new Error(JSON.stringify(res.refusal));
      return res.value;
    };
    return { r, h, log, see, readBack };
  }

  it("with the seen roots, a viewer's recorded view of an old version stays fully readable", async () => {
    const { r, h, log, see, readBack } = await seenRig();
    await see(h[3] as string, { n: 42 });
    const extra = await collectSeenRoots(log);
    await sweep(r, () => r.lin.pins({ keepLast: 3 }, extra));
    const read = await readBack();
    expect(read.views).toHaveLength(1);
    expect(read.views[0]?.entries.find((e) => e.state === "seen")?.value).toEqual({ n: 42 });
    expect(read.views[0]?.restricted).toBeFalsy();
    expect(await open(r.lin, "e", h[3] as string)).toBe(true);
    expect(await open(r.lin, "e", h[2] as string)).toBe(false); // everything else was reclaimed
  });

  it("CONTROL: pins alone omit the seen log's roots and the view degrades to nothing", async () => {
    const { r, h, see, readBack } = await seenRig();
    await see(h[3] as string, { n: 42 });
    await sweep(r, () => r.lin.pins({ keepLast: 3 }));
    const read = await readBack();
    expect(read.views[0]?.entries.find((e) => e.state === "seen")?.value).toBeUndefined();
  });

  it("a view recorded while the sweep runs (after the roots were computed) cites a touched artifact", async () => {
    const { r, h, see, readBack, log } = await seenRig();
    const extra = await collectSeenRoots(log); // computed BEFORE the view exists
    beforeFirstListPage(r, () => see(h[3] as string, { n: 7 }));
    await sweep(r, () => r.lin.pins({ keepLast: 3 }, extra));
    const read = await readBack();
    expect(read.views[0]?.entries.find((e) => e.state === "seen")?.value).toEqual({ n: 7 });
  });

  it("collectSeenRoots refuses (never returns an incomplete set) when a live stream is unreadable", async () => {
    const { r } = await seenRig();
    const events = new InMemoryLineageStore();
    const bad = new SeenLog({
      events,
      content: r.content,
      lineage: r.lin,
      keys: new InMemorySeenKeyStore(),
    });
    // a stream whose key does not round-trip the seen-stream key format
    await events.append("not-a-seen-stream-key", 0, {
      type: "x",
      at: "2026-10-06T00:00:00Z",
      payload: {},
    });
    await expect(collectSeenRoots(bad)).rejects.toThrow(/could not be read/);
    await expect(collectSeenRoots(bad, { allowUnreadable: true })).resolves.toBeDefined();
  });

  it("collectSeenGarbage with lineageRetention is ONE collector: old versions go, viewed ones and seen blobs stay", async () => {
    const { r, h, see, readBack, log } = await seenRig();
    await see(h[3] as string, { n: 9 });
    r.clock.now = NOW;
    const res = await collectSeenGarbage(log, {
      graceMs: 1000,
      ownsContentStore: true,
      lineageRetention: { keepLast: 3 },
    });
    expect(res.ok).toBe(true);
    expect(await open(r.lin, "e", h[2] as string)).toBe(false);
    expect(await open(r.lin, "e", h[3] as string)).toBe(true);
    expect((await readBack()).views[0]?.entries.find((e) => e.state === "seen")?.value).toEqual({
      n: 9,
    });
  });

  it("collectSeenGarbage WITHOUT lineageRetention reclaims no lineage version", async () => {
    const { r, h, see, log } = await seenRig();
    await see(h[3] as string, { n: 9 });
    r.clock.now = NOW;
    await collectSeenGarbage(log, { graceMs: 1000, ownsContentStore: true });
    expect(await open(r.lin, "e", h[2] as string)).toBe(true);
  });
});

describe("retention policy validation (a deletion policy never coerces)", () => {
  async function state() {
    const { lin } = await rig();
    await line(lin, "e", 6);
    return ok(await lin.state("e"));
  }
  it("keepLast: Infinity keeps every version", async () => {
    const s = await state();
    const r = retainedVersions(s, { keepLast: Number.POSITIVE_INFINITY });
    expect(r.reclaimable).toEqual([]);
    expect(r.keep.size).toBe(6);
  });
  it.each([
    ["NaN", { keepLast: Number.NaN }],
    ["negative", { keepLast: -1 }],
    ["fractional", { keepLast: 2.5 }],
    ["-Infinity", { keepLast: Number.NEGATIVE_INFINITY }],
    ["a string", { keepLast: "3" as unknown as number }],
    ["an unparseable keepSince", { keepSince: "last tuesday" }],
    ["a non-ISO keepSince (lenient Date.parse reads '1' as 2001)", { keepSince: "1" }],
    ["a non-ISO keepSince date", { keepSince: "Oct 1 2026" }],
    ["a boolean keepSince", { keepSince: true as unknown as string }],
    ["an invalid Date keepSince", { keepSince: new Date(Number.NaN) }],
    ["a NaN epoch keepSince", { keepSince: Number.NaN }],
    ["a non-function keep", { keep: true as unknown as () => boolean }],
  ])("throws on %s", async (_n, policy) => {
    const s = await state();
    expect(() => retainedVersions(s, policy)).toThrow(/RetentionPolicy/);
  });
  it.each([
    ["a date", "2026-10-01"],
    ["a date-time", "2026-10-01T00:00:00Z"],
    ["an offset date-time", "2026-10-01T12:30:15.5+05:30"],
    ["a Date", new Date("2026-10-01")],
    ["epoch ms", 1_790_000_000_000],
  ])("accepts keepSince as %s", async (_n, keepSince) => {
    const s = await state();
    expect(() => retainedVersions(s, { keepSince })).not.toThrow();
  });
  it("pins() throws on a bad policy rather than sweeping with it", async () => {
    const { lin } = await rig();
    await line(lin, "e", 3);
    await expect(async () => {
      for await (const _ of lin.pins({ keepLast: Number.NaN })) void _;
    }).rejects.toThrow(/RetentionPolicy/);
  });
});

describe("content refs that are not artifacts", () => {
  it("a ref carried by an op stays pinned while the version's own artifact is reclaimed", async () => {
    const r = await rig();
    const media = await r.content.put(new TextEncoder().encode("pixels"));
    // v2 inserts a node carrying the media ref, v3 removes it again: only the OPS (and v2's own
    // artifact, which the policy drops) ever mention the ref; no retained artifact holds it.
    const h = await line(r.lin, "e", 8, {
      extra: {
        2: ins(node("img", { src: media })),
        3: { op: { type: "removeNode", nodeId: "img" }, by, at: "2026-10-06T00:00:00Z" },
      },
    });
    await sweep(r, () => r.lin.pins({ keepLast: 2 }));
    expect(await open(r.lin, "e", h[2] as string)).toBe(false); // that version's artifact is reclaimed
    expect(await r.content.get(media)).not.toBeNull(); // the op still cites the media
  });

  it("a ref found only INSIDE a retained artifact (genesis nodes) is pinned too", async () => {
    const r = await rig();
    const media = await r.content.put(new TextEncoder().encode("pixels"));
    const h = await line(r.lin, "e", 8, { root: node("img", { src: media }) });
    await sweep(r, () => r.lin.pins({ keepLast: 2 }));
    expect(await open(r.lin, "e", h[0] as string)).toBe(true); // genesis kept
    expect(await r.content.get(media)).not.toBeNull();
  });
});
