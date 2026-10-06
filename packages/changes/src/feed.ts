import {
  type ChangeDescription,
  type DescribeOptions,
  type Finding,
  type HeadSignal,
  type ProjectionCatalog,
  describeChange,
} from "@loom-ui/core";
import {
  EXPERIENCE_BRANCHED,
  EXPERIENCE_PROMOTED,
  EXPERIENCE_REVERTED,
  type Lineage,
  type LineageStore,
  foldLineage,
} from "@loom-ui/lineage";

// ── The change feed ───────────────────────────────────────────────────────────
// A feed turns one experience's lineage log into a stream of CHANGE EVENTS a notifier can consume:
// "version X was composed", "version Y is now shown". An event says THAT and WHERE; it carries no
// node, no data and no text, because what a change MEANS is viewer-specific and the log holds
// content the viewer may not see. `describe(event, { viewer })` is where a viewer learns what
// changed, through `describeChange`'s redaction.
//
//   - RESUMABLE: a consumer keeps a cursor (the last `sequence` it handled) and asks for what is
//     after it. The cursor is the log's own dense sequence, so it survives a restart.
//   - AT-LEAST-ONCE with IDEMPOTENT ids: `id` is a pure function of the log position, so reading
//     the same range twice, or resubscribing from an older cursor, yields the same ids. A consumer
//     dedupes on `id` (or just on `sequence`).
//   - SERVER-SIDE. It reads the lineage store and the content store; never import it from a client.

export type ChangeEventKind = "composed" | "reverted" | "branched" | "promoted";

export interface ChangeEvent {
  /** Stable, unique per log position: `<experienceId>#<sequence>`. The idempotency key. */
  readonly id: string;
  readonly experienceId: string;
  /** 1-based position in the line's log; also the cursor value that means "handled through here". */
  readonly sequence: number;
  readonly at: string;
  readonly kind: ChangeEventKind;
  /** The version this event is about (the new head, or the version now shown). */
  readonly versionHash: string;
  /** What it replaced: the parent (composed/reverted), the forked version (branched), the version shown before (promoted); null = nothing. */
  readonly base: { readonly experienceId: string; readonly versionHash: string } | null;
}

export type ReadResult =
  | {
      readonly ok: true;
      readonly events: readonly ChangeEvent[];
      /** The sequence of the last event returned, or `after` when none was: pass it back as `after`. */
      readonly cursor: number;
      /** More events remain past `cursor` (the page was full). */
      readonly more: boolean;
      /** The log's tip at read time (0 = empty). */
      readonly tip: number;
    }
  | { readonly ok: false; readonly finding: Finding };

export type DescribeResult =
  | { readonly ok: true; readonly description: ChangeDescription }
  | { readonly ok: false; readonly finding: Finding };

export interface RetryOptions {
  /** First retry delay in ms (default 250). Doubles per consecutive failure. */
  readonly baseMs?: number;
  /** Delay ceiling in ms (default 30000). */
  readonly maxMs?: number;
}

export interface SubscribeOptions {
  /** Deliver events after this sequence (default 0 = from the start). */
  readonly after?: number;
  /** A failed read, or a handler that threw. Never throws itself. */
  readonly onError?: (err: unknown) => void;
  /** Backoff for re-trying a failed delivery or read with no new append. See `subscribe`. */
  readonly retry?: RetryOptions;
  /**
   * Called after each failed delivery of the SAME event, with the count of consecutive failures.
   * Return `true` to SKIP the event (the cursor moves past it, it is never redelivered to this
   * subscription); anything else (or a throw) keeps retrying. Absent = retry forever with capped
   * backoff: a poison event then stalls this subscription (and only it); a host that wants out
   * resubscribes with `after: <poison sequence>`.
   */
  readonly onPoison?: (event: ChangeEvent, attempts: number) => boolean | Promise<boolean>;
}

export interface ChangeFeed {
  read(experienceId: string, opts?: { after?: number; limit?: number }): Promise<ReadResult>;
  /**
   * Catch up from `after`, then follow the line, until the returned function is called. Events
   * arrive in sequence order, one at a time (the next waits for the handler's promise). A handler
   * that throws stops this pass at that event WITHOUT advancing: it is delivered again (at-least-
   * once), and `onError` hears of it. The retry does NOT wait for a new append: while the cursor is
   * behind the tip (a handler threw, or a read failed) a bounded exponential backoff timer
   * (jittered, `unref`'d, cleared on unsubscribe) re-runs the pass, so a quiet line is never stuck.
   * A permanently failing event is a poison event: see `SubscribeOptions.onPoison`. Resubscribing
   * from an older cursor redelivers the same ids.
   */
  subscribe(
    experienceId: string,
    handler: (event: ChangeEvent) => void | Promise<void>,
    opts?: SubscribeOptions
  ): () => void;
  /** What `event` changed, for one viewer. See `describeChange`: restricted content is never named. */
  describe(
    event: ChangeEvent,
    opts?: Omit<DescribeOptions, "ops" | "summary" | "summaryClass">
  ): Promise<DescribeResult>;
}

