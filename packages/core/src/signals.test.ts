import { describe, expect, it } from "vitest";
import { inspectExperience } from "./change";
import { compile } from "./compile";
import { walk } from "./node";
import { emptyLedger, foldProvenance } from "./provenance";
import { cleanProvenance } from "./provenance";
import { type Any, catalog, generate, handleOf } from "./restrictedGen.test-support";
import {
  DWELL_EDGES_MS,
  MAX_QUEUED_BATCHES,
  MAX_SIGNALS_PER_BATCH,
  SIGNAL_VERSION,
  type SignalBatch,
  SignalCollector,
  dwellBucket,
  validateSignalBatch,
} from "./signals";
import { mayView } from "./viewer";

const VIEW = { experienceId: "exp-1", versionHash: "sha256:v1" };
function make(extra: Partial<ConstructorParameters<typeof SignalCollector>[0]> = {}) {
  const sent: SignalBatch[] = [];
  let n = 0;
  const c = new SignalCollector({
    sink: (b) => void sent.push(b),
    newBatchId: () => `b${++n}`,
    ...extra,
  });
  c.setView(VIEW);
  return { c, sent };
}

// the right-to-left override, built from its code point so a formatter cannot rewrite the escape
const RLO = String.fromCharCode(0x202e);

describe("U11 SignalCollector", () => {
  it("exposure is once per node and view; clicks coalesce into a capped count; dwell is a bucket, never ms", async () => {
    const { c, sent } = make();
    for (let i = 0; i < 5; i++) c.expose("kpi");
    for (let i = 0; i < 400; i++) c.engage("kpi", "click");
    c.engage("kpi", "expand");
    c.dwell("kpi", 700);
    c.dwell("kpi", 2000); // 2.7 s total -> bucket 1
    await c.flush({ final: true });
    expect(sent).toHaveLength(1);
    const s = sent[0]?.signals ?? [];
    expect(s.filter((x) => x.kind === "exposure")).toHaveLength(1);
    expect(s).toContainEqual({ kind: "engagement", action: "click", count: 255, node: "kpi" });
    expect(s).toContainEqual({ kind: "engagement", action: "expand", count: 1, node: "kpi" });
    expect(s).toContainEqual({ kind: "engagement", action: "dwell", bucket: 1, node: "kpi" });
    // no raw timing anywhere in what leaves the client
    expect(JSON.stringify(sent)).not.toMatch(/2700|2\.7|700/);
    expect(dwellBucket(0)).toBe(0);
    expect(dwellBucket(DWELL_EDGES_MS[0] as number)).toBe(1);
    expect(dwellBucket(1e9)).toBe(DWELL_EDGES_MS.length);
    expect(dwellBucket(Number.NaN)).toBe(0);
  });

  it("dwell is sent ONCE per view, when sealed: per-view totals survive intermediate flushes; unchanged state is not re-sent", async () => {
    const { c, sent } = make();
    c.expose("kpi");
    c.dwell("kpi", 600);
    await c.flush(); // intermediate: exposure only, no dwell bucket yet
    c.dwell("kpi", 700); // 1.3 s in total (bucket 1), not two 0.6/0.7 s buckets
    await c.flush();
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]?.signals)).not.toContain("dwell");
    await c.flush({ final: true });
    const dwell = sent
      .flatMap((b) => b.signals)
      .filter((s) => s.kind === "engagement" && s.action === "dwell");
    expect(dwell).toEqual([{ kind: "engagement", action: "dwell", bucket: 1, node: "kpi" }]);
    // nothing changed since: nothing more goes out
    const n = sent.length;
    await c.flush({ final: true });
    expect(sent).toHaveLength(n);
    // a sealed view (a new version) emits its dwell exactly once too
    const v2 = make();
    v2.c.expose("a");
    v2.c.dwell("a", 6000);
    await v2.c.flush();
    v2.c.setView({ ...VIEW, versionHash: "sha256:v2" });
    await v2.c.flush();
    expect(v2.sent.flatMap((b) => b.signals).filter((s) => s.kind === "engagement")).toEqual([
      { kind: "engagement", action: "dwell", bucket: 2, node: "a" },
    ]);
  });

  it("a restricted placeholder is reported flagged, under its alias, with no content", async () => {
    const { c, sent } = make({ placeholders: ["r_AAAAAAAAAAAAAAAA"] });
    c.expose("r_AAAAAAAAAAAAAAAA");
    c.engage("r_AAAAAAAAAAAAAAAA", "click");
    c.feedback(4, "r_AAAAAAAAAAAAAAAA");
    await c.flush();
    for (const s of sent[0]?.signals ?? []) expect(s).toMatchObject({ restricted: true });
    expect(Object.keys(sent[0]?.signals[0] ?? {}).sort()).toEqual(["kind", "node", "restricted"]);
  });

  it("is bounded: tracked nodes, signals per batch, queued batches; a failing sink does not grow it", async () => {
    const { c, sent } = make({ maxTrackedNodes: 3 });
    for (let i = 0; i < 10; i++) c.expose(`n${i}`);
    expect(c.stats.dropped).toBe(7);
    await c.flush();
    expect(sent[0]?.signals).toHaveLength(3);

    // many nodes -> several batches, each within the cap
    const big = make({ maxTrackedNodes: 1000 });
    for (let i = 0; i < 300; i++) big.c.expose(`m${i}`);
    await big.c.flush();
    expect(big.sent.length).toBeGreaterThan(1);
    for (const b of big.sent) expect(b.signals.length).toBeLessThanOrEqual(MAX_SIGNALS_PER_BATCH);

    // a sink that always fails: batches stay queued, bounded, oldest lost and counted
    let n = 0;
    const down = new SignalCollector({
      sink: () => Promise.reject(new Error("offline")),
      newBatchId: () => `d${++n}`,
      maxTrackedNodes: 100_000,
    });
    down.setView(VIEW);
    for (let i = 0; i < MAX_SIGNALS_PER_BATCH * (MAX_QUEUED_BATCHES + 4); i++) down.expose(`x${i}`);
    await down.flush();
    expect(down.stats.queued).toBe(MAX_QUEUED_BATCHES);
    expect(down.stats.lost).toBe(MAX_SIGNALS_PER_BATCH * 4);
  });

  it("a failed batch is re-sent under the SAME batchId (the host dedupes on it)", async () => {
    let fail = true;
    const got: string[] = [];
    const c = new SignalCollector({
      sink: (b) => {
        if (fail) throw new Error("x");
        got.push(b.batchId);
      },
      newBatchId: () => "same-id",
    });
    c.setView(VIEW);
    c.expose("a");
    expect((await c.flush()).sent).toBe(0);
    fail = false;
    expect((await c.flush()).sent).toBe(1);
    expect(got).toEqual(["same-id"]);
  });

  it("a new version seals the old view's signals under the OLD version; an unsealed one collects nothing", async () => {
    const { c, sent } = make();
    c.expose("a");
    c.setView({ ...VIEW, versionHash: "sha256:v2" });
    c.expose("b");
    await c.flush();
    expect(
      sent.map((b) => [b.view.versionHash, b.signals.map((s) => "node" in s && s.node)])
    ).toEqual([
      ["sha256:v1", ["a"]],
      ["sha256:v2", ["b"]],
    ]);
    c.setView({ experienceId: "e", versionHash: "" });
    c.expose("z");
    expect((await c.flush()).sent).toBe(0);
  });

  it("refuses hostile node ids, ratings and names (counted, never sent)", async () => {
    const { c, sent } = make();
    c.expose("");
    c.expose(`a${RLO}b`);
    c.expose("x".repeat(129));
    c.feedback(9);
    c.feedback(2.5);
    c.outcome("has space", true);
    c.outcome("ok", "yes" as never);
    expect(c.stats.dropped).toBe(7);
    await c.flush();
    expect(sent).toHaveLength(0);
  });

  it("observeAction maps feedback/outcome/other actions and never copies the payload", async () => {
    const { c, sent } = make();
    c.expose("card");
    c.observeAction({
      type: "feedback",
      widgetId: "card",
      payload: { rating: 5, comment: "secret text" },
    });
    c.observeAction({
      type: "outcome",
      widgetId: "card",
      payload: { name: "approved", success: true },
    });
    c.observeAction({ type: "approve", widgetId: "card", payload: { note: "private" } });
    await c.flush();
    const json = JSON.stringify(sent);
    expect(json).not.toMatch(/secret text|private/);
    expect(sent[0]?.signals).toContainEqual({ kind: "feedback", rating: 5, node: "card" });
    expect(sent[0]?.signals).toContainEqual({ kind: "outcome", name: "approved", success: true });
  });
});

