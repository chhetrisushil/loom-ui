import {
  InMemoryAsyncEventStore,
  isKeyUnavailable,
  isPayloadShredded,
} from "@loomwork/event-runtime";
import {
  type ContentAccess,
  type ContentRef,
  type ContentStore,
  InMemoryContentStore,
  sweepUnpinnedContent,
} from "@loomwork/plugin-content";
import {
  EncryptingContentStore,
  EncryptingEventStore,
  InMemoryKeyStore,
} from "@loomwork/plugin-crypto";
import {
  type Provenance,
  type RecordedOperation,
  type SemanticNode,
  genesis,
} from "@loomwork/ui-core";
import { describe, expect, it } from "vitest";
import { LINEAGE_SENSITIVE_PATHS, registerLineageSensitivePaths } from "./events";
import { LineErasedError, LineUnreadableError, Lineage, type LineageResult } from "./lineage";
import { rootsFor } from "./rootsFor";
import { SeenLog } from "./seen";
import { InMemorySeenKeyStore } from "./seenCrypto";
import { collectSeenGarbage } from "./seenGc";
import {
  InMemoryLineageStore,
  LINEAGE_STREAM_PREFIX,
  LINEAGE_WORKFLOW_ID,
  eventStoreLineageStore,
} from "./store";

// ── Crypto-shred erasure of a lineage line ────────────────────────────────────────────────────
// A host maps a line's STREAM id to its owner's erasure subject in the `subjectOf` it gives BOTH the
// `EncryptingEventStore` and the `EncryptingContentStore`; destroying that key makes the line's
// events and artifact blobs unreadable, and every read then fails closed with a typed outcome.

const T0 = "2026-11-01T00:00:00Z";
const meta = { author: "a", createdAt: T0, sourceKind: "prompt" };
const g = (id: string) =>
  genesis({ experienceId: id, intent: { objective: "o", source: "user" }, meta });
const ANN: Provenance = { source: "user", ref: "ann-ref-7731" };
const BOB: Provenance = { source: "user", ref: "bob-ref-9042" };
const SECRET_PROP = "ann-diagnosis-hypertension";
const SECRET_LABEL = "ann-private-label";
const SECRET_SUMMARY = "ann-summary-from-her-documents";
const BOB_SECRET = "bob-private-note";

const node = (id: string, props: Record<string, unknown>): SemanticNode => ({
  id,
  order: id,
  kind: "semantic",
  type: "Metric",
  typeVersion: "1.0.0",
  span: 6,
  props,
  binding: { handle: `h-${id}`, priority: "P1" },
});
const rec = (op: RecordedOperation["op"], by: Provenance): RecordedOperation => ({
  op,
  by,
  at: T0,
});
function ok<T>(r: LineageResult<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  return r.value;
}
const codeOf = (r: LineageResult<unknown>): string | undefined =>
  !r.ok && r.refusal.kind === "refused" ? r.refusal.finding.code : undefined;
const erasedRefusal = (r: LineageResult<unknown>) => expect(codeOf(r)).toBe("line-erased");

const stream = (id: string) => `${LINEAGE_STREAM_PREFIX}${id}`;

/** Records every blob put (the bytes the RAW store would hold), and can corrupt reads. */
class RawContent implements ContentStore {
  readonly clock = { now: 0 };
  readonly inner = new InMemoryContentStore({ now: () => this.clock.now });
  readonly puts: string[] = [];
  corrupt = false;
  async put(bytes: Uint8Array, _access?: ContentAccess): Promise<ContentRef> {
    this.puts.push(new TextDecoder("latin1").decode(bytes));
    return this.inner.put(bytes);
  }
  async get(ref: ContentRef): Promise<Uint8Array | null> {
    const b = await this.inner.get(ref);
    if (b === null || !this.corrupt) return b;
    const c = new Uint8Array(b);
    c[c.length - 1] = (c[c.length - 1] as number) ^ 0xff;
    return c;
  }
  delete(ref: ContentRef) {
    return this.inner.delete(ref);
  }
  touch(addresses: readonly string[]) {
    return this.inner.touch?.(addresses) ?? Promise.resolve([]);
  }
}