export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 1000;

export interface LineageChangeFeedOptions {
  readonly lineage: Lineage;
  /** The same `LineageStore` the `Lineage` writes to. */
  readonly events: LineageStore;
  /** What wakes a subscription; see `pollingHeadSignal` / `eventStoreHeadSignal`. */
  readonly signal: HeadSignal;
  /**
   * The projections the host offers (the same `ProjectionCatalog` `compile` takes). ABSENT = none:
   * every projection-bound node is hidden from every viewer in `describe`, and a change to one is
   * a `restricted-changed`. An id the catalogue lacks, or a version pin that drifted, hides too.
   */
  readonly projections?: ProjectionCatalog;
  /** The host's hydration projection id (reserved; see `DescribeOptions`). */
  readonly hydrationProjectionId?: string;
}

const err = (code: string, message: string): { ok: false; finding: Finding } => ({
  ok: false,
  finding: { code, severity: "error", message },
});

const asCursor = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;

/**
 * A `ChangeFeed` over a `Lineage`. `read` folds the whole line (validating it: a malformed log is a
 * finding, never partial events) so it is O(log length) per call; a deployment with very long lines
 * pages with `limit` but still pays the fold: cache above this seam, not inside it.
 */
export class LineageChangeFeed implements ChangeFeed {
  private readonly lineage: Lineage;
  private readonly events: LineageStore;
  private readonly signal: HeadSignal;
  private readonly projections: ProjectionCatalog | undefined;
  private readonly hydrationProjectionId: string | undefined;

  constructor(opts: LineageChangeFeedOptions) {
    this.projections = opts.projections;
    this.hydrationProjectionId = opts.hydrationProjectionId;
    this.lineage = opts.lineage;
    this.events = opts.events;
    this.signal = opts.signal;
  }

  async read(
    experienceId: string,
    opts: { after?: number; limit?: number } = {}
  ): Promise<ReadResult> {
    const after = opts.after === undefined ? 0 : asCursor(opts.after);
    if (after === undefined) return err("cursor-invalid", "after is not a non-negative integer");
    const limit =
      opts.limit === undefined
        ? DEFAULT_PAGE
        : Number.isSafeInteger(opts.limit) && opts.limit >= 1
          ? Math.min(opts.limit, MAX_PAGE)
          : undefined;
    if (limit === undefined) return err("limit-invalid", "limit is not a positive integer");
    const records = await this.events.read(experienceId);
    const fold = foldLineage(experienceId, records);
    if (!fold.ok) return { ok: false, finding: fold.finding };
    const out: ChangeEvent[] = [];
    let promoted: string | null = null;
    let more = false;
    for (const rec of records) {
      // The fold validated every record, so these payload reads are of checked shapes.
      const p = rec.payload as { versionHash: string };
      const version = fold.state.versions.get(p.versionHash);
      let kind: ChangeEventKind;
      let base: ChangeEvent["base"];
      if (rec.type === EXPERIENCE_PROMOTED) {
        kind = "promoted";
        base = promoted === null ? null : { experienceId, versionHash: promoted };
        promoted = p.versionHash;
      } else {
        kind =
          rec.type === EXPERIENCE_REVERTED
            ? "reverted"
            : rec.type === EXPERIENCE_BRANCHED
              ? "branched"
              : "composed";
        const parent = version?.parents[0];
        base =
          kind === "branched" && version?.from !== undefined
            ? { experienceId: version.from.experienceId, versionHash: version.from.versionHash }
            : parent === undefined
              ? null
              : { experienceId, versionHash: parent };
      }
      if (rec.sequence <= after) continue;
      if (out.length === limit) {
        more = true;
        break;
      }
      out.push({
        id: `${experienceId}#${rec.sequence}`,
        experienceId,
        sequence: rec.sequence,
        at: rec.at,
        kind,
        versionHash: p.versionHash,
        base,
      });
    }
    return {
      ok: true,
      events: out,
      cursor: out.at(-1)?.sequence ?? after,
      more,
      tip: fold.state.sequence,
    };
  }

