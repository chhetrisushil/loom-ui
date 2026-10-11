import {
  MAX_SEEN_VALUE_BYTES,
  type Provenance,
  type RecordedOperation,
  type SemanticNode,
  genesis,
  seenToState,
  snapshotSeen,
} from "@loom-ui/core";
import { InMemoryAsyncEventStore, isReservedStream } from "@loom/event-runtime";
import { InMemoryContentStore, contentAddress, encodeValue } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { Lineage, type LineageResult } from "./lineage";
import {
  SEEN_STREAM_PREFIX,
  SeenLog,
  type SeenResult,
  VIEW_RECORDED,
  seenStoreOptions,
} from "./seen";
import { InMemorySeenKeyStore } from "./seenCrypto";
import { InMemoryLineageStore, type LineageStore, eventStoreLineageStore } from "./store";

const user: Provenance = { source: "user" };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const node = (id: string, handle: string, sensitivity?: "secret" | "internal"): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const ins = (n: SemanticNode): RecordedOperation => ({
  op: { type: "insertNode", parentId: "root", node: n },
  by: user,
  at: "2026-10-06T00:00:00Z",
});
function ok<T>(r: LineageResult<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  return r.value;
}
function okSeen<T>(r: SeenResult<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  return r.value;
}
const cleared = { clearance: "secret" as const };
const clock = () => {
  let n = 0;
  return () => new Date(Date.UTC(2026, 9, 6, 0, 0, n++)).toISOString();
};

const backends: Array<[string, () => LineageStore]> = [
  ["in-memory", () => new InMemoryLineageStore()],
  [
    "over loom's EventStore",
    () => eventStoreLineageStore(new InMemoryAsyncEventStore(), seenStoreOptions),
  ],
];

