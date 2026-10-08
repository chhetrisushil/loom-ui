// `@loom-ui/core/signals` — interaction signals (U11): the opt-in, privacy-preserving record of what a
// viewer did with a surface, so a reward can be attributed to the planner decision that produced it.
//
// WHAT A SIGNAL IS. A signal names a surface VERSION and (usually) a NODE id, and carries one of four
// facts: the node was EXPOSED (rendered and visible), the viewer ENGAGED with it (a click / expand
// count, or a dwell BUCKET), explicit FEEDBACK (a 1-5 rating), or a task OUTCOME (a token and a
// boolean). That is the whole vocabulary, on purpose:
//
//   - NO content, NO text, NO free-form strings: every string is a BOUNDED, control-free string (a node
//     id is the Blueprint's own id, which the page already holds, <=128 chars) or a strict TOKEN (an
//     outcome name or batch id is `[A-Za-z0-9_.:-]`);
//   - NO raw timing: dwell is accumulated on the client for the whole view and sent ONCE, as one of
//     four buckets per node, when the view is sealed; engagement is a coalesced COUNT (capped);
//   - a node drawn as a restricted placeholder is reported as `restricted: true` under its OPAQUE alias
//     (U10c), and a host attributes it at VERSION level only — it is never mapped back to a real id;
//   - everything is BOUNDED: tracked nodes, signals per batch, queued batches. A bound that is hit
//     drops (and counts) — it never grows.
//
// This module is pure and isomorphic (no zod, no DOM, no Node), so a browser can import it. It does
// not decide who the viewer is or whether to trust the batch: a signal is UNTRUSTED CLIENT INPUT, and
// the host half (`@loom-ui/learning`) validates, dedupes, rate-limits and re-checks exposure before a
// reward is derived from one. `validateSignalBatch` here is the shared, total, hand-written validator.

export const SIGNAL_VERSION = 1;
/** Signals one batch carries (a larger batch is refused whole by `validateSignalBatch`). */
export const MAX_SIGNALS_PER_BATCH = 64;
/** Distinct nodes the collector tracks per view; past it a node is dropped and counted. */
export const MAX_TRACKED_NODES = 512;
/** Ready-to-send batches the collector queues while the sink is failing; past it the oldest is dropped. */
export const MAX_QUEUED_BATCHES = 16;
export const MAX_NODE_ID_LENGTH = 128;
export const MAX_NAME_LENGTH = 48;
/** Largest engagement count one signal carries (a coalesced count, not an event stream). */
export const MAX_ENGAGEMENT_COUNT = 255;
/** Dwell is bucketed at these edges (ms): [0,1s) [1s,5s) [5s,30s) [30s,∞) → bucket 0..3. */
export const DWELL_EDGES_MS: readonly number[] = [1_000, 5_000, 30_000];
export const DWELL_BUCKETS = DWELL_EDGES_MS.length + 1;
/** Dwell a node can accumulate in one view (ms); past it more time adds nothing. */
const MAX_DWELL_MS = 10 * 60_000;

export type ClickAction = "click" | "expand";
export type EngagementAction = ClickAction | "dwell";

export interface SignalView {
  readonly experienceId: string;
  readonly versionHash: string;
  /** The compile fingerprint of the view (`compileFingerprint`), when the host declared one. */
  readonly compile?: string;
}

interface NodeFields {
  /** The Blueprint id of the node, as the viewer holds it. An opaque alias when `restricted`. */
  readonly node: string;
  readonly restricted?: true;
}

export type InteractionSignal =
  | ({ readonly kind: "exposure" } & NodeFields)
  | ({
      readonly kind: "engagement";
      readonly action: ClickAction;
      /** Coalesced occurrences, 1..{@link MAX_ENGAGEMENT_COUNT}. */
      readonly count: number;
    } & NodeFields)
  | ({
      readonly kind: "engagement";
      readonly action: "dwell";
      /** 0..3, see {@link DWELL_EDGES_MS}. */
      readonly bucket: number;
    } & NodeFields)
  | {
      readonly kind: "feedback";
      /** 1..5. Absent node = feedback on the surface as a whole. */
      readonly rating: number;
      readonly node?: string;
      readonly restricted?: true;
    }
  | { readonly kind: "outcome"; readonly name: string; readonly success: boolean };