function setup(owners: Record<string, string>, opts: { confirm?: boolean } = {}) {
  const keys = new InMemoryKeyStore();
  const subjectOf = (e: { executionId: string }): string =>
    owners[e.executionId.slice(LINEAGE_STREAM_PREFIX.length)] ?? e.executionId;
  const raw = new InMemoryAsyncEventStore();
  const events = new EncryptingEventStore(raw, keys, { sensitive: {}, subjectOf });
  registerLineageSensitivePaths(events);
  const rawContent = new RawContent();
  const content = new EncryptingContentStore(rawContent, keys, { subjectOf });
  const lineage = new Lineage({
    events: eventStoreLineageStore(events),
    content,
    now: () => T0,
    // the host's confirmation: its KeyStore recorded the destruction of the owner's key
    ...(opts.confirm !== false && {
      confirmErased: async (id: string) =>
        (await keys.wasDestroyed?.(subjectOf({ executionId: stream(id) }))) === true,
    }),
  });
  return { keys, raw, events, rawContent, content, lineage, subjectOf };
}

type World = ReturnType<typeof setup>;

/** Ann's line: start, compose (with props and a summary), compose (label), revert, promote. */
async function writeAnn(w: World, id = "exp-ann") {
  const l = w.lineage;
  const start = ok(await l.start(g(id), ANN));
  const c1 = ok(
    await l.compose({
      experienceId: id,
      expectedHead: start.version.versionHash,
      ops: [
        rec(
          {
            type: "insertNode",
            parentId: "root",
            node: node("n1", { note: SECRET_PROP }),
          },
          ANN
        ),
      ],
      by: ANN,
      summary: SECRET_SUMMARY,
    })
  );
  const c2 = ok(
    await l.compose({
      experienceId: id,
      expectedHead: c1.version.versionHash,
      ops: [
        rec({ type: "setLabel", nodeId: "n1", label: { key: "k", fallback: SECRET_LABEL } }, ANN),
      ],
      by: ANN,
    })
  );
  const rev = ok(
    await l.revert({
      experienceId: id,
      expectedHead: c2.version.versionHash,
      to: c1.version.versionHash,
      by: ANN,
    })
  );
  ok(
    await l.promote({
      experienceId: id,
      versionHash: c1.version.versionHash,
      expectedPromoted: null,
      by: ANN,
    })
  );
  return { start, c1, c2, rev };
}

async function rawDump(w: World, id: string): Promise<string> {
  return JSON.stringify(await w.raw.read(stream(id)));
}

describe("lineage erasure: what is stored", () => {
  it("holds no plaintext prop, label, summary or by in the raw event or content store", async () => {
    const w = setup({ "exp-ann": "user:ann" });
    await writeAnn(w);
    ok(
      await w.lineage.branch({
        from: {
          experienceId: "exp-ann",
          versionHash: (ok(await w.lineage.versions("exp-ann"))[1] as { versionHash: string })
            .versionHash,
        },
        experienceId: "exp-ann-fork",
        by: ANN,
      })
    );

    const dump = await rawDump(w, "exp-ann");
    for (const secret of [SECRET_PROP, SECRET_LABEL, SECRET_SUMMARY, "ann-ref-7731"]) {
      expect(dump).not.toContain(secret);
      for (const blob of w.rawContent.puts) expect(blob).not.toContain(secret);
    }
    expect(w.rawContent.puts.length).toBeGreaterThan(0);
    // identifiers stay plain, so the log's structure survives
    expect(dump).toContain("versionHash");
    expect(await w.keys.get("user:ann")).not.toBeNull();
    expect(await w.keys.get(stream("exp-ann"))).toBeNull();
    // the reader, with the key, still sees everything
    expect(JSON.stringify(ok(await w.lineage.versions("exp-ann")))).toContain(SECRET_SUMMARY);
  });

  it("a plain stack (no crypto) does hold them: the check above is not vacuous", async () => {
    const raw = new InMemoryAsyncEventStore();
    const lineage = new Lineage({
      events: eventStoreLineageStore(raw),
      content: new InMemoryContentStore(),
      now: () => T0,
    });
    const start = ok(await lineage.start(g("exp-p"), ANN));
    ok(
      await lineage.compose({
        experienceId: "exp-p",
        expectedHead: start.version.versionHash,
        ops: [rec({ type: "insertNode", parentId: "root", node: node("n1", {}) }, ANN)],
        by: ANN,
        summary: SECRET_SUMMARY,
      })
    );
    expect(JSON.stringify(await raw.read(stream("exp-p")))).toContain(SECRET_SUMMARY);
  });

  it("seals only the text paths: every path is on a real payload field", () => {
    expect(LINEAGE_SENSITIVE_PATHS.EXPERIENCE_COMPOSED).toEqual(["ops", "summary", "by"]);
    for (const t of ["EXPERIENCE_REVERTED", "EXPERIENCE_BRANCHED", "EXPERIENCE_PROMOTED"] as const)
      expect(LINEAGE_SENSITIVE_PATHS[t]).toEqual(["by"]);
  });

  it("derives the access from the store's stream prefix and workflow id", async () => {
    const seen: ContentAccess[] = [];
    const spy: ContentStore = {
      put: (b, a) => {
        if (a) seen.push(a);
        return new InMemoryContentStore().put(b);
      },
      get: async () => null,
      delete: async () => undefined,
    };
    const mem = new InMemoryAsyncEventStore();
    const a = new Lineage({
      events: eventStoreLineageStore(mem, {
        streamPrefix: "__loom_ui_custom__:",
        workflowId: "wf.x",
      }),
      content: spy,
    });
    ok(await a.start(g("e1"), ANN));
    const b = new Lineage({ events: new InMemoryLineageStore(), content: spy });
    ok(await b.start(g("e2"), ANN));
    expect(seen).toEqual([
      { executionId: "__loom_ui_custom__:e1", workflowId: "wf.x" },
      { executionId: `${LINEAGE_STREAM_PREFIX}e2`, workflowId: LINEAGE_WORKFLOW_ID },
    ]);
  });
});

