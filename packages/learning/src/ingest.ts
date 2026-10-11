import type { Audience } from "@loom-ui/core";
import { type InteractionSignal, validateSignalBatch } from "@loom-ui/core/signals";
import type { ExposureCheck } from "./exposure";
import {
  RESTRICTED_NODE,
  type Vote,
  type VoteLedger,
  type VoteSignal,
  visibleNode,
} from "./ledger";
import type { DecisionLink, DecisionLinkResolver, DecisionRef } from "./links";

// ── Ingesting untrusted signals (U11) ─────────────────────────────────────────
// A batch arrives from a browser the host does not control. The ingestor's job is to decide which
// of its signals may be APPENDED to which decision's vote log; the log's fold (see ledger.ts) then
// reduces each viewer to one bounded vote. In order:
//   1. COST     — every call is charged to the viewer's rate budget BEFORE anything is parsed, so a
//                 refusal (malformed, unknown view, replay) costs the sender as much as an acceptance;
//   2. SHAPE    — `validateSignalBatch` (bounded strings, in-range integers, <=64 signals);
//   3. WHICH    — the view must be registered for THIS tenant (a link without a tenant cannot exist);
//   4. NODE     — a visible node must be listed in the link and visible to this viewer; unlisted and
//                 hidden answer identically. A restricted placeholder is credited at VERSION level
//                 only, all of them collapsed onto one — its alias carries no weight, and a
//                 `restricted` flag on a node the link lists is refused;
//   5. SAW IT   — `exposure` is REQUIRED: an authoritative check (`seenLogExposure`), or the explicit
//                 `"client-claimed"` opt-out, where the fold credits an engagement only after the
//                 same viewer's claimed exposure of that node;
//   6. OUTCOME  — only a name the host registered with the ledger.
// The viewer is the host's authenticated session, keyed by tenant AND id, never the payload.
//
// WHAT THE CALLER SEES. `IngestResult` says why a signal was refused, including `unknown-node`; that
// is for the HOST's logs. Do not echo it to the client: answer every well-formed POST with the same
// bare 204, or the reasons become an oracle.

export type IngestRefusal = "batch-invalid" | "rate-limited" | "duplicate-batch" | "unknown-view";

/** Why one signal inside an accepted batch was not appended. */
export type SignalRejection =
  | "invalid"
  | "unexposed"
  | "unknown-node"
  | "restricted-misuse"
  | "unknown-outcome"
  | "capacity"
  | "viewer-capacity"
  | "contended"
  | "closed";

export interface IngestResult {
  /** Signals appended to at least one decision's log. */
  readonly accepted: number;
  readonly rejected: Readonly<Partial<Record<SignalRejection, number>>>;
  /** Set when the WHOLE batch was refused (then `accepted` is 0). */
  readonly refused?: IngestRefusal;
  readonly detail?: string;
}

export interface Viewer {
  /** The authenticated viewer id: from the host's session, NEVER from the batch. */
  readonly id: string;
  /** REQUIRED. Part of the viewer's identity and of the link lookup. */
  readonly tenant: string;
}

export interface SignalIngestorOptions {
  readonly links: DecisionLinkResolver;
  readonly ledger: VoteLedger;
  /** Injected time (ms) for the rate budget. */
  readonly clock: () => number;
  /**
   * REQUIRED. An authoritative "was it shown" check (e.g. `seenLogExposure(log, { versionIsEnough:
   * false })`), or `"client-claimed"`: trust the client's own exposure signals, which stops an
   * engagement on a node the client never claimed to show and nothing more. Demos and tests only.
   */
  readonly exposure: ExposureCheck | "client-claimed";
  /** Signals one viewer may submit per `rateWindowMs` (each refused call costs at least 1). Default 512. */
  readonly rateLimit?: number;
  /** Default 60 s. */
  readonly rateWindowMs?: number;
  /** Viewers tracked for rate/replay at once (least recently seen out). Default 50 000. */
  readonly maxViewers?: number;
}

interface ViewerRuntime {
  start: number;
  used: number;
  batches: Set<string>;
}
const MAX_RECENT_BATCHES = 128;