export interface SignalBatch {
  readonly v: typeof SIGNAL_VERSION;
  /** Unique per batch; a resend of a failed batch keeps it, so the host can dedupe it. */
  readonly batchId: string;
  readonly view: SignalView;
  readonly signals: readonly InteractionSignal[];
}

/** The host's transport. Reject (or throw) to say "not delivered": the collector re-queues, bounded. */
export type SignalSink = (batch: SignalBatch) => void | Promise<void>;

// ── tokens ────────────────────────────────────────────────────────────────────

// Control characters and bidi controls: a node id or name must never smuggle either into a log line.
// A code-point test, not a regex: a formatter may rewrite escapes in a regex into the raw characters.
function unsafe(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x200e ||
      c === 0x200f ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    )
      return true;
  }
  return false;
}
const TOKEN = /^[A-Za-z0-9_.:-]+$/;

const safeString = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= max && !unsafe(v);
const isToken = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= max && TOKEN.test(v);

/** Dwell → bucket index. Total: a non-finite or negative duration is bucket 0. */
export function dwellBucket(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  let b = 0;
  for (const edge of DWELL_EDGES_MS) if (ms >= edge) b += 1;
  return b;
}

// ── the collector ─────────────────────────────────────────────────────────────

export interface SignalCollectorOptions {
  readonly sink: SignalSink;
  /**
   * Ids drawn as bare restricted placeholders in this view (`CompileResult.fingerprint.placeholderNodes`).
   * A signal on one is reported `restricted: true`. Replaced by `setView`.
   */
  readonly placeholders?: Iterable<string>;
  /** Mints a batch id. Default: a per-collector random session prefix and a counter. */
  readonly newBatchId?: () => string;
  /** Test seam: distinct nodes tracked per view. */
  readonly maxTrackedNodes?: number;
}

export interface CollectorStats {
  /** Signals dropped by a bound or a malformed input; they were never sent. */
  readonly dropped: number;
  /** Signals lost to a queue overflow while the sink was failing. */
  readonly lost: number;
  /** Batches waiting for a sink that accepted them. */
  readonly queued: number;
}

interface ViewState {
  readonly view: SignalView;
  placeholders: ReadonlySet<string>;
  readonly exposed: Set<string>;
  readonly clicks: Map<string, number>; // `${action}\u0000${node}` → count
  readonly dwell: Map<string, number>; // node → ms
  readonly feedback: Map<string, number>; // node ("" = surface) → rating
  readonly outcomes: Map<string, boolean>;
  /** What was last handed to the queue, by signal key: only a CHANGED value is sent again. */
  readonly sent: Map<string, string>;
}

const sessionPrefix = (): string => {
  try {
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } })
      .crypto;
    if (c?.getRandomValues) {
      const a = c.getRandomValues(new Uint32Array(2));
      return `${(a[0] as number).toString(36)}${(a[1] as number).toString(36)}`;
    }
  } catch {
    // fall through
  }
  return Math.random().toString(36).slice(2, 12) || "s";
};

/**
 * Accumulates signals for ONE surface version at a time and sends them in bounded batches.
 * Exposure is once per node and view; clicks and dwell are coalesced; feedback is the last rating
 * per node. Nothing here reads the DOM — `@loom-ui/renderer-lit/signals` drives it from one.
 */
export class SignalCollector {
  private state: ViewState | undefined;
  private readonly queue: SignalBatch[] = [];
  private dropped = 0;
  private lost = 0;
  private counter = 0;
  private readonly session = sessionPrefix();
  private readonly maxNodes: number;
  private flushing: Promise<{ sent: number }> | undefined;

  constructor(private readonly opts: SignalCollectorOptions) {
    this.maxNodes = Math.max(1, opts.maxTrackedNodes ?? MAX_TRACKED_NODES);
    this.placeholders = new Set(opts.placeholders ?? []);
  }
  private placeholders: ReadonlySet<string>;