describe("lineage erasure: after the owner's key is destroyed", () => {
  async function erased() {
    const w = setup({ "exp-ann": "user:ann", "exp-ann-fork": "user:ann", "exp-bob": "user:bob" });
    const ann = await writeAnn(w);
    ok(
      await w.lineage.branch({
        from: { experienceId: "exp-ann", versionHash: ann.c1.version.versionHash },
        experienceId: "exp-ann-fork",
        by: ANN,
      })
    );
    await w.keys.destroy("user:ann");
    return { w, ann };
  }

  it("every read refuses with line-erased (never a crash)", async () => {
    const { w, ann } = await erased();
    const l = w.lineage;
    const h = ann.c1.version.versionHash;
    erasedRefusal(await l.state("exp-ann"));
    erasedRefusal(await l.head("exp-ann"));
    erasedRefusal(await l.versions("exp-ann"));
    erasedRefusal(await l.walk("exp-ann"));
    erasedRefusal(await l.get("exp-ann", h));
    erasedRefusal(await l.resolveLatest("exp-ann"));
    erasedRefusal(await l.resolvePromoted("exp-ann"));
    erasedRefusal(await l.provenance("exp-ann"));
    erasedRefusal(await l.explain("exp-ann", "n1"));
    erasedRefusal(await l.getMany("exp-ann", [h]));
    erasedRefusal(await l.cite("exp-ann", [h]));
    erasedRefusal(await l.state("exp-ann-fork"));
    const findings = await l.verify("exp-ann");
    expect(findings.map((f) => f.code)).toEqual(["line-erased"]);
  });

  it("the plain-value reads skip a confirmed-erased line and throw LineUnreadableError when unconfirmed", async () => {
    const { w } = await erased();
    // confirmed (the hook says so): skipped, nothing thrown
    await w.lineage.forEachContentRef(() => undefined);
    for await (const _ of w.lineage.pins()) void _;
    // the same destroyed key WITHOUT a confirmation hook: refuse rather than guess
    const u = setup({ "exp-ann": "user:ann" }, { confirm: false });
    await writeAnn(u);
    await u.keys.destroy("user:ann");
    const err = await u.lineage
      .forEachContentRef(() => undefined)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(LineUnreadableError);
    expect((err as LineUnreadableError).code).toBe("line-unreadable");
    expect((err as LineUnreadableError).experienceId).toBe("exp-ann");
    await expect(
      (async () => {
        for await (const _ of u.lineage.pins()) void _;
      })()
    ).rejects.toBeInstanceOf(LineUnreadableError);
    // the single-line read throws the confirmed class
    const one = await w.lineage.block(
      "exp-ann",
      await w.events.read(stream("exp-ann")).then(
        () => undefined,
        (e: unknown) => e
      )
    );
    expect(one).toBeInstanceOf(LineErasedError);
  });

  it("every write is refused typed", async () => {
    const { w, ann } = await erased();
    const l = w.lineage;
    const head = ann.rev.version.versionHash;
    erasedRefusal(
      await l.compose({
        experienceId: "exp-ann",
        expectedHead: head,
        ops: [rec({ type: "setLabel", nodeId: "n1", label: null }, ANN)],
        by: ANN,
      })
    );
    erasedRefusal(
      await l.revert({
        experienceId: "exp-ann",
        expectedHead: head,
        to: ann.c1.version.versionHash,
        by: ANN,
      })
    );
    erasedRefusal(await l.undo({ experienceId: "exp-ann", expectedHead: head, by: ANN }));
    erasedRefusal(
      await l.promote({
        experienceId: "exp-ann",
        versionHash: head,
        expectedPromoted: ann.c1.version.versionHash,
        by: ANN,
      })
    );
    erasedRefusal(await l.start(g("exp-ann"), ANN));
    // a new line owned by the erased subject cannot be minted either: its key is never re-minted
    erasedRefusal(
      await l.branch({
        from: { experienceId: "exp-ann", versionHash: ann.c1.version.versionHash },
        experienceId: "exp-bob",
        by: BOB,
      })
    );
    const owned = setup({ "exp-x": "user:ann" });
    await owned.keys.getOrCreate("user:ann");
    await owned.keys.destroy("user:ann");
    erasedRefusal(await owned.lineage.start(g("exp-x"), ANN));
  });

  it("the ciphertext is still stored but holds no plaintext", async () => {
    const { w } = await erased();
    const dump = await rawDump(w, "exp-ann");
    expect(dump.length).toBeGreaterThan(100);
    for (const s of [SECRET_PROP, SECRET_LABEL, SECRET_SUMMARY]) expect(dump).not.toContain(s);
  });

  it("the errors it recognises are the kernel's predicates, for events and for blobs", async () => {
    const { w, ann } = await erased();
    const e1 = await w.events.read(stream("exp-ann")).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(isKeyUnavailable(e1) || isPayloadShredded(e1)).toBe(true);
    const e2 = await w.content
      .get(ann.c1.version.ref, { executionId: stream("exp-ann"), workflowId: LINEAGE_WORKFLOW_ID })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(isPayloadShredded(e2)).toBe(true);
  });
});

