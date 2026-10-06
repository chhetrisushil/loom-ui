import type { Finding } from "@loom-ui/core";
import type { UnreadStore } from "./cursor";
import type { ChangeEvent, ChangeFeed } from "./feed";

// ── Conformance kits ──────────────────────────────────────────────────────────
// Findings, never throws (a feed or store that throws on a case is reported as a finding), like
// `checkLineageStoreConformance`.

export interface FeedHarness {
  readonly feed: ChangeFeed;
  /** Append one new version to `experienceId`'s line (the first call starts the line). */
  compose(experienceId: string): Promise<void>;
  /**
   * Force one wake of the feed's signal, for a deterministic harness (a manual-tick signal). Omit
   * for a real timer/push signal: the kit then waits (up to `waitMs`) for delivery.
   */
  tick?(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, tick: (() => Promise<void>) | undefined, waitMs: number) {
  const end = Date.now() + waitMs;
  for (;;) {
    if (tick !== undefined) await tick();
    if (cond()) return true;
    if (Date.now() > end) return false;
    await sleep(5);
  }
}

export async function checkChangeFeedConformance(
  make: () => FeedHarness | Promise<FeedHarness>,
  opts: { waitMs?: number } = {}
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fail = (code: string, message: string) =>
    findings.push({ code, severity: "error", message });
  const waitMs = opts.waitMs ?? 1500;
  const h = await make();
  const read = async (id: string, o?: { after?: number; limit?: number }) => {
    const r = await h.feed.read(id, o);
    if (!r.ok) throw new Error(`read failed: ${r.finding.message}`);
    return r;
  };
  const cases: Array<[string, () => Promise<void>]> = [
    [
      "an unknown line reads empty with tip 0",
      async () => {
        const r = await read("f-empty");
        if (r.events.length !== 0 || r.cursor !== 0 || r.tip !== 0 || r.more)
          fail("read-empty", `an unknown line read ${JSON.stringify(r)}`);
      },
    ],
    [
      "events are dense, ordered, with unique ids that are stable across reads",
      async () => {
        for (let i = 0; i < 3; i++) await h.compose("f-ids");
        const a = await read("f-ids");
        const b = await read("f-ids");
        if (a.events.map((e) => e.sequence).join() !== "1,2,3")
          fail("sequence", `sequences ${a.events.map((e) => e.sequence).join()} are not 1,2,3`);
        if (new Set(a.events.map((e) => e.id)).size !== a.events.length)
          fail("ids-unique", "two events share an id");
        if (a.events.map((e) => e.id).join() !== b.events.map((e) => e.id).join())
          fail("ids-stable", "re-reading the same range changed an id");
        if (a.cursor !== 3 || a.tip !== 3) fail("cursor", `cursor/tip were ${a.cursor}/${a.tip}`);
      },
    ],
    [
      "reading after a cursor returns only later events",
      async () => {
        for (let i = 0; i < 3; i++) await h.compose("f-resume");
        const r = await read("f-resume", { after: 1 });
        if (r.events.map((e) => e.sequence).join() !== "2,3")
          fail("resume", `after 1 returned ${r.events.map((e) => e.sequence).join()}`);
        const none = await read("f-resume", { after: 3 });
        if (none.events.length !== 0 || none.cursor !== 3)
          fail("resume-end", `after the tip returned ${JSON.stringify(none)}`);
      },
    ],
    [
      "paging by limit visits every event once, in order",
      async () => {
        for (let i = 0; i < 5; i++) await h.compose("f-page");
        const seen: number[] = [];
        let cursor = 0;
        for (let guard = 0; guard < 10; guard++) {
          const r = await read("f-page", { after: cursor, limit: 2 });
          if (r.events.length > 2) fail("limit", `limit 2 returned ${r.events.length}`);
          seen.push(...r.events.map((e) => e.sequence));
          cursor = r.cursor;
          if (!r.more) break;
        }
        if (seen.join() !== "1,2,3,4,5") fail("paging", `paging saw ${seen.join()}`);
        const bad = await h.feed.read("f-page", { after: -1 });
        if (bad.ok) fail("cursor-invalid", "a negative cursor was accepted");
        const badLimit = await h.feed.read("f-page", { limit: 0 });
        if (badLimit.ok) fail("limit-invalid", "a zero limit was accepted");
      },
    ],
    [
      "subscribe catches up from a cursor, then follows live, in order",
      async () => {
        await h.compose("f-sub");
        await h.compose("f-sub");
        const got: ChangeEvent[] = [];
        const off = h.feed.subscribe("f-sub", (e) => void got.push(e), { after: 1 });
        const caught = await until(() => got.length >= 1, h.tick, waitMs);
        if (!caught || got[0]?.sequence !== 2)
          fail("sub-catchup", `catch-up from 1 delivered ${got.map((e) => e.sequence).join()}`);
        await h.compose("f-sub");
        const live = await until(() => got.length >= 2, h.tick, waitMs);
        if (!live || got.map((e) => e.sequence).join() !== "2,3")
          fail("sub-live", `live delivery gave ${got.map((e) => e.sequence).join()}`);
        off();
        await h.compose("f-sub");
        await sleep(40);
        if (h.tick) await h.tick();
        await sleep(20);
        if (got.length !== 2) fail("sub-off", "an event was delivered after unsubscribe");
      },
    ],
    [
      "resubscribing from an older cursor redelivers the SAME ids (at-least-once, idempotent)",
      async () => {
        await h.compose("f-redo");
        await h.compose("f-redo");
        const first: string[] = [];
        const offA = h.feed.subscribe("f-redo", (e) => void first.push(e.id));
        await until(() => first.length >= 2, h.tick, waitMs);
        offA();
        const again: string[] = [];
        const offB = h.feed.subscribe("f-redo", (e) => void again.push(e.id), { after: 0 });
        await until(() => again.length >= 2, h.tick, waitMs);
        offB();
        if (first.join() !== again.join() || first.length !== 2)
          fail("redelivery", `first ${first.join()} vs again ${again.join()}`);
      },
    ],
    [
      "a throwing handler is reported, not advanced past, and the event is delivered again",
      async () => {
        await h.compose("f-throw");
        const errors: unknown[] = [];
        const ids: string[] = [];
        let attempts = 0;
        const off = h.feed.subscribe(
          "f-throw",
          (e) => {
            attempts += 1;
            if (attempts === 1) throw new Error("handler down");
            ids.push(e.id);
          },
          { onError: (e) => void errors.push(e), retry: { baseMs: 5, maxMs: 20 } }
        );
        await until(() => errors.length >= 1, h.tick, waitMs);
        if (errors.length < 1) fail("handler-error", "a throwing handler was not reported");
        // NO append and NO signal from here: a quiet line must still redeliver the failed event
        // (a feed that retries only when the head moves leaves it stuck).
        await until(() => ids.length >= 1, undefined, waitMs);
        off();
        if (ids.join() !== "f-throw#1")
          fail("handler-retry", `after a throw on a quiet line the handler saw ${ids.join()}`);
      },
    ],
  ];
  for (const [name, run] of cases) {
    try {
      await run();
    } catch (e) {
      fail("feed-threw", `${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return findings;
}

export async function checkUnreadStoreConformance(
  make: () => UnreadStore | Promise<UnreadStore>
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const fail = (code: string, message: string) =>
    findings.push({ code, severity: "error", message });
  const s = await make();
  const cases: Array<[string, () => Promise<void>]> = [
    [
      "an unseen (viewer, line) is 0",
      async () => {
        if ((await s.get("u-none", "e")) !== 0) fail("default", "an unseen cursor was not 0");
      },
    ],
    [
      "advance moves forward, never back, and is idempotent",
      async () => {
        const a = await s.advance("u-fwd", "e", 5);
        const b = await s.advance("u-fwd", "e", 3);
        const c = await s.advance("u-fwd", "e", 5);
        if (a !== 5 || b !== 5 || c !== 5 || (await s.get("u-fwd", "e")) !== 5)
          fail("monotone", `advance returned ${[a, b, c].join()}`);
      },
    ],
    [
      "invalid positions change nothing",
      async () => {
        await s.advance("u-bad", "e", 2);
        for (const bad of [
          -1,
          1.5,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          "9" as unknown as number,
        ]) {
          const r = await s.advance("u-bad", "e", bad);
          if (r !== 2) fail("invalid", `advance(${String(bad)}) returned ${r}`);
        }
      },
    ],
    [
      "cursors are per viewer and per line, with no id collisions",
      async () => {
        await s.advance("u-a", "e1", 4);
        await s.advance("u-c", "a:b", 9);
        if ((await s.get("u-c:a", "b")) !== 0)
          fail("collision", "ids that join to the same string share a cursor");
        if ((await s.get("u-a", "e2")) !== 0) fail("per-line", "another line shared a cursor");
        if ((await s.get("u-b", "e1")) !== 0) fail("per-viewer", "another viewer shared a cursor");
        if ((await s.get("u-a", "e1")) !== 4)
          fail("collision", "a joined-looking id disturbed a cursor");
      },
    ],
    [
      "concurrent advances land on the maximum",
      async () => {
        await Promise.all([1, 7, 3, 5, 2].map((n) => s.advance("u-race", "e", n)));
        if ((await s.get("u-race", "e")) !== 7)
          fail("race", "concurrent advances did not end at the max");
      },
    ],
  ];
  for (const [name, run] of cases) {
    try {
      await run();
    } catch (e) {
      fail("store-threw", `${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return findings;
}
