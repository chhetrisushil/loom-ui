import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { checkLineageStoreConformance } from "./conformance";
import {
  type AppendOutcome,
  InMemoryLineageStore,
  type LineageRecord,
  type LineageStore,
  type StoredLineageRecord,
  eventStoreLineageStore,
} from "./store";

describe("checkLineageStoreConformance", () => {
  it("passes the in-memory store", async () => {
    expect(await checkLineageStoreConformance(() => new InMemoryLineageStore())).toEqual([]);
  });

  it("passes the adapter over loom's EventStore", async () => {
    expect(
      await checkLineageStoreConformance(() =>
        eventStoreLineageStore(new InMemoryAsyncEventStore())
      )
    ).toEqual([]);
  });

  it("passes the adapter over an async store with latency (races are real)", async () => {
    expect(
      await checkLineageStoreConformance(() =>
        eventStoreLineageStore(new InMemoryAsyncEventStore({ latencyMs: 2 }))
      )
    ).toEqual([]);
  });

  // The kit must fail a store that breaks the contract — a kit that cannot fail proves nothing.
  const broken = (patch: (s: InMemoryLineageStore) => LineageStore): LineageStore =>
    patch(new InMemoryLineageStore());

  it("fails a store that silently overwrites on a stale tip", async () => {
    const store = broken((inner) => ({
      read: (id) => inner.read(id),
      // ignores expectedSequence: last writer wins
      append: async (id, _expected, rec) => {
        const tip = (await inner.read(id)).length;
        return inner.append(id, tip, rec);
      },
    }));
    const codes = (await checkLineageStoreConformance(() => store)).map((f) => f.code);
    expect(codes).toContain("stale-append");
    expect(codes).toContain("gap-append");
  });

  it("fails a store that aliases the caller's payload", async () => {
    const lines = new Map<string, StoredLineageRecord[]>();
    const aliasing: LineageStore = {
      async append(id, expected, rec: LineageRecord): Promise<AppendOutcome> {
        const line = lines.get(id) ?? [];
        if (line.length !== expected) return { ok: false, tip: line.length };
        line.push({ ...rec, sequence: line.length + 1 });
        lines.set(id, line);
        return { ok: true, sequence: line.length };
      },
      read: async (id) => lines.get(id) ?? [],
    };
    const codes = (await checkLineageStoreConformance(() => aliasing)).map((f) => f.code);
    expect(codes).toContain("copy-in");
  });

  it("reports a store that throws as a finding, never a throw", async () => {
    const throwing: LineageStore = {
      append: async () => {
        throw new Error("down");
      },
      read: async () => [],
    };
    const findings = await checkLineageStoreConformance(() => throwing);
    expect(findings.some((f) => f.code === "store-threw")).toBe(true);
  });
});
