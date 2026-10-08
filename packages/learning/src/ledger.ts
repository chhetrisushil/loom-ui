import { createHash, createHmac } from "node:crypto";
import { canonicalJson, fnv1a64 } from "@loom/core";
import type { DecisionRef } from "./links";

// ── The vote ledger (U11) ─────────────────────────────────────────────────────
// What a decision's surface earned is kept as an APPEND-ONLY log per decision, and the score is a
// deterministic FOLD of it. That one choice buys the properties the reward path needs:
//
//   - DURABLE and CAS-safe across replicas: the log's append refuses a taken sequence slot (the
//     same seam as `@loom-ui/lineage`'s `LineageStore`; `eventStoreLineageStore(eventStore)` over
//     SQLite/Postgres satisfies `VoteLog` as is). Two replicas ingesting at once just interleave;
//   - ONE BOUNDED VOTE PER VIEWER: the fold aggregates a viewer's signals first (capped counts, max
//     dwell bucket, latest rating, outcomes by host-registered name, a bounded set of nodes), then
//     pools viewers. A client that repeats, reorders or multiplies its signals changes nothing a
//     replay of the same log would not also do — there is no "once" ledger to evict;
//   - SETTLE ONCE, WITHOUT CONFLICT: `close` appends a CLAIM; votes after the first CLAIM are
//     ignored by every reader (the log's order is total), so every replica that settles the decision
//     computes the SAME frozen summary, hence the same score, and the kernel's `(decisionId, key)`
//     idempotency absorbs the repeats. A crash between claim and record is resumed, never forked.
//
// Viewers appear in the log only as a keyed HMAC (`viewerKey`): destroy the key and the log can no
// longer be tied to a person (the votes themselves hold no identity or content).

export interface VoteLogRecord {
  readonly type: string;
  readonly payload: unknown;
  /** ISO-8601. */
  readonly at: string;
}
export interface StoredVoteRecord extends VoteLogRecord {
  readonly sequence: number;
}
export type VoteAppend =
  | { readonly ok: true; readonly sequence: number }
  | { readonly ok: false; readonly tip: number };

/** Structurally `@loom-ui/lineage`'s `LineageStore` (append-if-tip + read). */
export interface VoteLog {
  /** Append as `expectedSequence + 1` iff the tip is exactly `expectedSequence`; never overwrite. */
  append(stream: string, expectedSequence: number, record: VoteLogRecord): Promise<VoteAppend>;
  read(stream: string): Promise<readonly StoredVoteRecord[]>;
}

/** Reference in-memory log. SINGLE PROCESS: use a durable `VoteLog` for more than one replica. */
export class InMemoryVoteLog implements VoteLog {
  private readonly lines = new Map<string, StoredVoteRecord[]>();
  async append(stream: string, expected: number, record: VoteLogRecord): Promise<VoteAppend> {
    const line = this.lines.get(stream) ?? [];
    if (line.length !== expected) return { ok: false, tip: line.length };
    line.push(structuredClone({ ...record, sequence: line.length + 1 }));
    this.lines.set(stream, line);
    return { ok: true, sequence: line.length };
  }
  async read(stream: string): Promise<readonly StoredVoteRecord[]> {
    return structuredClone(this.lines.get(stream) ?? []);
  }
}

// ── votes ─────────────────────────────────────────────────────────────────────

/** Node tags inside a vote: a visible node is `n:<id>`; every restricted placeholder collapses to `r`. */
export const RESTRICTED_NODE = "r";
export const visibleNode = (id: string): string => `n:${id}`;

export type VoteSignal =
  | { readonly k: "x"; readonly n: string }
  | { readonly k: "vx" }
  | { readonly k: "c"; readonly n: string; readonly a: "click" | "expand"; readonly c: number }
  | { readonly k: "d"; readonly n: string; readonly b: number }
  | { readonly k: "f"; readonly r: number; readonly n?: string }
  | { readonly k: "o"; readonly name: string; readonly ok: boolean };

