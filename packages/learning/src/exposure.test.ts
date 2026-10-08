import {
  type Provenance,
  type RecordedOperation,
  type SemanticNode,
  genesis,
  snapshotSeen,
} from "@loom-ui/core";
import { SIGNAL_VERSION } from "@loom-ui/core/signals";
import {
  InMemoryLineageStore,
  InMemorySeenKeyStore,
  Lineage,
  type LineageResult,
  SeenLog,
} from "@loom-ui/lineage";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { allOf, seenLogExposure } from "./exposure";
import { SignalIngestor } from "./ingest";
import { InMemoryVoteLog, VoteLedger } from "./ledger";
import { DecisionLinks } from "./links";

const user: Provenance = { source: "user" };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const node = (id: string, handle: string): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle, priority: "P1" },
});
const ins = (n: SemanticNode): RecordedOperation => ({
  op: { type: "insertNode", parentId: "root", node: n },
  by: user,
  at: "2026-10-06T00:00:00Z",
});
function ok<T>(r: { ok: true; value: T } | { ok: false; refusal: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  return r.value;
}

describe("U11 seenLogExposure over the real SeenLog (U12)", () => {
  async function setup() {
    const content = new InMemoryContentStore();
    const lineage = new Lineage({ events: new InMemoryLineageStore(), content });
    const v1 = ok(
      await lineage.start(
        genesis({ experienceId: "e", intent: { objective: "o", source: "user" }, meta }),
        user
      )
    );
    const v2 = ok(
      await lineage.compose({
        experienceId: "e",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("a", "ha")), ins(node("b", "hb"))],
        by: user,
      })
    );
    let t = 0;
    const log = new SeenLog({
      keys: new InMemorySeenKeyStore(),
      events: new InMemoryLineageStore(),
      content,
      lineage,
      now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, t++)).toISOString(),
    });
    const exp = v2.experience;
    const snap = snapshotSeen(exp, {
      viewer: { clearance: "secret" },
      read: () => ({ found: true, value: 1, status: "ready" }),
    });
    ok(
      await log.record({
        experienceId: "e",
        viewerId: "alice",
        snapshot: snap,
        viewer: { clearance: "secret" },
      })
    );
    return { log, exp };
  }

  it("a view the server recorded satisfies the check; an unrecorded viewer, another version, an erased viewer do not", async () => {
    const { log, exp } = await setup();
    const check = seenLogExposure(log);
    const q = { viewerId: "alice", experienceId: "e", versionHash: exp.versionHash, node: "a" };
    expect(await check.saw(q)).toBe(true);
    expect(await check.saw({ ...q, viewerId: "bob" })).toBe(false);
    expect(await check.saw({ ...q, versionHash: "sha256:other" })).toBe(false);
    expect(await check.saw({ ...q, experienceId: "someone-elses" })).toBe(false);
    // strict node mode: a node no recorded entry names is not "seen"
    const strict = seenLogExposure(log, { versionIsEnough: false });
    expect(await strict.saw(q)).toBe(true);
    expect(await strict.saw({ ...q, node: "ghost" })).toBe(false);
    expect(await strict.saw({ ...q, node: undefined as never })).toBe(true);
    await log.eraseViewer({ experienceId: "e", viewerId: "alice" });
    expect(await check.saw(q)).toBe(false);
  });

  it("fails closed: a throwing or refusing log answers no", async () => {
    const throwing = seenLogExposure({ read: () => Promise.reject(new Error("down")) });
    const refusing = seenLogExposure({
      read: async () => ({ ok: false as const, refusal: { code: "x" } }),
    });
    const q = { viewerId: "a", experienceId: "e", versionHash: "v" };
    expect(await throwing.saw(q)).toBe(false);
    expect(await refusing.saw(q)).toBe(false);
  });

  it("gates the ingestor: only a viewer the server recorded a view for is rewarded; strict mode needs the node to be data-bound", async () => {
    const { log, exp } = await setup();
    const ref = { executionId: "x1", decisionId: "plan-variant:1" };
    const links = new DecisionLinks();
    links.register("e", exp.versionHash, { tenant: "acme", decisions: [ref] });
    const ledger = new VoteLedger({
      log: new InMemoryVoteLog(),
      pseudonymKey: "0123456789abcdef0123456789abcdef",
      clock: () => 0,
    });
    const ing = new SignalIngestor({
      links,
      ledger,
      clock: () => 0,
      exposure: allOf(seenLogExposure(log)),
    });
    const raw = (id: string) => ({
      v: SIGNAL_VERSION,
      batchId: id,
      view: { experienceId: "e", versionHash: exp.versionHash },
      signals: [
        { kind: "exposure", node: "a" },
        { kind: "feedback", rating: 5 },
      ],
    });
    expect(
      (await ing.ingest({ viewer: { id: "alice", tenant: "acme" }, raw: raw("b1") })).accepted
    ).toBe(2);
    const bob = await ing.ingest({ viewer: { id: "bob", tenant: "acme" }, raw: raw("b2") });
    expect(bob.accepted).toBe(0);
    expect(bob.rejected).toEqual({ unexposed: 2 });
    expect((await ledger.fold(ref)).summary).toMatchObject({ viewers: 1, feedbackViewers: 1 });
  });
});
