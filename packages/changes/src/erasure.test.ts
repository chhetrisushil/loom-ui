import {
  LINEAGE_STREAM_PREFIX,
  LineErasedError,
  LineUnreadableError,
  Lineage,
  eventStoreLineageStore,
  registerLineageSensitivePaths,
} from "@loom-ui/lineage";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import {
  EncryptingContentStore,
  EncryptingEventStore,
  InMemoryKeyStore,
} from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { LineageChangeFeed } from "./feed";
import { by, g, ins, node } from "./harness.test-support";
import { pollingHeadSignal } from "./signal";

// A change feed over lineage lines sealed under their owners' keys: an erased line fails closed
// (typed), and a line owned by someone else is unaffected.

const owners: Record<string, string> = { ann: "user:ann", bob: "user:bob" };

async function setup(confirm = true) {
  const keys = new InMemoryKeyStore();
  const subjectOf = (e: { executionId: string }) =>
    owners[e.executionId.slice(LINEAGE_STREAM_PREFIX.length)] ?? e.executionId;
  const raw = new InMemoryAsyncEventStore();
  const sealed = new EncryptingEventStore(raw, keys, { sensitive: {}, subjectOf });
  registerLineageSensitivePaths(sealed);
  const events = eventStoreLineageStore(sealed);
  const confirmErased = async (id: string) =>
    (await keys.wasDestroyed?.(subjectOf({ executionId: `${LINEAGE_STREAM_PREFIX}${id}` }))) ===
    true;
  const lineage = new Lineage({
    events,
    content: new EncryptingContentStore(new InMemoryContentStore(), keys, { subjectOf }),
    ...(confirm && { confirmErased }),
  });
  const errors: unknown[] = [];
  const feed = new LineageChangeFeed({
    lineage,
    events,
    signal: pollingHeadSignal(events, {
      schedule: () => () => undefined,
      onError: (e) => errors.push(e),
    }),
  });
  void feed;
  for (const id of ["ann", "bob"]) {
    const s = await lineage.start(g(id), by);
    if (!s.ok) throw new Error(JSON.stringify(s.refusal));
    const c = await lineage.compose({
      experienceId: id,
      expectedHead: s.value.version.versionHash,
      ops: [ins(node("n1", "h1"))],
      by,
      summary: `${id} summary`,
    });
    if (!c.ok) throw new Error(JSON.stringify(c.refusal));
  }
  return { keys, feed, lineage, events, errors, confirmErased };
}

const setupConfirm = (keys: InMemoryKeyStore) => async (id: string) =>
  (await keys.wasDestroyed?.(owners[id] ?? id)) === true;

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
};