  subscribe(
    experienceId: string,
    handler: (event: ChangeEvent) => void | Promise<void>,
    opts: SubscribeOptions = {}
  ): () => void {
    let cursor = asCursor(opts.after) ?? 0;
    let stopped = false;
    let running = false;
    let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0; // consecutive failed passes, for the backoff
    let poisonSeq = 0;
    let poisonAttempts = 0;
    const baseMs = Math.max(1, finite(opts.retry?.baseMs, 250));
    const maxMs = Math.max(baseMs, finite(opts.retry?.maxMs, 30_000));
    const report = (e: unknown) => {
      try {
        opts.onError?.(e);
      } catch {
        // a reporting hook must not break delivery
      }
    };
    // The cursor is behind the tip whenever a pass failed: retry on a timer, since a quiet line
    // raises no signal. Delay = min(max, base * 2^n), jittered into [50%, 100%].
    const arm = (): void => {
      if (stopped || timer !== undefined) return;
      const delay = Math.min(maxMs, baseMs * 2 ** Math.min(failures, 30));
      failures += 1;
      timer = setTimeout(
        () => {
          timer = undefined;
          void pump();
        },
        Math.max(1, Math.round(delay * (0.5 + Math.random() / 2)))
      );
      (timer as { unref?: () => void }).unref?.();
    };
    const skipPoison = async (e: ChangeEvent): Promise<boolean> => {
      if (poisonSeq !== e.sequence) {
        poisonSeq = e.sequence;
        poisonAttempts = 0;
      }
      poisonAttempts += 1;
      if (opts.onPoison === undefined) return false;
      try {
        return (await opts.onPoison(e, poisonAttempts)) === true;
      } catch (thrown) {
        report(thrown);
        return false;
      }
    };
    const pump = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      let failed = false;
      try {
        do {
          again = false;
          for (;;) {
            if (stopped) return;
            const r = await this.read(experienceId, { after: cursor });
            if (!r.ok) {
              report(r.finding);
              failed = true;
              return;
            }
            for (const e of r.events) {
              if (stopped) return;
              try {
                await handler(e);
              } catch (thrown) {
                report(thrown);
                if (await skipPoison(e)) {
                  cursor = e.sequence;
                  continue;
                }
                failed = true;
                return; // not advanced: redelivered by the retry timer or the next wake
              }
              cursor = e.sequence;
              failures = 0;
            }
            if (!r.more) break;
          }
        } while (again && !stopped);
      } catch (thrown) {
        report(thrown);
        failed = true;
      } finally {
        running = false;
        if (failed) arm();
        else failures = 0;
      }
    };
    const unwatch = this.signal.watch(experienceId, () => void pump());
    void pump();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      unwatch();
    };
  }

  async describe(
    event: ChangeEvent,
    opts: Omit<DescribeOptions, "ops" | "summary" | "summaryClass"> = {}
  ): Promise<DescribeResult> {
    // The caller's event is a CLAIM about the log, not the log: its experience and sequence are
    // used only to find the recorded event, and `kind`/`base`/`versionHash` come from the fold.
    // An event that does not match the record at its position is refused (a forged `base` would
    // otherwise describe a different line's nodes: a confused deputy).
    const seq = event?.sequence;
    if (typeof event?.experienceId !== "string" || !Number.isSafeInteger(seq) || seq < 1)
      return err("event-invalid", "the event has no readable line and sequence");
    const at = await this.read(event.experienceId, { after: seq - 1, limit: 1 });
    if (!at.ok) return { ok: false, finding: at.finding };
    const truth = at.events[0];
    if (truth === undefined || truth.sequence !== seq)
      return err("event-unknown", "the event is not in the line's log");
    if (
      truth.versionHash !== event.versionHash ||
      truth.kind !== event.kind ||
      JSON.stringify(truth.base) !== JSON.stringify(event.base ?? null)
    )
      return err("event-mismatch", "the event does not match the log's record at its sequence");
    const versions = await this.lineage.versions(truth.experienceId);
    if (!versions.ok) return refusal(versions.refusal);
    const record = versions.value.find((v) => v.versionHash === truth.versionHash);
    if (record === undefined)
      return err("version-unknown", `"${truth.versionHash}" is not a version of the line`);
    const next = await this.lineage.get(truth.experienceId, truth.versionHash);
    if (!next.ok) return refusal(next.refusal);
    let prev = null;
    if (truth.base !== null) {
      const p = await this.lineage.get(truth.base.experienceId, truth.base.versionHash);
      if (!p.ok) return refusal(p.refusal);
      prev = p.value;
    }
    // The ops and the summary belong to ONE version. They describe this event when it IS that
    // version's creation, or when a promotion spans exactly that one step.
    const own = truth.kind !== "promoted" || record.parents.includes(truth.base?.versionHash ?? "");
    return {
      ok: true,
      description: describeChange(prev, next.value, {
        ...(this.projections !== undefined && { projections: this.projections }),
        ...(this.hydrationProjectionId !== undefined && {
          hydrationProjectionId: this.hydrationProjectionId,
        }),
        ...opts,
        ...(own && record.ops.length > 0 && { ops: record.ops }),
        ...(own && record.summary !== undefined && { summary: record.summary }),
        ...(own && record.summaryClass !== undefined && { summaryClass: record.summaryClass }),
      }),
    };
  }
}

const finite = (v: unknown, dflt: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : dflt;

function refusal(r: { kind: string; finding?: Finding }): { ok: false; finding: Finding } {
  return {
    ok: false,
    finding: r.finding ?? {
      code: r.kind,
      severity: "error",
      message: `the lineage refused: ${r.kind}`,
    },
  };
}