export interface Vote {
  /** `viewerKey` of the viewer. */
  readonly v: string;
  /** The client's batch id: a replay of a batch the fold has seen is ignored. */
  readonly b: string;
  readonly s: readonly VoteSignal[];
}

/** What the pooled votes add up to: every component is a sum of at most ONE bounded term per viewer. */
export interface VoteSummary {
  /** Viewers who were exposed to the decision's surface. */
  readonly viewers: number;
  /** Σ over viewers of (engaged nodes / exposed nodes), each in [0,1]. */
  readonly engagementSum: number;
  readonly feedbackViewers: number;
  /** Σ over rating viewers of (rating-1)/4, each in [0,1]. */
  readonly feedbackSum: number;
  readonly outcomeViewers: number;
  /** Σ over outcome viewers of their success rate over the REGISTERED outcome names, each in [0,1]. */
  readonly outcomeSum: number;
  /** Viewers beyond the ledger's per-decision cap (ignored, in log order). */
  readonly overflowViewers: number;
}

export interface LedgerSpec {
  readonly outcomes: readonly string[];
  readonly maxNodesPerViewer: number;
  readonly maxViewers: number;
  readonly maxBatchesPerViewer: number;
}

export interface Folded {
  readonly summary: VoteSummary;
  /** The first CLAIM: the cutoff every reader agrees on. */
  readonly claim?: { readonly closeId: string; readonly at: string; readonly sequence: number };
  readonly settled?: { readonly status: string; readonly at: string };
  readonly entries: number;
}

interface NodeState {
  x: boolean;
  click: number;
  expand: number;
  dwell: number;
}
interface ViewerState {
  nodes: Map<string, NodeState>;
  vx: boolean;
  rating?: number;
  outcomes: Map<string, boolean>;
  batches: Set<string>;
}

const MAX_COUNT = 255;
const ENGAGED_DWELL = 2;

