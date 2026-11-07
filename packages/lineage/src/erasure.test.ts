import { type Provenance, type RecordedOperation, type SemanticNode, genesis } from "@loom-ui/core";
import { InMemoryAsyncEventStore, isKeyUnavailable, isPayloadShredded } from "@loom/event-runtime";
import {
  type ContentAccess,
  type ContentRef,
  type ContentStore,
  InMemoryContentStore,
} from "@loom/plugin-content";
import {
  EncryptingContentStore,
  EncryptingEventStore,
  InMemoryKeyStore,
} from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { LINEAGE_SENSITIVE_PATHS, registerLineageSensitivePaths } from "./events";
import { LineErasedError, Lineage, type LineageResult } from "./lineage";
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
  readonly inner = new InMemoryContentStore();
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

function setup(owners: Record<string, string>) {
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
  });
  return { keys, raw, events, rawContent, content, lineage };
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

  it("the plain-value reads throw LineErasedError", async () => {
    const { w } = await erased();
    const err = await w.lineage
      .forEachContentRef(() => undefined)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(LineErasedError);
    expect((err as LineErasedError).code).toBe("line-erased");
    expect(["exp-ann", "exp-ann-fork"]).toContain((err as LineErasedError).experienceId);
    await expect(
      (async () => {
        for await (const _ of w.lineage.pins()) void _;
      })()
    ).rejects.toBeInstanceOf(LineErasedError);
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
    const events = new InMemoryLineageStore();
    const l = new Lineage({ events, content, now: () => T0 });
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
    await expect(
      (async () => {
        for await (const _ of l.pins()) void _;
      })()
    ).rejects.toThrow(); // not enumerable on a plain store: refused, never guessed
  });
});

describe("lineage erasure: negative control", () => {
  it("a corrupted blob with the key PRESENT is not reported as erased", async () => {
    const w = setup({ "exp-ann": "user:ann" });
    const ann = await writeAnn(w);
    w.rawContent.corrupt = true;
    const err = await w.lineage.get("exp-ann", ann.c1.version.versionHash).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LineErasedError);
    expect(isKeyUnavailable(err) || isPayloadShredded(err)).toBe(false);
    expect((err as Error).name).toBe("ContentUndecryptableError");
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
