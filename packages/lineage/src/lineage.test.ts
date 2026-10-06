import {
  type Experience,
  type Provenance,
  type RecordedOperation,
  type SemanticNode,
  experienceHandles,
  genesis,
  replay,
} from "@loom-ui/core";
import { putExperience, seal } from "@loom-ui/core/log";
import { EXPERIENCE_PROMOTED as PLANNER_PROMOTED } from "@loom-ui/planner";
import { InMemoryAsyncEventStore, isReservedStream } from "@loom/event-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import {
  EXPERIENCE_BRANCHED,
  EXPERIENCE_COMPOSED,
  EXPERIENCE_PROMOTED,
  EXPERIENCE_REVERTED,
} from "./events";
import { Lineage, type LineageResult } from "./lineage";
import {
  InMemoryLineageStore,
  LINEAGE_STREAM_PREFIX,
  type LineageStore,
  eventStoreLineageStore,
} from "./store";

const by: Provenance = { source: "user" };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const g = (id = "exp") =>
  genesis({ experienceId: id, intent: { objective: "o", source: "user" }, meta });
const node = (id: string, handle: string, sensitivity?: "secret" | "internal"): SemanticNode => ({
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
const rm = (nodeId: string): RecordedOperation => ({
  op: { type: "removeNode", nodeId },
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

const backends: Array<[string, () => LineageStore]> = [
  ["in-memory", () => new InMemoryLineageStore()],
  ["over loom's EventStore", () => eventStoreLineageStore(new InMemoryAsyncEventStore())],
];

for (const [name, makeStore] of backends) {
  describe(`Lineage over ${name}`, () => {
    const make = () => {
      const events = makeStore();
      const content = new InMemoryContentStore();
      return { events, content, lin: new Lineage({ events, content, now: clock() }) };
    };

    it("starts a line, composes onto the head, and resolves the latest", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      expect(v1.version.kind).toBe("composed");
      expect(v1.experience.versionHash).toMatch(/^sha256:/);
      const v2 = ok(
        await lin.compose({
          experienceId: "exp",
          expectedHead: v1.experience.versionHash,
          ops: [ins(node("a", "h"))],
          by,
        })
      );
      expect(v2.experience.parents).toEqual([v1.experience.versionHash]);
      expect(ok(await lin.head("exp"))).toBe(v2.experience.versionHash);
      expect(ok(await lin.resolveLatest("exp")).versionHash).toBe(v2.experience.versionHash);
      expect(ok(await lin.versions("exp")).map((v) => v.versionHash)).toEqual([
        v1.experience.versionHash,
        v2.experience.versionHash,
      ]);
      expect(ok(await lin.walk("exp")).map((v) => v.versionHash)).toEqual([
        v2.experience.versionHash,
        v1.experience.versionHash,
      ]);
      expect(await lin.verify("exp")).toEqual([]);
    });

    it("start on an existing line is a typed head-moved, never an overwrite", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      const again = await lin.start(g(), by);
      expect(again).toEqual({
        ok: false,
        refusal: {
          kind: "head-moved",
          expectedHead: null,
          actualHead: v1.experience.versionHash,
        },
      });
    });

    it("a lost race is a typed head-moved carrying the winner; the loser writes nothing", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      const base = v1.experience.versionHash;
      const [a, b] = await Promise.all([
        lin.compose({ experienceId: "exp", expectedHead: base, ops: [ins(node("a", "ha"))], by }),
        lin.compose({ experienceId: "exp", expectedHead: base, ops: [ins(node("b", "hb"))], by }),
      ]);
      const winners = [a, b].filter((r) => r.ok);
      const losers = [a, b].filter((r) => !r.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const win = ok(winners[0] as LineageResult<{ experience: Experience }>);
      const lost = (losers[0] as { ok: false; refusal: unknown }).refusal;
      expect(lost).toEqual({
        kind: "head-moved",
        expectedHead: base,
        actualHead: win.experience.versionHash,
      });
      expect(ok(await lin.versions("exp"))).toHaveLength(2);
    });

    it("an op authored against a stale base is refused even when the head matches (applyAt)", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      const r = await lin.compose({
        experienceId: "exp",
        expectedHead: v1.experience.versionHash,
        ops: [{ ...ins(node("a", "h")), baseVersion: "sha256:old" }],
        by,
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.refusal.kind === "refused" && r.refusal.finding.code).toBe(
        "stale-base-version"
      );
      expect(ok(await lin.versions("exp"))).toHaveLength(1);
    });

    it("advance refuses an artifact the recorded ops do not reproduce, and writes nothing", async () => {
      const { lin, events } = make();
      const v1 = ok(await lin.start(g(), by));
      const head = v1.experience.versionHash;
      // the ops say insert "a"; the artifact actually inserts "z"
      const forged = replay(v1.experience, [ins(node("z", "hz")).op]);
      if (!forged.ok) throw new Error("fixture");
      const r = await lin.advance({
        experienceId: "exp",
        expectedHead: head,
        artifact: forged.value,
        ops: [ins(node("a", "ha"))],
        by,
      });
      expect(!r.ok && r.refusal.kind === "refused" && r.refusal.finding.code).toBe(
        "ops-artifact-mismatch"
      );
      expect(await events.read("exp")).toHaveLength(1);
      expect(ok(await lin.head("exp"))).toBe(head);
    });

    it("advance refuses empty ops after the first version, a wrong parent, and a tampered hash", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      const head = v1.experience.versionHash;
      const next = replay(v1.experience, [ins(node("a", "h")).op]);
      if (!next.ok) throw new Error("fixture");
      const code = (r: LineageResult<unknown>) =>
        !r.ok && r.refusal.kind === "refused" ? r.refusal.finding.code : "ok";
      expect(
        code(
          await lin.advance({
            experienceId: "exp",
            expectedHead: head,
            artifact: next.value,
            ops: [],
            by,
          })
        )
      ).toBe("empty-ops");
      expect(
        code(
          await lin.advance({
            experienceId: "exp",
            expectedHead: head,
            artifact: { ...next.value, parents: ["sha256:other"] },
            ops: [ins(node("a", "h"))],
            by,
          })
        )
      ).toBe("artifact-parent-mismatch");
      expect(
        code(
          await lin.advance({
            experienceId: "exp",
            expectedHead: head,
            artifact: { ...next.value, versionHash: "sha256:bogus" },
            ops: [ins(node("a", "h"))],
            by,
          })
        )
      ).toBe("artifact-tampered");
      // the honest advance of the same artifact still works
      expect(
        (
          await lin.advance({
            experienceId: "exp",
            expectedHead: head,
            artifact: next.value,
            ops: [ins(node("a", "h"))],
            by,
          })
        ).ok
      ).toBe(true);
    });

    it("a recorded declassify is refused unless the host allows it", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      const withClass = ok(
        await lin.compose({
          experienceId: "exp",
          expectedHead: v1.experience.versionHash,
          ops: [ins(node("a", "h", "secret"))],
          by,
        })
      );
      const r = await lin.compose({
        experienceId: "exp",
        expectedHead: withClass.experience.versionHash,
        ops: [{ op: { type: "declassifyHandle", handle: "h" }, by, at: "t" }],
        by,
      });
      expect(!r.ok && r.refusal.kind === "refused" && r.refusal.finding.code).toBe(
        "declassify-not-allowed"
      );
    });

    it("revert appends a NEW version with the old content; history is intact and a revert can be reverted", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      const v2 = ok(
        await lin.compose({
          experienceId: "exp",
          expectedHead: v1.experience.versionHash,
          ops: [ins(node("a", "h"))],
          by,
        })
      );
      const r = ok(
        await lin.revert({
          experienceId: "exp",
          expectedHead: v2.experience.versionHash,
          to: v1.experience.versionHash,
          by,
        })
      );
      expect(r.version.kind).toBe("reverted");
      expect(r.experience.parents).toEqual([v2.experience.versionHash]);
      expect(r.experience.root).toEqual(v1.experience.root);
      expect(r.experience.versionHash).not.toBe(v1.experience.versionHash);
      expect(ok(await lin.versions("exp"))).toHaveLength(3);
      // v2 is still readable: nothing was rewritten
      expect(ok(await lin.get("exp", v2.experience.versionHash)).root).toEqual(v2.experience.root);
      // revert the revert = get v2's content back, as a fourth version
      const back = ok(
        await lin.revert({
          experienceId: "exp",
          expectedHead: r.experience.versionHash,
          to: v2.experience.versionHash,
          by,
        })
      );
      expect(back.experience.root).toEqual(v2.experience.root);
      expect(await lin.verify("exp")).toEqual([]);
    });

    it("revert refuses the head, an unknown version, and a stale head", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      const h = v1.experience.versionHash;
      const code = (r: LineageResult<unknown>) =>
        r.ok ? "ok" : r.refusal.kind === "refused" ? r.refusal.finding.code : r.refusal.kind;
      expect(code(await lin.revert({ experienceId: "exp", expectedHead: h, to: h, by }))).toBe(
        "revert-to-head"
      );
      expect(
        code(await lin.revert({ experienceId: "exp", expectedHead: h, to: "sha256:nope", by }))
      ).toBe("version-unknown");
      expect(
        code(await lin.revert({ experienceId: "exp", expectedHead: "sha256:old", to: h, by }))
      ).toBe("head-moved");
    });

    it("undo is a revert to the parent; the first version has nothing to undo", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      const none = await lin.undo({
        experienceId: "exp",
        expectedHead: v1.experience.versionHash,
        by,
      });
      expect(!none.ok && none.refusal.kind === "refused" && none.refusal.finding.code).toBe(
        "nothing-to-undo"
      );
      const v2 = ok(
        await lin.compose({
          experienceId: "exp",
          expectedHead: v1.experience.versionHash,
          ops: [ins(node("a", "h"))],
          by,
        })
      );
      const u = ok(
        await lin.undo({ experienceId: "exp", expectedHead: v2.experience.versionHash, by })
      );
      expect(u.version.revertedTo).toBe(v1.experience.versionHash);
      expect(u.experience.root).toEqual(v1.experience.root);
    });

    describe("security: sticky classes survive revert and branch (fail-closed)", () => {
      const classOf = (e: Experience, h: string) =>
        experienceHandles(e).find((u) => u.handle === h)?.sensitivity;

      it("a class learned AFTER the target and since removed is kept by a revert to before it", async () => {
        const { lin } = make();
        const v1 = ok(await lin.start(g(), by));
        const v2 = ok(
          await lin.compose({
            experienceId: "exp",
            expectedHead: v1.experience.versionHash,
            ops: [ins(node("a", "h", "secret"))],
            by,
          })
        );
        const v3 = ok(
          await lin.compose({
            experienceId: "exp",
            expectedHead: v2.experience.versionHash,
            ops: [rm("a")],
            by,
          })
        );
        // v3's tree has no classified node; its sticky map holds the class
        expect(v3.experience.handleClasses).toEqual({ h: "secret" });
        const r = ok(
          await lin.revert({
            experienceId: "exp",
            expectedHead: v3.experience.versionHash,
            to: v1.experience.versionHash,
            by,
          })
        );
        expect(r.experience.handleClasses).toEqual({ h: "secret" });
        // a plain re-insert of the handle after the revert still reads secret
        const v5 = ok(
          await lin.compose({
            experienceId: "exp",
            expectedHead: r.experience.versionHash,
            ops: [ins(node("b", "h"))],
            by,
          })
        );
        expect(classOf(v5.experience, "h")).toBe("secret");
      });

      it("a class held ONLY by the head's live nodes is written into the reverted version's sticky map", async () => {
        const { lin } = make();
        const v1 = ok(await lin.start(g(), by));
        const v2 = ok(
          await lin.compose({
            experienceId: "exp",
            expectedHead: v1.experience.versionHash,
            ops: [ins(node("a", "h", "secret"))],
            by,
          })
        );
        // v2 has NO sticky residue (the live node implies it); a naive revert to v1 would lose it
        expect(v2.experience.handleClasses?.h).toBe("secret");
        const r = ok(
          await lin.revert({
            experienceId: "exp",
            expectedHead: v2.experience.versionHash,
            to: v1.experience.versionHash,
            by,
          })
        );
        expect(r.experience.handleClasses).toEqual({ h: "secret" });
        const v4 = ok(
          await lin.compose({
            experienceId: "exp",
            expectedHead: r.experience.versionHash,
            ops: [ins(node("c", "h"))],
            by,
          })
        );
        expect(classOf(v4.experience, "h")).toBe("secret");
      });

      it("a revert never LOWERS: reverting past a trusted declassify re-raises the class", async () => {
        const events = new InMemoryLineageStore();
        const lin = new Lineage({
          events,
          content: new InMemoryContentStore(),
          now: clock(),
        });
        const v1 = ok(await lin.start(g(), by));
        const v2 = ok(
          await lin.compose({
            experienceId: "exp",
            expectedHead: v1.experience.versionHash,
            ops: [ins(node("a", "h", "secret"))],
            by,
          })
        );
        const v3 = ok(
          await lin.compose({
            experienceId: "exp",
            expectedHead: v2.experience.versionHash,
            ops: [{ op: { type: "declassifyHandle", handle: "h" }, by, at: "t" }],
            by,
            allowDeclassify: true,
          })
        );
        expect(classOf(v3.experience, "h")).toBeUndefined();
        const r = ok(
          await lin.revert({
            experienceId: "exp",
            expectedHead: v3.experience.versionHash,
            to: v2.experience.versionHash,
            by,
          })
        );
        expect(classOf(r.experience, "h")).toBe("secret");
      });

      it("tool and projection classes are carried too", async () => {
        const { lin } = make();
        const v1 = ok(await lin.start(g(), by));
        const withProj = ok(
          await lin.compose({
            experienceId: "exp",
            expectedHead: v1.experience.versionHash,
            ops: [
              {
                op: {
                  type: "insertNode",
                  parentId: "root",
                  node: {
                    ...node("p", "ignored"),
                    binding: undefined,
                    projection: { id: "proj", path: "p", version: "1", sensitivity: "secret" },
                  } as unknown as SemanticNode,
                },
                by,
                at: "t",
              },
            ],
            by,
          })
        );
        const r = ok(
          await lin.revert({
            experienceId: "exp",
            expectedHead: withProj.experience.versionHash,
            to: v1.experience.versionHash,
            by,
          })
        );
        expect(r.experience.projectionClasses).toEqual({ proj: "secret" });
      });

      it("a branch of an OLD version carries the classes the source learned since", async () => {
        const { lin } = make();
        const v1 = ok(await lin.start(g(), by));
        const v2 = ok(
          await lin.compose({
            experienceId: "exp",
            expectedHead: v1.experience.versionHash,
            ops: [ins(node("a", "h", "secret"))],
            by,
          })
        );
        const b = ok(
          await lin.branch({
            from: { experienceId: "exp", versionHash: v1.experience.versionHash },
            experienceId: "fork",
            by,
          })
        );
        expect(b.experience.experienceId).toBe("fork");
        expect(b.experience.parents).toEqual([v1.experience.versionHash]);
        expect(b.experience.handleClasses).toEqual({ h: "secret" });
        expect(b.version.kind).toBe("branched");
        expect(b.version.carriedFrom).toBe(v2.experience.versionHash);
        const c = ok(
          await lin.compose({
            experienceId: "fork",
            expectedHead: b.experience.versionHash,
            ops: [ins(node("n", "h"))],
            by,
          })
        );
        expect(classOf(c.experience, "h")).toBe("secret");
        expect(await lin.verify("fork")).toEqual([]);
      });
    });

    it("branch makes an independent line; the source is untouched; an existing line is refused", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      const from = { experienceId: "exp", versionHash: v1.experience.versionHash };
      const b = ok(await lin.branch({ from, experienceId: "fork", by }));
      expect(ok(await lin.head("fork"))).toBe(b.experience.versionHash);
      expect(ok(await lin.head("exp"))).toBe(v1.experience.versionHash);
      const again = await lin.branch({ from, experienceId: "fork", by });
      expect(!again.ok && again.refusal.kind).toBe("head-moved");
      const same = await lin.branch({ from, experienceId: "exp", by });
      expect(!same.ok && same.refusal.kind === "refused" && same.refusal.finding.code).toBe(
        "branch-same-line"
      );
      const unknown = await lin.branch({
        from: { experienceId: "exp", versionHash: "sha256:x" },
        experienceId: "f2",
        by,
      });
      expect(
        !unknown.ok && unknown.refusal.kind === "refused" && unknown.refusal.finding.code
      ).toBe("version-unknown");
      // walking the fork stops at its root: the parent lives in another line
      expect(ok(await lin.walk("fork")).map((v) => v.kind)).toEqual(["branched"]);
    });

    it("promote is compare-and-set on the shown pointer and names only known versions", async () => {
      const { lin } = make();
      const v1 = ok(await lin.start(g(), by));
      const v2 = ok(
        await lin.compose({
          experienceId: "exp",
          expectedHead: v1.experience.versionHash,
          ops: [ins(node("a", "h"))],
          by,
        })
      );
      const h1 = v1.experience.versionHash;
      const h2 = v2.experience.versionHash;
      expect((await lin.resolvePromoted("exp")).ok).toBe(false);
      ok(await lin.promote({ experienceId: "exp", versionHash: h1, expectedPromoted: null, by }));
      expect(ok(await lin.resolvePromoted("exp")).versionHash).toBe(h1);
      const stale = await lin.promote({
        experienceId: "exp",
        versionHash: h2,
        expectedPromoted: null,
        by,
      });
      expect(!stale.ok && stale.refusal).toEqual({
        kind: "promoted-moved",
        expectedPromoted: null,
        actualPromoted: h1,
      });
      ok(await lin.promote({ experienceId: "exp", versionHash: h2, expectedPromoted: h1, by }));
      const unknown = await lin.promote({
        experienceId: "exp",
        versionHash: "sha256:x",
        expectedPromoted: h2,
        by,
      });
      expect(!unknown.ok && unknown.refusal.kind === "refused").toBe(true);
      // a promotion does not move the head, and a compose after one still advances
      expect(ok(await lin.head("exp"))).toBe(h2);
      ok(
        await lin.compose({
          experienceId: "exp",
          expectedHead: h2,
          ops: [ins(node("b", "hb"))],
          by,
        })
      );
    });

    it("verify() reports a stored version whose ops disagree with its artifact", async () => {
      const { lin, events, content } = make();
      const v1 = ok(await lin.start(g(), by));
      const head = v1.experience.versionHash;
      // forge: a version whose artifact inserts "z" but whose recorded ops say "a"
      const z = replay(v1.experience, [ins(node("z", "hz")).op]);
      if (!z.ok) throw new Error("fixture");
      const stored = await putExperience(content, z.value);
      if (!stored.ok) throw new Error("fixture");
      const tip = (await events.read("exp")).length;
      await events.append("exp", tip, {
        type: EXPERIENCE_COMPOSED,
        at: "2026-10-06T00:00:09Z",
        payload: {
          experienceId: "exp",
          versionHash: stored.experience.versionHash,
          ref: stored.ref,
          parents: [head],
          ops: [ins(node("a", "ha"))],
          by,
        },
      });
      const findings = await lin.verify("exp");
      expect(findings.map((f) => f.code)).toContain("ops-artifact-mismatch");
    });

    it("verify() reports a blob swapped under a logged ref, and a log with a forged parent", async () => {
      const { lin, events, content } = make();
      const v1 = ok(await lin.start(g(), by));
      const other = await putExperience(content, seal(g("elsewhere")));
      if (!other.ok) throw new Error("fixture");
      // a version event pointing at a blob of a different experience
      await events.append("exp", 1, {
        type: EXPERIENCE_COMPOSED,
        at: "t",
        payload: {
          experienceId: "exp",
          versionHash: other.experience.versionHash,
          ref: other.ref,
          parents: [v1.experience.versionHash],
          ops: [ins(node("a", "h"))],
          by,
        },
      });
      expect((await lin.verify("exp")).map((f) => f.code)).toContain("artifact-mismatch");
      // a parent that is not the head is a structural finding from the fold itself
      await events.append("exp", 2, {
        type: EXPERIENCE_COMPOSED,
        at: "t",
        payload: {
          experienceId: "exp",
          versionHash: "sha256:x",
          ref: other.ref,
          parents: ["sha256:not-the-head"],
          ops: [],
          by,
        },
      });
      expect((await lin.verify("exp")).map((f) => f.code)).toEqual(["lineage-parent-mismatch"]);
      expect((await lin.head("exp")).ok).toBe(false);
    });

    it("verify() reports a blob that is missing from the content store", async () => {
      const { lin, content } = make();
      ok(await lin.start(g(), by));
      const [v] = ok(await lin.versions("exp"));
      await content.delete(v?.ref as never);
      expect((await lin.verify("exp")).map((x) => x.code)).toContain("artifact-missing");
    });
  });
}

