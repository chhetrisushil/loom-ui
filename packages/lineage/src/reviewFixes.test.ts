import {
  type Provenance,
  type RecordedOperation,
  type SeenSnapshot,
  type SemanticNode,
  genesis,
  seenToState,
  snapshotSeen,
} from "@loom-ui/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  type ContentRef,
  type ContentStore,
  InMemoryContentStore,
  contentAddress,
  encodeValue,
} from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { Lineage, type LineageResult } from "./lineage";
import { SeenLog, type SeenResult, VIEW_RECORDED, seenStoreOptions } from "./seen";
import {
  InMemorySeenKeyStore,
  deriveSeenKeys,
  refAad,
  sealRef,
  seenKeySubject,
} from "./seenCrypto";
import {
  InMemoryLineageStore,
  LINEAGE_STREAM_PREFIX,
  type LineageStore,
  eventStoreLineageStore,
} from "./store";

// The U12 round-1 review findings, one test each (each fails with its fix reverted).

const user: Provenance = { source: "user" };
const meta = { author: "a", createdAt: "2026-10-06T00:00:00Z", sourceKind: "prompt" };
const g = (id: string) =>
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
const rec = (op: RecordedOperation["op"], by: Provenance = user): RecordedOperation => ({
  op,
  by,
  at: "2026-10-06T00:00:00Z",
});
const ins = (n: SemanticNode, by = user) =>
  rec({ type: "insertNode", parentId: "root", node: n }, by);
function ok<T>(r: LineageResult<T> | SeenResult<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  return r.value;
}
const code = (r: { ok: boolean; refusal?: unknown }): string | undefined => {
  const f = r.refusal as { code?: string; finding?: { code: string } } | undefined;
  return f?.code ?? f?.finding?.code;
};

/** A store that counts `get`s. */
class CountingContent implements ContentStore {
  gets = 0;
  readonly inner = new InMemoryContentStore();
  put(b: Uint8Array) {
    return this.inner.put(b);
  }
  async get(r: ContentRef) {
    this.gets++;
    return this.inner.get(r);
  }
  delete(r: ContentRef) {
    return this.inner.delete(r);
  }
}
class CountingEvents implements LineageStore {
  reads = 0;
  constructor(readonly inner: LineageStore) {}
  append(a: string, b: number, c: Parameters<LineageStore["append"]>[2]) {
    return this.inner.append(a, b, c);
  }
  read(a: string) {
    this.reads++;
    return this.inner.read(a);
  }
}

const mk = (content: ContentStore = new InMemoryContentStore()) => {
  const events = new CountingEvents(new InMemoryLineageStore());
  return { lineage: new Lineage({ events, content }), events, content };
};

