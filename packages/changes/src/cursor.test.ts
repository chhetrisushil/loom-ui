import { describe, expect, it } from "vitest";
import { checkUnreadStoreConformance } from "./conformance";
import { InMemoryUnreadStore, type UnreadStore, markRead, unreadChanges } from "./cursor";
import { manualHarness } from "./harness.test-support";

describe("the unread cursor", () => {
  it("passes the conformance kit", async () => {
    expect(await checkUnreadStoreConformance(() => new InMemoryUnreadStore())).toEqual([]);
  });

  it("the kit fails a store whose cursor can move back, and one that throws", async () => {
    const lines = new Map<string, number>();
    const backwards: UnreadStore = {
      get: async (v, e) => lines.get(`${v}:${e}`) ?? 0,
      advance: async (v, e, to) => {
        lines.set(`${v}:${e}`, to);
        return to;
      },
    };
    const codes = (await checkUnreadStoreConformance(() => backwards)).map((f) => f.code);
    expect(codes).toContain("monotone");
    expect(codes).toContain("collision");
    const throwing: UnreadStore = {
      get: async () => {
        throw new Error("down");
      },
      advance: async () => 0,
    };
    expect(
      (await checkUnreadStoreConformance(() => throwing)).some((f) => f.code === "store-threw")
    ).toBe(true);
  });

  it("unread = events after the viewer's cursor; markRead moves it, per viewer", async () => {
    const h = manualHarness();
    for (let i = 0; i < 3; i++) await h.compose("e");
    const store = new InMemoryUnreadStore();
    const first = await unreadChanges(h.feed, store, "alice", "e");
    expect(first.ok && first.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    const marked = await markRead(h.feed, store, "alice", "e", 2);
    expect(marked).toEqual({ ok: true, cursor: 2 });
    const after = await unreadChanges(h.feed, store, "alice", "e");
    expect(after.ok && after.events.map((e) => e.sequence)).toEqual([3]);
    const bob = await unreadChanges(h.feed, store, "bob", "e");
    expect(bob.ok && bob.events).toHaveLength(3);
    await h.compose("e");
    const next = await unreadChanges(h.feed, store, "alice", "e", { limit: 1 });
    expect(next.ok && next.events.map((e) => e.sequence)).toEqual([3]);
    expect(next.ok && next.more).toBe(true);
  });

  it("an acknowledgement is idempotent, clamped to the tip, and cannot pre-read the future", async () => {
    const h = manualHarness();
    await h.compose("e");
    const store = new InMemoryUnreadStore();
    expect(await markRead(h.feed, store, "v", "e", 999)).toEqual({ ok: true, cursor: 1 });
    expect(await markRead(h.feed, store, "v", "e", 1)).toEqual({ ok: true, cursor: 1 });
    expect(await markRead(h.feed, store, "v", "e", -3)).toEqual({ ok: true, cursor: 1 });
    await h.compose("e");
    const u = await unreadChanges(h.feed, store, "v", "e");
    expect(u.ok && u.events.map((e) => e.sequence)).toEqual([2]);
  });

  it("an unreadable line is a finding and moves no cursor", async () => {
    const h = manualHarness();
    await h.compose("e");
    const events = h.events;
    await events.append("e", 1, { type: "EXPERIENCE_COMPOSED", payload: {}, at: "x" });
    const store = new InMemoryUnreadStore();
    expect((await markRead(h.feed, store, "v", "e", 1)).ok).toBe(false);
    expect((await unreadChanges(h.feed, store, "v", "e")).ok).toBe(false);
    expect(await store.get("v", "e")).toBe(0);
  });
});