  get stats(): CollectorStats {
    return { dropped: this.dropped, lost: this.lost, queued: this.queue.length };
  }

  /**
   * Point the collector at a surface version. A DIFFERENT version seals what was collected for the
   * previous one into queued batches (sent by the next `flush`) and starts fresh; the same version
   * only refreshes the placeholder set. An unsealed version (empty hash) collects nothing.
   */
  setView(view: SignalView, placeholders?: Iterable<string>): void {
    if (placeholders !== undefined) this.placeholders = new Set(placeholders);
    const cur = this.state;
    if (
      cur !== undefined &&
      cur.view.experienceId === view.experienceId &&
      cur.view.versionHash === view.versionHash &&
      cur.view.compile === view.compile
    ) {
      cur.placeholders = this.placeholders;
      return;
    }
    if (cur !== undefined) this.seal(cur, true);
    if (
      !safeString(view.experienceId, 256) ||
      !safeString(view.versionHash, 128) ||
      (view.compile !== undefined && !safeString(view.compile, 64))
    ) {
      this.state = undefined;
      return;
    }
    this.state = {
      view: {
        experienceId: view.experienceId,
        versionHash: view.versionHash,
        ...(view.compile !== undefined && { compile: view.compile }),
      },
      placeholders: this.placeholders,
      exposed: new Set(),
      clicks: new Map(),
      dwell: new Map(),
      feedback: new Map(),
      outcomes: new Map(),
      sent: new Map(),
    };
  }

  /** The node was rendered and visible. Once per node and view. */
  expose(node: string): void {
    const s = this.admit(node);
    if (s !== undefined) s.exposed.add(node);
  }

  /** A click / expand on the node. Coalesced into a capped count. */
  engage(node: string, action: ClickAction): void {
    if (action !== "click" && action !== "expand") return void this.dropped++;
    const s = this.admit(node);
    if (s === undefined) return;
    const k = `${action}\u0000${node}`;
    s.clicks.set(k, Math.min(MAX_ENGAGEMENT_COUNT, (s.clicks.get(k) ?? 0) + 1));
  }

  /** Time the node was visible, in ms. Accumulated; only a bucket ever leaves the client. */
  dwell(node: string, ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    const s = this.admit(node);
    if (s === undefined) return;
    s.dwell.set(node, Math.min(MAX_DWELL_MS, (s.dwell.get(node) ?? 0) + ms));
  }

  /** An explicit 1-5 rating, on a node or (no node) on the surface. The last one wins. */
  feedback(rating: number, node?: string): void {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return void this.dropped++;
    const s = node === undefined ? this.state : this.admit(node);
    if (s === undefined) return void (node === undefined && this.dropped++);
    s.feedback.set(node ?? "", rating);
  }

  /** A task outcome. The name is a token (`[A-Za-z0-9_.:-]`, ≤48); the last value per name wins. */
  outcome(name: string, success: boolean): void {
    const s = this.state;
    if (s === undefined || !isToken(name, MAX_NAME_LENGTH) || typeof success !== "boolean")
      return void this.dropped++;
    if (!s.outcomes.has(name) && s.outcomes.size >= 16) return void this.dropped++;
    s.outcomes.set(name, success);
  }

  /**
   * Map a renderer `onAction` to a signal: `feedback` with `{ rating }`, `outcome` with
   * `{ name, success }`, anything else a click on the widget. The payload is read for those fields
   * only — it is never copied.
   */
  observeAction(a: { type: string; widgetId: string; payload?: unknown }): void {
    const p = (typeof a.payload === "object" && a.payload !== null ? a.payload : {}) as Record<
      string,
      unknown
    >;
    if (a.type === "feedback") this.feedback(p.rating as number, a.widgetId);
    else if (a.type === "outcome") this.outcome(p.name as string, p.success as boolean);
    else this.engage(a.widgetId, "click");
  }