const SEP = "\u0000";
const refKey = (r: DecisionRef): string => `${r.executionId}${SEP}${r.decisionId}`;

/** What a raw call costs before it is parsed: its claimed signal count, at least 1, at most a batch. */
function rawCost(raw: unknown): number {
  const s = (raw as { signals?: unknown } | null)?.signals;
  return Array.isArray(s) ? Math.max(1, Math.min(s.length, 65)) : 1;
}

export class SignalIngestor {
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;
  private readonly maxViewers: number;
  private readonly viewers = new Map<string, ViewerRuntime>();

  constructor(private readonly opts: SignalIngestorOptions) {
    if (opts.exposure === undefined)
      throw new Error(
        'SignalIngestor: `exposure` is required - pass an ExposureCheck (seenLogExposure) or the explicit "client-claimed"'
      );
    this.rateLimit = Math.max(1, opts.rateLimit ?? 512);
    this.rateWindowMs = Math.max(1, opts.rateWindowMs ?? 60_000);
    this.maxViewers = Math.max(1, opts.maxViewers ?? 50_000);
  }

  /**
   * `audience`: the audience of the surface the signals came from. `"broadcast"` judges exposure
   * (and `visibleTo`) on what a viewer with no clearance was shown, not on the principal's own view.
   */
  async ingest(input: {
    readonly viewer: Viewer;
    readonly raw: unknown;
    readonly audience?: Audience;
  }): Promise<IngestResult> {
    const { viewer } = input;
    if (
      typeof viewer?.id !== "string" ||
      viewer.id === "" ||
      typeof viewer.tenant !== "string" ||
      viewer.tenant === ""
    )
      throw new TypeError(
        "SignalIngestor.ingest: the viewer must name an id and a tenant (from the session)"
      );
    const none = (refused: IngestRefusal, detail?: string): IngestResult => ({
      accepted: 0,
      rejected: {},
      refused,
      ...(detail !== undefined && { detail }),
    });
    const ledger = this.opts.ledger;
    const vk = ledger.viewerKey(viewer.tenant, viewer.id);

    // 1. cost, before anything else
    const rt = this.runtimeOf(vk);
    const now = this.opts.clock();
    if (now - rt.start >= this.rateWindowMs || now < rt.start) {
      rt.start = now;
      rt.used = 0;
    }
    const cost = rawCost(input.raw);
    if (rt.used + cost > this.rateLimit) return none("rate-limited");
    rt.used += cost;

    const v = validateSignalBatch(input.raw);
    if (!v.ok) return none("batch-invalid", v.reason);
    const { batch } = v;
    if (rt.batches.has(batch.batchId)) return none("duplicate-batch");

    const link = this.opts.links.resolve({
      tenant: viewer.tenant,
      experienceId: batch.view.experienceId,
      versionHash: batch.view.versionHash,
    });
    if (link === undefined || link.tenant !== viewer.tenant) return none("unknown-view");

    const rejected: Partial<Record<SignalRejection, number>> = {};
    const reject = (r: SignalRejection, n = 1) => {
      rejected[r] = (rejected[r] ?? 0) + n;
    };
    if (v.rejected > 0) reject("invalid", v.rejected);

    const visible = link.visibleTo?.(viewer, input.audience);
    const check = this.opts.exposure === "client-claimed" ? undefined : this.opts.exposure;
    const base = {
      viewerId: viewer.id,
      tenant: viewer.tenant,
      experienceId: batch.view.experienceId,
      versionHash: batch.view.versionHash,
      ...(input.audience !== undefined && { audience: input.audience }),
    };
    const memo = new Map<string, Promise<boolean>>();
    const saw = (node: string | undefined, restricted: boolean): Promise<boolean> => {
      if (check === undefined) return Promise.resolve(true);
      const k = `${node ?? ""}${SEP}${restricted}`;
      let p = memo.get(k);
      if (p === undefined) {
        p = Promise.resolve(
          check.saw({
            ...base,
            ...(node !== undefined && { node }),
            ...(restricted && { restricted: true }),
          })
        ).catch(() => false);
        memo.set(k, p);
      }
      return p;
    };

    const perDecision = new Map<string, { ref: DecisionRef; sigs: VoteSignal[] }>();
    const put = (ref: DecisionRef, s: VoteSignal) => {
      const k = refKey(ref);
      const e = perDecision.get(k) ?? { ref, sigs: [] as VoteSignal[] };
      perDecision.set(k, e);
      e.sigs.push(s);
    };
    const everyDecision = (s: VoteSignal) => {
      for (const d of link.decisions) put(d, s);
    };
    let versionExposed = false;
    let appended = 0;

    for (const s of batch.signals as readonly InteractionSignal[]) {
      const node = "node" in s ? s.node : undefined;
      const restricted = "restricted" in s && s.restricted === true;
      // 4. node
      let target: readonly DecisionRef[] | undefined;
      let tag: string | undefined;
      if (node !== undefined && restricted) {
        if (link.nodes !== undefined && Object.hasOwn(link.nodes, node)) {
          reject("restricted-misuse");
          continue;
        }
        target = link.decisions;
        tag = RESTRICTED_NODE;
      } else if (node !== undefined) {
        const listed = link.nodes === undefined || Object.hasOwn(link.nodes, node);
        if (!listed || (visible !== undefined && !visible.has(node))) {
          reject("unknown-node");
          continue;
        }
        target =
          link.nodes === undefined
            ? link.decisions
            : [(link.nodes as Record<string, DecisionRef>)[node] as DecisionRef];
        tag = visibleNode(node);
      } else target = link.decisions;
      if (target.length === 0) {
        reject("unknown-node");
        continue;
      }
      // 6. outcome names
      if (s.kind === "outcome" && !ledger.spec.outcomes.includes(s.name)) {
        reject("unknown-outcome");
        continue;
      }
      // 5. saw it
      if (!(await saw(node === undefined ? undefined : node, restricted))) {
        reject("unexposed");
        continue;
      }
      const emit = (vs: VoteSignal) => {
        for (const d of target as readonly DecisionRef[]) put(d, vs);
      };
      switch (s.kind) {
        case "exposure":
          emit({ k: "x", n: tag as string });
          versionExposed = true;
          break;
        case "engagement":
          emit(
            s.action === "dwell"
              ? { k: "d", n: tag as string, b: s.bucket }
              : { k: "c", n: tag as string, a: s.action, c: s.count }
          );
          break;
        case "feedback":
          emit({ k: "f", r: s.rating, ...(tag !== undefined && { n: tag }) });
          break;
        case "outcome":
          everyDecision({ k: "o", name: s.name, ok: s.success });
          break;
      }
      appended += 1;
    }

    // version-level exposure (what version-level feedback / outcomes lean on)
    const versionLevel = batch.signals.some(
      (s) => s.kind === "outcome" || (s.kind === "feedback" && s.node === undefined)
    );
    if (versionExposed || (versionLevel && check !== undefined && (await saw(undefined, false))))
      everyDecision({ k: "vx" });

    let wrote = 0;
    for (const { ref, sigs } of perDecision.values()) {
      const vote: Vote = { v: vk, b: batch.batchId, s: sigs };
      const r = await ledger.recordVote(ref, vote);
      if (r === "ok") wrote += 1;
      else reject(r, sigs.filter((x) => x.k !== "vx").length);
    }
    rt.batches.add(batch.batchId);
    if (rt.batches.size > MAX_RECENT_BATCHES)
      rt.batches.delete(rt.batches.values().next().value as string);
    return { accepted: wrote > 0 ? appended : 0, rejected };
  }

  private runtimeOf(vk: string): ViewerRuntime {
    let rt = this.viewers.get(vk);
    if (rt === undefined) rt = { start: 0, used: 0, batches: new Set() };
    this.viewers.delete(vk);
    this.viewers.set(vk, rt);
    while (this.viewers.size > this.maxViewers)
      this.viewers.delete(this.viewers.keys().next().value as string);
    return rt;
  }
}

export type { DecisionLink };
