import type { HeadChange } from "@loom-ui/core";
import { eventStoreLineageStore } from "@loom-ui/lineage";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { makeLineage, manualTimer } from "./harness.test-support";
import { eventStoreHeadSignal, pollingHeadSignal } from "./signal";

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("pollingHeadSignal", () => {
  it("reports the head of a non-empty line on watch, then each new head once", async () => {
    const l = makeLineage();
    await l.compose("e");
    const timer = manualTimer();
    const seen: HeadChange[] = [];
    const off = pollingHeadSignal(l.events, { schedule: timer.schedule }).watch(
      "e",
      (c) => void seen.push(c)
    );
    await settle();
    expect(seen.map((c) => c.sequence)).toEqual([1]);
    await timer.fire();
    expect(seen).toHaveLength(1); // nothing moved: no repeat
    await l.compose("e");
    await timer.fire();
    expect(seen.map((c) => c.sequence)).toEqual([1, 2]);
    expect(seen[1]?.head).not.toBe(seen[0]?.head);
    off();
    await l.compose("e");
    await timer.fire();
    expect(seen).toHaveLength(2);
    expect(timer.size()).toBe(0);
  });

  it("says nothing for an empty line, then learns of its first version", async () => {
    const l = makeLineage();
    const timer = manualTimer();
    const seen: HeadChange[] = [];
    pollingHeadSignal(l.events, { schedule: timer.schedule }).watch(
      "new",
      (c) => void seen.push(c)
    );
    await timer.fire();
    expect(seen).toEqual([]);
    await l.compose("new");
    await timer.fire();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.promoted).toBeNull();
  });

  it("a throwing listener and a malformed log are reported but never stop the signal", async () => {
    const l = makeLineage();
    await l.compose("e");
    const timer = manualTimer();
    const errors: unknown[] = [];
    let calls = 0;
    pollingHeadSignal(l.events, {
      schedule: timer.schedule,
      onError: (e) => void errors.push(e),
    }).watch("e", () => {
      calls += 1;
      throw new Error("listener");
    });
    await settle();
    await l.compose("e");
    await timer.fire();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);
    await l.events.append("e", 2, { type: "EXPERIENCE_COMPOSED", payload: {}, at: "x" });
    await timer.fire();
    expect(errors).toHaveLength(3); // the fold finding
  });

  it("watchers are independent", async () => {
    const l = makeLineage();
    await l.compose("a");
    await l.compose("b");
    const timer = manualTimer();
    const sig = pollingHeadSignal(l.events, { schedule: timer.schedule });
    const a: number[] = [];
    const b: number[] = [];
    sig.watch("a", (c) => void a.push(c.sequence));
    sig.watch("b", (c) => void b.push(c.sequence));
    await l.compose("a");
    await timer.fire();
    expect(a).toEqual([1, 2].slice(a.length === 2 ? 0 : 0));
    expect(b).toEqual([1]);
  });
});

describe("eventStoreHeadSignal (push over loom's EventStore)", () => {
  it("wakes when the lineage appends, with no timer", async () => {
    const store = new InMemoryAsyncEventStore();
    const events = eventStoreLineageStore(store);
    const l = makeLineage(events);
    const seen: HeadChange[] = [];
    const off = eventStoreHeadSignal(store, events).watch("e", (c) => void seen.push(c));
    await settle();
    expect(seen).toEqual([]);
    await l.compose("e");
    await settle();
    await l.compose("e");
    await settle();
    expect(seen.map((c) => c.sequence)).toEqual([1, 2]);
    off();
    await l.compose("e");
    await settle();
    expect(seen).toHaveLength(2);
  });

  it("an unsubscribe before the async subscribe resolves still unsubscribes", async () => {
    const store = new InMemoryAsyncEventStore();
    const events = eventStoreLineageStore(store);
    const l = makeLineage(events);
    const seen: HeadChange[] = [];
    const off = eventStoreHeadSignal(store, events).watch("e", (c) => void seen.push(c));
    off();
    await settle();
    await l.compose("e");
    await settle();
    expect(seen).toEqual([]);
  });

  it("a throwing onError never becomes an unhandled rejection when the subscription fails", async () => {
    const store = new InMemoryAsyncEventStore();
    const events = eventStoreLineageStore(store);
    const broken = {
      ...store,
      subscribe: () => Promise.reject(new Error("no push")),
    } as unknown as InMemoryAsyncEventStore;
    const off = eventStoreHeadSignal(broken, events, {
      onError: () => {
        throw new Error("hook");
      },
    }).watch("e", () => {});
    await settle();
    off();
  });

  it("an optional fallback poll catches a head the push missed, and is cancelled on unwatch", async () => {
    const store = new InMemoryAsyncEventStore();
    const events = eventStoreLineageStore(store);
    const l = makeLineage(events);
    const broken = {
      ...store,
      subscribe: () => Promise.reject(new Error("no push")),
    } as unknown as InMemoryAsyncEventStore;
    const timer = manualTimer();
    const seen: HeadChange[] = [];
    const off = eventStoreHeadSignal(broken, events, {
      fallbackIntervalMs: 50,
      schedule: timer.schedule,
    }).watch("e", (c) => void seen.push(c));
    await settle();
    expect(seen).toEqual([]);
    await l.compose("e");
    await timer.fire();
    expect(seen.map((c) => c.sequence)).toEqual([1]);
    off();
    expect(timer.size()).toBe(0);
  });
});
