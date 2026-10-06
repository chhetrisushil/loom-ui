import {
  MAX_SEEN_VALUE_BYTES,
  type Provenance,
  type RecordedOperation,
  type SemanticNode,
  genesis,
  snapshotSeen,
} from "@loom-ui/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  type ContentStore,
  InMemoryContentStore,
  contentAddress,
  encodeValue,
} from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { Lineage, type LineageResult } from "./lineage";
import {
  SeenLog,
  type SeenResult,
  VIEWER_ERASED,
  VIEWS_RETAINED,
  VIEW_RECORDED,
  seenStoreOptions,
  seenStreamKey,
} from "./seen";
import {
  InMemorySeenKeyStore,
  MAX_SEALED_ADDRESS_CHARS,
  type SeenKeyStore,
  checkSeenKeyStoreConformance,
  sealRef,
  seenKeySubject,
} from "./seenCrypto";
import { collectSeenGarbage } from "./seenGc";
import {
  InMemoryLineageStore,
  type LineageStore,
  type StoredLineageRecord,
  eventStoreLineageStore,
} from "./store";

const user: Provenance = { source: "user" };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
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
const ins = (n: SemanticNode): RecordedOperation => ({
  op: { type: "insertNode", parentId: "root", node: n },
  by: user,
  at: "2026-10-06T00:00:00Z",
});
const ok = <T>(r: LineageResult<T> | SeenResult<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  return r.value;
};

async function rig(
  opts: {
    maxViews?: number;
    maxAgeMs?: number;
    maxSkewMs?: number;
    keys?: SeenKeyStore;
    seen?: LineageStore;
  } = {}
) {
  const clock = { t: 1_000_000 };
  const content = new InMemoryContentStore({ now: () => clock.t });
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
      ops: [ins(node("a", "h"))],
      by: user,
    })
  );
  const keys = opts.keys ?? new InMemorySeenKeyStore();
  const es = new InMemoryAsyncEventStore();
  const events = opts.seen ?? eventStoreLineageStore(es, seenStoreOptions);
  const log = new SeenLog({
    keys,
    events,
    content,
    lineage,
    now: () => new Date(clock.t).toISOString(),
    ...((opts.maxViews !== undefined || opts.maxAgeMs !== undefined) && {
      retention: {
        ...(opts.maxViews !== undefined && { maxViews: opts.maxViews }),
        ...(opts.maxAgeMs !== undefined && { maxAgeMs: opts.maxAgeMs }),
        maxSkewMs: opts.maxSkewMs ?? 0,
      },
    }),
  });
  const snap = (value: unknown) =>
    snapshotSeen(v2.experience, {
      viewer: {},
      read: (s) =>
        s.kind === "handle" && s.handle === "h"
          ? { found: true, value, status: "ready" }
          : { found: false, status: "pending" },
    });
  const see = async (viewerId: string, value: unknown) => {
    clock.t += 1000;
    return ok(await log.record({ experienceId: "e", viewerId, snapshot: snap(value), viewer: {} }));
  };
  const values = async (viewerId: string) => {
    const r = ok(await log.read({ experienceId: "e", viewerId, limit: 500 }));
    return r.views.map((v) => v.entries.find((e) => e.state === "seen")?.value);
  };
  const raw = async (viewerId: string) => events.read(seenStreamKey("e", viewerId));
  const addr = (value: unknown) => contentAddress(encodeValue(value));
  const gc = (graceMs = 0) => {
    clock.t += 100_000; // everything written so far is older than any test grace
    return collectSeenGarbage(log, { graceMs, ownsContentStore: true });
  };
  return { clock, content, lineage, keys, es, events, log, see, values, raw, addr, gc, snap };
}
const has = async (content: ContentStore, address: string) =>
  (await content.get({ __loomContent: address })) !== null;

describe("the SeenKeyStore conformance kit", () => {
  it("passes the reference store", async () => {
    expect(await checkSeenKeyStoreConformance(() => new InMemorySeenKeyStore())).toEqual([]);
  });
  it("fails a store that resurrects a destroyed key", async () => {
    const keys = new Map<string, Uint8Array>();
    const bad: SeenKeyStore = {
      getOrCreate: async (s) => {
        const k = keys.get(s) ?? new Uint8Array(32).fill(keys.size + 1);
        keys.set(s, k);
        return k;
      },
      get: async (s) => keys.get(s) ?? null,
      destroy: async (s) => void keys.delete(s),
    };
    const f = await checkSeenKeyStoreConformance(() => bad);
    expect(f.map((x) => x.code)).toContain("destroy-resurrect");
  });
});