describe("lineage erasure: scoped to the owner", () => {
  it("a second line owned by another subject stays fully readable and writable", async () => {
    const w = setup({ "exp-ann": "user:ann", "exp-bob": "user:bob" });
    const ann = await writeAnn(w);
    const l = w.lineage;
    const bs = ok(await l.start(g("exp-bob"), BOB));
    const b1 = ok(
      await l.compose({
        experienceId: "exp-bob",
        expectedHead: bs.version.versionHash,
        ops: [
          rec(
            { type: "insertNode", parentId: "root", node: node("b1", { note: BOB_SECRET }) },
            BOB
          ),
        ],
        by: BOB,
        summary: "bob summary",
      })
    );
    await w.keys.destroy("user:ann");
    erasedRefusal(await l.head("exp-ann"));
    expect(ok(await l.head("exp-bob"))).toBe(b1.version.versionHash);
    expect(JSON.stringify(ok(await l.resolveLatest("exp-bob")))).toContain(BOB_SECRET);
    expect(ok(await l.versions("exp-bob")).length).toBe(2);
    expect(await l.verify("exp-bob")).toEqual([]);
    ok(
      await l.compose({
        experienceId: "exp-bob",
        expectedHead: b1.version.versionHash,
        ops: [rec({ type: "setLabel", nodeId: "b1", label: null }, BOB)],
        by: BOB,
      })
    );
    void ann;
  });

  it("a branch from Ann's line into Bob's survives Ann's erasure (re-put under Bob)", async () => {
    const w = setup({ "exp-ann": "user:ann", "exp-bob": "user:bob" });
    const ann = await writeAnn(w);
    const l = w.lineage;
    const fork = ok(
      await l.branch({
        from: { experienceId: "exp-ann", versionHash: ann.c1.version.versionHash },
        experienceId: "exp-bob",
        by: BOB,
      })
    );
    expect(await l.verify("exp-bob")).toEqual([]);
    // sealed under Bob, not Ann: a different address from anything Ann holds
    const annRefs = new Set<string>();
    await l.forEachContentRef((a) => annRefs.add(a));
    const bobRef = fork.version.ref.__loomContent;
    expect(ok(await l.versions("exp-ann")).some((v) => v.ref.__loomContent === bobRef)).toBe(false);

    await w.keys.destroy("user:ann");
    erasedRefusal(await l.head("exp-ann"));
    expect(ok(await l.head("exp-bob"))).toBe(fork.version.versionHash);
    expect(ok(await l.resolveLatest("exp-bob")).experienceId).toBe("exp-bob");
    expect(ok(await l.provenance("exp-bob"))).toBeDefined();
    // the source is gone, so the fork is attested by its address alone and says so
    const findings = await l.verify("exp-bob");
    expect(findings.map((f) => f.code)).toEqual(["branch-source-erased"]);
    expect(findings[0]?.severity).toBe("warn");
    // and the line still takes writes, which verify normally
    const c = ok(
      await l.compose({
        experienceId: "exp-bob",
        expectedHead: fork.version.versionHash,
        ops: [
          rec({ type: "setLabel", nodeId: "n1", label: { key: "k", fallback: "bob label" } }, BOB),
        ],
        by: BOB,
      })
    );
    expect(ok(await l.head("exp-bob"))).toBe(c.version.versionHash);
    expect((await l.verify("exp-bob")).map((f) => f.code)).toEqual(["branch-source-erased"]);
  });

  it("branching Ann's version into Bob's line does not need Ann's key on Bob's reads", async () => {
    const w = setup({ "exp-ann": "user:ann", "exp-bob": "user:bob" });
    const ann = await writeAnn(w);
    ok(
      await w.lineage.branch({
        from: { experienceId: "exp-ann", versionHash: ann.c1.version.versionHash },
        experienceId: "exp-bob",
        by: BOB,
      })
    );
    // Bob's blob opens under Bob's access only
    const bobHead = ok(await w.lineage.versions("exp-bob"))[0] as { ref: ContentRef };
    await expect(
      w.content.get(bobHead.ref, {
        executionId: stream("exp-ann"),
        workflowId: LINEAGE_WORKFLOW_ID,
      })
    ).rejects.toThrow();
  });
});

