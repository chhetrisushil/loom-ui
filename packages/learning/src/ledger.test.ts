import { eventStoreLineageStore } from "@loom-ui/lineage";
import { UNIT_KEY } from "@loom-ui/planner";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import {
  InMemoryVoteLog,
  type Vote,
  VoteLedger,
  type VoteLedgerOptions,
  type VoteLog,
  foldVotes,
  unitAlias,
} from "./ledger";

const KEY = "0123456789abcdef0123456789abcdef";
const REF = { executionId: "e1", decisionId: "plan-variant:a" };
const mk = (log: VoteLog = new InMemoryVoteLog(), extra: Partial<VoteLedgerOptions> = {}) =>
  new VoteLedger({ log, pseudonymKey: KEY, clock: () => 1_000, outcomes: ["approved"], ...extra });
const vote = (v: string, b: string, s: Vote["s"]): Vote => ({ v, b, s });

describe("U11 VoteLedger fold: one bounded vote per viewer", () => {
  it("repeating, reordering or multiplying signals changes nothing a replay would not", async () => {
    const l = mk();
    const once = [
      { k: "x", n: "n:a" },
      { k: "c", n: "n:a", a: "click", c: 3 },
    ] as const;
    await l.recordVote(REF, vote("v1", "b1", [...once]));
    const base = (await l.fold(REF)).summary;
    // 200 more batches carrying the same facts, each with a fresh id, add the same viewer's same state
    for (let i = 0; i < 200; i++)
      await l.recordVote(
        REF,
        vote("v1", `r${i}`, [...once, { k: "c", n: "n:a", a: "click", c: 255 }])
      );
    const after = (await l.fold(REF)).summary;
    expect(after.viewers).toBe(1);
    expect(after.engagementSum).toBe(1);
    expect(base.engagementSum).toBe(1);
  });

  it("a replayed OLD batch cannot override a newer rating", async () => {
    const l = mk();
    await l.recordVote(
      REF,
      vote("v1", "b1", [
        { k: "x", n: "n:a" },
        { k: "f", r: 5, n: "n:a" },
      ])
    );
    await l.recordVote(REF, vote("v1", "b2", [{ k: "f", r: 1, n: "n:a" }]));
    await l.recordVote(REF, vote("v1", "b1", [{ k: "f", r: 5, n: "n:a" }])); // the replay
    const s = (await l.fold(REF)).summary;
    expect(s.feedbackViewers).toBe(1);
    expect(s.feedbackSum).toBe(0); // rating 1 -> 0, the LATEST
  });

  it("an engagement or rating without the same viewer's exposure counts for nothing; a viewer with no exposure is not a viewer", async () => {
    const l = mk();
    await l.recordVote(
      REF,
      vote("v1", "b1", [
        { k: "c", n: "n:a", a: "click", c: 1 },
        { k: "f", r: 5, n: "n:a" },
        { k: "f", r: 5 },
        { k: "o", name: "approved", ok: true },
      ])
    );
    expect((await l.fold(REF)).summary).toMatchObject({
      viewers: 0,
      feedbackViewers: 0,
      outcomeViewers: 0,
    });
  });

  it("outcome names are the host's: 63 invented names add nothing, a registered one counts once per viewer", async () => {
    const l = mk();
    const names = Array.from({ length: 63 }, (_, i) => ({
      k: "o" as const,
      name: `n${i}`,
      ok: true,
    }));
    await l.recordVote(
      REF,
      vote("v1", "b1", [{ k: "x", n: "n:a" }, ...names, { k: "o", name: "approved", ok: false }])
    );
    const s = (await l.fold(REF)).summary;
    expect(s.outcomeViewers).toBe(1);
    expect(s.outcomeSum).toBe(0); // only "approved" (false) counted
  });

  it("bounds: nodes per viewer, viewers per decision, batches per viewer", async () => {
    const l = mk(new InMemoryVoteLog(), {
      maxNodesPerViewer: 3,
      maxViewers: 2,
      maxBatchesPerViewer: 2,
    });
    await l.recordVote(
      REF,
      vote(
        "v1",
        "b1",
        Array.from({ length: 10 }, (_, i) => ({ k: "x" as const, n: `n:${i}` }))
      )
    );
    await l.recordVote(REF, vote("v2", "b1", [{ k: "x", n: "n:a" }]));
    await l.recordVote(REF, vote("v3", "b1", [{ k: "x", n: "n:a" }]));
    for (const b of ["b2", "b3", "b4"])
      await l.recordVote(REF, vote("v2", b, [{ k: "f", r: 5, n: "n:a" }]));
    const s = (await l.fold(REF)).summary;
    expect(s.viewers).toBe(2);
    expect(s.overflowViewers).toBe(1);
    expect(s.feedbackViewers).toBe(1); // v2's b2 counted (2nd batch), b3 and b4 over the batch cap
    const f = foldVotes((await new InMemoryVoteLog().read("x")) as never, l.spec);
    expect(f.summary.viewers).toBe(0);
  });

  it("refuses past the per-decision entry cap (never forgets silently)", async () => {
    const l = mk(new InMemoryVoteLog(), { maxEntriesPerDecision: 3 });
    const r = [];
    for (let i = 0; i < 5; i++)
      r.push(await l.recordVote(REF, vote(`v${i}`, "b", [{ k: "x", n: "n:a" }])));
    expect(r).toEqual(["ok", "ok", "ok", "capacity", "capacity"]);
    expect((await l.fold(REF)).summary.viewers).toBe(3);
  });
});

