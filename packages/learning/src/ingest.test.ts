import { type InteractionSignal, SIGNAL_VERSION } from "@loom-ui/core/signals";
import { describe, expect, it } from "vitest";
import type { ExposureCheck } from "./exposure";
import { SignalIngestor, type SignalRejection, type Viewer } from "./ingest";
import { InMemoryVoteLog, VoteLedger } from "./ledger";
import { type DecisionLink, DecisionLinks, type DecisionRef } from "./links";
import { defaultReward } from "./rewards";

const REF: DecisionRef = { executionId: "exec-1", decisionId: "plan-variant:aaa" };
const REF2: DecisionRef = { executionId: "exec-2", decisionId: "plan-variant:bbb" };
const alice: Viewer = { id: "alice", tenant: "acme" };

function rig(
  opts: {
    link?: Partial<DecisionLink>;
    exposure?: ExposureCheck | "client-claimed";
    rateLimit?: number;
    ledger?: Partial<ConstructorParameters<typeof VoteLedger>[0]>;
  } = {}
) {
  let now = 1_000_000;
  const links = new DecisionLinks();
  links.register("exp", "v1", { tenant: "acme", decisions: [REF], ...opts.link });
  const ledger = new VoteLedger({
    log: new InMemoryVoteLog(),
    pseudonymKey: "0123456789abcdef0123456789abcdef",
    clock: () => now,
    outcomes: ["approved"],
    ...opts.ledger,
  });
  const ing = new SignalIngestor({
    links,
    ledger,
    clock: () => now,
    exposure: opts.exposure ?? "client-claimed",
    ...(opts.rateLimit !== undefined && { rateLimit: opts.rateLimit }),
  });
  let n = 0;
  const batch = (signals: unknown[], view = { experienceId: "exp", versionHash: "v1" }) => ({
    v: SIGNAL_VERSION,
    batchId: `b${++n}`,
    view,
    signals,
  });
  return {
    ing,
    ledger,
    links,
    batch,
    advance: (ms: number) => {
      now += ms;
    },
    summary: async (ref = REF) => (await ledger.fold(ref)).summary,
  };
}
const expo = (node: string): InteractionSignal => ({ kind: "exposure", node });
const click = (node: string): InteractionSignal => ({
  kind: "engagement",
  action: "click",
  count: 1,
  node,
});