  /**
   * Seal the current view's pending signals and hand every queued batch to the sink, oldest first.
   * A batch the sink rejects stays queued (bounded) for the next flush. Concurrent calls share one run.
   */
  flush(opts: { readonly final?: boolean } = {}): Promise<{ sent: number }> {
    if (this.flushing !== undefined) return this.flushing;
    if (this.state !== undefined) this.seal(this.state, opts.final === true);
    const run = (async () => {
      let sent = 0;
      while (this.queue.length > 0) {
        const batch = this.queue[0] as SignalBatch;
        try {
          await this.opts.sink(batch);
        } catch {
          break; // stays queued; the next flush retries it under the same batchId
        }
        this.queue.shift();
        sent += 1;
      }
      return { sent };
    })().finally(() => {
      this.flushing = undefined;
    });
    this.flushing = run;
    return run;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private admit(node: string): ViewState | undefined {
    const s = this.state;
    if (s === undefined || !safeString(node, MAX_NODE_ID_LENGTH)) {
      this.dropped += 1;
      return undefined;
    }
    if (!this.known(s, node) && this.tracked(s) >= this.maxNodes) {
      this.dropped += 1;
      return undefined;
    }
    return s;
  }
  private known(s: ViewState, node: string): boolean {
    return (
      s.exposed.has(node) ||
      s.dwell.has(node) ||
      s.feedback.has(node) ||
      s.clicks.has(`click\u0000${node}`) ||
      s.clicks.has(`expand\u0000${node}`)
    );
  }
  private tracked(s: ViewState): number {
    const ids = new Set<string>(s.exposed);
    for (const k of s.dwell.keys()) ids.add(k);
    for (const k of s.feedback.keys()) if (k !== "") ids.add(k);
    for (const k of s.clicks.keys()) ids.add(k.slice(k.indexOf("\u0000") + 1));
    return ids.size;
  }

  /**
   * Queue what changed since the last seal. Exposure, clicks, feedback and outcomes go out as they
   * stand (the host keeps the max / latest per viewer, so a re-sent total is idempotent). DWELL is
   * the exception: a bucket of a still-running total would be a moving target, so it is sent once
   * when the view is `final` (a new version, a hide, an explicit `flush({ final: true })`) — per-view
   * totals survive intermediate flushes.
   */
  private seal(s: ViewState, final: boolean): void {
    const mark = (node: string): NodeFields => ({
      node,
      ...(s.placeholders.has(node) && { restricted: true as const }),
    });
    const all: Array<[string, InteractionSignal]> = [];
    for (const node of s.exposed) all.push([`x|${node}`, { kind: "exposure", ...mark(node) }]);
    for (const [k, count] of s.clicks) {
      const i = k.indexOf("\u0000");
      const action = k.slice(0, i) as ClickAction;
      const node = k.slice(i + 1);
      all.push([`c|${action}|${node}`, { kind: "engagement", action, count, ...mark(node) }]);
    }
    if (final)
      for (const [node, ms] of s.dwell)
        all.push([
          `d|${node}`,
          { kind: "engagement", action: "dwell", bucket: dwellBucket(ms), ...mark(node) },
        ]);
    for (const [node, rating] of s.feedback)
      all.push([
        `f|${node}`,
        node === "" ? { kind: "feedback", rating } : { kind: "feedback", rating, ...mark(node) },
      ]);
    for (const [name, success] of s.outcomes)
      all.push([`o|${name}`, { kind: "outcome", name, success }]);
    const out: InteractionSignal[] = [];
    for (const [key, sig] of all) {
      const ser = JSON.stringify(sig);
      if (s.sent.get(key) === ser) continue;
      s.sent.set(key, ser);
      out.push(sig);
    }
    for (let i = 0; i < out.length; i += MAX_SIGNALS_PER_BATCH) {
      this.queue.push({
        v: SIGNAL_VERSION,
        batchId: this.opts.newBatchId?.() ?? `${this.session}-${++this.counter}`,
        view: s.view,
        signals: out.slice(i, i + MAX_SIGNALS_PER_BATCH),
      });
    }
    while (this.queue.length > MAX_QUEUED_BATCHES) {
      const gone = this.queue.shift() as SignalBatch;
      this.lost += gone.signals.length;
    }
  }
}

// ── the shared validator ──────────────────────────────────────────────────────

export type BatchRefusal =
  | "not-an-object"
  | "unsupported-version"
  | "bad-batch-id"
  | "bad-view"
  | "bad-signals"
  | "batch-too-large";

export type ValidatedBatch =
  | { readonly ok: true; readonly batch: SignalBatch; readonly rejected: number }
  | { readonly ok: false; readonly reason: BatchRefusal };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function nodeFields(o: Record<string, unknown>, required: boolean): NodeFields | undefined | null {
  if (o.node === undefined && !required) return undefined;
  if (!safeString(o.node, MAX_NODE_ID_LENGTH)) return null;
  if (o.restricted !== undefined && o.restricted !== true) return null;
  return { node: o.node, ...(o.restricted === true && { restricted: true as const }) };
}

function signalOf(raw: unknown): InteractionSignal | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case "exposure": {
      const n = nodeFields(raw, true);
      return n ? { kind: "exposure", ...n } : undefined;
    }
    case "engagement": {
      const n = nodeFields(raw, true);
      if (!n) return undefined;
      if (raw.action === "click" || raw.action === "expand") {
        const c = raw.count;
        if (!Number.isInteger(c) || (c as number) < 1 || (c as number) > MAX_ENGAGEMENT_COUNT)
          return undefined;
        return { kind: "engagement", action: raw.action, count: c as number, ...n };
      }
      if (raw.action === "dwell") {
        const b = raw.bucket;
        if (!Number.isInteger(b) || (b as number) < 0 || (b as number) >= DWELL_BUCKETS)
          return undefined;
        return { kind: "engagement", action: "dwell", bucket: b as number, ...n };
      }
      return undefined;
    }
    case "feedback": {
      const r = raw.rating;
      if (!Number.isInteger(r) || (r as number) < 1 || (r as number) > 5) return undefined;
      const n = nodeFields(raw, false);
      if (n === null) return undefined;
      return { kind: "feedback", rating: r as number, ...(n ?? {}) };
    }
    case "outcome":
      if (!isToken(raw.name, MAX_NAME_LENGTH) || typeof raw.success !== "boolean") return undefined;
      return { kind: "outcome", name: raw.name, success: raw.success };
    default:
      return undefined;
  }
}