describe("P1-1: a seen entry is judged by what its nodes bind", () => {
  async function forge() {
    const { lineage, content } = mk();
    const v1 = ok(await lineage.start(g("e"), user));
    const v2 = ok(
      await lineage.compose({
        experienceId: "e",
        expectedHead: v1.experience.versionHash,
        by: user,
        ops: [ins(node("pub", "pubh")), ins(node("s", "sec", "secret"))],
      })
    );
    const log = new SeenLog({
      keys: new InMemorySeenKeyStore(),
      events: new InMemoryLineageStore(),
      content,
      lineage,
    });
    return { lineage, content, log, exp: v2.experience };
  }

  it("a secret source listed under a public node reads back to nobody without clearance", async () => {
    const { log, exp } = await forge();
    const snapshot: SeenSnapshot = {
      experienceId: "e",
      versionHash: exp.versionHash,
      omitted: 0,
      restricted: false,
      entries: [
        {
          source: { kind: "handle", handle: "sec" },
          nodeIds: ["pub"],
          class: "unclassified",
          state: "seen",
          value: { ssn: "123" },
        },
      ],
    };
    ok(
      await log.record({
        experienceId: "e",
        viewerId: "v",
        snapshot,
        viewer: { clearance: "secret" },
      })
    );
    const r = ok(await log.read({ experienceId: "e", viewerId: "v" }));
    expect(r.views[0]?.entries).toEqual([]);
    expect(seenToState(r.views[0]?.entries ?? []).values.sec).toBeUndefined();
    // even a fully cleared reader gets no value for it: the entry is withheld, not re-classed
    const cleared = ok(
      await log.read({ experienceId: "e", viewerId: "v", reader: { clearance: "secret" } })
    );
    expect(cleared.views[0]?.entries).toEqual([]);
  });

  it("an entry with no nodes is withheld, and record refuses a snapshot naming a source twice", async () => {
    const { log, exp } = await forge();
    const e = (nodeIds: string[], value: unknown, cls: "unclassified" | "secret") => ({
      source: { kind: "handle" as const, handle: "pubh" },
      nodeIds,
      class: cls,
      state: "seen" as const,
      value,
    });
    const base = {
      experienceId: "e",
      versionHash: exp.versionHash,
      omitted: 0,
      restricted: false,
    };
    const dup = await log.record({
      experienceId: "e",
      viewerId: "w",
      snapshot: {
        ...base,
        entries: [e(["pub"], "public", "unclassified"), e(["s"], "TOPSECRET", "secret")],
      },
      viewer: { clearance: "secret" },
    });
    expect(dup.ok).toBe(false);
    expect(code(dup as never)).toBe("seen-duplicate-source");
    const none = await log.record({
      experienceId: "e",
      viewerId: "x",
      snapshot: { ...base, entries: [e([], "v", "unclassified")] },
      viewer: { clearance: "secret" },
    });
    expect(ok(none)).toMatchObject({ recorded: true });
    expect(ok(await log.read({ experienceId: "e", viewerId: "x" })).views[0]?.entries).toEqual([]);
  });

  it("a stored record with duplicate sources does not cross-wire values: refs go by position", async () => {
    const { log, content, exp } = await forge();
    const events = new InMemoryLineageStore();
    const keys = new InMemorySeenKeyStore();
    const log2 = new SeenLog({
      keys,
      events,
      content,
      lineage: (log as never as { lineage: Lineage }).lineage,
    });
    const ra = await content.put(encodeValue("A"));
    const rb = await content.put(encodeValue("B"));
    const dk = deriveSeenKeys(await keys.getOrCreate(seenKeySubject("e/v")));
    const entry = (nodeId: string, ref: ContentRef, idx: number) => ({
      source: { kind: "handle", handle: "pubh" },
      nodeIds: [nodeId],
      class: "unclassified",
      state: "seen",
      sealed: sealRef(dk.enc, refAad("e", "v", 1, idx), ref, 1),
    });
    // hand-written (hostile) manifest: the same source twice; the second names a secret node
    await events.append("e/v", 0, {
      type: VIEW_RECORDED,
      at: "2026-10-06T00:00:00Z",
      payload: {
        experienceId: "e",
        versionHash: exp.versionHash,
        viewerId: "v",
        entries: [entry("pub", ra, 0), entry("s", rb, 1)],
        omitted: 0,
        restricted: false,
        digest: "d",
      },
    });
    const r = ok(await log2.read({ experienceId: "e", viewerId: "v" }));
    // the second entry's node "s" binds `sec`, not `pubh`: withheld; the first keeps ITS value
    expect(r.views[0]?.entries.map((x) => x.value)).toEqual(["A"]);
  });
});