/** Pure: fold a log into a summary (votes strictly before the first CLAIM). */
export function foldVotes(records: readonly StoredVoteRecord[], spec: LedgerSpec): Folded {
  const viewers = new Map<string, ViewerState>();
  const outcomeNames = new Set(spec.outcomes);
  let overflow = 0;
  let claim: Folded["claim"];
  let settled: Folded["settled"];
  for (const r of records) {
    if (r.type === "CLAIM") {
      if (claim === undefined) {
        const p = r.payload as { closeId?: unknown };
        claim = { closeId: String(p?.closeId ?? ""), at: r.at, sequence: r.sequence };
      }
      continue;
    }
    if (r.type === "SETTLED") {
      if (settled === undefined)
        settled = { status: String((r.payload as { status?: unknown })?.status ?? ""), at: r.at };
      continue;
    }
    if (r.type !== "VOTE" || claim !== undefined) continue;
    const vote = r.payload as Vote;
    if (typeof vote?.v !== "string" || typeof vote.b !== "string" || !Array.isArray(vote.s))
      continue;
    let st = viewers.get(vote.v);
    if (st === undefined) {
      if (viewers.size >= spec.maxViewers) {
        overflow += 1;
        continue;
      }
      st = { nodes: new Map(), vx: false, outcomes: new Map(), batches: new Set() };
      viewers.set(vote.v, st);
    }
    if (st.batches.has(vote.b) || st.batches.size >= spec.maxBatchesPerViewer) continue;
    st.batches.add(vote.b);
    const nodeOf = (n: string, create: boolean): NodeState | undefined => {
      let ns = st.nodes.get(n);
      if (ns === undefined && create && st.nodes.size < spec.maxNodesPerViewer) {
        ns = { x: false, click: 0, expand: 0, dwell: 0 };
        st.nodes.set(n, ns);
      }
      return ns;
    };
    // exposures first: everything else in the vote is judged against what the viewer has shown
    for (const sig of vote.s) {
      if (sig.k === "x" && typeof sig.n === "string") {
        const ns = nodeOf(sig.n, true);
        if (ns) ns.x = true;
        st.vx = true;
      } else if (sig.k === "vx") st.vx = true;
    }
    for (const sig of vote.s) {
      switch (sig.k) {
        case "c": {
          const ns = nodeOf(sig.n, false);
          if (ns?.x && Number.isInteger(sig.c) && sig.c > 0) {
            const c = Math.min(MAX_COUNT, sig.c);
            if (sig.a === "click") ns.click = Math.max(ns.click, c);
            else if (sig.a === "expand") ns.expand = Math.max(ns.expand, c);
          }
          break;
        }
        case "d": {
          const ns = nodeOf(sig.n, false);
          if (ns?.x && Number.isInteger(sig.b) && sig.b >= 0 && sig.b <= 3)
            ns.dwell = Math.max(ns.dwell, sig.b);
          break;
        }
        case "f": {
          if (!Number.isInteger(sig.r) || sig.r < 1 || sig.r > 5) break;
          if (sig.n === undefined ? st.vx : nodeOf(sig.n, false)?.x) st.rating = sig.r;
          break;
        }
        case "o":
          if (st.vx && outcomeNames.has(sig.name) && typeof sig.ok === "boolean")
            st.outcomes.set(sig.name, sig.ok);
          break;
      }
    }
  }
  let n = 0;
  let engagementSum = 0;
  let fv = 0;
  let fs = 0;
  let ov = 0;
  let os = 0;
  for (const st of viewers.values()) {
    const exposed = [...st.nodes.values()].filter((x) => x.x);
    // a viewer counts for a decision that showed them a node of it, or that they rated / reported on
    if (exposed.length === 0 && st.rating === undefined && st.outcomes.size === 0) continue;
    n += 1;
    if (exposed.length > 0) {
      const engaged = exposed.filter(
        (x) => x.click > 0 || x.expand > 0 || x.dwell >= ENGAGED_DWELL
      );
      engagementSum += engaged.length / exposed.length;
    }
    if (st.rating !== undefined) {
      fv += 1;
      fs += (st.rating - 1) / 4;
    }
    if (st.outcomes.size > 0) {
      ov += 1;
      let ok = 0;
      for (const v of st.outcomes.values()) if (v) ok += 1;
      os += ok / st.outcomes.size;
    }
  }
  return {
    summary: {
      viewers: n,
      engagementSum,
      feedbackViewers: fv,
      feedbackSum: fs,
      outcomeViewers: ov,
      outcomeSum: os,
      overflowViewers: overflow,
    },
    ...(claim !== undefined && { claim }),
    ...(settled !== undefined && { settled }),
    entries: records.length,
  };
}

// ── the ledger ────────────────────────────────────────────────────────────────

export interface VoteLedgerOptions {
  readonly log: VoteLog;
  /**
   * Secret (>=16 bytes) that pseudonymises viewers in the log and derives unit aliases. Keep it with
   * the host's other secrets; destroying it severs every vote from its viewer.
   */
  readonly pseudonymKey: string | Uint8Array;
  /** Injected time (ms) for record timestamps. */
  readonly clock: () => number;
  /**
   * The outcome NAMES the host recognises (e.g. `["task-approved"]`). A client's outcome with any
   * other name is dropped: a client cannot mint outcomes.
   */
  readonly outcomes?: readonly string[];
  /** Records a decision's log may hold before ingest refuses more (`capacity`). Default 1 000 000. */
  readonly maxEntriesPerDecision?: number;
  /** Distinct viewers pooled per decision (later ones are counted in `overflowViewers`). Default 100 000. */
  readonly maxViewers?: number;
  /** Nodes one viewer may vote on per decision. Default 64. */
  readonly maxNodesPerViewer?: number;
  readonly maxBatchesPerViewer?: number;
}

