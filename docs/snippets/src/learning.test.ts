// The learning snippet of docs/guides/planners-and-learning.md, referenced from planner.test.ts's
// doc check as `<!-- snippet: NAME in learning.test.ts -->`.
import { describe, expect, it } from "vitest";
// #region imports
import { SIGNAL_VERSION } from "@loom-ui/core/signals";
import {
  DecisionLinks,
  InMemoryVoteLog,
  SignalIngestor,
  VoteLedger,
  defaultReward,
} from "@loom-ui/learning";
// #endregion imports

describe("docs/guides/planners-and-learning.md, learning", () => {
  it("folds untrusted signals into one bounded vote per viewer", async () => {
    // #region ingest
    // What the host knows about one compiled version: which decision wrote which node.
    const decision = { executionId: "exec-1", decisionId: "plan-variant:abc" };
    const links = new DecisionLinks();
    links.register("weekly-orders", "v1", {
      tenant: "acme", // REQUIRED: a link is looked up by tenant
      decisions: [decision],
      nodes: { orders: decision },
    });

    const ledger = new VoteLedger({
      log: new InMemoryVoteLog(), // production: a durable VoteLog (eventStoreLineageStore)
      pseudonymKey: "0123456789abcdef0123456789abcdef", // >= 16 bytes, from your secret store
      clock: Date.now,
      outcomes: ["approved"], // the only outcome names a client may report
    });
    const ingestor = new SignalIngestor({
      links,
      ledger,
      clock: Date.now,
      exposure: "client-claimed", // tests and demos; production: seenLogExposure(seenLog, ...)
    });

    // The viewer is the host's authenticated session, never a field of the payload.
    const result = await ingestor.ingest({
      viewer: { id: "ana", tenant: "acme" },
      raw: {
        v: SIGNAL_VERSION,
        batchId: "b1",
        view: { experienceId: "weekly-orders", versionHash: "v1" },
        signals: [
          { kind: "exposure", node: "orders" },
          { kind: "engagement", action: "click", count: 1, node: "orders" },
          { kind: "feedback", rating: 5 },
        ],
      },
    });
    // Answer the client with a bare 204 whatever `result` says; keep it in your server logs.

    const { summary } = await ledger.fold(decision);
    const reward = defaultReward()(summary); // a pooled score in [0, 1]
    // #endregion ingest
    expect(result.accepted).toBe(3);
    expect(result.refused).toBeUndefined();
    expect(summary.viewers).toBe(1);
    expect(reward).toBeGreaterThan(0);
    expect(reward).toBeLessThanOrEqual(1);
  });
});