describe("P1-2: an invalid provenance is refused before the append, and the line stays readable", () => {
  const long = "d".repeat(300);
  const cases: Array<[string, Provenance, Provenance]> = [
    ["decisionId too long on the op", user, { source: "agent", decisionId: long }],
    ["decisionId empty on the op", user, { source: "agent", decisionId: "" }],
    ["decisionId too long on compose", { source: "agent", decisionId: long }, user],
    ["unknown source", { source: "robot" as never }, user],
    ["non-string agentId", { source: "agent", agentId: 5 as never }, user],
  ];
  for (const [label, by, opBy] of cases)
    it(label, async () => {
      const { lineage } = mk();
      const v1 = ok(await lineage.start(g("e"), user));
      const head = v1.experience.versionHash;
      const r = await lineage.compose({
        experienceId: "e",
        expectedHead: head,
        by,
        ops: [ins(node("n", "h"), opBy)],
      });
      expect(r.ok).toBe(false);
      expect(code(r as never)).toBe("provenance-invalid");
      // nothing was written: the line still folds and the head did not move
      expect(ok(await lineage.head("e"))).toBe(head);
      expect(ok(await lineage.verify("e").then((f) => ({ ok: true as const, value: f })))).toEqual(
        []
      );
    });

  it("start, revert, branch and promote refuse it too", async () => {
    const { lineage } = mk();
    const bad = { source: "agent", decisionId: long } as Provenance;
    expect(code((await lineage.start(g("z"), bad)) as never)).toBe("provenance-invalid");
    const v1 = ok(await lineage.start(g("e"), user));
    const v2 = ok(
      await lineage.compose({
        experienceId: "e",
        expectedHead: v1.experience.versionHash,
        by: user,
        ops: [ins(node("n", "h"))],
      })
    );
    expect(
      code(
        (await lineage.revert({
          experienceId: "e",
          expectedHead: v2.experience.versionHash,
          to: v1.experience.versionHash,
          by: bad,
        })) as never
      )
    ).toBe("provenance-invalid");
    expect(
      code(
        (await lineage.branch({
          from: { experienceId: "e", versionHash: v1.experience.versionHash },
          experienceId: "b",
          by: bad,
        })) as never
      )
    ).toBe("provenance-invalid");
    expect(
      code(
        (await lineage.promote({
          experienceId: "e",
          versionHash: v2.experience.versionHash,
          expectedPromoted: null,
          by: bad,
        })) as never
      )
    ).toBe("provenance-invalid");
    expect(ok(await lineage.state("e")).sequence).toBe(2);
    expect(ok(await lineage.head("e"))).toBe(v2.experience.versionHash);
  });
});

describe("P2-1/P2-2: the creating version's floor survives a declassify and a branch", () => {
  async function setup() {
    const { lineage } = mk();
    const v1 = ok(await lineage.start(g("e"), user));
    const v2 = ok(
      await lineage.compose({
        experienceId: "e",
        expectedHead: v1.experience.versionHash,
        by: user,
        summary: "SUMMARY-TEXT",
        summaryClass: "internal",
        ops: [
          rec({
            type: "prompt",
            text: "PROMPT-TEXT salary of bob",
            materialized: [
              { type: "insertNode", parentId: "root", node: node("a", "h", "secret") },
            ],
          }),
        ],
      })
    );
    const v3 = ok(
      await lineage.compose({
        experienceId: "e",
        expectedHead: v2.experience.versionHash,
        by: user,
        allowDeclassify: true,
        ops: [rec({ type: "declassifyHandle", handle: "h", to: "internal" })],
      })
    );
    return { lineage, v3 };
  }
  const internal = { clearance: "internal" as const };
  const text = (r: unknown) => JSON.stringify(r);

  it("same line: after a declassify an internal viewer still does not get the prompt or summary", async () => {
    const { lineage } = await setup();
    const r = ok(await lineage.explain("e", "a", { viewer: internal }));
    expect(r.available).toBe(true);
    expect(text(r)).not.toContain("PROMPT-TEXT");
    expect(text(r)).not.toContain("SUMMARY-TEXT");
    const secret = ok(await lineage.explain("e", "a", { viewer: { clearance: "secret" } }));
    expect(text(secret)).toContain("PROMPT-TEXT"); // the gate is the floor, not a blanket removal
  });

  it("a branch carries the floor: the writer lives on the SOURCE line", async () => {
    const { lineage, v3 } = await setup();
    ok(
      await lineage.branch({
        from: { experienceId: "e", versionHash: v3.experience.versionHash },
        experienceId: "b",
        by: user,
      })
    );
    const r = ok(await lineage.explain("b", "a", { viewer: internal }));
    expect(r.available).toBe(true);
    expect(text(r)).not.toContain("PROMPT-TEXT");
    expect(text(r)).not.toContain("SUMMARY-TEXT");
    const secret = ok(await lineage.explain("b", "a", { viewer: { clearance: "secret" } }));
    expect(text(secret)).toContain("PROMPT-TEXT");
  });

  it("a branch of a branch resolves the writer through both hops", async () => {
    const { lineage, v3 } = await setup();
    const b1 = ok(
      await lineage.branch({
        from: { experienceId: "e", versionHash: v3.experience.versionHash },
        experienceId: "b",
        by: user,
      })
    );
    ok(
      await lineage.branch({
        from: { experienceId: "b", versionHash: b1.experience.versionHash },
        experienceId: "c",
        by: user,
      })
    );
    const r = ok(await lineage.explain("c", "a", { viewer: internal }));
    expect(r.available).toBe(true);
    expect(text(r)).not.toContain("PROMPT-TEXT");
  });
});

