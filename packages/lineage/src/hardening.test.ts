import {
  type Experience,
  type Provenance,
  type RecordedOperation,
  genesis,
  replay,
} from "@loom-ui/core";
import type { SemanticNode } from "@loom-ui/core";
import { putExperience, seal } from "@loom-ui/core/log";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { branchArtifact } from "./derive";
import { EXPERIENCE_BRANCHED, EXPERIENCE_COMPOSED, EXPERIENCE_PROMOTED } from "./events";
import { Lineage, type LineageResult } from "./lineage";
import { MAX_OPS_PER_VERSION, foldLineage } from "./state";
import {
  type AppendOutcome,
  InMemoryLineageStore,
  type LineageRecord,
  type LineageStore,
  type StoredLineageRecord,
  eventStoreLineageStore,
} from "./store";

// U6 review round 1: a log is untrusted input, verify must not trust a branch's source, the
// declassify gate is per call, and the adapter/meta/retry edges.

const by: Provenance = { source: "user" };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const g = (id = "exp") =>
  genesis({ experienceId: id, intent: { objective: "o", source: "user" }, meta });
const node = (id: string, handle: string, sensitivity?: "secret"): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props: {},
  binding: { handle, priority: "P1", ...(sensitivity && { sensitivity }) },
});
const ins = (n: SemanticNode): RecordedOperation => ({
  op: { type: "insertNode", parentId: "root", node: n },
  by,
  at: "2026-10-06T00:00:00Z",
});
function ok<T>(r: LineageResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.refusal)}`);
  return r.value;
}
const clock = () => {
  let n = 0;
  return () => new Date(Date.UTC(2026, 9, 6, 0, 0, n++)).toISOString();
};
const rec = (sequence: number, type: string, payload: unknown): StoredLineageRecord => ({
  sequence,
  type,
  payload,
  at: "2026-10-06T00:00:00Z",
});
const composedPayload = (ops: unknown) => ({
  experienceId: "exp",
  versionHash: "sha256:v1",
  ref: { __loomContent: "c" },
  parents: [],
  ops,
  by,
});
const deepNode = (depth: number): unknown => {
  let n: unknown = { id: "leaf", kind: "semantic" };
  for (let i = 0; i < depth; i++) n = { id: `n${i}`, kind: "container", children: [n] };
  return n;
};
const deepPrompt = (depth: number): unknown => {
  let op: unknown = { type: "removeNode", nodeId: "x" };
  for (let i = 0; i < depth; i++) op = { type: "prompt", text: "t", materialized: [op] };
  return op;
};
const recorded = (op: unknown) => ({ op, by, at: "t" });

describe("foldLineage is total over a hostile log (P2-1)", () => {
  const code = (records: readonly unknown[]) => {
    const f = foldLineage("exp", records as StoredLineageRecord[]);
    return f.ok ? "ok" : f.finding.code;
  };

  it("an insertNode op nested 20k deep is a finding, not a stack overflow", () => {
    const ops = [recorded({ type: "insertNode", parentId: "root", node: deepNode(20_000) })];
    expect(code([rec(1, EXPERIENCE_COMPOSED, composedPayload(ops))])).toBe("lineage-event-invalid");
  });

  it("prompt ops nested past the cap are a finding", () => {
    const ops = [recorded(deepPrompt(5_000))];
    expect(code([rec(1, EXPERIENCE_COMPOSED, composedPayload(ops))])).toBe("lineage-event-invalid");
  });

  it("an ops array over the cap is a finding before any schema walk", () => {
    const ops = Array.from({ length: MAX_OPS_PER_VERSION + 1 }, () =>
      recorded({ type: "removeNode", nodeId: "x" })
    );
    expect(code([rec(1, EXPERIENCE_COMPOSED, composedPayload(ops))])).toBe("lineage-event-invalid");
  });

  it("a null / non-object record is a finding", () => {
    expect(code([null])).toBe("lineage-event-invalid");
    expect(code([42])).toBe("lineage-event-invalid");
    expect(code([rec(1, EXPERIENCE_COMPOSED, null)])).toBe("lineage-event-invalid");
  });

  it("a record that throws when read is a finding, never an exception", () => {
    const hostile = {
      sequence: 1,
      at: "t",
      get type(): string {
        throw new Error("boom");
      },
    };
    expect(code([hostile])).toBe("lineage-event-invalid");
  });

  it("every Lineage read over such a log returns a refusal instead of throwing", async () => {
    const ops = [recorded({ type: "insertNode", parentId: "root", node: deepNode(20_000) })];
    const records = [rec(1, EXPERIENCE_COMPOSED, composedPayload(ops))];
    const stub: LineageStore = {
      append: async (): Promise<AppendOutcome> => ({ ok: false, tip: 1 }),
      read: async () => records,
    };
    const lin = new Lineage({ events: stub, content: new InMemoryContentStore() });
    expect((await lin.state("exp")).ok).toBe(false);
    expect((await lin.head("exp")).ok).toBe(false);
    expect((await lin.verify("exp")).map((f) => f.code)).toEqual(["lineage-event-invalid"]);
    expect((await lin.start(g(), by)).ok).toBe(false);
  });
});

describe("verify does not trust a branch's source (P2-3)", () => {
  async function tamperedSource() {
    const events = new InMemoryLineageStore();
    const content = new InMemoryContentStore();
    const lin = new Lineage({ events, content, now: clock() });
    const v1 = ok(await lin.start(g(), by));
    // forge a head on "exp": the artifact inserts "z" but the recorded ops say "a"
    const z = replay(v1.experience, [ins(node("z", "hz")).op]);
    if (!z.ok) throw new Error("fixture");
    const stored = await putExperience(content, z.value);
    if (!stored.ok) throw new Error("fixture");
    await events.append("exp", 1, {
      type: EXPERIENCE_COMPOSED,
      at: "2026-10-06T00:00:09Z",
      payload: {
        experienceId: "exp",
        versionHash: stored.experience.versionHash,
        ref: stored.ref,
        parents: [v1.experience.versionHash],
        ops: [ins(node("a", "ha"))],
        by,
      },
    });
    return { lin, events, content, v1 };
  }

  it("a branch off a tampered source line reports the source's finding", async () => {
    const { lin, v1 } = await tamperedSource();
    expect((await lin.verify("exp")).map((f) => f.code)).toContain("ops-artifact-mismatch");
    const b = await lin.branch({
      from: { experienceId: "exp", versionHash: v1.experience.versionHash },
      experienceId: "fork",
      by,
    });
    expect(b.ok).toBe(true); // the write path does not re-verify a whole source line
    const findings = await lin.verify("fork");
    expect(findings.map((f) => f.code)).toContain("ops-artifact-mismatch");
    expect(findings.some((f) => f.message.includes('source line "exp"'))).toBe(true);
  });

  it("a clean source verifies clean, and the source is only checked up to carriedFrom", async () => {
    const events = new InMemoryLineageStore();
    const lin = new Lineage({ events, content: new InMemoryContentStore(), now: clock() });
    const v1 = ok(await lin.start(g("clean"), by));
    ok(
      await lin.compose({
        experienceId: "clean",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("a", "h"))],
        by,
      })
    );
    ok(
      await lin.branch({
        from: { experienceId: "clean", versionHash: v1.experience.versionHash },
        experienceId: "fork",
        by,
      })
    );
    expect(await lin.verify("fork")).toEqual([]);
    // the source later grows a forged head: the branch carried classes only up to its fork point
    const clean = ok(await lin.resolveLatest("clean"));
    await events.append("clean", 2, {
      type: EXPERIENCE_COMPOSED,
      at: "2026-10-06T00:00:09Z",
      payload: {
        experienceId: "clean",
        versionHash: "sha256:bogus",
        ref: { __loomContent: "missing" },
        parents: [clean.versionHash],
        ops: [ins(node("q", "hq"))],
        by,
      },
    });
    expect(await lin.verify("fork")).toEqual([]);
    expect((await lin.verify("clean")).length).toBeGreaterThan(0);
  });

  it("carriedFrom must be the forked version or a descendant of it on the source line", async () => {
    const events = new InMemoryLineageStore();
    const content = new InMemoryContentStore();
    const lin = new Lineage({ events, content, now: clock() });
    const v1 = ok(await lin.start(g("src"), by));
    const v2 = ok(
      await lin.compose({
        experienceId: "src",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("a", "h"))],
        by,
      })
    );
    // forge a branch of v2 whose carriedFrom is the OLDER v1 (it would launder v2's classes)
    const adopted = seal(
      branchArtifact(v2.experience, v1.experience, "fork", { by, at: "2026-10-06T00:00:09Z" })
    );
    const stored = await putExperience(content, adopted);
    if (!stored.ok) throw new Error("fixture");
    await events.append("fork", 0, {
      type: EXPERIENCE_BRANCHED,
      at: "2026-10-06T00:00:09Z",
      payload: {
        experienceId: "fork",
        versionHash: adopted.versionHash,
        ref: stored.ref,
        parents: adopted.parents,
        from: { experienceId: "src", versionHash: v2.experience.versionHash },
        carriedFrom: v1.experience.versionHash,
        by,
      },
    });
    expect((await lin.verify("fork")).map((f) => f.code)).toContain("branch-carried-from-invalid");
  });

  it("a forged branch cycle (a forks b forks a) terminates with a finding or clean", async () => {
    const events = new InMemoryLineageStore();
    const content = new InMemoryContentStore();
    const lin = new Lineage({ events, content, now: clock() });
    const a = ok(await lin.start(g("a"), by));
    const b = ok(
      await lin.branch({
        from: { experienceId: "a", versionHash: a.experience.versionHash },
        experienceId: "b",
        by,
      })
    );
    // a second line "a" version forked from b: a (v2) = branch of b
    const adopted = seal(
      branchArtifact(b.experience, b.experience, "a", { by, at: "2026-10-06T00:00:09Z" })
    );
    const stored = await putExperience(content, adopted);
    if (!stored.ok) throw new Error("fixture");
    await events.append("a", 1, {
      type: EXPERIENCE_BRANCHED,
      at: "2026-10-06T00:00:09Z",
      payload: {
        experienceId: "a",
        versionHash: adopted.versionHash,
        ref: stored.ref,
        parents: adopted.parents,
        from: { experienceId: "b", versionHash: b.experience.versionHash },
        carriedFrom: b.experience.versionHash,
        by,
      },
    });
    await expect(lin.verify("b")).resolves.toBeInstanceOf(Array);
  });
});

describe("authorization: declassify is a per-call host argument, meta is derived (P2-4, P3)", () => {
  const classOf = (e: Experience, h: string) => e.handleClasses?.[h];

  async function withSecret(lin: Lineage) {
    const v1 = ok(await lin.start(g(), by));
    return ok(
      await lin.compose({
        experienceId: "exp",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("a", "h", "secret"))],
        by,
      })
    );
  }
  const declassify: RecordedOperation = {
    op: { type: "declassifyHandle", handle: "h" },
    by,
    at: "t",
  };

  it("a constructor-level allowDeclassify is NOT honoured (the flag is gone)", async () => {
    const lin = new Lineage({
      events: new InMemoryLineageStore(),
      content: new InMemoryContentStore(),
      allowDeclassify: true,
    } as never);
    const v2 = await withSecret(lin);
    const r = await lin.compose({
      experienceId: "exp",
      expectedHead: v2.experience.versionHash,
      ops: [declassify],
      by,
    });
    expect(!r.ok && r.refusal.kind === "refused" && r.refusal.finding.code).toBe(
      "declassify-not-allowed"
    );
  });

  it("per-call allowDeclassify lowers the class, and verify() of that line is clean", async () => {
    const lin = new Lineage({
      events: new InMemoryLineageStore(),
      content: new InMemoryContentStore(),
      now: clock(),
    });
    const v2 = await withSecret(lin);
    const v3 = ok(
      await lin.compose({
        experienceId: "exp",
        expectedHead: v2.experience.versionHash,
        ops: [declassify],
        by,
        allowDeclassify: true,
      })
    );
    expect(classOf(v3.experience, "h")).toBeUndefined();
    expect(await lin.verify("exp")).toEqual([]); // was a false `ops-refused`
  });

  it("the per-call flag on advance is also honoured and is not sticky across calls", async () => {
    const lin = new Lineage({
      events: new InMemoryLineageStore(),
      content: new InMemoryContentStore(),
      now: clock(),
    });
    const v2 = await withSecret(lin);
    const next = replay(v2.experience, [declassify.op], { allowDeclassify: true });
    if (!next.ok) throw new Error("fixture");
    const head = v2.experience.versionHash;
    const denied = await lin.advance({
      experienceId: "exp",
      expectedHead: head,
      artifact: next.value,
      ops: [declassify],
      by,
    });
    expect(!denied.ok && denied.refusal.kind === "refused" && denied.refusal.finding.code).toBe(
      "ops-refused"
    );
    expect(
      (
        await lin.advance({
          experienceId: "exp",
          expectedHead: head,
          artifact: next.value,
          ops: [declassify],
          by,
          allowDeclassify: true,
        })
      ).ok
    ).toBe(true);
  });

  it("the stored artifact's meta derives from `by` and the clock, not from the caller's claim", async () => {
    const lin = new Lineage({
      events: new InMemoryLineageStore(),
      content: new InMemoryContentStore(),
      now: clock(),
    });
    const v1 = ok(await lin.start(g(), { source: "user", agentId: "agent-7" }));
    const next = replay(v1.experience, [ins(node("a", "h")).op]);
    if (!next.ok) throw new Error("fixture");
    const forged = {
      ...next.value,
      meta: { author: "mallory", createdAt: "1999-01-01T00:00:00Z", sourceKind: "forged" },
    };
    const v2 = ok(
      await lin.advance({
        experienceId: "exp",
        expectedHead: v1.experience.versionHash,
        artifact: forged,
        ops: [ins(node("a", "h"))],
        by: { source: "user", agentId: "agent-9" },
      })
    );
    expect(v2.experience.meta.author).toBe("agent-9");
    expect(v2.experience.meta.createdAt.startsWith("2026-10-06")).toBe(true);
    expect(ok(await lin.get("exp", v2.experience.versionHash)).meta.author).toBe("agent-9");
    expect(v1.experience.meta.author).toBe("agent-7");
    expect(await lin.verify("exp")).toEqual([]);
  });
});

describe("the EventStore adapter's conflict detection (P3-1)", () => {
  it("a same-NAME error that is not an instance of ours is a lost CAS, not a throw", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = Object.create(inner) as InMemoryAsyncEventStore;
    store.append = async () => {
      throw Object.assign(new Error("duplicate"), { name: "DuplicateSequenceError" });
    };
    const out = await eventStoreLineageStore(store).append("l", 0, {
      type: EXPERIENCE_COMPOSED,
      payload: {},
      at: "2026-10-06T00:00:00Z",
    });
    expect(out.ok).toBe(false);
  });

  it("any other error is still an infrastructure failure and propagates", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = Object.create(inner) as InMemoryAsyncEventStore;
    store.append = async () => {
      throw new Error("disk on fire");
    };
    await expect(
      eventStoreLineageStore(store).append("l", 0, {
        type: EXPERIENCE_COMPOSED,
        payload: {},
        at: "2026-10-06T00:00:00Z",
      })
    ).rejects.toThrow("disk on fire");
  });
});

describe("the commit retry path", () => {
  it("a promotion slipping in between read and append retries at the new tip", async () => {
    const inner = new InMemoryLineageStore();
    let armed = false;
    let slipped = 0;
    const store: LineageStore = {
      read: (id) => inner.read(id),
      async append(id, expected, record: LineageRecord) {
        if (armed) {
          armed = false;
          const [first] = await inner.read(id);
          const p = first?.payload as { versionHash: string; ref: unknown };
          await inner.append(id, expected, {
            type: EXPERIENCE_PROMOTED,
            at: "2026-10-06T00:00:05Z",
            payload: { ref: p.ref, experienceId: id, versionHash: p.versionHash, by },
          });
          slipped++;
          return { ok: false, tip: expected + 1 };
        }
        return inner.append(id, expected, record);
      },
    };
    const lin = new Lineage({ events: store, content: new InMemoryContentStore(), now: clock() });
    const v1 = ok(await lin.start(g(), by));
    armed = true;
    const v2 = ok(
      await lin.compose({
        experienceId: "exp",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("a", "h"))],
        by,
      })
    );
    expect(slipped).toBe(1);
    expect(ok(await lin.head("exp"))).toBe(v2.experience.versionHash);
    expect(ok(await lin.state("exp")).promoted).toBe(v1.experience.versionHash);
    expect(ok(await lin.state("exp")).sequence).toBe(3);
    expect(await lin.verify("exp")).toEqual([]);
  });
});