/**
 * Validate an UNTRUSTED batch (parsed JSON) and return a CLEAN copy: only known keys, every string a
 * bounded token, every number an in-range integer. Total: never throws. A malformed batch envelope
 * is refused whole; a malformed SIGNAL inside a good envelope is dropped and counted in `rejected`
 * (so one bad entry cannot veto the rest, and a flood of them is visible). More than
 * {@link MAX_SIGNALS_PER_BATCH} signals refuses the whole batch.
 */
export function validateSignalBatch(raw: unknown): ValidatedBatch {
  try {
    if (!isRecord(raw)) return { ok: false, reason: "not-an-object" };
    if (raw.v !== SIGNAL_VERSION) return { ok: false, reason: "unsupported-version" };
    if (!isToken(raw.batchId, 64)) return { ok: false, reason: "bad-batch-id" };
    const v = raw.view;
    if (
      !isRecord(v) ||
      !safeString(v.experienceId, 256) ||
      !safeString(v.versionHash, 128) ||
      (v.compile !== undefined && !safeString(v.compile, 64))
    )
      return { ok: false, reason: "bad-view" };
    if (!Array.isArray(raw.signals)) return { ok: false, reason: "bad-signals" };
    if (raw.signals.length > MAX_SIGNALS_PER_BATCH) return { ok: false, reason: "batch-too-large" };
    const signals: InteractionSignal[] = [];
    let rejected = 0;
    for (const s of raw.signals) {
      const clean = signalOf(s);
      if (clean === undefined) rejected += 1;
      else signals.push(clean);
    }
    return {
      ok: true,
      rejected,
      batch: {
        v: SIGNAL_VERSION,
        batchId: raw.batchId,
        view: {
          experienceId: v.experienceId,
          versionHash: v.versionHash,
          ...(v.compile !== undefined && { compile: v.compile as string }),
        },
        signals,
      },
    };
  } catch {
    return { ok: false, reason: "not-an-object" };
  }
}
