import {
  type ChangeDescription,
  type DescribeOptions,
  type Finding,
  type HeadSignal,
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

export interface SubscribeOptions {
  /** Deliver events after this sequence (default 0 = from the start). */
  readonly after?: number;
  /** A failed read, or a handler that threw. Never throws itself. */
  readonly onError?: (err: unknown) => void;
}

export interface ChangeFeed {
  read(experienceId: string, opts?: { after?: number; limit?: number }): Promise<ReadResult>;
  /**
   * Catch up from `after`, then follow the line, until the returned function is called. Events
   * arrive in sequence order, one at a time (the next waits for the handler's promise). A handler
   * that throws stops this pass at that event WITHOUT advancing: it is delivered again on the next
   * wake (at-least-once), and `onError` hears of it. Resubscribing from an older cursor
   * redelivers the same ids.
   */
  subscribe(
    experienceId: string,
    handler: (event: ChangeEvent) => void | Promise<void>,
    opts?: SubscribeOptions
  ): () => void;
  /** What `event` changed, for one viewer. See `describeChange`: restricted content is never named. */
  describe(
    event: ChangeEvent,
    opts?: Omit<DescribeOptions, "ops" | "summary">
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

  constructor(opts: LineageChangeFeedOptions) {
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
    const report = (e: unknown) => {
      try {
        opts.onError?.(e);
      } catch {
        // a reporting hook must not break delivery
      }
    };
    const pump = async (): Promise<void> => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          for (;;) {
            if (stopped) return;
            const r = await this.read(experienceId, { after: cursor });
            if (!r.ok) {
              report(r.finding);
              return;
            }
            for (const e of r.events) {
              if (stopped) return;
              try {
                await handler(e);
              } catch (thrown) {
                report(thrown);
                return; // not advanced: redelivered on the next wake
              }
              cursor = e.sequence;
            }
            if (!r.more) break;
          }
        } while (again && !stopped);
      } catch (thrown) {
        report(thrown);
      } finally {
        running = false;
      }
    };
    const unwatch = this.signal.watch(experienceId, () => void pump());
    void pump();
    return () => {
      stopped = true;
      unwatch();
    };
  }

  async describe(
    event: ChangeEvent,
    opts: Omit<DescribeOptions, "ops" | "summary"> = {}
  ): Promise<DescribeResult> {
    const versions = await this.lineage.versions(event.experienceId);
    if (!versions.ok) return refusal(versions.refusal);
    const record = versions.value.find((v) => v.versionHash === event.versionHash);
    if (record === undefined)
      return err("version-unknown", `"${event.versionHash}" is not a version of the line`);
    const next = await this.lineage.get(event.experienceId, event.versionHash);
    if (!next.ok) return refusal(next.refusal);
    let prev = null;
    if (event.base !== null) {
      const p = await this.lineage.get(event.base.experienceId, event.base.versionHash);
      if (!p.ok) return refusal(p.refusal);
      prev = p.value;
    }
    // The ops and the summary belong to ONE version. They describe this event when it IS that
    // version's creation, or when a promotion spans exactly that one step.
    const own = event.kind !== "promoted" || record.parents.includes(event.base?.versionHash ?? "");
    return {
      ok: true,
      description: describeChange(prev, next.value, {
        ...opts,
        ...(own && record.ops.length > 0 && { ops: record.ops }),
        ...(own && record.summary !== undefined && { summary: record.summary }),
      }),
    };
  }
}

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
