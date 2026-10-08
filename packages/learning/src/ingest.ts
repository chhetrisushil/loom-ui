import { type InteractionSignal, validateSignalBatch } from "@loom-ui/core/signals";
import type { ExposureCheck } from "./exposure";
import type { DecisionLink, DecisionLinkResolver, DecisionRef } from "./links";

// ── Ingesting untrusted signals (U11) ─────────────────────────────────────────
// A batch arrives from a browser the host does not control. Before any of it can move a reward:
//   1. SHAPE   — `validateSignalBatch` (bounded tokens, in-range integers, ≤64 signals; extra keys gone);
//   2. WHO     — the viewer comes from the host's AUTHENTICATED session, never from the payload;
//   3. RATE    — a per-viewer budget per window; a batch over it is refused whole and NOT remembered;
//   4. REPLAY  — a batchId already accepted for this viewer is a duplicate, whole;
//   5. WHICH   — the view must be one the host registered, in the viewer's tenant (a foreign tenant's
//                view and an unknown one answer the same);
//   6. SAW IT  — an engagement / feedback / outcome counts only after the viewer is known to have been
//                shown the node (the ledger of their own accepted exposures, AND the host's
//                authoritative `ExposureCheck` when given);
//   7. ONCE    — exposure, engagement, dwell, feedback and outcome count at most once per
//                (viewer, version, node, kind): a client cannot raise a reward by repeating itself.
// Everything is bounded; a bound that is hit refuses or forgets (documented), it never grows.

export type IngestRefusal =
  | "batch-invalid"
  | "rate-limited"
  | "duplicate-batch"
  | "unknown-view"
  | "capacity";

/** Why one signal inside an accepted batch did not count. */
export type SignalRejection =
  | "invalid"
  | "duplicate"
  | "unexposed"
  | "unknown-node"
  | "restricted-cap"
  | "capacity";

export interface IngestResult {
  readonly accepted: number;
  /** Per-reason counts for signals that did not count. */
  readonly rejected: Readonly<Partial<Record<SignalRejection, number>>>;
  /** Set when the WHOLE batch was refused (then `accepted` is 0). */
  readonly refused?: IngestRefusal;
  readonly detail?: string;
}

export interface Viewer {
  /** The authenticated viewer id: from the host's session, NEVER from the batch. */
  readonly id: string;
  readonly tenant?: string;
}

/** What one decision's signals add up to in one window: the input to a reward function. */
export interface WindowSummary {
  /** Distinct (viewer, node) exposures. */
  readonly exposed: number;
  /** Of those, pairs with a click or expand. */
  readonly clicked: number;
  /** Distinct (viewer, node) pairs by dwell bucket 0..3. */
  readonly dwell: readonly [number, number, number, number];
  /** Pairs that count as ENGAGED: a click, an expand, or a dwell of bucket ≥ 2 (≥ 5 s). */
  readonly engaged: number;
  readonly feedbackCount: number;
  /** Sum of ratings 1..5. */
  readonly feedbackSum: number;
  readonly outcomes: number;
  readonly outcomeSuccesses: number;
}

interface MutableSummary {
  exposed: number;
  clicked: number;
  dwell: [number, number, number, number];
  engaged: number;
  feedbackCount: number;
  feedbackSum: number;
  outcomes: number;
  outcomeSuccesses: number;
}
const blank = (): MutableSummary => ({
  exposed: 0,
  clicked: 0,
  dwell: [0, 0, 0, 0],
  engaged: 0,
  feedbackCount: 0,
  feedbackSum: 0,
  outcomes: 0,
  outcomeSuccesses: 0,
});

export interface AccumulatedEntry {
  readonly ref: DecisionRef;
  readonly window: number;
  readonly summary: WindowSummary;
}

/** The per-(decision, window) counters. Bounded: a new key past `max` is refused. */
export class RewardAccumulator {
  private readonly map = new Map<string, { ref: DecisionRef; window: number; s: MutableSummary }>();
  constructor(private readonly max = 4_096) {}
  private static key(ref: DecisionRef, window: number): string {
    return `${ref.executionId}\u0000${ref.decisionId}\u0000${window}`;
  }
  /** The counters for a key, or `undefined` when a NEW key would pass the bound. */
  bucket(ref: DecisionRef, window: number): MutableSummary | undefined {
    const k = RewardAccumulator.key(ref, window);
    const hit = this.map.get(k);
    if (hit !== undefined) return hit.s;
    if (this.map.size >= this.max) return undefined;
    const s = blank();
    this.map.set(k, { ref, window, s });
    return s;
  }
  /** Entries of windows strictly before `before` (closed windows). */
  closed(before: number): AccumulatedEntry[] {
    const out: AccumulatedEntry[] = [];
    for (const { ref, window, s } of this.map.values())
      if (window < before)
        out.push({ ref, window, summary: { ...s, dwell: [...s.dwell] as WindowSummary["dwell"] } });
    return out;
  }
  drop(ref: DecisionRef, window: number): void {
    this.map.delete(RewardAccumulator.key(ref, window));
  }
  get size(): number {
    return this.map.size;
  }
}