describe("lineage erasure: blobs alone", () => {
  it("an erased artifact blob refuses line-erased even when the events are plain", async () => {
    const keys = new InMemoryKeyStore();
    const content = new EncryptingContentStore(new InMemoryContentStore(), keys, {
      subjectOf: () => "user:ann",
    });
    const events = eventStoreLineageStore(new InMemoryAsyncEventStore());
    const l = new Lineage({
      events,
      content,
      now: () => T0,
      confirmErased: async () => (await keys.wasDestroyed?.("user:ann")) === true,
    });
    const start = ok(await l.start(g("e"), ANN));
    expect(ok(await l.head("e"))).toBe(start.version.versionHash);
    await keys.destroy("user:ann");
    expect(ok(await l.head("e"))).toBe(start.version.versionHash); // events are plain: still there
    erasedRefusal(await l.resolveLatest("e"));
    erasedRefusal(await l.get("e", start.version.versionHash));
    expect((await l.verify("e")).map((f) => f.code)).toEqual(["line-erased"]);
    erasedRefusal(
      await l.compose({
        experienceId: "e",
        expectedHead: start.version.versionHash,
        ops: [rec({ type: "insertNode", parentId: "root", node: node("n", {}) }, ANN)],
        by: ANN,
      })
    );
    // confirmed erased: the line contributes no roots, GC is not blocked
    const roots: string[] = [];
    for await (const a of l.pins()) roots.push(a);
    expect(roots).toEqual([]);
  });

  it("blobs erased, events plain: the line's own artifacts are dropped, a shared blob its ops cite stays rooted", async () => {
    // The conservative side of the asymmetry: an address the plain events cite OUTSIDE the line's
    // own artifacts may belong to someone else, so erasing this line's blobs must not unroot it.
    const keys = new InMemoryKeyStore();
    const content = new EncryptingContentStore(new InMemoryContentStore(), keys, {
      subjectOf: () => "user:ann",
    });
    const events = eventStoreLineageStore(new InMemoryAsyncEventStore());
    const l = new Lineage({
      events,
      content,
      now: () => T0,
      confirmErased: async () => (await keys.wasDestroyed?.("user:ann")) === true,
    });
    const SHARED = "shared-blob-address";
    const start = ok(await l.start(g("e"), ANN));
    const c1 = ok(
      await l.compose({
        experienceId: "e",
        expectedHead: start.version.versionHash,
        ops: [
          rec(
            {
              type: "insertNode",
              parentId: "root",
              node: node("n", { image: { __loomContent: SHARED } }),
            },
            ANN
          ),
        ],
        by: ANN,
      })
    );
    const own = [start.version.ref, c1.version.ref].map(
      (r) => (r as { __loomContent: string }).__loomContent
    );
    await keys.destroy("user:ann");
    const roots: string[] = [];
    for await (const a of l.pins()) roots.push(a);
    expect(roots).toContain(SHARED);
    for (const a of own) expect(roots).not.toContain(a);
  });
});