describe("U11 validateSignalBatch (untrusted input)", () => {
  const good = (signals: unknown[]): unknown => ({
    v: SIGNAL_VERSION,
    batchId: "b-1",
    view: { ...VIEW },
    signals,
  });

  it("returns a CLEAN copy: unknown keys and smuggled text are gone", () => {
    const r = validateSignalBatch(
      good([{ kind: "exposure", node: "a", text: "leak", html: "<b>", __proto__: { x: 1 } }])
    );
    expect(r.ok && r.batch.signals).toEqual([{ kind: "exposure", node: "a" }]);
    expect(JSON.stringify(r)).not.toMatch(/leak|<b>/);
  });

  it("drops bad signals and counts them; refuses a bad envelope or an oversized batch whole", () => {
    const r = validateSignalBatch(
      good([
        { kind: "exposure", node: "a" },
        { kind: "engagement", action: "click", count: 0, node: "a" },
        { kind: "engagement", action: "click", count: 256, node: "a" },
        { kind: "engagement", action: "dwell", bucket: 4, node: "a" },
        { kind: "engagement", action: "hover", count: 1, node: "a" },
        { kind: "feedback", rating: 6 },
        { kind: "feedback", rating: 3, node: "n\u0000" },
        { kind: "outcome", name: "a b", success: true },
        { kind: "exposure", node: "a", restricted: false },
        null,
        "str",
        { kind: "mystery" },
      ])
    );
    expect(r.ok && r.rejected).toBe(11);
    expect(r.ok && r.batch.signals).toHaveLength(1);
    const many = Array.from({ length: MAX_SIGNALS_PER_BATCH + 1 }, () => ({
      kind: "exposure",
      node: "a",
    }));
    expect(validateSignalBatch(good(many))).toEqual({ ok: false, reason: "batch-too-large" });
    expect(validateSignalBatch(null)).toEqual({ ok: false, reason: "not-an-object" });
    expect(validateSignalBatch([])).toEqual({ ok: false, reason: "not-an-object" });
    expect(validateSignalBatch({ ...(good([]) as object), v: 2 })).toEqual({
      ok: false,
      reason: "unsupported-version",
    });
    expect(validateSignalBatch({ ...(good([]) as object), batchId: "a b" })).toEqual({
      ok: false,
      reason: "bad-batch-id",
    });
    expect(validateSignalBatch({ ...(good([]) as object), view: { experienceId: "e" } })).toEqual({
      ok: false,
      reason: "bad-view",
    });
    expect(validateSignalBatch({ ...(good([]) as object), signals: {} })).toEqual({
      ok: false,
      reason: "bad-signals",
    });
  });

  it("is total: a hostile getter or proxy cannot make it throw", () => {
    const evil = new Proxy(
      {},
      {
        get: () => {
          throw new Error("boom");
        },
        has: () => {
          throw new Error("boom");
        },
        ownKeys: () => {
          throw new Error("boom");
        },
      }
    );
    expect(() => validateSignalBatch(evil)).not.toThrow();
    expect(validateSignalBatch(evil).ok).toBe(false);
  });
});

