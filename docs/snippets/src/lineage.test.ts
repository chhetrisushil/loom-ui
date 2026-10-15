// The code of docs/guides/lineage-and-changes.md (see mirror.test-support.ts).
import { describe, expect, it, vi } from "vitest";
import { boardExperience } from "./fixtures.test-support";
import { expectDocMirrors } from "./mirror.test-support";
// #region imports
import {
  InMemoryUnreadStore,
  LineageChangeFeed,
  markRead,
  pollingHeadSignal,
  unreadChanges,
} from "@loom-ui/changes";
import type { Provenance } from "@loom-ui/core";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { InMemoryContentStore } from "@loom/plugin-content";
// #endregion imports

describe("docs/guides/lineage-and-changes.md", () => {
  it("keeps a head, refuses a stale author, reverts and branches as new versions", async () => {
    // #region setup
    const events = new InMemoryLineageStore(); // production: eventStoreLineageStore(loomEventStore)
    const lineage = new Lineage({ events, content: new InMemoryContentStore() });
    const by: Provenance = { source: "user" };

    const started = await lineage.start(boardExperience(), by);
    if (!started.ok) throw new Error(started.refusal.kind);
    const v1 = started.value.version.versionHash;
    // #endregion setup

    // #region compose
    const edit = (unit: string) => ({
      op: { type: "setProps" as const, nodeId: "p99", patch: { unit } },
      by,
      at: new Date().toISOString(),
    });

    const second = await lineage.compose({
      experienceId: "checkout-latency",
      expectedHead: v1, // the head this author composed against
      ops: [edit("s")],
      by,
      summary: "Show seconds", // untrusted model or author text: bounded, never an instruction
    });
    if (!second.ok) throw new Error(second.refusal.kind);
    const v2 = second.value.version.versionHash;

    // A second author who still holds v1 loses the race, with a typed result, not an overwrite.
    const late = await lineage.compose({
      experienceId: "checkout-latency",
      expectedHead: v1,
      ops: [edit("us")],
      by,
    });
    if (!late.ok && late.refusal.kind === "head-moved") {
      late.refusal.actualHead; // v2: re-read, re-author, try again
    }
    // #endregion compose
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.refusal).toMatchObject({ kind: "head-moved", actualHead: v2 });

    // #region revert
    // Nothing is rewritten: each of these appends a NEW version.
    const reverted = await lineage.revert({
      experienceId: "checkout-latency",
      expectedHead: v2,
      to: v1,
      by,
    });
    if (!reverted.ok) throw new Error(reverted.refusal.kind);

    const undone = await lineage.undo({
      experienceId: "checkout-latency",
      expectedHead: reverted.value.version.versionHash, // undoing a revert is a redo
      by,
    });

    const fork = await lineage.branch({
      from: { experienceId: "checkout-latency", versionHash: v2 },
      experienceId: "checkout-latency-experiment",
      by,
    });

    // Rebuild every line from its log and compare addresses. [] means consistent.
    const problems = await lineage.verify("checkout-latency");
    // #endregion revert
    expect(undone.ok && fork.ok).toBe(true);
    expect(problems).toEqual([]);
    const versions = await lineage.versions("checkout-latency");
    expect(versions.ok && versions.value.map((v) => v.kind)).toEqual([
      "composed", // the first version of a line is recorded as composed, with no ops
      "composed",
      "reverted",
      "reverted",
    ]);
  });

  it("delivers a change feed, describes it per viewer and tracks unread", async () => {
    const events = new InMemoryLineageStore();
    const lineage = new Lineage({ events, content: new InMemoryContentStore() });
    const by: Provenance = { source: "user" };
    const g = await lineage.start(boardExperience(), by);
    if (!g.ok) throw new Error("start");

    // #region feed
    const feed = new LineageChangeFeed({
      lineage,
      events, // the same store the Lineage writes to
      signal: pollingHeadSignal(events, { intervalMs: 50 }),
    });

    const seen: string[] = [];
    const unsubscribe = feed.subscribe(
      "checkout-latency",
      async (event) => {
        // The event says THAT something changed, never WHAT. Describing is per viewer.
        const d = await feed.describe(event, { viewer: { clearance: "internal" } });
        if (d.ok && d.description.attention !== "none") seen.push(event.id);
      },
      { after: 0 } // a saved cursor: the last sequence you handled
    );
    // #endregion feed
    await lineage.compose({
      experienceId: "checkout-latency",
      expectedHead: g.value.version.versionHash,
      ops: [
        {
          op: { type: "setProps", nodeId: "p99", patch: { unit: "s" } },
          by,
          at: new Date().toISOString(),
        },
      ],
      by,
    });
    // The genesis is attention-level information too (a first node appeared).
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    unsubscribe();

    // #region unread
    const unread = new InMemoryUnreadStore();
    const before = await unreadChanges(feed, unread, "ana", "checkout-latency");
    // before.ok && before.events.length === 2: ids "checkout-latency#1" and "#2"
    if (before.ok && before.events.length > 0) {
      const last = before.events[before.events.length - 1];
      if (last) await markRead(feed, unread, "ana", "checkout-latency", last.sequence);
    }
    // #endregion unread
    expect(before.ok && before.events.map((e) => e.id)).toEqual([
      "checkout-latency#1",
      "checkout-latency#2",
    ]);
    const after = await unreadChanges(feed, unread, "ana", "checkout-latency");
    expect(after.ok && after.events).toEqual([]);
  });

  it("keeps docs/guides/lineage-and-changes.md in step with this file", () => {
    expectDocMirrors("docs/guides/lineage-and-changes.md", "lineage.test.ts");
  });
});