describe("the event vocabulary", () => {
  it("EXPERIENCE_PROMOTED is spelled exactly as the planner's", () => {
    expect(EXPERIENCE_PROMOTED).toBe(PLANNER_PROMOTED);
  });
  it("the four types are distinct", () => {
    expect(
      new Set([EXPERIENCE_COMPOSED, EXPERIENCE_REVERTED, EXPERIENCE_BRANCHED, EXPERIENCE_PROMOTED])
        .size
    ).toBe(4);
  });
});

describe("the EventStore adapter", () => {
  it("keeps lineage streams in a reserved namespace real-execution enumerators skip", async () => {
    const store = new InMemoryAsyncEventStore();
    const lin = new Lineage({
      events: eventStoreLineageStore(store),
      content: new InMemoryContentStore(),
    });
    ok(await lin.start(g("zz"), by));
    const all = (await store.listExecutions?.()) ?? [];
    expect(all).toEqual(["__loom_ui_lineage__:zz"]);
    // the namespace IS loom's reserved one (a non-`__loom_` prefix would be mistaken for an execution)
    expect(isReservedStream(`${LINEAGE_STREAM_PREFIX}zz`)).toBe(true);
    const events = await store.read("__loom_ui_lineage__:zz");
    expect(events.map((e) => [e.eventType, e.sequence])).toEqual([[EXPERIENCE_COMPOSED, 1]]);
  });

  it("a writer that races the adapter past its tip check still loses the CAS, not the log", async () => {
    const store = new InMemoryAsyncEventStore({ latencyMs: 1 });
    const adapter = eventStoreLineageStore(store);
    const outs = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        adapter.append("r", 0, {
          type: EXPERIENCE_COMPOSED,
          payload: { i },
          at: "2026-10-06T00:00:00Z",
        })
      )
    );
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
    expect(await adapter.read("r")).toHaveLength(1);
  });
});