const AT = (ms: number): string => new Date(ms).toISOString();

/** Why an append did not happen. `contended`: the log stayed busy past the retry bound; try again. */
export type AppendResult = "ok" | "capacity" | "viewer-capacity" | "closed" | "contended";

/** What a process knows of one decision's log, rebuilt from the durable log whenever a CAS loses. */
interface StreamState {
  tip: number;
  claimed: boolean;
  /** VOTE entries per viewer key, from the log itself (not from this process's own appends only). */
  perViewer: Map<string, number>;
}

const MAX_STREAMS = 1024;
const MAX_APPEND_ATTEMPTS = 64;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function stateOf(records: readonly StoredVoteRecord[]): StreamState {
  const st: StreamState = { tip: records.length, claimed: false, perViewer: new Map() };
  for (const r of records) {
    if (r.type === "CLAIM") st.claimed = true;
    else if (r.type === "VOTE") {
      const v = (r.payload as { v?: unknown } | null)?.v;
      if (typeof v === "string") st.perViewer.set(v, (st.perViewer.get(v) ?? 0) + 1);
    }
  }
  return st;
}

export class VoteLedger {
  readonly spec: LedgerSpec;
  /**
   * Names the LEDGER configuration (outcome names and caps): part of the recorded outcome key, so a
   * changed spec records under a NEW key. It does NOT cover the reward function or its weights: name
   * those in `rewardId`.
   */
  readonly specHash: string;
  private readonly key: Buffer;
  private readonly maxEntries: number;
  /** Capacity kept back for viewers' FIRST votes: a returning viewer cannot spend it. */
  private readonly firstVoteReserve: number;
  private readonly streams = new Map<string, StreamState>();
  /** Per-stream promise chain: appends to one decision are serialised in this process. Entries leave when idle. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly opts: VoteLedgerOptions) {
    this.key = Buffer.from(opts.pseudonymKey);
    if (this.key.length < 16) throw new Error("VoteLedger: pseudonymKey must be at least 16 bytes");
    this.maxEntries = Math.max(1, opts.maxEntriesPerDecision ?? 1_000_000);
    this.firstVoteReserve = Math.floor(this.maxEntries / 4);
    this.spec = {
      outcomes: [...(opts.outcomes ?? [])].sort(),
      maxNodesPerViewer: Math.max(1, opts.maxNodesPerViewer ?? 64),
      maxViewers: Math.max(1, opts.maxViewers ?? 100_000),
      maxBatchesPerViewer: Math.max(1, opts.maxBatchesPerViewer ?? 128),
    };
    this.specHash = fnv1a64(canonicalJson({ v: 1, ...this.spec })).slice(0, 8);
  }

  /**
   * The pseudonym a viewer has in the log: HMAC(key, [tenant, id]). Tenant is part of the identity;
   * the pair is JSON-encoded so no character in either field can shift the boundary.
   */
  viewerKey(tenant: string, id: string): string {
    return createHmac("sha256", this.key)
      .update(JSON.stringify(["viewer", tenant, id]))
      .digest("base64url")
      .slice(0, 27);
  }

  streamOf(ref: DecisionRef): string {
    return `votes-${createHash("sha256")
      .update(JSON.stringify([ref.executionId, ref.decisionId]))
      .digest("hex")}`;
  }

  private remember(stream: string, st: StreamState): void {
    this.streams.delete(stream);
    this.streams.set(stream, st);
    while (this.streams.size > MAX_STREAMS)
      this.streams.delete(this.streams.keys().next().value as string);
  }

  /** Run `fn` after every earlier job on `stream`; the chain entry is dropped when nothing follows. */
  private serialised<T>(stream: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(stream) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    this.chains.set(stream, tail);
    void tail.then(() => {
      if (this.chains.get(stream) === tail) this.chains.delete(stream);
    });
    return run;
  }