describe("U11 SignalIngestor", () => {
  it("requires an exposure policy: no silent fail-open", () => {
    const base = { links: new DecisionLinks(), ledger: rig().ledger, clock: () => 0 };
    expect(() => new SignalIngestor(base as never)).toThrow(/exposure/);
    expect(() => new SignalIngestor({ ...base, exposure: "client-claimed" })).not.toThrow();
  });

  it("pools one bounded vote per viewer: exposure, engagement, dwell, rating, outcome", async () => {
    const r = rig();
    const res = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([
        click("a"), // listed before the exposure: judged after it
        expo("a"),
        { kind: "engagement", action: "dwell", bucket: 3, node: "a" },
        { kind: "feedback", rating: 5 },
        { kind: "outcome", name: "approved", success: true },
      ]),
    });
    expect(res.refused).toBeUndefined();
    expect(res.accepted).toBe(5);
    const s = await r.summary();
    expect(s).toMatchObject({
      viewers: 1,
      engagementSum: 1,
      feedbackViewers: 1,
      feedbackSum: 1,
      outcomeViewers: 1,
      outcomeSum: 1,
    });
    expect(defaultReward()(s)).toBe(1);
  });

  it("engagement is a SHARE of the viewer's own exposed nodes: 1 of 4 is 0.25, not 1", async () => {
    const r = rig();
    await r.ing.ingest({
      viewer: alice,
      raw: r.batch([expo("a"), expo("b"), expo("c"), expo("d"), click("a"), click("a")]),
    });
    expect((await r.summary()).engagementSum).toBe(0.25);
  });

  it("P1: a client cannot mint outcomes - one viewer with 63 invented names is one viewer, and unregistered names are refused", async () => {
    const r = rig();
    const names = Array.from({ length: 63 }, (_, i) => ({
      kind: "outcome",
      name: `fake${i}`,
      success: true,
    }));
    const res = await r.ing.ingest({ viewer: alice, raw: r.batch([expo("a"), ...names]) });
    expect(res.rejected).toEqual({ "unknown-outcome": 63 });
    const s = await r.summary();
    expect(s.outcomeViewers).toBe(0);
    expect(s.viewers).toBe(1);
  });

  it("P2-2: forged restricted aliases collapse onto ONE version-level node: they carry no weight", async () => {
    const r = rig({ link: { nodes: { a: REF } } });
    const forged = Array.from({ length: 60 }, (_, i) => ({
      kind: "exposure",
      node: `r_forged${i}`,
      restricted: true,
    }));
    const clicks = Array.from({ length: 60 }, (_, i) => ({
      kind: "engagement",
      action: "click",
      count: 255,
      node: `r_forged${i}`,
      restricted: true,
    }));
    await r.ing.ingest({ viewer: alice, raw: r.batch([...forged]) });
    await r.ing.ingest({ viewer: alice, raw: r.batch([...clicks]) });
    const s = await r.summary();
    expect(s.viewers).toBe(1);
    expect(s.engagementSum).toBe(1); // one pseudo node, engaged once: at most this viewer's single vote
    // forged restricted aliases cannot dilute or inflate a viewer's REAL nodes either: one real,
    // unengaged node plus 60 forged engaged aliases is 1 real + ONE pseudo node, engaged: 1/2
    const mixed = rig({ link: { nodes: { a: REF } } });
    await mixed.ing.ingest({
      viewer: alice,
      raw: mixed.batch([expo("a"), ...forged.slice(0, 30), ...clicks.slice(0, 30)]),
    });
    expect((await mixed.summary()).engagementSum).toBe(0.5);
    // and a second viewer with no engagement dilutes it exactly as one viewer should
    await r.ing.ingest({ viewer: { id: "bob", tenant: "acme" }, raw: r.batch([expo("a")]) });
    expect((await r.summary()).engagementSum).toBe(1);
    expect((await r.summary()).viewers).toBe(2);
  });

  it("P2-3: restricted:true on a node the link lists is refused, and cannot move credit to other decisions", async () => {
    const r = rig({ link: { decisions: [REF, REF2], nodes: { a: REF, b: REF2 } } });
    const res = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([{ kind: "exposure", node: "a", restricted: true }, expo("a")]),
    });
    expect(res.rejected).toEqual({ "restricted-misuse": 1 });
    expect((await r.summary(REF)).viewers).toBe(1);
    expect((await r.summary(REF2)).viewers).toBe(0); // not credited by the forged flag
  });

  it("P2-4: a hidden node and an unlisted node answer identically (no existence oracle)", async () => {
    const r = rig({ link: { nodes: { a: REF, secret: REF }, visibleTo: () => new Set(["a"]) } });
    const hidden = await r.ing.ingest({ viewer: alice, raw: r.batch([expo("secret")]) });
    const unknown = await r.ing.ingest({ viewer: alice, raw: r.batch([expo("nope")]) });
    expect(hidden).toEqual(unknown);
    expect(hidden.rejected).toEqual({ "unknown-node": 1 });
    expect((await r.ing.ingest({ viewer: alice, raw: r.batch([expo("a")]) })).accepted).toBe(1);
  });

  it("P3-9: refused calls (unknown view, malformed, replay) are charged to the rate budget too", async () => {
    const r = rig({ rateLimit: 6 });
    const calls = [];
    for (let i = 0; i < 8; i++)
      calls.push(
        (
          await r.ing.ingest({
            viewer: alice,
            raw: r.batch([expo("a")], { experienceId: "exp", versionHash: "never" }),
          })
        ).refused
      );
    expect(calls.slice(0, 6)).toEqual(Array(6).fill("unknown-view"));
    expect(calls.slice(6)).toEqual(["rate-limited", "rate-limited"]);
    const bad = rig({ rateLimit: 3 });
    const out = [];
    for (let i = 0; i < 5; i++)
      out.push((await bad.ing.ingest({ viewer: alice, raw: "junk" })).refused);
    expect(out).toEqual([
      "batch-invalid",
      "batch-invalid",
      "batch-invalid",
      "rate-limited",
      "rate-limited",
    ]);
    const dup = rig({ rateLimit: 3 });
    const b = dup.batch([expo("a")]);
    const d = [];
    for (let i = 0; i < 5; i++) d.push((await dup.ing.ingest({ viewer: alice, raw: b })).refused);
    expect(d).toEqual([
      undefined,
      "duplicate-batch",
      "duplicate-batch",
      "rate-limited",
      "rate-limited",
    ]);
  });

  it("P2-6/7: tenant is part of identity and of the link key; a viewer or link without one is refused", async () => {
    const r = rig();
    // the same experience+version registered by another tenant is a different link
    const other = { tenant: "evil", decisions: [REF2] };
    r.links.register("exp", "v1", other);
    expect(
      r.links.resolve({ tenant: "acme", experienceId: "exp", versionHash: "v1" })?.decisions
    ).toEqual([REF]);
    expect(
      r.links.resolve({ tenant: "evil", experienceId: "exp", versionHash: "v1" })?.decisions
    ).toEqual([REF2]);
    expect(r.links.size).toBe(2);
    expect(() => r.links.register("e", "v", { decisions: [] } as never)).toThrow(/tenant/);
    await expect(
      r.ing.ingest({ viewer: { id: "x" } as never, raw: r.batch([expo("a")]) })
    ).rejects.toThrow(/tenant/);
    // a viewer of another tenant never reaches acme's link
    const foreign = await r.ing.ingest({
      viewer: { id: "mallory", tenant: "other" },
      raw: r.batch([expo("a")]),
    });
    expect(foreign).toEqual({ accepted: 0, rejected: {}, refused: "unknown-view" });
    // identical ids in two tenants are two people: separate rate budgets, replay memory and votes
    const a2: Viewer = { id: "alice", tenant: "evil" };
    const same = r.batch([expo("a")]);
    expect((await r.ing.ingest({ viewer: alice, raw: same })).accepted).toBe(1);
    expect((await r.ing.ingest({ viewer: a2, raw: same })).accepted).toBe(1);
    expect((await r.summary(REF)).viewers).toBe(1);
    expect((await r.summary(REF2)).viewers).toBe(1);
  });

  it("the host's authoritative exposure check can veto everything, the exposure signal included", async () => {
    const r = rig({ exposure: { saw: (q) => q.node === "real" } });
    const res = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([
        expo("real"),
        expo("claimed-only"),
        click("claimed-only"),
        { kind: "feedback", rating: 5, node: "claimed-only" },
      ]),
    });
    expect(res.rejected).toEqual({ unexposed: 3 });
    expect((await r.summary()).viewers).toBe(1);
    expect((await r.summary()).feedbackViewers).toBe(0);
    // a throwing check is a no
    const t = rig({ exposure: { saw: () => Promise.reject(new Error("down")) } });
    expect((await t.ing.ingest({ viewer: alice, raw: t.batch([expo("a")]) })).rejected).toEqual({
      unexposed: 1,
    });
  });

  it("client-claimed: an engagement on a node the viewer never claimed to show earns nothing (judged by the fold)", async () => {
    const r = rig();
    await r.ing.ingest({
      viewer: alice,
      raw: r.batch([expo("a"), click("b"), { kind: "feedback", rating: 5, node: "b" }]),
    });
    const s = await r.summary();
    expect(s.engagementSum).toBe(0);
    expect(s.feedbackViewers).toBe(0);
    // nor an outcome from a viewer who exposed nothing
    const r2 = rig();
    await r2.ing.ingest({
      viewer: alice,
      raw: r2.batch([{ kind: "outcome", name: "approved", success: true }]),
    });
    expect((await r2.summary()).outcomeViewers).toBe(0);
  });

  it("repeating yourself raises nothing: duplicate batches, repeated signals, a second rating", async () => {
    const r = rig();
    const raw = r.batch([expo("a"), { kind: "feedback", rating: 5, node: "a" }]);
    expect((await r.ing.ingest({ viewer: alice, raw })).accepted).toBe(2);
    expect((await r.ing.ingest({ viewer: alice, raw })).refused).toBe("duplicate-batch");
    for (let i = 0; i < 20; i++)
      await r.ing.ingest({ viewer: alice, raw: r.batch([expo("a"), click("a"), click("a")]) });
    const s = await r.summary();
    expect(s.viewers).toBe(1);
    expect(s.engagementSum).toBe(1);
    expect(s.feedbackViewers).toBe(1);
  });

  it("a forged identity in the payload is ignored: the viewer is the session's", async () => {
    const r = rig();
    await r.ing.ingest({
      viewer: alice,
      raw: { ...(r.batch([expo("a")]) as object), viewer: "bob", viewerId: "bob", tenant: "other" },
    });
    await r.ing.ingest({
      viewer: { id: "carol", tenant: "acme" },
      raw: { ...(r.batch([expo("a")]) as object), viewerId: "alice" },
    });
    expect((await r.summary()).viewers).toBe(2);
  });

  it("node-level credit follows the node's decision; an unlisted node earns nothing", async () => {
    const r = rig({ link: { decisions: [REF, REF2], nodes: { a: REF, b: REF2 } } });
    const res = await r.ing.ingest({
      viewer: alice,
      raw: r.batch([expo("a"), expo("b"), expo("human-edited"), click("b")]),
    });
    expect(res.rejected).toEqual({ "unknown-node": 1 });
    expect((await r.summary(REF)).engagementSum).toBe(0);
    expect((await r.summary(REF2)).engagementSum).toBe(1);
  });

  it("version-level facts credit every decision of the version, each judged against exposure in its own log", async () => {
    const r = rig({ link: { decisions: [REF, REF2], nodes: { a: REF, b: REF2 } } });
    await r.ing.ingest({
      viewer: alice,
      raw: r.batch([
        expo("a"),
        { kind: "feedback", rating: 5 },
        { kind: "outcome", name: "approved", success: true },
      ]),
    });
    for (const ref of [REF, REF2])
      expect(await r.summary(ref)).toMatchObject({
        viewers: 1,
        feedbackViewers: 1,
        outcomeViewers: 1,
      });
  });

  it("is rate limited per viewer: an over-budget batch is refused whole and not remembered", async () => {
    const r = rig({ rateLimit: 10 });
    const first = r.batch(Array.from({ length: 8 }, (_, i) => expo(`n${i}`)));
    expect((await r.ing.ingest({ viewer: alice, raw: first })).accepted).toBe(8);
    const second = r.batch(Array.from({ length: 8 }, (_, i) => expo(`m${i}`)));
    expect((await r.ing.ingest({ viewer: alice, raw: second })).refused).toBe("rate-limited");
    expect(
      (await r.ing.ingest({ viewer: { id: "bob", tenant: "acme" }, raw: r.batch([expo("n0")]) }))
        .accepted
    ).toBe(1);
    r.advance(61_000);
    expect((await r.ing.ingest({ viewer: alice, raw: second })).accepted).toBe(8);
  });

  it("malformed and oversized batches are refused whole; one bad signal is dropped and counted", async () => {
    const r = rig();
    for (const raw of [
      null,
      "x",
      [],
      { v: 9 },
      r.batch(Array.from({ length: 65 }, () => expo("a"))),
    ])
      expect((await r.ing.ingest({ viewer: alice, raw })).refused).toBe("batch-invalid");
    expect(
      await r.ing.ingest({ viewer: alice, raw: r.batch([expo("a"), { kind: "evil", text: "hi" }]) })
    ).toEqual({ accepted: 1, rejected: { invalid: 1 } });
  });

  it("ledger capacity and a closed decision are reported, never swallowed", async () => {
    const r = rig({ ledger: { maxEntriesPerDecision: 1 } });
    const a = await r.ing.ingest({ viewer: alice, raw: r.batch([expo("a")]) });
    const b = await r.ing.ingest({
      viewer: { id: "bob", tenant: "acme" },
      raw: r.batch([expo("a")]),
    });
    expect(a.accepted).toBe(1);
    expect(b).toEqual({
      accepted: 0,
      rejected: { capacity: 1 } satisfies Partial<Record<SignalRejection, number>>,
    });
    const c = rig();
    await c.ing.ingest({ viewer: alice, raw: c.batch([expo("a")]) });
    await c.ledger.close(REF, "end");
    const late = await c.ing.ingest({
      viewer: { id: "bob", tenant: "acme" },
      raw: c.batch([expo("a")]),
    });
    expect(late.rejected).toEqual({ closed: 1 });
  });

  it("a resolver that returns ANOTHER tenant's link is refused (the tenant check does not rest on the registry)", async () => {
    const r = rig();
    const evil: DecisionLink = { tenant: "evil", decisions: [REF2] };
    const ing = new SignalIngestor({
      links: { resolve: () => evil },
      ledger: r.ledger,
      clock: () => 0,
      exposure: "client-claimed",
    });
    const res = await ing.ingest({ viewer: alice, raw: r.batch([expo("a")]) });
    expect(res).toEqual({ accepted: 0, rejected: {}, refused: "unknown-view" });
    expect((await r.ledger.fold(REF2)).entries).toBe(0);
  });

  it("passes the viewer's tenant to the exposure check", async () => {
    const seen: string[] = [];
    const r = rig({
      exposure: {
        saw: (q) => {
          seen.push(q.tenant);
          return true;
        },
      },
    });
    await r.ing.ingest({ viewer: alice, raw: r.batch([expo("a")]) });
    expect(new Set(seen)).toEqual(new Set(["acme"]));
  });

  it("one viewer sending 3000 one-signal batches cannot starve a later viewer; the flooder is refused past its budget", async () => {
    const r = rig({ ledger: { maxEntriesPerDecision: 2000 } });
    const flood = new SignalIngestor({
      links: r.links,
      ledger: r.ledger,
      clock: () => 0,
      exposure: "client-claimed",
      rateLimit: 1_000_000,
    });
    let accepted = 0;
    const reasons: Partial<Record<SignalRejection, number>> = {};
    for (let i = 0; i < 3000; i++) {
      const res = await flood.ingest({ viewer: alice, raw: r.batch([expo("a")]) });
      accepted += res.accepted;
      for (const [k, n] of Object.entries(res.rejected))
        reasons[k as SignalRejection] = (reasons[k as SignalRejection] ?? 0) + (n ?? 0);
    }
    expect(accepted).toBe(128);
    expect(reasons).toEqual({ "viewer-capacity": 2872 });
    const bob = await flood.ingest({
      viewer: { id: "bob", tenant: "acme" },
      raw: r.batch([expo("a")]),
    });
    expect(bob).toEqual({ accepted: 1, rejected: {} });
  });
});