describe("a composed version keeps the author's summary (U7)", () => {
  const make = () => {
    const events = new InMemoryLineageStore();
    return {
      events,
      lin: new Lineage({ events, content: new InMemoryContentStore(), now: clock() }),
    };
  };

  it("records it bounded and control-stripped, readable on the version record, and verify stays clean", async () => {
    const { lin } = make();
    const v1 = ok(await lin.start(g(), by));
    const c = ok(
      await lin.compose({
        experienceId: "exp",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("m1", "h1"))],
        by,
        summary: `added a tile\n\u202e${"z".repeat(5000)}`,
      })
    );
    expect(c.version.summary).toBeDefined();
    expect(c.version.summary).not.toMatch(/[\n\u202e]/);
    expect([...(c.version.summary as string)].length).toBeLessThanOrEqual(600);
    const listed = await lin.versions("exp");
    expect(listed.ok && listed.value.at(-1)?.summary).toBe(c.version.summary);
    expect(await lin.verify("exp")).toEqual([]);
  });

  it("has none when none was given or it is blank, and a hostile logged summary is bounded on read", async () => {
    const { lin, events } = make();
    const v1 = ok(await lin.start(g(), by));
    const c = ok(
      await lin.compose({
        experienceId: "exp",
        expectedHead: v1.experience.versionHash,
        ops: [ins(node("m1", "h1"))],
        by,
        summary: "   ",
      })
    );
    expect(c.version.summary).toBeUndefined();
    const rows = await events.read("exp");
    const last = rows.at(-1);
    // Forge a record whose summary is huge and control-laden (anyone with append access could).
    const forged = { ...(last?.payload as object), summary: `x\n${"q".repeat(100000)}` };
    const tip = rows.length;
    await events.append("exp", tip, {
      type: EXPERIENCE_COMPOSED,
      payload: { ...forged, versionHash: "forged", parents: [c.experience.versionHash] },
      at: "2026-10-06T00:00:00Z",
    });
    const state = await lin.versions("exp");
    expect(state.ok).toBe(true);
    const forgedVersion = state.ok ? state.value.at(-1) : undefined;
    expect(forgedVersion?.versionHash).toBe("forged");
    expect([...(forgedVersion?.summary ?? "")].length).toBeLessThanOrEqual(600);
    expect(forgedVersion?.summary).not.toContain("\n");
  });
});