describe("erasure: destroying a viewer's key", () => {
  it("the stream never holds a plaintext address, and after erasure the viewer yields nothing", async () => {
    const r = await rig();
    await r.see("v1", "secret-42");
    const hex = r.addr("secret-42").replace(/^sha256:/, "");
    const before = JSON.stringify(await r.raw("v1"));
    expect(before).not.toContain(hex);
    expect(before).not.toContain("__loomContent");
    expect(await r.values("v1")).toEqual(["secret-42"]);

    ok(await r.log.eraseViewer({ experienceId: "e", viewerId: "v1" }));
    expect(await r.keys.get(seenKeySubject(seenStreamKey("e", "v1")))).toBeNull();
    const read = ok(await r.log.read({ experienceId: "e", viewerId: "v1" }));
    expect(read).toEqual({ views: [], malformed: 0, erased: true });
    const after = await r.raw("v1");
    expect(JSON.stringify(after)).not.toContain(hex);
    expect(after[after.length - 1]?.type).toBe(VIEWER_ERASED);
    // and nothing more is recorded for them
    r.clock.t += 1;
    const again = await r.log.record({
      experienceId: "e",
      viewerId: "v1",
      snapshot: r.snap("x"),
      viewer: {},
    });
    expect(again).toMatchObject({ ok: false, refusal: { code: "seen-viewer-erased" } });
  });

  it("the manifest digest is keyed: the same manifest under two keys digests differently (no confirmation oracle)", async () => {
    const one = await rig();
    const two = await rig();
    await one.see("a", "low-entropy");
    await two.see("a", "low-entropy");
    const dig = async (r: typeof one) =>
      (await r.raw("a"))[0]?.payload as { digest: string; versionHash: string };
    const [d1, d2] = [await dig(one), await dig(two)];
    expect(d1.versionHash).toBe(d2.versionHash); // same manifest...
    expect(d1.digest).not.toBe(d2.digest); // ...different key, different digest
    expect(d1.digest).toMatch(/^hmac:/);
  });

  it("is idempotent, completes after a crash between key and tombstone, and does not touch other viewers", async () => {
    const r = await rig();
    await r.see("v1", "a");
    await r.see("v2", "a");
    // crash simulation: the key is gone, the tombstone was never written
    await r.keys.destroy(seenKeySubject(seenStreamKey("e", "v1")));
    expect(ok(await r.log.read({ experienceId: "e", viewerId: "v1" })).erased).toBe(true);
    ok(await r.log.eraseViewer({ experienceId: "e", viewerId: "v1" }));
    ok(await r.log.eraseViewer({ experienceId: "e", viewerId: "v1" }));
    expect((await r.raw("v1")).filter((x) => x.type === VIEWER_ERASED)).toHaveLength(1);
    expect(await r.values("v2")).toEqual(["a"]);
  });

  it("a record with no key fails closed: refused, nothing written", async () => {
    const failing: SeenKeyStore = {
      getOrCreate: async () => {
        throw new Error("kms down");
      },
      get: async () => {
        throw new Error("kms down");
      },
      destroy: async () => {},
    };
    const r = await rig({ keys: failing });
    r.clock.t += 1;
    expect(
      await r.log.record({ experienceId: "e", viewerId: "v", snapshot: r.snap(1), viewer: {} })
    ).toMatchObject({ ok: false, refusal: { code: "seen-key-unavailable" } });
    expect(await r.raw("v")).toEqual([]);
    expect(await r.log.read({ experienceId: "e", viewerId: "v" })).toMatchObject({ ok: true });
  });
});

