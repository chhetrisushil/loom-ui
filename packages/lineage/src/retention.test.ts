import { type Provenance, type RecordedOperation, type SemanticNode, genesis } from "@loom-ui/core";
import { InMemoryContentStore, sweepUnpinnedContent } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { Lineage, type LineageResult } from "./lineage";
import { DEFAULT_KEEP_LAST, retainedVersions } from "./retention";
import { InMemoryLineageStore } from "./store";

// U17: version retention. Every version stores a whole artifact, and a scanned lineage stream pins
// every one of them for ever. `Lineage.pins(policy)` is the replacement root set: the artifacts the
// policy keeps. Proved against loom's REAL `sweepUnpinnedContent`, not a model of it.

const by: Provenance = { source: "user" };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const node = (id: string): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle: `h-${id}`, priority: "P1" },
});
const ins = (id: string): RecordedOperation => ({
  op: { type: "insertNode", parentId: "root", node: node(id) },
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

/** A line of `n` versions: v1 is the genesis, each later one inserts a node. Returns the hashes oldest first. */
async function line(lin: Lineage, id: string, n: number): Promise<string[]> {
  const hashes = [
    ok(
      await lin.start(
        genesis({ experienceId: id, intent: { objective: "o", source: "user" }, meta }),
        by
      )
    ).version.versionHash,
  ];
  for (let i = 1; i < n; i++) {
    const head = hashes.at(-1) as string;
    hashes.push(
      ok(await lin.compose({ experienceId: id, expectedHead: head, ops: [ins(`n${i}`)], by }))
        .version.versionHash
    );
  }
  return hashes;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("retainedVersions (pure)", () => {
  it("keeps the newest N, the head, the promoted version and the genesis; the rest is reclaimable", async () => {
    const { lin } = await rig();
    const h = await line(lin, "e", 12);
    ok(
      await lin.promote({
        experienceId: "e",
        versionHash: h[4] as string,
        expectedPromoted: null,
        by,
      })
    );
    const state = ok(await lin.state("e"));
    const r = retainedVersions(state, { keepLast: 3 });
    expect([...r.keep].sort()).toEqual([h[0], h[4], h[9], h[10], h[11]].sort());
    expect(r.reclaimable).toEqual([h[1], h[2], h[3], h[5], h[6], h[7], h[8]]);
  });

  it("the head is kept even when keepLast is 0, and an empty line keeps nothing", async () => {
    const { lin } = await rig();
    const h = await line(lin, "e", 4);
    const r = retainedVersions(ok(await lin.state("e")), { keepLast: 0, keepGenesis: false });
    expect([...r.keep]).toEqual([h[3]]);
    expect(retainedVersions(ok(await lin.state("none")), {}).keep.size).toBe(0);
  });

  it("keepSince, a host predicate and a fork's source widen the keep set; the default keeps 20", async () => {
    const { lin } = await rig();
    const h = await line(lin, "e", 30);
    const state = ok(await lin.state("e"));
    expect(retainedVersions(state).keep.size).toBe(DEFAULT_KEEP_LAST + 1); // newest 20 + the genesis
    const viaPredicate = retainedVersions(state, { keepLast: 1, keep: (v) => v.sequence === 7 });
    expect(viaPredicate.keep.has(h[6] as string)).toBe(true);
    const forked = retainedVersions(state, { keepLast: 1 }, new Set([h[10] as string, "unknown"]));
    expect(forked.keep.has(h[10] as string)).toBe(true);
    expect(forked.keep.has("unknown")).toBe(false);
    const since = retainedVersions(state, { keepLast: 1, keepSince: "2100-01-01T00:00:00Z" });
    expect(since.keep.size).toBe(2); // the future cutoff keeps nothing extra: head + genesis
  });
});

describe("Lineage.pins against loom's real sweepUnpinnedContent", () => {
  async function sweep(
    r: Awaited<ReturnType<typeof rig>>,
    pins: AsyncIterable<string>,
    dry = false
  ) {
    r.clock.now = NOW;
    return sweepUnpinnedContent({
      eventStores: [], // the lineage's streams are NOT scanned: `pins` replaces them
      contentStore: r.content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
      roots: () => pins,
      reclaimOrphans: { completeScan: true },
      dryRun: dry,
    });
  }
  const present = async (
    r: Awaited<ReturnType<typeof rig>>,
    lin: Lineage,
    id: string,
    hash: string
  ) => (await lin.get(id, hash)).ok;

  it("reclaims the artifacts of versions the policy dropped and keeps the rest readable", async () => {
    const r = await rig();
    const h = await line(r.lin, "e", 12);
    ok(
      await r.lin.promote({
        experienceId: "e",
        versionHash: h[4] as string,
        expectedPromoted: null,
        by,
      })
    );
    const policy = { keepLast: 3 };
    const dry = await sweep(r, r.lin.pins(policy), true);
    expect(dry.orphansReclaimed).toHaveLength(7); // reported, not deleted
    expect(await present(r, r.lin, "e", h[1] as string)).toBe(true);

    const swept = await sweep(r, r.lin.pins(policy));
    expect(swept.orphansReclaimed).toHaveLength(7);
    for (const i of [1, 2, 3, 5, 6, 7, 8])
      expect(await present(r, r.lin, "e", h[i] as string)).toBe(false);
    for (const i of [0, 4, 9, 10, 11])
      expect(await present(r, r.lin, "e", h[i] as string)).toBe(true);
    expect(ok(await r.lin.resolveLatest("e")).versionHash).toBe(h[11]);
    expect(ok(await r.lin.resolvePromoted("e")).versionHash).toBe(h[4]);
  });

  it("a version another line was forked from is kept however old, and the fork stays openable", async () => {
    const r = await rig();
    const h = await line(r.lin, "src", 10);
    ok(
      await r.lin.branch({
        from: { experienceId: "src", versionHash: h[2] as string },
        experienceId: "fork",
        by,
      })
    );
    await sweep(r, r.lin.pins({ keepLast: 1, keepGenesis: false }));
    expect(await present(r, r.lin, "src", h[2] as string)).toBe(true); // the fork's source
    expect(await present(r, r.lin, "src", h[3] as string)).toBe(false);
    expect((await r.lin.resolveLatest("fork")).ok).toBe(true);
  });

  it("CONTROL: scanning the lineage's streams instead pins every version, which is the problem pins solves", async () => {
    const r = await rig();
    const h = await line(r.lin, "e", 12);
    const all: string[] = [];
    await r.lin.forEachContentRef((a) => all.push(a));
    r.clock.now = NOW;
    const res = await sweepUnpinnedContent({
      eventStores: [],
      contentStore: r.content,
      pinnedEventTypes: [],
      olderThanMs: TTL,
      now: NOW,
      roots: async function* () {
        yield* all;
      },
      reclaimOrphans: { completeScan: true },
    });
    expect(res.orphansReclaimed).toEqual([]); // nothing is ever freed
    expect(await present(r, r.lin, "e", h[1] as string)).toBe(true);
  });

  it("yields each address once, and refuses (never guesses) over a store that cannot enumerate its lines", async () => {
    const r = await rig();
    await line(r.lin, "e", 5);
    const got = await collect(r.lin.pins({ keepLast: 100 }));
    expect(new Set(got).size).toBe(got.length);
    expect(got).toHaveLength(5);
    const blind = new Lineage({
      events: { ...r.events, listStreams: undefined } as never,
      content: r.content,
    });
    await expect(collect(blind.pins())).rejects.toThrow(/cannot enumerate/);
  });
});