describe("lineage erasure: negative control", () => {
  it("a corrupted blob with the key PRESENT is not reported as erased", async () => {
    const w = setup({ "exp-ann": "user:ann" });
    const ann = await writeAnn(w);
    w.rawContent.corrupt = true;
    // typed, but never an erasure: the key is present and nothing was confirmed erased
    const r = await w.lineage.get("exp-ann", ann.c1.version.versionHash);
    expect(codeOf(r)).toBe("artifact-unsealed");
    expect(codeOf(r)).not.toBe("line-erased");
  });

  it("a corrupted sealed event with the key PRESENT propagates its own error, not an erasure", async () => {
    // An envelope whose seal marker is gone, so the cipher failure surfaces as itself. (A tampered
    // envelope that KEEPS its seal marker is classified by loom as `KeyUnavailableError`, "this node
    // cannot open it": that is indistinguishable from an absent key, and reads as line-erased.)
    const w = setup({ "exp-ann": "user:ann" });
    await writeAnn(w);
    const real = w.raw.read.bind(w.raw);
    w.raw.read = (async (id: string) => {
      const out = await real(id);
      return out.map((e, i) => {
        if (i !== 0) return e;
        const by = (e.payload as { by: { data: string } }).by;
        const { seal: _seal, ...metadata } = (e.metadata ?? {}) as Record<string, unknown>;
        return {
          ...e,
          metadata,
          payload: { ...(e.payload as object), by: { ...by, data: `${by.data.slice(0, 4)}AAAA` } },
        };
      });
    }) as typeof w.raw.read;
    const err = await w.lineage.head("exp-ann").then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LineErasedError);
    expect(isKeyUnavailable(err) || isPayloadShredded(err)).toBe(false);
  });
});

// ── confirmed erasure vs an unreadable line ───────────────────────────────────────────────────────
const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

async function twoOwners(confirm: boolean) {
  const w = setup({ "exp-ann": "user:ann", "exp-bob": "user:bob" }, { confirm });
  w.rawContent.clock.now = NOW - 60 * DAY;
  const ann = await writeAnn(w);
  const l = w.lineage;
  const bs = ok(await l.start(g("exp-bob"), BOB));
  const b1 = ok(
    await l.compose({
      experienceId: "exp-bob",
      expectedHead: bs.version.versionHash,
      ops: [
        rec({ type: "insertNode", parentId: "root", node: node("b1", { note: BOB_SECRET }) }, BOB),
      ],
      by: BOB,
    })
  );
  const refs = async (id: string) =>
    ok(await l.versions(id)).map((v) => (v.ref as ContentRef).__loomContent);
  const annRefs = await refs("exp-ann");
  const bobRefs = await refs("exp-bob");
  w.rawContent.clock.now = NOW;
  const sweep = () =>
    sweepUnpinnedContent({
      eventStores: [],
      contentStore: w.rawContent.inner,
      pinnedEventTypes: [],
      olderThanMs: 30 * DAY,
      now: NOW,
      roots: () => rootsFor({ lineages: [{ lineage: l }] }),
      reclaimOrphans: { completeScan: true },
    });
  const present = async (a: string) =>
    (await w.rawContent.inner.get({ __loomContent: a })) !== null;
  return { w, ann, b1, annRefs, bobRefs, sweep, present };
}