export interface SignalIngestorOptions {
  readonly links: DecisionLinkResolver;
  readonly accumulator: RewardAccumulator;
  /** Injected time (ms). Windows and rate budgets are functions of it; nothing reads a wall clock. */
  readonly clock: () => number;
  /** Reward window length (ms). Default one hour. */
  readonly windowMs?: number;
  /** The host's authoritative "was it shown" check (e.g. `seenLogExposure`). Optional but advised. */
  readonly exposure?: ExposureCheck;
  /** Signals one viewer may submit per `rateWindowMs`. Default 512. */
  readonly rateLimit?: number;
  /** Default 60 s. */
  readonly rateWindowMs?: number;
  /** Distinct (viewer, version, node, kind) keys remembered for "once". Default 100 000. */
  readonly maxRemembered?: number;
  /** Batch ids remembered for replay refusal. Default 50 000. */
  readonly maxBatches?: number;
  /** Viewers with a live rate budget. Default 50 000. */
  readonly maxViewers?: number;
  /** Distinct restricted-placeholder exposures counted per viewer and version. Default 16. */
  readonly maxRestrictedPerView?: number;
}

/** Remembers a bounded set of keys, forgetting the oldest. */
class Forgetful {
  private readonly set = new Set<string>();
  constructor(private readonly max: number) {}
  has(k: string): boolean {
    return this.set.has(k);
  }
  add(k: string): void {
    if (this.set.has(k)) return;
    this.set.add(k);
    if (this.set.size > this.max) this.set.delete(this.set.values().next().value as string);
  }
}

const SEP = "\u0000";

export class SignalIngestor {
  private readonly windowMs: number;
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;
  private readonly maxRestricted: number;
  private readonly once: Forgetful;
  private readonly batches: Forgetful;
  /** viewer → { windowStart, used }. Insertion-ordered; the oldest viewer is dropped past `maxViewers`. */
  private readonly rate = new Map<string, { start: number; used: number }>();
  private readonly maxViewers: number;
  /** viewer+version → restricted exposures counted. */
  private readonly restrictedSeen = new Map<string, number>();

  constructor(private readonly opts: SignalIngestorOptions) {
    this.windowMs = Math.max(1, opts.windowMs ?? 3_600_000);
    this.rateLimit = Math.max(1, opts.rateLimit ?? 512);
    this.rateWindowMs = Math.max(1, opts.rateWindowMs ?? 60_000);
    this.maxRestricted = Math.max(0, opts.maxRestrictedPerView ?? 16);
    this.maxViewers = Math.max(1, opts.maxViewers ?? 50_000);
    this.once = new Forgetful(Math.max(1, opts.maxRemembered ?? 100_000));
    this.batches = new Forgetful(Math.max(1, opts.maxBatches ?? 50_000));
  }

  /** The reward window `t` falls in. */
  windowOf(t: number): number {
    return Math.floor(t / this.windowMs);
  }

  async ingest(input: { readonly viewer: Viewer; readonly raw: unknown }): Promise<IngestResult> {
    const { viewer } = input;
    const none = (refused: IngestRefusal, detail?: string): IngestResult => ({
      accepted: 0,
      rejected: {},
      refused,
      ...(detail !== undefined && { detail }),
    });
    const v = validateSignalBatch(input.raw);
    if (!v.ok) return none("batch-invalid", v.reason);
    const { batch } = v;
    const rejected: Partial<Record<SignalRejection, number>> = {};
    const reject = (r: SignalRejection, n = 1) => {
      rejected[r] = (rejected[r] ?? 0) + n;
    };
    if (v.rejected > 0) reject("invalid", v.rejected);

    // 4. replay — before the rate budget, so an honest resend of an accepted batch costs nothing.
    const batchKey = `${viewer.id}${SEP}${batch.batchId}`;
    if (this.batches.has(batchKey)) return none("duplicate-batch");

    // 5. which view (a foreign tenant's is indistinguishable from an unknown one)
    const { experienceId, versionHash } = batch.view;
    const link = this.opts.links.resolve(experienceId, versionHash);
    if (link === undefined || (link.tenant !== undefined && link.tenant !== viewer.tenant))
      return none("unknown-view");

    // 3. rate — charged for the whole batch, refused whole when it does not fit
    const now = this.opts.clock();
    if (!this.charge(viewer.id, now, batch.signals.length)) return none("rate-limited");
    this.batches.add(batchKey);

    const window = this.windowOf(now);
    let accepted = 0;
    // Exposures first: an engagement in the same batch is then judged against them.
    const ordered = [...batch.signals].sort(
      (a, b) => (a.kind === "exposure" ? 0 : 1) - (b.kind === "exposure" ? 0 : 1)
    );
    for (const s of ordered) {
      const r = await this.one(viewer, batch.view, link, window, s);
      if (r === undefined) accepted += 1;
      else reject(r);
    }
    return { accepted, rejected };
  }

