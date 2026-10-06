import { boundSummary, untrustedSummary } from "@loom-ui/core";
import { eventStoreLineageStore } from "@loom-ui/lineage";
import { isTainted } from "@loom/classify";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { checkChangeFeedConformance } from "./conformance";
import { type ChangeFeed, LineageChangeFeed } from "./feed";
import { by, g, ins, makeLineage, manualHarness, node } from "./harness.test-support";
import { eventStoreHeadSignal, pollingHeadSignal } from "./signal";
import { summaryAsTainted } from "./untrusted";

describe("checkChangeFeedConformance", () => {
  it("passes the lineage feed with a manual-tick polling signal", async () => {
    expect(await checkChangeFeedConformance(() => manualHarness())).toEqual([]);
  });

  it("passes with a REAL polling timer (no manual tick)", async () => {
    expect(
      await checkChangeFeedConformance(() => {
        const l = makeLineage();
        return {
          feed: new LineageChangeFeed({
            lineage: l.lineage,
            events: l.events,
            signal: pollingHeadSignal(l.events, { intervalMs: 10 }),
          }),
          compose: l.compose,
        };
      })
    ).toEqual([]);
  });

  it("passes with a push signal over loom's EventStore", async () => {
    expect(
      await checkChangeFeedConformance(() => {
        const store = new InMemoryAsyncEventStore();
        const events = eventStoreLineageStore(store);
        const l = makeLineage(events);
        return {
          feed: new LineageChangeFeed({
            lineage: l.lineage,
            events,
            signal: eventStoreHeadSignal(store, events),
          }),
          compose: l.compose,
        };
      })
    ).toEqual([]);
  });

  // The kit must fail a feed that breaks the contract.
  const wrap = (patch: (inner: ChangeFeed) => ChangeFeed) => () => {
    const h = manualHarness();
    return { ...h, feed: patch(h.feed) };
  };

  it("fails a feed that ignores the cursor", async () => {
    const codes = (
      await checkChangeFeedConformance(
        wrap((inner) => ({
          ...inner,
          read: (id, o) => inner.read(id, { ...o, after: 0 }),
          subscribe: (...a) => inner.subscribe(...a),
          describe: (e, o) => inner.describe(e, o),
        }))
      )
    ).map((f) => f.code);
    expect(codes).toContain("resume");
  });

  it("fails a feed whose ids change between reads", async () => {
    let n = 0;
    const codes = (
      await checkChangeFeedConformance(
        wrap((inner) => ({
          ...inner,
          read: async (id, o) => {
            const r = await inner.read(id, o);
            return r.ok
              ? { ...r, events: r.events.map((e) => ({ ...e, id: `${e.id}~${n++}` })) }
              : r;
          },
          describe: (e, o) => inner.describe(e, o),
          subscribe: (...a) => inner.subscribe(...a),
        }))
      )
    ).map((f) => f.code);
    expect(codes).toContain("ids-stable");
  });

  it("fails a feed that drops an event whose handler threw", async () => {
    const codes = (
      await checkChangeFeedConformance(
        wrap((inner) => ({
          ...inner,
          read: (id, o) => inner.read(id, o),
          describe: (e, o) => inner.describe(e, o),
          subscribe: (id, handler, o) =>
            inner.subscribe(
              id,
              async (e) => {
                try {
                  await handler(e);
                } catch (err) {
                  o?.onError?.(err); // swallowed: advances past the failure
                }
              },
              o
            ),
        }))
      )
    ).map((f) => f.code);
    expect(codes).toContain("handler-retry");
  });

  it("fails a feed that retries only when the head moves (a quiet line stays stuck)", async () => {
    const codes = (
      await checkChangeFeedConformance(
        wrap((inner) => ({
          ...inner,
          read: (id, o) => inner.read(id, o),
          describe: (e, o) => inner.describe(e, o),
          subscribe: (id, handler, o) =>
            inner.subscribe(id, handler, { ...o, retry: { baseMs: 1e9, maxMs: 1e9 } }),
        })),
        { waitMs: 300 }
      )
    ).map((f) => f.code);
    expect(codes).toContain("handler-retry");
  });

  it("reports a feed that throws as a finding, never a throw", async () => {
    const findings = await checkChangeFeedConformance(
      () => {
        const h = manualHarness();
        return {
          ...h,
          feed: {
            read: async () => {
              throw new Error("down");
            },
            subscribe: () => () => {},
            describe: async () => ({
              ok: false as const,
              finding: { code: "x", severity: "error" as const, message: "" },
            }),
          },
        };
      },
      { waitMs: 20 }
    );
    expect(findings.some((f) => f.code === "feed-threw")).toBe(true);
  });
});