describe("lineage erasure: GC liveness", () => {
  it("a CONFIRMED-erased line contributes no roots: Bob stays rooted and Ann's blobs are reclaimed", async () => {
    const t = await twoOwners(true);
    await t.w.keys.destroy("user:ann");
    const roots = new Set<string>();
    for await (const a of rootsFor({ lineages: [{ lineage: t.w.lineage }] })) roots.add(a);
    for (const a of t.bobRefs) expect(roots.has(a)).toBe(true);
    for (const a of t.annRefs) expect(roots.has(a)).toBe(false);
    await t.sweep();
    for (const a of t.annRefs) expect(await t.present(a)).toBe(false);
    for (const a of t.bobRefs) expect(await t.present(a)).toBe(true);
    // Bob is still fully readable after the sweep
    expect(JSON.stringify(ok(await t.w.lineage.resolveLatest("exp-bob")))).toContain(BOB_SECRET);
    // forEachContentRef skips the erased line as well
    const seen: string[] = [];
    await t.w.lineage.forEachContentRef((a) => seen.push(a));
    for (const a of t.annRefs) expect(seen).not.toContain(a);
  });

  it("an unreadable line that is NOT confirmed erased still makes GC refuse", async () => {
    const t = await twoOwners(false);
    await t.w.keys.destroy("user:ann");
    await expect(
      (async () => {
        for await (const _ of rootsFor({ lineages: [{ lineage: t.w.lineage }] })) void _;
      })()
    ).rejects.toBeInstanceOf(LineUnreadableError);
    await expect(t.sweep()).rejects.toBeInstanceOf(LineUnreadableError);
    for (const a of t.annRefs) expect(await t.present(a)).toBe(true); // nothing was deleted
  });

  it("collectSeenGarbage proceeds past a confirmed erasure and refuses an unconfirmed one", async () => {
    for (const confirm of [true, false]) {
      const t = await twoOwners(confirm);
      await t.w.keys.destroy("user:ann");
      const content = new InMemoryContentStore({ now: () => NOW });
      const log = new SeenLog({
        events: new InMemoryLineageStore(),
        content,
        lineage: t.w.lineage,
        keys: new InMemorySeenKeyStore(),
      });
      const r = await collectSeenGarbage(log, { graceMs: 1000, ownsContentStore: true });
      if (confirm) expect(r.ok).toBe(true);
      else {
        expect(r.ok).toBe(false);
        expect(!r.ok && r.refusal.code).toBe("gc-roots-unavailable");
      }
    }
  });

  it("Bob's branch from Ann verifies with a branch-source-erased warn, before and after the sweep", async () => {
    const t = await twoOwners(true);
    const l = t.w.lineage;
    ok(
      await l.branch({
        from: { experienceId: "exp-ann", versionHash: t.ann.c1.version.versionHash },
        experienceId: "exp-fork",
        by: BOB,
      })
    );
    await t.w.keys.destroy("user:ann");
    const codes = async () => (await l.verify("exp-fork")).map((f) => `${f.code}:${f.severity}`);
    expect(await codes()).toEqual(["branch-source-erased:warn"]);
    await t.sweep();
    expect(await codes()).toEqual(["branch-source-erased:warn"]);
  });

  it("a confirmed-erased source whose EVENTS were deleted too still reads as branch-source-erased", async () => {
    const t = await twoOwners(true);
    const l = t.w.lineage;
    ok(
      await l.branch({
        from: { experienceId: "exp-ann", versionHash: t.ann.c1.version.versionHash },
        experienceId: "exp-fork",
        by: BOB,
      })
    );
    await t.w.keys.destroy("user:ann");
    const real = t.w.raw.read.bind(t.w.raw);
    t.w.raw.read = (async (id: string, ...rest: unknown[]) =>
      id === stream("exp-ann")
        ? []
        : (real as (...a: unknown[]) => unknown)(id, ...rest)) as typeof t.w.raw.read;
    const findings = await l.verify("exp-fork");
    expect(findings.map((f) => `${f.code}:${f.severity}`)).toEqual(["branch-source-erased:warn"]);
  });
});