  private charge(viewerId: string, now: number, n: number): boolean {
    let e = this.rate.get(viewerId);
    if (e === undefined || now - e.start >= this.rateWindowMs || now < e.start) {
      e = { start: now, used: 0 };
    }
    if (e.used + n > this.rateLimit) return false;
    e.used += n;
    this.rate.delete(viewerId);
    this.rate.set(viewerId, e);
    while (this.rate.size > this.maxViewers)
      this.rate.delete(this.rate.keys().next().value as string);
    return true;
  }

  /** The decisions a signal credits, or the reason it credits none. */
  private targets(
    link: DecisionLink,
    node: string | undefined,
    restricted: boolean
  ): readonly DecisionRef[] | "unknown-node" {
    if (node === undefined || restricted || link.nodes === undefined) return link.decisions;
    return Object.hasOwn(link.nodes, node) ? [link.nodes[node] as DecisionRef] : "unknown-node";
  }

  private async one(
    viewer: Viewer,
    view: { readonly experienceId: string; readonly versionHash: string },
    link: DecisionLink,
    window: number,
    s: InteractionSignal
  ): Promise<SignalRejection | undefined> {
    const node = "node" in s ? s.node : undefined;
    const restricted = "restricted" in s && s.restricted === true;
    const targets = this.targets(link, node, restricted);
    if (targets === "unknown-node") return "unknown-node";
    if (targets.length === 0) return "unknown-node";
    const pair = `${viewer.id}${SEP}${view.experienceId}${SEP}${view.versionHash}${SEP}${node ?? ""}`;
    const q = {
      viewerId: viewer.id,
      experienceId: view.experienceId,
      versionHash: view.versionHash,
      ...(node !== undefined && { node }),
      ...(restricted && { restricted: true }),
    };

    // 6. saw it (the exposure signal itself needs only the authoritative check, if any)
    const exposedKey = `${pair}${SEP}exposure`;
    if (s.kind !== "exposure") {
      const claimed =
        node === undefined ? this.versionClaimed(viewer.id, view) : this.once.has(exposedKey);
      if (!claimed) return "unexposed";
    }
    if (this.opts.exposure !== undefined && !(await this.opts.exposure.saw(q))) return "unexposed";

    // 7. once
    const onceKey =
      s.kind === "exposure"
        ? exposedKey
        : s.kind === "engagement"
          ? `${pair}${SEP}engagement${SEP}${s.action}`
          : s.kind === "feedback"
            ? `${pair}${SEP}feedback`
            : `${viewer.id}${SEP}${view.experienceId}${SEP}${view.versionHash}${SEP}outcome${SEP}${s.name}`;
    if (this.once.has(onceKey)) return "duplicate";

    if (s.kind === "exposure" && restricted) {
      const rk = `${viewer.id}${SEP}${view.experienceId}${SEP}${view.versionHash}`;
      const n = this.restrictedSeen.get(rk) ?? 0;
      if (n >= this.maxRestricted) return "restricted-cap";
      this.restrictedSeen.set(rk, n + 1);
      if (this.restrictedSeen.size > 50_000)
        this.restrictedSeen.delete(this.restrictedSeen.keys().next().value as string);
    }

    // credit every target; refuse the signal if any bucket would pass the capacity bound
    const buckets = [];
    for (const t of targets) {
      const b = this.opts.accumulator.bucket(t, window);
      if (b === undefined) return "capacity";
      buckets.push(b);
    }
    this.once.add(onceKey);
    if (s.kind === "exposure")
      this.once.add(`${viewer.id}${SEP}${view.experienceId}${SEP}${view.versionHash}${SEP}seen`);
    for (const b of buckets) apply(b, s, this.engagedBefore(pair));
    if (s.kind === "engagement") this.markEngaged(pair, s);
    return undefined;
  }

  private versionClaimed(
    viewerId: string,
    view: { experienceId: string; versionHash: string }
  ): boolean {
    return this.once.has(
      `${viewerId}${SEP}${view.experienceId}${SEP}${view.versionHash}${SEP}seen`
    );
  }
  private engagedBefore(pair: string): boolean {
    return this.once.has(`${pair}${SEP}engaged`);
  }
  private markEngaged(pair: string, s: InteractionSignal): void {
    if (s.kind === "engagement" && (s.action !== "dwell" || s.bucket >= 2))
      this.once.add(`${pair}${SEP}engaged`);
  }
}

function apply(b: MutableSummary, s: InteractionSignal, alreadyEngaged: boolean): void {
  switch (s.kind) {
    case "exposure":
      b.exposed += 1;
      return;
    case "engagement": {
      if (s.action === "dwell")
        b.dwell[Math.min(3, s.bucket)] = (b.dwell[Math.min(3, s.bucket)] as number) + 1;
      else b.clicked += 1;
      const counts = s.action !== "dwell" || s.bucket >= 2;
      if (counts && !alreadyEngaged) b.engaged += 1;
      return;
    }
    case "feedback":
      b.feedbackCount += 1;
      b.feedbackSum += s.rating;
      return;
    case "outcome":
      b.outcomes += 1;
      if (s.success) b.outcomeSuccesses += 1;
  }
}