for (const [name, makeStore] of backends) {
  describe(`SeenLog over ${name}`, () => {
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
            ins(node("a", "h")),
            ins(node("s", "hs", "secret")),
            ins(node("i", "hi", "internal")),
          ],
          by: user,
        })
      );
      const events = makeStore();
      const log = new SeenLog({
        keys: new InMemorySeenKeyStore(),
        events,
        content,
        lineage,
        now: clock(),
      });
      const exp = v2.experience;
      const snap = (values: Record<string, unknown>, viewer = cleared) =>
        snapshotSeen(exp, {
          viewer,
          read: (s) =>
            s.kind === "handle" && Object.hasOwn(values, s.handle)
              ? { found: true, value: values[s.handle], status: "ready" }
              : { found: false, status: "pending" },
        });
      return { log, events, content, lineage, exp, snap };
    }

    it("records what a viewer saw and reads it back, values and all, replayable into store shape", async () => {
      const { log, snap } = await setup();
      const r = okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "v1",
          snapshot: snap({ h: { n: 1 }, hs: "top", hi: [1] }),
          viewer: cleared,
        })
      );
      expect(r).toEqual({ recorded: true, sequence: 1 });
      const read = okSeen(await log.read({ experienceId: "e", viewerId: "v1", reader: cleared }));
      expect(read.malformed).toBe(0);
      const v = read.views[0];
      expect(v?.entries.map((e) => [e.source, e.value])).toEqual([
        [{ kind: "handle", handle: "h" }, { n: 1 }],
        [{ kind: "handle", handle: "hi" }, [1]],
        [{ kind: "handle", handle: "hs" }, "top"],
      ]);
      expect({ ...seenToState(v?.entries ?? []).values }).toEqual({
        h: { n: 1 },
        hi: [1],
        hs: "top",
      });
    });

    it("a broadcast audience records and reads as a viewer with no clearance, whoever the principal is", async () => {
      const { log, snap } = await setup();
      const values = { h: 1, hs: "top", hi: 2 };
      // The wall's record: the principal is secret-cleared, the surface is broadcast.
      okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "wall",
          snapshot: snap(values),
          viewer: cleared,
          audience: "broadcast",
        })
      );
      const hs = (r: { views: readonly { entries: readonly { source: unknown }[] }[] }) =>
        JSON.stringify(r.views.map((v) => v.entries.map((e) => e.source)));
      const wall = okSeen(await log.read({ experienceId: "e", viewerId: "wall", reader: cleared }));
      expect(hs(wall)).toContain('"h"');
      expect(hs(wall)).not.toContain('"hs"');
      expect(hs(wall)).not.toContain('"hi"');
      // The personal record of the same principal keeps everything; reading it AS the wall drops it.
      okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "me",
          snapshot: snap(values),
          viewer: cleared,
        })
      );
      const mine = okSeen(await log.read({ experienceId: "e", viewerId: "me", reader: cleared }));
      expect(hs(mine)).toContain('"hs"');
      const mineAsWall = okSeen(
        await log.read({
          experienceId: "e",
          viewerId: "me",
          reader: cleared,
          audience: "broadcast",
        })
      );
      expect(hs(mineAsWall)).not.toContain('"hs"');
      expect(mineAsWall.views[0]?.restricted).toBe(true);
    });

    it("a reader with lower clearance sees only what they may, learns nothing of the rest, and no blob is fetched for it", async () => {
      const { log, content, snap } = await setup();
      okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "v1",
          snapshot: snap({ h: 1, hs: "top", hi: 2 }),
          viewer: cleared,
        })
      );
      const fetched: string[] = [];
      const orig = content.get.bind(content);
      content.get = (async (ref: { __loomContent: string }) => {
        fetched.push(ref.__loomContent);
        return orig(ref as never);
      }) as never;
      const low = okSeen(
        await log.read({ experienceId: "e", viewerId: "v1", reader: { clearance: "internal" } })
      );
      expect(low.views[0]?.entries.map((e) => e.nodeIds)).toEqual([["a"], ["i"]]);
      expect(low.views[0]?.restricted).toBe(true);
      expect(JSON.stringify(low)).not.toContain("top");
      expect(JSON.stringify(low)).not.toContain("hs");
      // U10c: the hidden node's id (`s`) is named nowhere either, only the visible `a` and `i`
      expect(JSON.stringify(low.views.map((v) => v.entries.map((e) => e.nodeIds)))).not.toContain(
        '"s"'
      );
      // the artifact, h and hi: never the secret value's blob
      expect(fetched).toHaveLength(3);
      expect(fetched).not.toContain(contentAddress(encodeValue("top")));
      const none = okSeen(await log.read({ experienceId: "e", viewerId: "v1" }));
      expect(none.views[0]?.entries.map((e) => e.nodeIds)).toEqual([["a"]]);
    });

    it("an identical consecutive view is not re-recorded; a changed value is; views are newest first and `until` bounds", async () => {
      const { log, snap } = await setup();
      const a = okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "v1",
          snapshot: snap({ h: 1 }),
          viewer: cleared,
        })
      );
      const b = okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "v1",
          snapshot: snap({ h: 1 }),
          viewer: cleared,
        })
      );
      expect(b).toEqual({ recorded: false, sequence: a.sequence });
      okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "v1",
          snapshot: snap({ h: 2 }),
          viewer: cleared,
        })
      );
      const all = okSeen(await log.read({ experienceId: "e", viewerId: "v1", reader: cleared }));
      expect(all.views.map((v) => v.entries[0]?.value)).toEqual([2, 1]);
      const asOf = okSeen(
        await log.read({
          experienceId: "e",
          viewerId: "v1",
          reader: cleared,
          until: all.views[1]?.at as string,
        })
      );
      expect(asOf.views.map((v) => v.entries[0]?.value)).toEqual([1]);
    });

    it("viewers are isolated: one viewer's record is not another's", async () => {
      const { log, snap } = await setup();
      okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "v1",
          snapshot: snap({ h: 1 }),
          viewer: cleared,
        })
      );
      const other = okSeen(await log.read({ experienceId: "e", viewerId: "v2", reader: cleared }));
      expect(other.views).toEqual([]);
    });

    it("does not trust the snapshot: a laxer class stamp is raised, a foreign experience or version is refused", async () => {
      const { log, snap } = await setup();
      const s = snap({ h: 1, hs: "top", hi: 2 });
      // a host (or an attacker) re-stamps the secret entry as unclassified
      const forged = {
        ...s,
        entries: s.entries.map((e) =>
          e.class === "secret" ? { ...e, class: "unclassified" as const } : e
        ),
      };
      okSeen(
        await log.record({ experienceId: "e", viewerId: "v1", snapshot: forged, viewer: cleared })
      );
      const low = okSeen(
        await log.read({ experienceId: "e", viewerId: "v1", reader: { clearance: "internal" } })
      );
      expect(JSON.stringify(low)).not.toContain("top");
      const wrong = await log.record({
        experienceId: "e",
        viewerId: "v1",
        snapshot: { ...s, experienceId: "other" },
      });
      expect(wrong).toMatchObject({ ok: false, refusal: { code: "seen-wrong-line" } });
      const unknownVersion = await log.record({
        experienceId: "e",
        viewerId: "v1",
        snapshot: { ...s, versionHash: "sha256:nope" },
      });
      expect(unknownVersion).toMatchObject({
        ok: false,
        refusal: { code: "seen-version-unknown" },
      });
    });

    it("an entry the recording viewer may not see is dropped at record time", async () => {
      const { log, snap } = await setup();
      const s = snap({ h: 1, hs: "top" });
      okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "v1",
          snapshot: s,
          viewer: { clearance: "internal" },
        })
      );
      const all = okSeen(await log.read({ experienceId: "e", viewerId: "v1", reader: cleared }));
      expect(JSON.stringify(all)).not.toContain("top");
      expect(all.views[0]?.restricted).toBe(true);
    });

    it("re-enforces the caps on a hand-built snapshot", async () => {
      const { log, snap } = await setup();
      const s = snap({ h: 1 });
      const huge = {
        ...s,
        entries: s.entries.map((e) => ({
          ...e,
          state: "seen" as const,
          value: "x".repeat(MAX_SEEN_VALUE_BYTES + 1),
        })),
      };
      expect(
        await log.record({ experienceId: "e", viewerId: "v1", snapshot: huge, viewer: cleared })
      ).toMatchObject({
        ok: false,
        refusal: { code: "seen-value-too-large" },
      });
      expect(await log.record({ experienceId: "", viewerId: "v1", snapshot: s })).toMatchObject({
        refusal: { code: "seen-id-invalid" },
      });
      expect(
        await log.record({ experienceId: "e", viewerId: "x".repeat(300), snapshot: s })
      ).toMatchObject({
        refusal: { code: "seen-id-invalid" },
      });
    });

    it("an erased value blob leaves the fact of the view, not the value", async () => {
      const { log, content, snap } = await setup();
      okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "v1",
          snapshot: snap({ h: "pii" }),
          viewer: cleared,
        })
      );
      const orig = content.get.bind(content);
      const erased = contentAddress(encodeValue("pii"));
      content.get = (async (ref: { __loomContent: string }) =>
        ref.__loomContent === erased ? undefined : orig(ref as never)) as never;
      const r = okSeen(await log.read({ experienceId: "e", viewerId: "v1", reader: cleared }));
      expect(r.views[0]?.entries[0]).toMatchObject({ state: "absent" });
      expect(JSON.stringify(r)).not.toContain("pii");
    });

    it("a malformed or forged record is counted, never thrown, and a stripped stamp is withheld", async () => {
      const { log, events, snap } = await setup();
      okSeen(
        await log.record({
          experienceId: "e",
          viewerId: "v1",
          snapshot: snap({ h: 1 }),
          viewer: cleared,
        })
      );
      const key = `${encodeURIComponent("e")}/${encodeURIComponent("v1")}`;
      await events.append(key, (await events.read(key)).length, {
        type: VIEW_RECORDED,
        at: "2026-10-07T00:00:00Z",
        payload: { nonsense: true },
      });
      const tip = await events.read(key);
      const good = tip[0]?.payload as { entries: Array<Record<string, unknown>> };
      const stripped = {
        ...good,
        digest: "other",
        entries: good.entries.map((e) => ({ ...e, class: "" })),
      };
      await events.append(key, tip.length, {
        type: VIEW_RECORDED,
        at: "2026-10-07T00:00:01Z",
        payload: stripped,
      });
      const r = okSeen(await log.read({ experienceId: "e", viewerId: "v1", reader: cleared }));
      expect(r.malformed).toBe(1);
      expect(r.views[0]?.entries).toEqual([]);
      expect(r.views[0]?.restricted).toBe(true);
    });
  });
}

describe("the seen stream is its own reserved namespace", () => {
  it("is reserved (enumerators of real executions skip it) and distinct from the lineage's", async () => {
    const es = new InMemoryAsyncEventStore();
    const store = eventStoreLineageStore(es, seenStoreOptions);
    await store.append("e/v", 0, { type: VIEW_RECORDED, at: "2026-10-06T00:00:00Z", payload: {} });
    expect(isReservedStream(`${SEEN_STREAM_PREFIX}e/v`)).toBe(true);
    expect((await es.read(`${SEEN_STREAM_PREFIX}e/v`)).length).toBe(1);
  });
});