describe("lineage erasure: unreadable is not erased", () => {
  const tamper = (w: World) => {
    const real = w.raw.read.bind(w.raw);
    w.raw.read = (async (id: string) =>
      (await real(id)).map((e) => {
        const by = (e.payload as { by: { data: string } }).by;
        return {
          ...e,
          payload: {
            ...(e.payload as object),
            by: { ...by, data: `${by.data.slice(0, 6)}AAAA${by.data.slice(10)}` },
          },
        };
      })) as typeof w.raw.read;
  };

  it("without a confirmation hook a destroyed key is line-unreadable, never line-erased", async () => {
    const w = setup({ "exp-ann": "user:ann" }, { confirm: false });
    await writeAnn(w);
    await w.keys.destroy("user:ann");
    const r = await w.lineage.head("exp-ann");
    expect(codeOf(r)).toBe("line-unreadable");
    expect((await w.lineage.verify("exp-ann")).map((f) => f.code)).toEqual(["line-unreadable"]);
    expect(codeOf(await w.lineage.start(g("exp-ann"), ANN))).toBe("line-unreadable");
  });

  it("a tampered sealed event (key present) is line-unreadable even with the hook; a branch over it errors", async () => {
    const w = setup({ "exp-ann": "user:ann", "exp-bob": "user:bob" });
    const ann = await writeAnn(w);
    ok(
      await w.lineage.branch({
        from: { experienceId: "exp-ann", versionHash: ann.c1.version.versionHash },
        experienceId: "exp-bob",
        by: BOB,
      })
    );
    const realRead = w.raw.read.bind(w.raw);
    tamper(w);
    const annOnly = w.raw.read.bind(w.raw);
    w.raw.read = (async (id: string) =>
      id === stream("exp-ann") ? annOnly(id) : realRead(id)) as typeof w.raw.read;
    expect(codeOf(await w.lineage.head("exp-ann"))).toBe("line-unreadable");
    const f = await w.lineage.verify("exp-bob");
    expect(f.some((x) => x.severity === "error" && x.code === "line-unreadable")).toBe(true);
    expect(f.some((x) => x.code === "branch-source-erased")).toBe(false);
  });

  it("a drifted subjectOf is line-unreadable, never line-erased", async () => {
    const keys = new InMemoryKeyStore();
    let subj = "user:ann";
    const subjectOf = () => subj;
    const raw = new InMemoryAsyncEventStore();
    const ee = new EncryptingEventStore(raw, keys, { sensitive: {}, subjectOf });
    registerLineageSensitivePaths(ee);
    const l = new Lineage({
      events: eventStoreLineageStore(ee),
      content: new EncryptingContentStore(new InMemoryContentStore(), keys, { subjectOf }),
      now: () => T0,
      confirmErased: async () => (await keys.wasDestroyed?.(subj)) === true,
    });
    ok(await l.start(g("x"), ANN));
    await keys.getOrCreate("user:other");
    subj = "user:other";
    expect(codeOf(await l.head("x"))).toBe("line-unreadable");
    expect((await l.verify("x")).map((f) => f.code)).toEqual(["line-unreadable"]);
  });

  it("a plaintext line opened through a sealing store is typed, with a distinct code, never erased", async () => {
    const inner = new InMemoryContentStore();
    const evs = new InMemoryAsyncEventStore();
    const plain = new Lineage({
      events: eventStoreLineageStore(evs),
      content: inner,
      now: () => T0,
    });
    const start = ok(await plain.start(g("old"), ANN));
    const keys = new InMemoryKeyStore();
    const subjectOf = () => "user:ann";
    const ee = new EncryptingEventStore(evs, keys, { sensitive: {}, subjectOf });
    registerLineageSensitivePaths(ee);
    const sealed = new Lineage({
      events: eventStoreLineageStore(ee),
      content: new EncryptingContentStore(inner, keys, { subjectOf }),
      now: () => T0,
      confirmErased: async () => (await keys.wasDestroyed?.("user:ann")) === true,
    });
    // key present (minted by a write elsewhere): the plaintext blob does not open
    await keys.getOrCreate("user:ann");
    expect(codeOf(await sealed.resolveLatest("old"))).toBe("artifact-unsealed");
    expect((await sealed.verify("old")).map((f) => f.code)).toEqual(["artifact-unsealed"]);
    // no key at all: unreadable, still not erased (nothing was destroyed)
    const bare = new InMemoryKeyStore();
    const noKey = new Lineage({
      events: eventStoreLineageStore(evs),
      content: new EncryptingContentStore(inner, bare, { subjectOf }),
      now: () => T0,
      confirmErased: async () => (await bare.wasDestroyed?.("user:ann")) === true,
    });
    const r = await noKey.resolveLatest("old");
    expect(codeOf(r)).not.toBe("line-erased");
    expect(["line-unreadable", "artifact-unsealed"]).toContain(codeOf(r));
    void start;
  });
});

describe("lineage erasure: construction and write races", () => {
  it("fails closed at construction when the content store seals but the events store has no prefix", () => {
    const content = new EncryptingContentStore(new InMemoryContentStore(), new InMemoryKeyStore(), {
      subjectOf: () => "user:ann",
    });
    expect(() => new Lineage({ events: new InMemoryLineageStore(), content })).toThrow(
      /sealsContent|streamPrefix/
    );
    expect(
      () => new Lineage({ events: eventStoreLineageStore(new InMemoryAsyncEventStore()), content })
    ).not.toThrow();
  });

  it("a key destroyed between state() and append returns the typed refusal, not the key store's error", async () => {
    const w = setup({ "exp-ann": "user:ann" });
    const ann = await writeAnn(w);
    const store = w.events as unknown as { append: (...a: unknown[]) => Promise<unknown> };
    store.append = async (...a: unknown[]) => {
      await w.keys.destroy("user:ann");
      throw new Error("key store: subject destroyed"); // untyped, as a key store may raise it
    };
    const r = await w.lineage.compose({
      experienceId: "exp-ann",
      expectedHead: ann.rev.version.versionHash,
      ops: [rec({ type: "setLabel", nodeId: "n1", label: null }, ANN)],
      by: ANN,
    });
    erasedRefusal(r);
  });

  it("an append failure on a still-readable line rethrows", async () => {
    const w = setup({ "exp-ann": "user:ann" });
    const ann = await writeAnn(w);
    const store = w.events as unknown as { append: (...a: unknown[]) => Promise<unknown> };
    store.append = async () => {
      throw new Error("disk full");
    };
    await expect(
      w.lineage.compose({
        experienceId: "exp-ann",
        expectedHead: ann.rev.version.versionHash,
        ops: [rec({ type: "setLabel", nodeId: "n1", label: null }, ANN)],
        by: ANN,
      })
    ).rejects.toThrow("disk full");
  });
});
