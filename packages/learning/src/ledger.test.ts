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

  it("each bound alone is enforced by the fold (so a log written by another replica is bounded too)", () => {
    const rec = (
      seq: number,
      v: Vote
    ): { type: string; payload: unknown; at: string; sequence: number } => ({
      type: "VOTE",
      payload: v,
      at: "t",
      sequence: seq,
    });
    const spec = { outcomes: [], maxNodesPerViewer: 3, maxViewers: 100, maxBatchesPerViewer: 2 };
    // nodes: 6 exposed, only the first 3 are tracked -> 3 exposed nodes, 0 engaged of them
    const six = Array.from({ length: 6 }, (_, i) => ({ k: "x" as const, n: `n:${i}` }));
    const withClick = [...six, { k: "c" as const, n: "n:5", a: "click" as const, c: 1 }];
    const nodes = foldVotes([rec(1, vote("v", "b", withClick))], spec);
    expect(nodes.summary.engagementSum).toBe(0); // n:5 was beyond the cap: its click is nothing
    const nodesOk = foldVotes(
      [rec(1, vote("v", "b", [...six, { k: "c", n: "n:2", a: "click", c: 1 }]))],
      spec
    );
    expect(nodesOk.summary.engagementSum).toBeCloseTo(1 / 3);
    // batches: the 3rd batch of a viewer is ignored
    const batches = foldVotes(
      [
        rec(1, vote("v", "b1", X)),
        rec(2, vote("v", "b2", X)),
        rec(3, vote("v", "b3", [{ k: "f", r: 5 }])),
      ],
      spec
    );
    expect(batches.summary.feedbackViewers).toBe(0);
    const two = foldVotes(
      [rec(1, vote("v", "b1", X)), rec(2, vote("v", "b2", [{ k: "f", r: 5 }]))],
      spec
    );
    expect(two.summary.feedbackViewers).toBe(1);
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

const X: Vote["s"] = [{ k: "x", n: "n:a" }];
const durable = (): VoteLog =>
  eventStoreLineageStore(new InMemoryAsyncEventStore(), {
    streamPrefix: "__loom_ui_votes__:",
    workflowId: "loom-ui.votes",
  });

for (const [name, make] of backends) {
  describe(`U11 concurrent appends are serialised, not retried to death (${name})`, () => {
    for (const n of [17, 64, 200]) {
      it(`${n} concurrent votes on one decision are ALL accepted`, async () => {
        const l = mk(make());
        const r = await Promise.all(
          Array.from({ length: n }, (_, i) => l.recordVote(REF, vote(`v${i}`, "b", X)))
        );
        expect(r.filter((x) => x === "ok")).toHaveLength(n);
        expect((await l.fold(REF)).summary.viewers).toBe(n);
      });
    }

    it("a CLAIM racing 100 votes settles; every vote reported ok precedes it, none after it reports ok", async () => {
      const l = mk(make());
      const ops: Promise<unknown>[] = [];
      const res: string[] = [];
      for (let i = 0; i < 100; i++) {
        ops.push(l.recordVote(REF, vote(`v${i}`, "b", X)).then((r) => res.push(r)));
        if (i === 50) ops.push(l.close(REF, "end"));
      }
      await Promise.all(ops);
      const f = await l.fold(REF);
      expect(f.claim).toBeDefined();
      // accepted == folded: nothing is "ok" yet invisible, nothing past the CLAIM is reported ok
      expect(res.filter((x) => x === "ok")).toHaveLength(f.summary.viewers);
      expect(res.filter((x) => x === "closed").length + f.summary.viewers).toBe(100);
    });

    it("a second replica's votes interleave with the first's: all accepted over one log", async () => {
      const log = make();
      const a = mk(log);
      const b = mk(log);
      const r = await Promise.all(
        Array.from({ length: 60 }, (_, i) => (i % 2 ? a : b).recordVote(REF, vote(`v${i}`, "b", X)))
      );
      expect(r.filter((x) => x === "ok")).toHaveLength(60);
      expect((await a.fold(REF)).summary.viewers).toBe(60);
    });
  });
}

describe("U11 contention is a typed result, never a throw", () => {
  it("a log that always loses the CAS yields contended; the ledger keeps working afterwards", async () => {
    let lose = true;
    const inner = new InMemoryVoteLog();
    const log: VoteLog = {
      read: (st) => inner.read(st),
      append: async (st, e, rec) => (lose ? { ok: false, tip: e } : inner.append(st, e, rec)),
    };
    const l = mk(log);
    expect(await l.recordVote(REF, vote("v1", "b", X))).toBe("contended");
    lose = false;
    expect(await l.recordVote(REF, vote("v1", "b", X))).toBe("ok");
  }, 30_000);

  it("one ledger never loses a CAS to itself: 200 concurrent votes cost zero rejected appends", async () => {
    const inner = new InMemoryVoteLog();
    let lost = 0;
    const log: VoteLog = {
      read: (st) => inner.read(st),
      append: async (st, e, rec) => {
        const r = await inner.append(st, e, rec);
        if (!r.ok) lost += 1;
        return r;
      },
    };
    const l = mk(log);
    await Promise.all(
      Array.from({ length: 200 }, (_, i) => l.recordVote(REF, vote(`v${i}`, "b", X)))
    );
    expect(lost).toBe(0);
  });

  it("the per-stream queue is dropped once idle (bounded)", async () => {
    const l = mk();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        l.recordVote({ executionId: `e${i}`, decisionId: "d" }, vote("v", "b", X))
      )
    );
    await new Promise((r) => setTimeout(r, 0));
    expect((l as unknown as { chains: Map<string, unknown> }).chains.size).toBe(0);
  });
});