describe("LineageChangeFeed", () => {
  it("emits one event per log record: composed, promoted, reverted, branched", async () => {
    const l = makeLineage();
    const feed = new LineageChangeFeed({
      lineage: l.lineage,
      events: l.events,
      signal: pollingHeadSignal(l.events, { schedule: () => () => {} }),
    });
    const v1 = await l.lineage.start(g("e"), by);
    if (!v1.ok) throw new Error("setup");
    const c = await l.lineage.compose({
      experienceId: "e",
      expectedHead: v1.value.experience.versionHash,
      ops: [ins(node("m1", "h1"))],
      by,
    });
    if (!c.ok) throw new Error("setup");
    await l.lineage.promote({
      experienceId: "e",
      versionHash: c.value.experience.versionHash,
      expectedPromoted: null,
      by,
    });
    await l.lineage.revert({
      experienceId: "e",
      expectedHead: c.value.experience.versionHash,
      to: v1.value.experience.versionHash,
      by,
    });
    await l.lineage.branch({
      from: { experienceId: "e", versionHash: c.value.experience.versionHash },
      experienceId: "fork",
      by,
    });
    const r = await feed.read("e");
    if (!r.ok) throw new Error("read");
    expect(r.events.map((e) => e.kind)).toEqual(["composed", "composed", "promoted", "reverted"]);
    expect(r.events[0]?.base).toBeNull();
    expect(r.events[1]?.base).toEqual({
      experienceId: "e",
      versionHash: v1.value.experience.versionHash,
    });
    expect(r.events[2]?.base).toBeNull(); // nothing was shown before
    const fork = await feed.read("fork");
    expect(fork.ok && fork.events[0]?.kind).toBe("branched");
    expect(fork.ok && fork.events[0]?.base?.experienceId).toBe("e");
    // an event carries no content: no node, no text, no summary
    expect(JSON.stringify(r.events)).not.toContain("m1");
  });

  it("a malformed log is a finding, never partial events", async () => {
    const l = makeLineage();
    await l.compose("bad");
    await l.events.append("bad", 1, { type: "EXPERIENCE_COMPOSED", payload: { nope: 1 }, at: "x" });
    const feed = new LineageChangeFeed({
      lineage: l.lineage,
      events: l.events,
      signal: pollingHeadSignal(l.events, { schedule: () => () => {} }),
    });
    const r = await feed.read("bad");
    expect(r.ok).toBe(false);
  });

  it("subscription errors on a malformed log are reported and do not throw", async () => {
    const h = manualHarness();
    await h.compose("sub-bad");
    const errors: unknown[] = [];
    await h.events.append("sub-bad", 1, { type: "EXPERIENCE_COMPOSED", payload: {}, at: "x" });
    const off = h.feed.subscribe("sub-bad", () => {}, { onError: (e) => void errors.push(e) });
    await h.tick?.();
    off();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("LineageChangeFeed.describe — viewer-safe, end to end", () => {
  const setup = async () => {
    const h = manualHarness();
    const l = h.lineage;
    const v1 = await l.start(g("e"), by);
    if (!v1.ok) throw new Error("setup");
    return { h, l, head: v1.value.experience.versionHash };
  };

  it("describes a composition with its ops, summary and attention", async () => {
    const { h, l, head } = await setup();
    const c = await l.compose({
      experienceId: "e",
      expectedHead: head,
      ops: [ins(node("pub", "hp"))],
      by,
      summary: "Added the public tile",
    });
    if (!c.ok) throw new Error("setup");
    const r = await h.feed.read("e");
    if (!r.ok) throw new Error("read");
    const d = await h.feed.describe(r.events[1] as never, { viewer: { clearance: "secret" } });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.description.entries).toEqual([{ kind: "node-added", nodeId: "pub", type: "Metric" }]);
    expect(d.description.summary).toEqual({ untrusted: true, text: "Added the public tile" });
    expect(d.description.origin).toBe("edit");
    expect(d.description.attention).toBe("attention");
  });

  it("an uncleared viewer is never told what a restricted change was, nor the summary", async () => {
    const { h, l, head } = await setup();
    const c = await l.compose({
      experienceId: "e",
      expectedHead: head,
      ops: [ins(node("payroll", "hpay", "secret"))],
      by,
      summary: "Added the payroll tile",
    });
    if (!c.ok) throw new Error("setup");
    const r = await h.feed.read("e");
    if (!r.ok) throw new Error("read");
    for (const viewer of [undefined, { clearance: "internal" as const }]) {
      const d = await h.feed.describe(r.events[1] as never, viewer === undefined ? {} : { viewer });
      expect(d.ok).toBe(true);
      if (!d.ok) continue;
      expect(d.description.entries).toEqual([{ kind: "restricted-changed" }]);
      expect(d.description.summary).toBeUndefined();
      expect(JSON.stringify(d)).not.toMatch(/payroll|hpay/);
    }
    const cleared = await h.feed.describe(r.events[1] as never, {
      viewer: { clearance: "secret" },
    });
    expect(cleared.ok && cleared.description.entries[0]?.nodeId).toBe("payroll");
  });

  it("a promotion describes what the viewer sees change between the shown versions", async () => {
    const { h, l, head } = await setup();
    const a = await l.compose({
      experienceId: "e",
      expectedHead: head,
      ops: [ins(node("m1", "h1"))],
      by,
      summary: "one tile",
    });
    if (!a.ok) throw new Error("setup");
    await l.promote({ experienceId: "e", versionHash: head, expectedPromoted: null, by });
    await l.promote({
      experienceId: "e",
      versionHash: a.value.experience.versionHash,
      expectedPromoted: head,
      by,
    });
    const r = await h.feed.read("e");
    if (!r.ok) throw new Error("read");
    const second = r.events.filter((e) => e.kind === "promoted")[1];
    const d = await h.feed.describe(second as never, { viewer: { clearance: "secret" } });
    expect(d.ok && d.description.entries).toEqual([
      { kind: "node-added", nodeId: "m1", type: "Metric" },
    ]);
    expect(d.ok && d.description.summary?.text).toBe("one tile");
  });

  it("an unknown version is a finding", async () => {
    const { h } = await setup();
    const d = await h.feed.describe({
      id: "e#9",
      experienceId: "e",
      sequence: 9,
      at: "",
      kind: "composed",
      versionHash: "nope",
      base: null,
    });
    expect(d.ok).toBe(false);
  });
});

describe("review round 1 — summary class, forged events, projections, retry", () => {
  const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
  const sec = { clearance: "secret" as const };
  const internal = { clearance: "internal" as const };

  it("P1: an unchanged secret node + a visible insert withholds the summary from an uncleared viewer", async () => {
    const h = manualHarness();
    const v = await h.lineage.start(g("e"), by);
    if (!v.ok) throw new Error("setup");
    const a = await h.lineage.compose({
      experienceId: "e",
      expectedHead: v.value.experience.versionHash,
      ops: [ins(node("pay", "hpay", "secret")), ins(node("a1", "h1"))],
      by,
    });
    if (!a.ok) throw new Error("setup");
    const b = await h.lineage.compose({
      experienceId: "e",
      expectedHead: a.value.experience.versionHash,
      ops: [ins(node("a2", "h2"))],
      by,
      summary: "added a chart beside the payroll table (CEO salary $2.1M)",
    });
    if (!b.ok) throw new Error("setup");
    const r = await h.feed.read("e");
    if (!r.ok) throw new Error("read");
    const ev = r.events[2] as never;
    const low = await h.feed.describe(ev, { viewer: internal });
    expect(low.ok && low.description.restricted).toBe(false);
    expect(low.ok && low.description.summary).toBeUndefined();
    expect(JSON.stringify(low)).not.toMatch(/payroll|salary/);
    const high = await h.feed.describe(ev, { viewer: sec });
    expect(high.ok && high.description.summary?.text).toContain("payroll");
  });

  it("P1: a host-stamped summaryClass withholds the summary though every node is public", async () => {
    const h = manualHarness();
    const v = await h.lineage.start(g("e"), by);
    if (!v.ok) throw new Error("setup");
    const b = await h.lineage.compose({
      experienceId: "e",
      expectedHead: v.value.experience.versionHash,
      ops: [ins(node("a2", "h2"))],
      by,
      summary: "mentions the confidential context",
      summaryClass: "secret",
    });
    if (!b.ok) throw new Error("setup");
    const r = await h.feed.read("e");
    if (!r.ok) throw new Error("read");
    const low = await h.feed.describe(r.events[1] as never, { viewer: {} });
    expect(low.ok && low.description.summary).toBeUndefined();
    const high = await h.feed.describe(r.events[1] as never, { viewer: sec });
    expect(high.ok && high.description.summary).toBeDefined();
  });

  it("P2-a: a forged base or kind is refused, never described from another line", async () => {
    const h = manualHarness();
    await h.compose("e");
    await h.compose("e");
    await h.compose("other");
    await h.compose("other");
    const e = await h.feed.read("e");
    const o = await h.feed.read("other");
    if (!e.ok || !o.ok) throw new Error("read");
    const real = e.events[1];
    if (real === undefined || o.events[1] === undefined) throw new Error("setup");
    const forged = [
      { ...real, base: { experienceId: "other", versionHash: o.events[0]?.versionHash as string } },
      { ...real, kind: "promoted" as const },
      { ...real, versionHash: o.events[1].versionHash },
      { ...real, sequence: 99 },
      { ...real, sequence: -1 },
      { ...real, experienceId: 5 as never },
    ];
    for (const f of forged) {
      const d = await h.feed.describe(f, { viewer: sec });
      expect(d.ok).toBe(false);
    }
    expect((await h.feed.describe(real, { viewer: sec })).ok).toBe(true);
    expect((await h.feed.describe(null as never)).ok).toBe(false);
  });

  const projectionLine = async (
    projections?: readonly { id: string; version: string; sensitivity?: "secret" }[]
  ) => {
    const l = makeLineage();
    const { LineageChangeFeed: Feed } = await import("./feed");
    const feed = new Feed({
      lineage: l.lineage,
      events: l.events,
      signal: pollingHeadSignal(l.events, { schedule: () => () => {} }),
      ...(projections !== undefined && { projections }),
    });
    const v = await l.lineage.start(g("e"), by);
    if (!v.ok) throw new Error("setup");
    const proj = {
      ...node("pn", "x"),
      binding: undefined,
      type: "SalaryTable",
      projection: { id: "payroll", path: "rows", version: "1" },
    };
    const c = await l.lineage.compose({
      experienceId: "e",
      expectedHead: v.value.experience.versionHash,
      ops: [ins(proj as never)],
      by,
    });
    if (!c.ok) throw new Error(JSON.stringify(c.refusal));
    const r = await feed.read("e");
    if (!r.ok) throw new Error("read");
    return feed.describe(r.events[1] as never, { viewer: {} });
  };

  it("P2-b: with no catalogue a projection node is hidden from an uncleared viewer", async () => {
    const d = await projectionLine();
    expect(d.ok && d.description.entries).toEqual([{ kind: "restricted-changed" }]);
    expect(JSON.stringify(d)).not.toContain("SalaryTable");
  });

  it("P2-b: unknown id and drifted version are hidden; an offered public one is shown", async () => {
    for (const cat of [[{ id: "other", version: "1" }], [{ id: "payroll", version: "2" }]]) {
      const d = await projectionLine(cat);
      expect(d.ok && d.description.restricted).toBe(true);
    }
    const shown = await projectionLine([{ id: "payroll", version: "1" }]);
    expect(shown.ok && shown.description.entries[0]?.nodeId).toBe("pn");
    const secret = await projectionLine([{ id: "payroll", version: "1", sensitivity: "secret" }]);
    expect(secret.ok && secret.description.entries).toEqual([{ kind: "restricted-changed" }]);
  });

  it("P2-c: a failed delivery on a QUIET line is retried with no new append", async () => {
    const h = manualHarness();
    await h.compose("q");
    await h.compose("q");
    const got: string[] = [];
    const errors: unknown[] = [];
    let attempts = 0;
    const off = h.feed.subscribe(
      "q",
      (e) => {
        if (e.sequence === 2 && attempts++ === 0) throw new Error("down once");
        got.push(e.id);
      },
      { retry: { baseMs: 5, maxMs: 20 }, onError: (e) => void errors.push(e) }
    );
    for (let i = 0; i < 5; i++) await h.tick?.();
    await settle(150); // no further tick, no further append
    off();
    expect(errors).toHaveLength(1);
    expect(got).toEqual(["q#1", "q#2"]);
  });

  it("P2-c: a failed read is retried too", async () => {
    const h = manualHarness();
    await h.compose("r");
    let n = 0;
    const flaky = {
      ...h.feed,
      read: (id: string, o?: { after?: number; limit?: number }) =>
        n++ === 0
          ? Promise.resolve({
              ok: false as const,
              finding: { code: "x", severity: "error" as const, message: "" },
            })
          : h.feed.read(id, o),
    };
    const { LineageChangeFeed: Feed } = await import("./feed");
    const feed = Object.assign(Object.create(Object.getPrototypeOf(h.feed)), h.feed, {
      read: flaky.read,
    }) as InstanceType<typeof Feed>;
    const got: string[] = [];
    const off = feed.subscribe("r", (e) => void got.push(e.id), {
      retry: { baseMs: 5, maxMs: 10 },
    });
    await settle(150);
    off();
    expect(got).toEqual(["r#1"]);
  });

  it("P2-c: unsubscribe clears the retry timer (nothing is delivered afterwards)", async () => {
    const h = manualHarness();
    await h.compose("u");
    let calls = 0;
    const off = h.feed.subscribe(
      "u",
      () => {
        calls += 1;
        throw new Error("always");
      },
      { retry: { baseMs: 5, maxMs: 5 } }
    );
    await settle(30);
    off();
    const seen = calls;
    await settle(60);
    expect(calls).toBe(seen);
  });

  it("poison: onPoison can skip a permanently failing event, with its attempt count", async () => {
    const h = manualHarness();
    await h.compose("p");
    await h.compose("p");
    await h.compose("p");
    const got: string[] = [];
    const attempts: number[] = [];
    const off = h.feed.subscribe(
      "p",
      (e) => {
        if (e.sequence === 2) throw new Error("poison");
        got.push(e.id);
      },
      {
        retry: { baseMs: 5, maxMs: 10 },
        onPoison: (e, n) => {
          attempts.push(n);
          return n >= 3;
        },
      }
    );
    await settle(200);
    off();
    expect(attempts.slice(0, 3)).toEqual([1, 2, 3]);
    expect(got).toEqual(["p#1", "p#3"]);
  });

  it("poison: without onPoison it stalls only itself and a resubscribe after its sequence escapes", async () => {
    const h = manualHarness();
    await h.compose("s");
    await h.compose("s");
    await h.compose("s");
    const got: string[] = [];
    const stalled = h.feed.subscribe(
      "s",
      (e) => {
        if (e.sequence === 2) throw new Error("poison");
        got.push(e.id);
      },
      { retry: { baseMs: 5, maxMs: 5 } }
    );
    await settle(60);
    stalled();
    expect(got).toEqual(["s#1"]);
    const out: string[] = [];
    const off = h.feed.subscribe("s", (e) => void out.push(e.id), { after: 2 });
    await settle(30);
    off();
    expect(out).toEqual(["s#3"]);
  });

  it("a throwing poison hook or onError hook never breaks delivery", async () => {
    const h = manualHarness();
    await h.compose("t");
    const got: string[] = [];
    let n = 0;
    const off = h.feed.subscribe(
      "t",
      (e) => {
        if (n++ === 0) throw new Error("x");
        got.push(e.id);
      },
      {
        retry: { baseMs: 5, maxMs: 5 },
        onPoison: () => {
          throw new Error("hook");
        },
        onError: () => {
          throw new Error("hook");
        },
      }
    );
    await settle(80);
    off();
    expect(got).toEqual(["t#1"]);
  });
});

describe("review round 1 — untrusted summary as loom's taint (ADR 0085)", () => {
  it("summaryAsTainted wraps the bounded text as a TaintedValue", () => {
    const u = untrustedSummary("hello\nworld");
    if (u === undefined) throw new Error("setup");
    const t = summaryAsTainted(u);
    expect(isTainted(t)).toBe(true);
    expect(t.value).toBe("hello world");
    expect(t.__loomTainted.origin).toBe("loom-ui:change-summary");
    expect(boundSummary("x")).toBe("x");
  });
});