describe("P3-1: explain costs the same for a hidden node and an unknown id", () => {
  it("content.get count is equal", async () => {
    const content = new CountingContent();
    const { lineage } = mk(content);
    const v1 = ok(await lineage.start(g("e"), user));
    ok(
      await lineage.compose({
        experienceId: "e",
        expectedHead: v1.experience.versionHash,
        by: user,
        summary: "S",
        ops: [ins(node("s", "hs", "secret"))],
      })
    );
    const cost = async (id: string) => {
      content.gets = 0;
      const r = ok(await lineage.explain("e", id, { viewer: { clearance: "internal" } }));
      expect(r).toEqual({ available: false });
      return content.gets;
    };
    const hidden = await cost("s");
    const unknown = await cost("ghost");
    expect(hidden).toBe(unknown);
  });
});

describe("P3-2: a read verifies the bytes against the manifest's address", () => {
  it("a store that returns other bytes yields `corrupt`, never the value", async () => {
    const real = new InMemoryContentStore();
    let lie = false;
    const content: ContentStore = {
      put: (b) => real.put(b),
      delete: (r) => real.delete(r),
      get: async (r) =>
        lie && r.__loomContent === contentAddress(encodeValue("REAL"))
          ? encodeValue("FORGED")
          : real.get(r),
    };
    const { lineage } = mk(content);
    const v1 = ok(await lineage.start(g("e"), user));
    const v2 = ok(
      await lineage.compose({
        experienceId: "e",
        expectedHead: v1.experience.versionHash,
        by: user,
        ops: [ins(node("a", "h"))],
      })
    );
    const log = new SeenLog({
      keys: new InMemorySeenKeyStore(),
      events: new InMemoryLineageStore(),
      content,
      lineage,
    });
    ok(
      await log.record({
        experienceId: "e",
        viewerId: "v",
        viewer: { clearance: "secret" },
        snapshot: snapshotSeen(v2.experience, {
          viewer: { clearance: "secret" },
          read: () => ({ found: true, value: "REAL" }),
        }),
      })
    );
    expect(
      ok(await log.read({ experienceId: "e", viewerId: "v" })).views[0]?.entries[0]
    ).toMatchObject({
      state: "seen",
      value: "REAL",
    });
    lie = true;
    const v = ok(await log.read({ experienceId: "e", viewerId: "v" })).views[0]?.entries[0];
    expect(v?.state).toBe("corrupt");
    expect(v && "value" in v).toBe(false);
    expect(contentAddress(encodeValue("REAL"))).toMatch(/^sha256:/);
  });
});

