import { eventStoreLineageStore } from "@loom-ui/lineage";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { checkChangeFeedConformance } from "./conformance";
import { type ChangeFeed, LineageChangeFeed } from "./feed";
import { by, g, ins, makeLineage, manualHarness, node } from "./harness.test-support";
import { eventStoreHeadSignal, pollingHeadSignal } from "./signal";

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