describe("U11 + U10c: signals never carry a restricted node's real id", () => {
  const KEY = "opaque-id-test-key-0123456789abcdef";
  it("over 120 randomised experiences x 4 viewers, a collector fed every placeholder emits only aliases", async () => {
    const viewers: Array<Any> = [
      undefined,
      { clearance: "internal" },
      { clearance: "sensitive" },
      { clearance: "secret" },
    ];
    let placeholders = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const { exp, projections, tc } = generate(seed);
      for (const viewer of viewers) {
        const r = compile(exp, {
          surface: "web",
          catalog,
          hydrationProjectionId: "hydration",
          hydrationProjectionVersion: "1",
          projections: projections as never,
          placeholderKey: KEY,
          ...tc,
          ...(viewer !== undefined && { viewer }),
        } as never);
        const ins = inspectExperience(exp, {
          projections,
          hydrationProjectionId: "hydration",
          ...tc,
        } as Any);
        const hidden = [...ins.nodes]
          .filter(([, v]) => v.blocked || !mayView(viewer, v.cls))
          .map(([id]) => id);
        const bp = JSON.stringify(r.blueprint);
        for (const a of r.fingerprint.placeholderNodes) expect(bp).toContain(`"${a}"`);
        placeholders += r.fingerprint.placeholderNodes.length;
        const sent: SignalBatch[] = [];
        const c = new SignalCollector({
          sink: (b) => void sent.push(b),
          placeholders: r.fingerprint.placeholderNodes,
        });
        c.setView({ experienceId: exp.experienceId, versionHash: exp.versionHash || "sha256:x" });
        for (const a of r.fingerprint.placeholderNodes) {
          c.expose(a);
          c.engage(a, "click");
          c.feedback(3, a);
        }
        await c.flush();
        const json = JSON.stringify(sent);
        for (const id of hidden) {
          expect(json).not.toContain(id);
          expect(json).not.toContain(handleOf(id));
        }
        for (const b of sent) for (const s of b.signals) expect((s as Any).restricted).toBe(true);
      }
    }
    expect(placeholders).toBeGreaterThan(300); // the generator does produce placeholders
  });
});

describe("U11 Provenance.policyDecisionId", () => {
  it("is carried through the ledger and cleaned (bounded, stripped)", () => {
    const by = cleanProvenance({
      source: "agent",
      decisionId: "plan:1",
      policyDecisionId: `plan-variant:abc${RLO}`,
    });
    expect(by.policyDecisionId).toBe("plan-variant:abc");
    const ledger = foldProvenance(emptyLedger(), [
      {
        versionHash: "v1",
        at: "t",
        by: { source: "agent", policyDecisionId: "pv:1" },
        ops: [
          {
            at: "t",
            by: { source: "agent", policyDecisionId: "pv:1" },
            op: { type: "setTitle", nodeId: "root", title: null },
          } as Any,
        ],
      },
    ]);
    expect(ledger.nodes.get("root")?.changed?.by.policyDecisionId).toBe("pv:1");
    void walk;
  });
});