describe("ChangeFeed over an erased line", () => {
  it("read and describe refuse with line-erased; another line's feed is unaffected", async () => {
    const { keys, feed } = await setup();
    const before = await feed.read("ann");
    expect(before.ok && before.events.length).toBe(2);
    const event = before.ok ? before.events[1] : undefined;
    expect(event).toBeDefined();
    const bobBefore = await feed.read("bob");

    await keys.destroy("user:ann");

    const r = await feed.read("ann");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.finding.code).toBe("line-erased");
    const d = await feed.describe(event as NonNullable<typeof event>);
    expect(d.ok).toBe(false);
    expect(!d.ok && d.finding.code).toBe("line-erased");

    const bob = await feed.read("bob");
    expect(bob).toEqual(bobBefore);
    const bobEvent = bob.ok ? bob.events[1] : undefined;
    expect((await feed.describe(bobEvent as NonNullable<typeof bobEvent>)).ok).toBe(true);
  });

  it("a subscription reports the typed finding instead of delivering", async () => {
    const { keys, feed } = await setup();
    await keys.destroy("user:ann");
    const got: unknown[] = [];
    const reported: unknown[] = [];
    const off = feed.subscribe("ann", (e) => void got.push(e), {
      onError: (e) => reported.push(e),
    });
    await new Promise((r) => setTimeout(r, 20));
    off();
    expect(got).toEqual([]);
    expect((reported[0] as { code?: string }).code).toBe("line-erased");
  });

  it("the head signal reports a typed LineErasedError, and a live line still signals", async () => {
    const { keys, events } = await setup();
    await keys.destroy("user:ann");
    const errors: unknown[] = [];
    const heads: unknown[] = [];
    const sig = pollingHeadSignal(events, {
      schedule: () => () => undefined,
      onError: (e) => errors.push(e),
      confirmErased: setupConfirm(keys),
    });
    const offA = sig.watch("ann", (c) => heads.push(c));
    const offB = sig.watch("bob", (c) => heads.push(c));
    await new Promise((r) => setTimeout(r, 20));
    offA();
    offB();
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(LineErasedError);
    expect((errors[0] as LineErasedError).experienceId).toBe("ann");
    expect(heads.length).toBe(1);
  });

  it("a different failure propagates unchanged", async () => {
    const { feed, events } = await setup();
    const boom = new Error("disk");
    const broken = new LineageChangeFeed({
      lineage: (feed as unknown as { lineage: Lineage }).lineage,
      events: { ...events, read: async () => Promise.reject(boom) },
      signal: pollingHeadSignal(events, { schedule: () => () => undefined }),
    });
    await expect(broken.read("ann")).rejects.toBe(boom);
  });
});

describe("unconfirmed vs confirmed", () => {
  it("without a confirmation hook the feed reports line-unreadable, not line-erased", async () => {
    const { keys, feed } = await setup(false);
    await keys.destroy("user:ann");
    const r = await feed.read("ann");
    expect(!r.ok && r.finding.code).toBe("line-unreadable");
  });

  it("a head signal without the hook reports LineUnreadableError, and keeps checking", async () => {
    const { keys, events } = await setup(false);
    await keys.destroy("user:ann");
    const errors: unknown[] = [];
    let tick: (() => void) | undefined;
    const sig = pollingHeadSignal(events, {
      schedule: (fn) => {
        tick = fn;
        return () => undefined;
      },
      onError: (e) => errors.push(e),
    });
    const off = sig.watch("ann", () => undefined);
    await until(() => errors.length === 1);
    tick?.();
    tick?.();
    await until(() => errors.length >= 2);
    off();
    expect(errors.every((e) => e instanceof LineUnreadableError)).toBe(true);
  });

  it("a confirmed-erased line's signal reports once and goes terminal (timer cancelled)", async () => {
    const { keys, events } = await setup();
    await keys.destroy("user:ann");
    const errors: unknown[] = [];
    let cancelled = false;
    let tick: (() => void) | undefined;
    const sig = pollingHeadSignal(events, {
      schedule: (fn) => {
        tick = fn;
        return () => {
          cancelled = true;
        };
      },
      onError: (e) => errors.push(e),
      confirmErased: setupConfirm(keys),
    });
    const off = sig.watch("ann", () => undefined);
    await until(() => errors.length === 1 && cancelled);
    tick?.();
    tick?.();
    await new Promise((r) => setTimeout(r, 20));
    off();
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(LineErasedError);
  });

  it("a subscription on a confirmed-erased line reports once and stops retrying; unconfirmed retries", async () => {
    for (const confirm of [true, false]) {
      const { keys, feed } = await setup(confirm);
      await keys.destroy("user:ann");
      const reported: unknown[] = [];
      const off = feed.subscribe("ann", () => undefined, {
        onError: (e) => reported.push(e),
        retry: { baseMs: 1, maxMs: 2 },
      });
      if (confirm) {
        await until(() => reported.length === 1);
        await new Promise((r) => setTimeout(r, 60));
        expect(reported.length).toBe(1);
        expect((reported[0] as { code?: string }).code).toBe("line-erased");
      } else {
        await until(() => reported.length >= 3);
        expect((reported[0] as { code?: string }).code).toBe("line-unreadable");
      }
      off();
    }
  });
});