  private append(
    stream: string,
    type: string,
    payload: unknown,
    viewer?: string
  ): Promise<AppendResult> {
    return this.serialised(stream, async () => {
      let st = this.streams.get(stream);
      for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
        if (st === undefined) {
          st = stateOf(await this.opts.log.read(stream));
          this.remember(stream, st);
        }
        if (type === "VOTE") {
          if (st.claimed) return "closed";
          if (st.tip >= this.maxEntries) return "capacity";
          const mine = viewer === undefined ? 0 : (st.perViewer.get(viewer) ?? 0);
          // A viewer is bounded by what the fold would read of it anyway, and a RETURNING viewer
          // cannot spend the capacity reserved for first votes: one viewer cannot starve the rest.
          if (mine >= this.spec.maxBatchesPerViewer) return "viewer-capacity";
          if (mine > 0 && st.tip >= this.maxEntries - this.firstVoteReserve)
            return "viewer-capacity";
        }
        const r = await this.opts.log.append(stream, st.tip, {
          type,
          payload,
          at: AT(this.opts.clock()),
        });
        if (r.ok) {
          st.tip = r.sequence;
          if (type === "CLAIM") st.claimed = true;
          if (type === "VOTE" && viewer !== undefined)
            st.perViewer.set(viewer, (st.perViewer.get(viewer) ?? 0) + 1);
          return "ok";
        }
        // lost the CAS to another replica: rebuild from the durable log (counts included), then back off
        st = undefined;
        this.streams.delete(stream);
        if (attempt > 0) await sleep(Math.random() * Math.min(50, 2 ** attempt));
      }
      return "contended";
    });
  }

  /**
   * Append one viewer's vote on a decision. `closed` once the decision is claimed (checked against the
   * log's own state at the append, so a vote that lands after a CLAIM is never reported accepted).
   */
  recordVote(ref: DecisionRef, vote: Vote): Promise<AppendResult> {
    return this.append(this.streamOf(ref), "VOTE", vote, vote.v);
  }

  async fold(ref: DecisionRef): Promise<Folded> {
    const stream = this.streamOf(ref);
    // read + refresh inside the stream's queue, so the cache never goes behind an append that just landed
    const records = await this.serialised(stream, async () => {
      const rs = await this.opts.log.read(stream);
      this.remember(stream, stateOf(rs));
      return rs;
    });
    return foldVotes(records, this.spec);
  }

  /**
   * Freeze the decision: append a CLAIM unless one exists. Whoever wins, every reader folds the same
   * votes (those before the first CLAIM), so concurrent closers agree on the summary. The returned
   * fold has no `claim` only if the log stayed contended: the caller leaves the decision for a retry.
   */
  async close(ref: DecisionRef, closeId: string): Promise<Folded> {
    for (let i = 0; i < 4; i++) {
      const f = await this.fold(ref);
      if (f.claim) return f;
      await this.append(this.streamOf(ref), "CLAIM", { closeId });
    }
    return this.fold(ref);
  }

  async markSettled(ref: DecisionRef, status: string): Promise<void> {
    // a contended SETTLED is harmless: the next run re-derives the same score and the kernel dedupes
    await this.append(this.streamOf(ref), "SETTLED", { status });
  }
}

/**
 * The opaque unit key a host hands the planner (`ComposeInput.unit`): a keyed HMAC alias of the
 * user id, derived SERVER-SIDE. Never take a unit from a client, and never pass a raw user id —
 * the unit is recorded in the decision log. Destroying the key severs the log from the person.
 */
export function unitAlias(key: string | Uint8Array, userId: string): string {
  const k = Buffer.from(key);
  if (k.length < 16) throw new Error("unitAlias: key must be at least 16 bytes");
  return `u_${createHmac("sha256", k).update(`unit\u0000${userId}`).digest("base64url").slice(0, 32)}`;
}