const backends: Array<[string, () => VoteLog]> = [
  ["in-memory", () => new InMemoryVoteLog()],
  [
    "loom EventStore (durable seam)",
    () =>
      eventStoreLineageStore(new InMemoryAsyncEventStore(), {
        streamPrefix: "__loom_ui_votes__:",
        workflowId: "loom-ui.votes",
      }),
  ],
];
for (const [name, make] of backends) {
  describe(`U11 settlement is CAS-safe across replicas (${name})`, () => {
    it("two replicas ingesting and closing concurrently agree on one frozen summary; later votes are ignored by both", async () => {
      const log = make();
      const a = mk(log);
      const b = mk(log); // a second replica over the SAME log
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          (i % 2 ? a : b).recordVote(
            REF,
            vote(`v${i}`, "b1", [
              { k: "x", n: "n:a" },
              { k: "c", n: "n:a", a: "click", c: 1 },
            ])
          )
        )
      );
      const [fa, fb] = await Promise.all([a.close(REF, "end"), b.close(REF, "end")]);
      expect(fa.summary).toEqual(fb.summary);
      expect(fa.summary.viewers).toBe(12);
      expect(fa.claim?.sequence).toBe(fb.claim?.sequence);
      // a vote that lands after the claim is invisible to every reader
      const l = new VoteLedger({
        log,
        pseudonymKey: KEY,
        clock: () => 2_000,
        outcomes: ["approved"],
      });
      await l.recordVote(REF, vote("late", "b1", [{ k: "x", n: "n:a" }]));
      expect((await a.fold(REF)).summary.viewers).toBe(12);
      expect((await l.fold(REF)).summary.viewers).toBe(12);
      expect(await a.recordVote(REF, vote("late2", "b1", [{ k: "x", n: "n:a" }]))).toBe("closed");
    });
  });
}

describe("U11 pseudonyms", () => {
  it("viewerKey is keyed, tenant-scoped and carries no raw id", () => {
    const l = mk();
    const k1 = l.viewerKey("acme", "alice");
    expect(k1).not.toContain("alice");
    expect(l.viewerKey("evil", "alice")).not.toBe(k1);
    expect(
      mk(undefined, { pseudonymKey: "another-secret-of-16-bytes!" }).viewerKey("acme", "alice")
    ).not.toBe(k1);
    expect(() => mk(undefined, { pseudonymKey: "short" })).toThrow(/16 bytes/);
  });
  it("unitAlias is an opaque planner unit token derived from a secret", () => {
    const u = unitAlias(KEY, "alice@example.com");
    expect(UNIT_KEY.test(u)).toBe(true);
    expect(u).not.toContain("alice");
    expect(unitAlias(KEY, "alice@example.com")).toBe(u);
    expect(unitAlias(KEY, "bob@example.com")).not.toBe(u);
    expect(() => unitAlias("short", "x")).toThrow();
  });
});