describe("P3-3: stream namespaces", () => {
  const store = new InMemoryAsyncEventStore();
  it("a prefix must live under __loom_ui_ (not the kernel's reserved streams)", () => {
    for (const p of ["__loom_lifecycle__:", "__loom_erasure__:", "__loom_", "x:", "", "__loom_ui_"])
      expect(() => eventStoreLineageStore(store, { streamPrefix: p })).toThrow();
    expect(() => eventStoreLineageStore(store, { streamPrefix: "__loom_ui_mine:" })).not.toThrow();
    expect(() => eventStoreLineageStore(store, { workflowId: "" })).toThrow();
    expect(() => eventStoreLineageStore(store, { workflowId: "a b\n" })).toThrow();
  });

  it("a SeenLog refuses the lineage's own store or its prefix", () => {
    const events = eventStoreLineageStore(store);
    const content = new InMemoryContentStore();
    const lineage = new Lineage({ events, content });
    expect(
      () => new SeenLog({ keys: new InMemorySeenKeyStore(), events, content, lineage })
    ).toThrow(/store of its own/);
    expect(
      () =>
        new SeenLog({
          keys: new InMemorySeenKeyStore(),
          events: eventStoreLineageStore(new InMemoryAsyncEventStore(), {
            streamPrefix: LINEAGE_STREAM_PREFIX,
          }),
          content,
          lineage: new Lineage({ events: new InMemoryLineageStore(), content }),
        })
    ).toThrow();
    expect(
      () =>
        new SeenLog({
          keys: new InMemorySeenKeyStore(),
          events: eventStoreLineageStore(new InMemoryAsyncEventStore(), seenStoreOptions),
          content,
          lineage,
        })
    ).not.toThrow();
  });
});

describe("P3-4: record is total", () => {
  async function setup() {
    const { lineage, content } = mk();
    const v1 = ok(await lineage.start(g("e"), user));
    const log = new SeenLog({
      keys: new InMemorySeenKeyStore(),
      events: new InMemoryLineageStore(),
      content,
      lineage,
    });
    return { log, hash: v1.experience.versionHash };
  }
  it("refuses a non-finite `omitted`, an oversized clearance and a null snapshot", async () => {
    const { log, hash } = await setup();
    const snap = (omitted: number): SeenSnapshot => ({
      experienceId: "e",
      versionHash: hash,
      entries: [],
      omitted,
      restricted: false,
    });
    for (const omitted of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5])
      expect(
        code(
          (await log.record({ experienceId: "e", viewerId: "v", snapshot: snap(omitted) })) as never
        )
      ).toBe("seen-snapshot-invalid");
    const r = await log.record({
      experienceId: "e",
      viewerId: "v",
      snapshot: snap(0),
      viewer: { clearance: "c".repeat(40) as never },
    });
    expect(code(r as never)).toBe("seen-record-invalid");
    const n = await log.record({ experienceId: "e", viewerId: "v", snapshot: null as never });
    expect(code(n as never)).toBe("seen-snapshot-invalid");
    // nothing malformed was written
    expect(ok(await log.read({ experienceId: "e", viewerId: "v" }))).toEqual({
      erased: false,
      views: [],
      malformed: 0,
    });
  });
});

describe("P3-5: a read folds the lineage once", () => {
  it("lineage log reads do not grow with the number of distinct versions", async () => {
    const { lineage, events, content } = mk();
    let head = ok(await lineage.start(g("e"), user)).experience.versionHash;
    const log = new SeenLog({
      keys: new InMemorySeenKeyStore(),
      events: new InMemoryLineageStore(),
      content,
      lineage,
    });
    for (let i = 0; i < 6; i++) {
      const v = ok(
        await lineage.compose({
          experienceId: "e",
          expectedHead: head,
          by: user,
          ops: [ins(node(`n${i}`, `h${i}`))],
        })
      );
      head = v.experience.versionHash;
      ok(
        await log.record({
          experienceId: "e",
          viewerId: "v",
          viewer: { clearance: "secret" },
          snapshot: snapshotSeen(v.experience, {
            viewer: { clearance: "secret" },
            read: () => ({ found: true, value: i }),
          }),
        })
      );
    }
    events.reads = 0;
    const r = ok(await log.read({ experienceId: "e", viewerId: "v", limit: 6 }));
    expect(new Set(r.views.map((v) => v.versionHash)).size).toBe(6);
    expect(events.reads).toBe(1);
  });
});