describe("U11 per-viewer append budget (one viewer cannot fill a decision's log)", () => {
  it("the flooding viewer is refused past its budget; a later viewer still votes", async () => {
    const l = mk(new InMemoryVoteLog(), { maxEntriesPerDecision: 2000 });
    const res: string[] = [];
    for (let i = 0; i < 3000; i++) res.push(await l.recordVote(REF, vote("flood", `b${i}`, X)));
    expect(res.filter((x) => x === "ok")).toHaveLength(128);
    expect(new Set(res.slice(128))).toEqual(new Set(["viewer-capacity"]));
    expect(await l.recordVote(REF, vote("later", "b", X))).toBe("ok");
    expect((await l.fold(REF)).summary.viewers).toBe(2);
  });

  it("the budget comes from the DURABLE log: a fresh ledger over the same log still refuses the flooder", async () => {
    const log = durable();
    const a = mk(log, { maxBatchesPerViewer: 5 });
    for (let i = 0; i < 5; i++)
      expect(await a.recordVote(REF, vote("flood", `b${i}`, X))).toBe("ok");
    const b = mk(log, { maxBatchesPerViewer: 5 }); // restart / second replica: no in-memory memory of the flood
    expect(await b.recordVote(REF, vote("flood", "more", X))).toBe("viewer-capacity");
    expect(await b.recordVote(REF, vote("other", "b", X))).toBe("ok");
  });

  it("capacity is reserved for first votes: returning viewers stop at 75% of the cap, new viewers keep voting to 100%", async () => {
    const l = mk(new InMemoryVoteLog(), { maxEntriesPerDecision: 40, maxBatchesPerViewer: 128 });
    // 10 viewers first-vote, then keep going: returning votes stop once the log holds 30
    for (let i = 0; i < 10; i++) await l.recordVote(REF, vote(`v${i}`, "b0", X));
    const more: string[] = [];
    for (let round = 1; round < 10; round++)
      for (let i = 0; i < 10; i++)
        more.push(await l.recordVote(REF, vote(`v${i}`, `b${round}`, X)));
    expect(more.filter((x) => x === "ok")).toHaveLength(20);
    expect(more.filter((x) => x === "viewer-capacity").length).toBe(70);
    // the reserved 10 slots take 10 brand-new viewers; the 11th is genuinely out of capacity
    const fresh: string[] = [];
    for (let i = 0; i < 11; i++) fresh.push(await l.recordVote(REF, vote(`new${i}`, "b", X)));
    expect(fresh.filter((x) => x === "ok")).toHaveLength(10);
    expect(fresh[10]).toBe("capacity");
  });
});

describe("U11 viewerKey is unambiguous", () => {
  it("fields containing NUL cannot shift the tenant/id boundary", () => {
    const l = mk();
    expect(l.viewerKey("a\u0000b", "c")).not.toBe(l.viewerKey("a", "b\u0000c"));
    expect(l.viewerKey("a", "b")).toBe(l.viewerKey("a", "b"));
  });
});

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