describe("refs are bound to (experience, viewer, record, entry)", () => {
  it("a sealed ref moved to another record of the same viewer is withheld, never read", async () => {
    const r = await rig();
    await r.see("v", "first");
    await r.see("v", "second");
    const [one, two] = await r.raw("v");
    // forge a third record that carries record 1's ciphertext
    const forged = structuredClone(two?.payload) as {
      entries: Array<{ sealed: string }>;
      digest: string;
    };
    forged.entries[0]!.sealed = (one?.payload as typeof forged).entries[0]!.sealed;
    forged.digest = "forged";
    await r.events.append(seenStreamKey("e", "v"), 2, {
      type: VIEW_RECORDED,
      at: new Date(r.clock.t + 1).toISOString(),
      payload: forged,
    });
    const read = ok(await r.log.read({ experienceId: "e", viewerId: "v" }));
    expect(read.views[0]?.entries).toEqual([]); // the transplanted ref was not honoured
    expect(read.views[0]?.restricted).toBe(true);
    expect(read.views.slice(1).map((v) => v.entries[0]?.value)).toEqual(["second", "first"]);
  });

  it("a ref moved to ANOTHER VIEWER is withheld even if both share one key", async () => {
    const shared = new Uint8Array(32).fill(7);
    const oneKey: SeenKeyStore = {
      getOrCreate: async () => shared,
      get: async () => shared,
      destroy: async () => {},
    };
    const r = await rig({ keys: oneKey });
    await r.see("a", "alice-only");
    const [fromA] = await r.raw("a");
    // the SAME slot (sequence 1, entry 0) of another viewer's stream, under the same key: only the
    // viewer id in the associated data tells these apart
    const forged = structuredClone(fromA?.payload) as {
      viewerId: string;
      entries: Array<{ sealed: string }>;
    };
    forged.viewerId = "b";
    await r.events.append(seenStreamKey("e", "b"), 0, {
      type: VIEW_RECORDED,
      at: new Date(r.clock.t + 1).toISOString(),
      payload: forged,
    });
    const read = ok(await r.log.read({ experienceId: "e", viewerId: "b" }));
    expect(read.views[0]?.entries).toEqual([]);
    expect(read.views[0]?.restricted).toBe(true);
  });

  it("a tampered ciphertext is withheld", async () => {
    const r = await rig();
    await r.see("v", "x");
    const rec = (await r.raw("v"))[0];
    const p = structuredClone(rec?.payload) as {
      entries: Array<{ sealed: string }>;
      digest: string;
    };
    const s = p.entries[0]!.sealed;
    p.entries[0]!.sealed = `${s.slice(0, -4)}${s.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    p.digest = "t";
    await r.events.append(seenStoreKey(), 1, {
      type: VIEW_RECORDED,
      at: "2026-10-07T00:00:00Z",
      payload: p,
    });
    function seenStoreKey() {
      return seenStreamKey("e", "v");
    }
    const read = ok(await r.log.read({ experienceId: "e", viewerId: "v" }));
    expect(read.views[0]?.entries).toEqual([]);
    expect(read.views[0]?.restricted).toBe(true);
  });
});

describe("collectSeenGarbage (mark and sweep)", () => {
  it("sweeps an erased viewer's unique blob; another viewer's copy and the lineage's blobs survive", async () => {
    const r = await rig();
    await r.see("gone", "unique");
    await r.see("gone", "shared");
    await r.see("stays", "shared");
    const lineageBlobs = r.content.size - 2; // the artifacts the lineage wrote
    expect(lineageBlobs).toBeGreaterThan(0);
    ok(await r.log.eraseViewer({ experienceId: "e", viewerId: "gone" }));
    const res = await r.gc();
    expect(res.ok && res.report.deleted).toBe(1);
    expect(await has(r.content, r.addr("unique"))).toBe(false);
    expect(await has(r.content, r.addr("shared"))).toBe(true);
    expect(await r.values("stays")).toEqual(["shared"]);
    expect(r.content.size).toBe(lineageBlobs + 1);
  });

  it("a blob younger than the grace period survives; once past it, an unrooted blob is swept", async () => {
    const r = await rig();
    const orphan = await r.content.put(encodeValue("manifest-not-appended-yet"));
    const res = await collectSeenGarbage(r.log, { graceMs: 60_000, ownsContentStore: true });
    expect(res.ok && res.report).toMatchObject({ deleted: 0 });
    expect(await has(r.content, orphan.__loomContent)).toBe(true);
    r.clock.t += 61_000;
    const later = await collectSeenGarbage(r.log, { graceMs: 60_000, ownsContentStore: true });
    expect(later.ok && later.report.deleted).toBe(1);
    expect(await has(r.content, orphan.__loomContent)).toBe(false);
  });

  it("a crash between the blob put and the manifest append leaks until the sweep past grace, and never loses a live value", async () => {
    const inner = new InMemoryLineageStore();
    let crash = false;
    const crashing: LineageStore & { streamPrefix: string } = {
      streamPrefix: "__loom_ui_seen__:",
      read: (k) => inner.read(k),
      readTail: (k, n) => inner.readTail(k, n),
      readAfter: (k, a, l) => inner.readAfter(k, a, l),
      listStreams: () => inner.listStreams(),
      append: async (k, e, rec) => {
        if (crash) throw new Error("process died");
        return inner.append(k, e, rec);
      },
    };
    const r = await rig({ seen: crashing });
    crash = true;
    await expect(r.see("v1", "half-written")).rejects.toThrow("process died");
    crash = false;
    expect(await has(r.content, r.addr("half-written"))).toBe(true); // leaked, not lost
    // within grace: kept (the retry may be about to cite it)
    const early = await collectSeenGarbage(r.log, { graceMs: 1_000_000, ownsContentStore: true });
    expect(early.ok && early.report.deleted).toBe(0);
    // another viewer cites the same value in the meantime: it is a root now
    await r.see("v2", "half-written");
    const late = await r.gc();
    expect(late.ok && late.report.deleted).toBe(0);
    expect(await r.values("v2")).toEqual(["half-written"]);
    // had nobody cited it, the next pass past grace reclaims it
    ok(await r.log.eraseViewer({ experienceId: "e", viewerId: "v2" }));
    const reclaimed = await r.gc();
    expect(reclaimed.ok && reclaimed.report.deleted).toBe(1);
  });

  it("is idempotent: a rerun deletes nothing more and finds the same roots", async () => {
    const r = await rig();
    await r.see("a", "x");
    await r.see("b", "y");
    ok(await r.log.eraseViewer({ experienceId: "e", viewerId: "b" }));
    const first = await r.gc();
    const second = await r.gc();
    expect(first.ok && first.report.deleted).toBe(1);
    expect(second.ok && second.report).toMatchObject({
      deleted: 0,
      marked: first.ok ? first.report.marked : -1,
    });
    expect(await r.values("a")).toEqual(["x"]);
  });

  it("fails closed: nothing is deleted when the root set cannot be established", async () => {
    const r = await rig();
    await r.see("a", "x");
    const orphan = await r.content.put(encodeValue("orphan"));
    r.clock.t += 100_000;
    // unattested ownership
    expect(await collectSeenGarbage(r.log, { graceMs: 0 } as never)).toMatchObject({
      refusal: { code: "gc-ownership-unasserted" },
    });
    // a key store that fails mid-mark
    const real = r.keys.get.bind(r.keys);
    r.keys.get = async () => {
      throw new Error("kms down");
    };
    expect(await collectSeenGarbage(r.log, { graceMs: 0, ownsContentStore: true })).toMatchObject({
      refusal: { code: "gc-roots-unavailable" },
    });
    r.keys.get = real;
    expect(await has(r.content, orphan.__loomContent)).toBe(true);
    // a content store without touch times
    const bare: ContentStore = {
      put: (b) => r.content.put(b),
      get: (x) => r.content.get(x),
      delete: (x) => r.content.delete(x),
    };
    const log2 = new SeenLog({
      keys: r.keys,
      events: eventStoreLineageStore(r.es, seenStoreOptions),
      content: bare,
      lineage: r.lineage,
    });
    expect(await collectSeenGarbage(log2, { graceMs: 0, ownsContentStore: true })).toMatchObject({
      refusal: { code: "gc-content-store-unsupported" },
    });
    // a stream store that cannot enumerate
    const noList = new SeenLog({
      keys: r.keys,
      events: {
        streamPrefix: "__loom_ui_seen__:",
        read: (k: string) => r.events.read(k),
        append: (k: string, e: number, rec: Parameters<LineageStore["append"]>[2]) =>
          r.events.append(k, e, rec),
      } as LineageStore,
      content: r.content,
      lineage: r.lineage,
    });
    expect(await collectSeenGarbage(noList, { graceMs: 0, ownsContentStore: true })).toMatchObject({
      refusal: { code: "gc-roots-unavailable" },
    });
    expect(await has(r.content, orphan.__loomContent)).toBe(true);
    // extraRoots keep what the host names
    const kept = await collectSeenGarbage(r.log, {
      graceMs: 0,
      ownsContentStore: true,
      extraRoots: () => [orphan.__loomContent],
    });
    expect(kept.ok && kept.report.deleted).toBe(0);
  });
});

describe("retention: roll-off, never refusal", () => {
  it("a new view always records; the oldest roll off; the collector reclaims their blobs", async () => {
    const r = await rig({ maxViews: 3 });
    for (let i = 1; i <= 8; i++) await r.see("v", `val-${i}`);
    expect(await r.values("v")).toEqual(["val-8", "val-7", "val-6"]);
    const raw = await r.raw("v");
    expect(raw.some((x) => x.type === VIEWS_RETAINED)).toBe(true);
    const res = await r.gc();
    expect(res.ok && res.report.deleted).toBe(5);
    for (const i of [1, 2, 3, 4, 5]) expect(await has(r.content, r.addr(`val-${i}`))).toBe(false);
    for (const i of [6, 7, 8]) expect(await has(r.content, r.addr(`val-${i}`))).toBe(true);
    expect(await r.values("v")).toEqual(["val-8", "val-7", "val-6"]);
  });

  it("the window applies at read and in the collector even when no watermark was ever written", async () => {
    const inner = new InMemoryLineageStore();
    const noWatermark: LineageStore & { streamPrefix: string } = {
      streamPrefix: "__loom_ui_seen__:",
      read: (k) => inner.read(k),
      readTail: (k, n) => inner.readTail(k, n),
      readAfter: (k, a, l) => inner.readAfter(k, a, l),
      listStreams: () => inner.listStreams(),
      append: async (k, e, rec) =>
        rec.type === VIEWS_RETAINED ? { ok: false, tip: e } : inner.append(k, e, rec),
    };
    const r = await rig({ seen: noWatermark, maxViews: 3 });
    for (let i = 1; i <= 8; i++) await r.see("v", `val-${i}`);
    expect((await r.raw("v")).some((x) => x.type === VIEWS_RETAINED)).toBe(false);
    expect(await r.values("v")).toEqual(["val-8", "val-7", "val-6"]);
    const res = await r.gc();
    expect(res.ok && res.report.deleted).toBe(5);
  });

  it("an identical consecutive view is still deduped; an age limit rolls off old views at read and in GC", async () => {
    const r = await rig({ maxAgeMs: 10_000 });
    await r.see("v", "old");
    expect(await r.see("v", "old")).toMatchObject({ recorded: false });
    r.clock.t += 20_000;
    await r.see("v", "new");
    expect(await r.values("v")).toEqual(["new"]);
    r.clock.t += 1000; // (r.gc() would age "new" out too: the window applies at the collector's clock)
    const res = await collectSeenGarbage(r.log, { graceMs: 500, ownsContentStore: true });
    expect(res.ok && res.report.deleted).toBe(1);
    expect(await has(r.content, r.addr("old"))).toBe(false);
    expect(await has(r.content, r.addr("new"))).toBe(true);
  });

  it("record and read never read the whole log (cost is the window, not the age of the log)", async () => {
    const inner = new InMemoryLineageStore();
    let fullReads = 0;
    const counting: LineageStore & { streamPrefix: string } = {
      streamPrefix: "__loom_ui_seen__:",
      read: (k) => {
        fullReads++;
        return inner.read(k);
      },
      readTail: (k, n) => inner.readTail(k, n),
      readAfter: (k, a, l) => inner.readAfter(k, a, l),
      listStreams: () => inner.listStreams(),
      append: (k, e, rec) => inner.append(k, e, rec),
    };
    const r = await rig({ seen: counting, maxViews: 5 });
    for (let i = 0; i < 30; i++) await r.see("v", i);
    await r.values("v");
    expect(fullReads).toBe(0);
    expect(await r.values("v")).toEqual([29, 28, 27, 26, 25]);
  });

  it("rejects a nonsensical policy at construction", async () => {
    const mk = (retention: { maxViews?: number; maxAgeMs?: number }) => () =>
      new SeenLog({
        keys: new InMemorySeenKeyStore(),
        events: new InMemoryLineageStore(),
        content: new InMemoryContentStore(),
        lineage: new Lineage({
          events: new InMemoryLineageStore(),
          content: new InMemoryContentStore(),
        }),
        retention,
      });
    expect(mk({ maxViews: 0 })).toThrow(/maxViews/);
    expect(mk({ maxAgeMs: -1 })).toThrow(/maxAgeMs/);
  });
});

describe("sharesStreamsWith compares prefixes both ways and refuses an unreadable one", () => {
  const lineageOver = (prefix: string) =>
    new Lineage({
      events: eventStoreLineageStore(new InMemoryAsyncEventStore(), {
        streamPrefix: prefix,
      }),
      content: new InMemoryContentStore(),
    });
  const store = (prefix: string) =>
    eventStoreLineageStore(new InMemoryAsyncEventStore(), { streamPrefix: prefix });

  it("a prefix that contains the other (either way) collides; a disjoint one does not", () => {
    const l = lineageOver("__loom_ui_x:y:");
    expect(l.sharesStreamsWith(store("__loom_ui_x:y:z:"))).toBe(true); // the other extends ours
    expect(l.sharesStreamsWith(store("__loom_ui_x:"))).toBe(true); // ours extends the other
    expect(l.sharesStreamsWith(store("__loom_ui_other:"))).toBe(false);
  });

  it("a decorator that hides its streamPrefix is refused", () => {
    const inner = store("__loom_ui_seen__:");
    const hidden: LineageStore = {
      append: (a, b, c) => inner.append(a, b, c),
      read: (a) => inner.read(a),
    };
    expect(lineageOver("__loom_ui_lineage__:").sharesStreamsWith(hidden)).toBe(true);
    expect(
      () =>
        new SeenLog({
          keys: new InMemorySeenKeyStore(),
          events: hidden,
          content: new InMemoryContentStore(),
          lineage: lineageOver("__loom_ui_lineage__:"),
        })
    ).toThrow(/streamPrefix/);
  });
});

// ── Fix round 3 ───────────────────────────────────────────────────────────────────────────
describe("P2-1: the collector fails closed on anything it cannot read", () => {
  const gcNow = (r: Awaited<ReturnType<typeof rig>>, allowUnreadable?: boolean) => {
    r.clock.t += 100_000;
    return collectSeenGarbage(r.log, {
      graceMs: 0,
      ownsContentStore: true,
      ...(allowUnreadable !== undefined && { allowUnreadable }),
    });
  };

  it("a newer writer's record shape (rolling upgrade) refuses the sweep; nothing is deleted", async () => {
    const inner = eventStoreLineageStore(new InMemoryAsyncEventStore(), seenStoreOptions);
    const flag = { newer: false };
    const mut = (rs: readonly StoredLineageRecord[]) =>
      flag.newer
        ? rs.map((x) =>
            x.type === VIEW_RECORDED
              ? {
                  ...x,
                  payload: {
                    ...(x.payload as { entries: object[] }),
                    entries: (x.payload as { entries: object[] }).entries.map((e) => ({
                      ...e,
                      state: "seen-v2",
                    })),
                  },
                }
              : x
          )
        : rs;
    const wrap: LineageStore & { streamPrefix: string } = {
      streamPrefix: inner.streamPrefix as string,
      append: (...a) => inner.append(...a),
      read: async (k) => mut(await inner.read(k)),
      readTail: async (k, n) =>
        mut(await (inner.readTail as NonNullable<typeof inner.readTail>)(k, n)),
      readAfter: async (k, a, l) =>
        mut(await (inner.readAfter as NonNullable<typeof inner.readAfter>)(k, a, l)),
      listStreams: () => (inner.listStreams as NonNullable<typeof inner.listStreams>)(),
    };
    const r = await rig({ seen: wrap });
    await r.see("v", "only-copy");
    flag.newer = true;
    const res = await gcNow(r);
    expect(res).toMatchObject({ ok: false, refusal: { code: "gc-unreadable-record" } });
    expect(await has(r.content, r.addr("only-copy"))).toBe(true);
    flag.newer = false;
    expect(await r.values("v")).toEqual(["only-copy"]);
    // the explicit opt-in is "sweep what they cite"
    flag.newer = true;
    const forced = await gcNow(r, true);
    expect(forced.ok && forced.report.unreadable.records).toBe(1);
    expect(forced.ok && forced.report.unreadable.examples.records).toEqual(["e/v@1"]);
    expect(await has(r.content, r.addr("only-copy"))).toBe(false);
  });

  it("a sealed ref that does not open under a PRESENT key refuses; an ABSENT key (erased) does not", async () => {
    const r = await rig();
    await r.see("v", "kept");
    await r.see("gone", "shred-me");
    const rec = (await r.raw("v"))[0];
    const p = structuredClone(rec?.payload) as {
      entries: Array<{ sealed: string }>;
      digest: string;
    };
    const s0 = p.entries[0]?.sealed as string;
    p.entries[0]!.sealed = `${s0.slice(0, -4)}${s0.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    p.digest = "t";
    await r.events.append(seenStreamKey("e", "v"), 1, {
      type: VIEW_RECORDED,
      at: new Date(r.clock.t + 1).toISOString(),
      payload: p,
    });
    ok(await r.log.eraseViewer({ experienceId: "e", viewerId: "gone" }));
    const res = await gcNow(r);
    expect(res).toMatchObject({ ok: false, refusal: { code: "gc-unreadable-record" } });
    expect(await has(r.content, r.addr("shred-me"))).toBe(true); // refused before ANY delete
    expect(await has(r.content, r.addr("kept"))).toBe(true);
    // without the tampered record the erased viewer's blob IS swept (the shred path is not "unreadable")
    const clean = await rig();
    await clean.see("gone", "shred-me");
    ok(await clean.log.eraseViewer({ experienceId: "e", viewerId: "gone" }));
    const ok2 = await gcNow(clean);
    expect(ok2.ok && ok2.report.deleted).toBe(1);
  });

  it("a stream key that does not round-trip refuses", async () => {
    const r = await rig();
    await r.see("v", "kept");
    await r.events.append("no-slash-here", 0, {
      type: VIEW_RECORDED,
      at: new Date(r.clock.t).toISOString(),
      payload: {},
    });
    const res = await gcNow(r);
    expect(res).toMatchObject({ ok: false, refusal: { code: "gc-unreadable-record" } });
    expect(res.ok === false && res.refusal.message).toMatch(/1 stream/);
    expect(res.ok === false && res.refusal.message).toContain("streams [no-slash-here]");
    expect(await has(r.content, r.addr("kept"))).toBe(true);
  });
});

describe("P2-2: a seen entry's size is sealed; the stream reveals no value", () => {
  it("no plaintext `bytes` on a seen entry, constant sealed length, size still read back", async () => {
    const r = await rig();
    const vals: unknown[] = [true, false, null, "x", "y".repeat(300), { a: [1, 2, 3] }];
    for (const [i, v] of vals.entries()) await r.see(`v${i}`, v);
    const lens = new Set<number>();
    for (const [i] of vals.entries()) {
      const e = ((await r.raw(`v${i}`))[0]?.payload as { entries: Array<Record<string, unknown>> })
        .entries[0] as Record<string, unknown>;
      expect(e.bytes).toBeUndefined();
      lens.add((e.sealed as string).length);
    }
    expect(lens.size).toBe(1);
    const read = ok(await r.log.read({ experienceId: "e", viewerId: "v4" }));
    expect(read.views[0]?.entries[0]).toMatchObject({
      state: "seen",
      bytes: encodeValue("y".repeat(300)).length,
    });
  });

  it("an oversize entry keeps its recorded size (a size class, documented)", async () => {
    const r = await rig();
    await r.see("v", "z".repeat(MAX_SEEN_VALUE_BYTES + 10));
    const e = ((await r.raw("v"))[0]?.payload as { entries: Array<Record<string, unknown>> })
      .entries[0] as Record<string, unknown>;
    expect(e.state).toBe("oversize");
    expect(typeof e.bytes).toBe("number");
    expect(e.sealed).toBeUndefined();
  });

  it("an oversize entry stores a power-of-two size class: two different sizes in one bucket are identical", async () => {
    const r = await rig();
    await r.see("a", "z".repeat(MAX_SEEN_VALUE_BYTES + 10));
    await r.see("b", "z".repeat(MAX_SEEN_VALUE_BYTES + 5000));
    const sz = async (v: string) =>
      (
        ((await r.raw(v))[0]?.payload as { entries: Array<Record<string, unknown>> })
          .entries[0] as Record<string, unknown>
      ).bytes;
    expect(await sz("a")).toBe(await sz("b"));
    expect(await sz("a")).toBe(2 ** Math.ceil(Math.log2(MAX_SEEN_VALUE_BYTES + 10)));
  });
});

describe("P3: destroy, caches and atomic create", () => {
  it("the kit fails a store whose cache outlives destroy", async () => {
    const live = new Map<string, Uint8Array>();
    const cache = new Map<string, Uint8Array>();
    const bad: SeenKeyStore = {
      getOrCreate: async (s) => {
        const k = live.get(s) ?? new Uint8Array(32).fill(live.size + 1);
        live.set(s, k);
        return k;
      },
      get: async (s) => {
        const hit = cache.get(s) ?? live.get(s);
        if (hit !== undefined) cache.set(s, hit);
        return hit ?? null;
      },
      destroy: async (s) => void live.delete(s),
    };
    const f = await checkSeenKeyStoreConformance(() => bad);
    expect(f.map((x) => x.code)).toContain("destroy-cache");
  });

  it("the kit fails a non-atomic create-if-absent", async () => {
    const m = new Map<string, Uint8Array>();
    let n = 0;
    const bad: SeenKeyStore = {
      getOrCreate: async (s) => {
        if (m.has(s)) return m.get(s) as Uint8Array;
        await Promise.resolve(); // read-then-write across an await
        const k = new Uint8Array(32).fill(++n);
        m.set(s, k);
        return k;
      },
      get: async (s) => m.get(s) ?? null,
      destroy: async (s) => void m.delete(s),
    };
    const f = await checkSeenKeyStoreConformance(() => bad);
    expect(f.map((x) => x.code)).toContain("create-race");
  });

  it("the reference store returns copies and zeroizes on destroy", async () => {
    const store = new InMemorySeenKeyStore();
    const k = await store.getOrCreate("s");
    const before = Buffer.from(k);
    k.fill(0); // a caller scribbling on its copy
    expect(Buffer.from((await store.get("s")) as Uint8Array)).toEqual(before);
    const internal = (store as unknown as { keys: Map<string, Uint8Array> }).keys.get("s");
    await store.destroy("s");
    expect(internal?.every((b) => b === 0)).toBe(true);
  });

  it("record re-reads the key before appending: an erasure that lands mid-record is not followed by a sealed record", async () => {
    const base = new InMemorySeenKeyStore();
    let hook: (() => Promise<void>) | null = null;
    const keys: SeenKeyStore = {
      getOrCreate: async (s) => {
        const k = await base.getOrCreate(s);
        const h = hook;
        hook = null;
        if (h) await h();
        return k;
      },
      get: (s) => base.get(s),
      destroy: (s) => base.destroy(s),
    };
    const r = await rig({ keys });
    await r.see("v", "first");
    hook = () => base.destroy(seenKeySubject(seenStreamKey("e", "v")));
    r.clock.t += 1000;
    const res = await r.log.record({
      experienceId: "e",
      viewerId: "v",
      snapshot: r.snap("second"),
      viewer: {},
    });
    expect(res).toMatchObject({ ok: false, refusal: { code: "seen-viewer-erased" } });
    expect((await r.raw("v")).map((x) => x.type)).toEqual([VIEW_RECORDED]);
  });
});

describe("P3: clock skew cannot roll off or sweep what is inside the window by true time", () => {
  const mk = async () => {
    const r = await rig({ maxAgeMs: 10_000, maxViews: 10, maxSkewMs: 60_000 });
    const fastClock = { skew: 30_000 };
    const fast = new SeenLog({
      keys: r.keys,
      events: r.events,
      content: r.content,
      lineage: r.lineage,
      now: () => new Date(r.clock.t + fastClock.skew).toISOString(),
      retention: { maxAgeMs: 10_000, maxViews: 10, maxSkewMs: 60_000 },
    });
    return { r, fast };
  };

  it("a future-dated writer does not raise the persisted watermark past young views", async () => {
    const { r, fast } = await mk();
    await r.see("v", "a1");
    await r.see("v", "a2");
    r.clock.t += 1000;
    ok(await fast.record({ experienceId: "e", viewerId: "v", snapshot: r.snap("f"), viewer: {} }));
    expect((await r.raw("v")).map((x) => x.type)).not.toContain(VIEWS_RETAINED);
    expect(await r.values("v")).toEqual(["f", "a2", "a1"]);
  });

  it("the collector keeps views inside maxAgeMs + maxSkewMs even by a fast clock", async () => {
    const { r, fast } = await mk();
    await r.see("v", "a1");
    r.clock.t += 5000; // a1 is 5s old by true time: inside maxAgeMs
    const res = await collectSeenGarbage(fast, { graceMs: 0, ownsContentStore: true });
    expect(res.ok && res.report.deleted).toBe(0);
    expect(await has(r.content, r.addr("a1"))).toBe(true);
    expect(await r.values("v")).toEqual(["a1"]);
  });

  it("a genuinely old view (older than maxAgeMs + maxSkewMs) is still rolled off", async () => {
    const { r } = await mk();
    await r.see("v", "old");
    r.clock.t += 80_000;
    await r.see("v", "new");
    expect((await r.raw("v")).map((x) => x.type)).toContain(VIEWS_RETAINED);
    expect(await r.values("v")).toEqual(["new"]);
  });
});

describe("P3: a malformed tip does not reset the floor", () => {
  it("the floor is carried from the last well-formed record", async () => {
    const inner = new InMemoryLineageStore();
    const afters: number[] = [];
    const spy: LineageStore & { streamPrefix: string } = {
      streamPrefix: "__loom_ui_seen__:",
      read: (k) => inner.read(k),
      readTail: (k, n) => inner.readTail(k, n),
      readAfter: (k, a, l) => {
        afters.push(a);
        return inner.readAfter(k, a, l);
      },
      listStreams: () => inner.listStreams(),
      append: (k, e, rec) => inner.append(k, e, rec),
    };
    const r = await rig({ seen: spy, maxViews: 3 });
    for (let i = 0; i < 20; i++) await r.see("v", i);
    const recs = await r.raw("v");
    const floor = Math.max(...recs.map((x) => (x.payload as { floor?: number }).floor ?? 0));
    expect(floor).toBeGreaterThan(0);
    await inner.append(seenStreamKey("e", "v"), recs[recs.length - 1]?.sequence as number, {
      type: VIEW_RECORDED,
      at: new Date(r.clock.t).toISOString(),
      payload: { garbage: true },
    });
    afters.length = 0;
    await r.values("v");
    expect(afters).toEqual([floor]);
  });
});

describe("eraseViewerEverywhere", () => {
  const seed = async (r: Awaited<ReturnType<typeof rig>>, exp: string, viewer: string) =>
    r.events.append(seenStreamKey(exp, viewer), 0, {
      type: VIEW_RECORDED,
      at: new Date(r.clock.t).toISOString(),
      payload: {},
    });

  it("erases the viewer in every experience, leaves others, and is idempotent", async () => {
    const r = await rig();
    await r.see("v", "mine");
    await r.see("w", "theirs");
    await seed(r, "e2", "v");
    await seed(r, "e/3", "v");
    await seed(r, "e2", "w");
    const res = ok(await r.log.eraseViewerEverywhere({ viewerId: "v" }));
    expect(res.complete).toBe(true);
    expect(res.results.map((x) => x.experienceId).sort()).toEqual(["e", "e/3", "e2"]);
    expect(ok(await r.log.read({ experienceId: "e", viewerId: "v" })).erased).toBe(true);
    expect(await r.keys.get(seenKeySubject(seenStreamKey("e", "v")))).toBeNull();
    expect(await r.values("w")).toEqual(["theirs"]);
    expect((await r.raw("w")).map((x) => x.type)).toEqual([VIEW_RECORDED]);
    expect(ok(await r.log.eraseViewerEverywhere({ viewerId: "v" })).complete).toBe(true);
    expect(ok(await r.log.eraseViewerEverywhere({ viewerId: "nobody" })).results).toEqual([]);
  });

  it("is resumable: a failed key destroy is reported per experience and a rerun completes it", async () => {
    const base = new InMemorySeenKeyStore();
    let failFor: string | undefined = seenKeySubject(seenStreamKey("e2", "v"));
    const keys: SeenKeyStore = {
      getOrCreate: (s) => base.getOrCreate(s),
      get: (s) => base.get(s),
      destroy: async (s) => {
        if (s === failFor) throw new Error("kms down");
        return base.destroy(s);
      },
    };
    const r = await rig({ keys });
    await r.see("v", "mine");
    await seed(r, "e2", "v");
    const first = ok(await r.log.eraseViewerEverywhere({ viewerId: "v" }));
    expect(first.complete).toBe(false);
    expect(first.results.find((x) => x.experienceId === "e2")).toMatchObject({
      erased: false,
      refusal: { code: "seen-key-unavailable" },
    });
    expect(first.results.find((x) => x.experienceId === "e")?.erased).toBe(true);
    failFor = undefined;
    expect(ok(await r.log.eraseViewerEverywhere({ viewerId: "v" })).complete).toBe(true);
  });

  it("refuses when the store cannot enumerate its streams", async () => {
    const r = await rig();
    const noList = new SeenLog({
      keys: r.keys,
      events: {
        streamPrefix: "__loom_ui_seen__:",
        read: (k: string) => r.events.read(k),
        append: (k: string, e: number, rec: Parameters<LineageStore["append"]>[2]) =>
          r.events.append(k, e, rec),
      } as LineageStore,
      content: r.content,
      lineage: r.lineage,
    });
    expect(await noList.eraseViewerEverywhere({ viewerId: "v" })).toMatchObject({
      ok: false,
      refusal: { code: "seen-enumeration-unavailable" },
    });
  });
});

describe("sealRef fails closed on an over-long address", () => {
  it("refuses an address that would round the padding up to the next block", () => {
    const enc = Buffer.alloc(32, 1);
    const aad = Buffer.from("a");
    expect(() =>
      sealRef(enc, aad, { __loomContent: "x".repeat(MAX_SEALED_ADDRESS_CHARS + 1) }, 1)
    ).toThrow(/refused/);
    const a = sealRef(enc, aad, { __loomContent: "a".repeat(64) }, 1);
    const b = sealRef(
      enc,
      aad,
      { __loomContent: "b".repeat(MAX_SEALED_ADDRESS_CHARS) },
      999_999_999_999
    );
    expect(a.length).toBe(b.length);
  });
});
