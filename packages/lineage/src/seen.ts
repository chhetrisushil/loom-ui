import {
  type Experience,
  MAX_SEEN_NODE_IDS,
  MAX_SEEN_SOURCES,
  MAX_SEEN_TOTAL_BYTES,
  MAX_SEEN_VALUE_BYTES,
  type ProjectionCatalog,
  type SeenEntry,
  type SeenSnapshot,
  type Viewer,
  redactSeen,
} from "@loom-ui/core";
import {
  type ContentRef,
  type ContentStore,
  contentAddress,
  decodeValue,
  encodeValue,
} from "@loom/plugin-content";
import { z } from "zod";
import type { Lineage, LineageResult } from "./lineage";
import {
  type SeenKeyStore,
  deriveSeenKeys,
  keyedDigest,
  openText,
  refAad,
  sealText,
  seenKeySubject,
} from "./seenCrypto";
import { LINEAGE_STREAM_PREFIX, type LineageStore, type StoredLineageRecord } from "./store";

// ── The record of what a viewer SAW (U12) ─────────────────────────────────────
// WHERE IT LIVES, and why not the two obvious places:
//
//  * NOT the lineage stream. A lineage line is the SHARED, append-only history of an experience: one
//    compare-and-set tip per line, folded by every reader (the change feed fans it out to every
//    viewer), and its fold is total and structural. A view is per-viewer, high-rate, and carries
//    DATA. Appending views there would make every open of a surface contend with every writer of a
//    version for the same tip, put one viewer's classified values in a log every reader of the line
//    folds, and let a view record change what `verify` of the line has to explain.
//  * NOT the hydration store. That is a latest-value cache for the surface being drawn: it holds
//    the CURRENT value of a handle, evicts, is projected to a client, and keeps no history, so it
//    cannot say what a viewer saw last Tuesday.
//
// So: a SEPARATE, per-(experience, viewer) log in a reserved namespace of the same `LineageStore`
// seam (one stream per viewer: no cross-viewer contention, isolation by key) whose events are
// MANIFESTS. A manifest names the version viewed and, per data source, a class stamp, a delivery
// state and — for a value that fit the caps — a SEALED content reference. The VALUE BYTES live in the
// ContentStore under their plain content address (identical values dedupe across viewers and with the
// lineage). Nothing here is part of any artifact or content address.
//
// ERASURE (crypto-shredding). A plain SHA-256 in an append-only log confirms any low-entropy value
// ("did this viewer see `42`?" is one hash away), and a log has no delete. So each entry's ref is
// stored ENCRYPTED (AES-256-GCM) under a per-(experience, viewer) data key held in a host-supplied
// `SeenKeyStore`, and the manifest digest is a keyed HMAC, not a hash. Erasing a viewer destroys the
// key: nothing left in the stream is decryptable and no readable address remains. The ciphertext is
// bound to (experience, viewer, record sequence, entry index) as associated data, so a ref cannot be
// transplanted between records or viewers. Not hidden by this: the stream's structure (which
// handles/projections an entry named, node ids, class stamps, byte lengths, times). A reader of the
// raw log learns THAT a viewer saw those sources, never a value or its address.
//
// VALUE BLOBS are reclaimed by a MARK-AND-SWEEP collector (`collectSeenGarbage`, seenGc.ts), never a
// refcount: there is no transaction across the event log and the ContentStore, so a counter drifts,
// and a crash between "append" and "increment" would delete a live value. Roots are re-derived from
// the logs on every pass.
//
// RETENTION. A viewer's log is bounded by roll-off, not refusal: new views ALWAYS record, and the
// oldest fall out of a `{ maxViews, maxAgeMs }` window. The log is append-only, so roll-off is a
// watermark: every view record carries the `floor` in force when written, and a `VIEWS_RETAINED`
// record raises it; records at or below the floor are not read and not marked by the collector.
// The tip, floor and last digest come from the LAST record alone, and a read costs the size of the
// window (`readAfter(floor)`), not the age of the log.
//
// Reads are viewer-safe: the entries are redacted against the recorded version's artifact with
// core's `redactSeen` BEFORE any blob is fetched (a viewer is never even handed a restricted ref),
// and a stamp that is missing or unknown is withheld.

export const VIEW_RECORDED = "VIEW_RECORDED";
/** A retention watermark: every record at or below `floor` has rolled off. */
export const VIEWS_RETAINED = "VIEWS_RETAINED";
/** The viewer was erased (written AFTER the key is destroyed; a rerun completes it). */
export const VIEWER_ERASED = "VIEWER_ERASED";
/** The reserved-stream namespace a viewer's record lives under (distinct from the lineage's). */
export const SEEN_STREAM_PREFIX = "__loom_ui_seen__:";
export const SEEN_WORKFLOW_ID = "loom-ui.seen";
/** Default most views a viewer's log keeps readable; older ones roll off (never a refusal). */
export const DEFAULT_MAX_SEEN_VIEWS = 10_000;
/** Most records one read returns. */
export const MAX_SEEN_READ = 500;
const MAX_APPEND_RETRIES = 16;
const MAX_ID = 256;
const MAX_VIEWS_CAP = 1_000_000;

const SourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("handle"), handle: z.string().min(1).max(512) }),
  z.object({
    kind: z.literal("projection"),
    id: z.string().min(1).max(512),
    path: z.string().min(1).max(1024),
    version: z.string().min(1).max(512),
  }),
]);
// `class` is left a plain string here: an unknown stamp must reach `redactSeen` and be WITHHELD there
// (the record is untrusted input), not make the whole record unparseable.
const EntrySchema = z.object({
  source: SourceSchema,
  nodeIds: z.array(z.string().min(1).max(512)).min(1).max(MAX_SEEN_NODE_IDS),
  class: z.string().max(32),
  state: z.enum(["seen", "absent", "oversize", "over-budget", "unreadable"]),
  status: z.string().max(64).optional(),
  bytes: z.number().int().nonnegative().optional(),
  /** The content ref, AEAD-sealed under the viewer's data key (see the header). Never a plain address. */
  sealed: z.string().min(1).max(1024).optional(),
});
export const ViewRecordPayload = z.object({
  experienceId: z.string().min(1).max(MAX_ID),
  versionHash: z.string().min(1).max(256),
  viewerId: z.string().min(1).max(MAX_ID),
  /** The clearance the viewer held when shown the surface (informational: reads use the READER's). */
  clearance: z.string().max(32).optional(),
  entries: z.array(EntrySchema).max(MAX_SEEN_SOURCES),
  omitted: z.number().int().nonnegative(),
  restricted: z.boolean(),
  /** Keyed digest (HMAC under the viewer's key) of the manifest's meaning: an identical consecutive view is not re-recorded. */
  digest: z.string().min(1).max(128),
  /** The retention floor in force when this was written (see the header). */
  floor: z.number().int().nonnegative().optional(),
});
export type ViewRecordPayload = z.infer<typeof ViewRecordPayload>;

/** How long a viewer's views stay readable (and their value blobs live). Old views roll off; new ones always record. */
export interface SeenRetention {
  /** Most views kept readable per viewer (default {@link DEFAULT_MAX_SEEN_VIEWS}). */
  readonly maxViews?: number;
  /** Views older than this (ms, by the record's own time) roll off. Default: no age limit. */
  readonly maxAgeMs?: number;
}

export interface SeenLogOptions {
  /** A `LineageStore` over a namespace of its own (`eventStoreLineageStore(store, { streamPrefix: SEEN_STREAM_PREFIX, workflowId: SEEN_WORKFLOW_ID })`). */
  readonly events: LineageStore;
  /** Where value bytes live. The same store the lineage uses is fine: addresses are content hashes. */
  readonly content: ContentStore;
  /** Resolves the version a record names (and refuses one that is not a version of the line). */
  readonly lineage: Lineage;
  /** Per-(experience, viewer) data keys. Destroying one erases that viewer. A loom `KeyStore` fits. */
  readonly keys: SeenKeyStore;
  readonly retention?: SeenRetention;
  readonly now?: () => string;
}

export type SeenRefusal = { readonly code: string; readonly message: string };
export type SeenResult<T> = { ok: true; value: T } | { ok: false; refusal: SeenRefusal };

const refused = (code: string, message: string): { ok: false; refusal: SeenRefusal } => ({
  ok: false,
  refusal: { code, message },
});

export interface SeenView {
  readonly sequence: number;
  readonly at: string;
  readonly versionHash: string;
  /** The entries THIS reader may see, values resolved. */
  readonly entries: readonly SeenEntry[];
  /** Something was withheld from this reader (a class, an unreadable stamp, a missing artifact): no count, no name. */
  readonly restricted: boolean;
  /** Sources the capture dropped at its source cap. */
  readonly omitted: number;
}

export const seenStreamKey = (experienceId: string, viewerId: string): string =>
  `${encodeURIComponent(experienceId)}/${encodeURIComponent(viewerId)}`;

const sourceKey = (s: unknown): string | undefined => {
  const o = s as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null) return undefined;
  return JSON.stringify(
    o.kind === "handle"
      ? ["h", o.handle]
      : o.kind === "projection"
        ? ["p", o.id, o.path, o.version]
        : null
  );
};

const validId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID;

/** The floor a record carries (a hint: anything malformed counts as 0, i.e. keeps more, never less). */
const floorOf = (rec: StoredLineageRecord | undefined): number => {
  if (rec === undefined || (rec.type !== VIEW_RECORDED && rec.type !== VIEWS_RETAINED)) return 0;
  const f = (rec.payload as { floor?: unknown } | null)?.floor;
  return Number.isSafeInteger(f) && (f as number) >= 0 && (f as number) < rec.sequence
    ? (f as number)
    : 0;
};

const isContentAddress = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256;

export class SeenLog {
  private readonly events: LineageStore;
  private readonly content: ContentStore;
  private readonly lineage: Lineage;
  private readonly keys: SeenKeyStore;
  private readonly maxViews: number;
  private readonly maxAgeMs: number | undefined;
  private readonly slack: number;
  private readonly now: () => string;

  constructor(opts: SeenLogOptions) {
    // A record is per-viewer data; it must never share streams with the lineage it describes (a
    // shared prefix would put a viewer's manifests among the line's versions, and make an
    // experienceId that spells a stream key read as one). An unreadable prefix cannot be proven
    // disjoint, so it is refused too (see `Lineage.sharesStreamsWith`).
    if (
      opts.lineage.sharesStreamsWith(opts.events) ||
      (opts.events as { streamPrefix?: unknown }).streamPrefix === LINEAGE_STREAM_PREFIX
    )
      throw new Error(
        "SeenLog: `events` must be a store of its own with a readable `streamPrefix` that does not overlap the lineage's: use seenStoreOptions"
      );
    const maxViews = opts.retention?.maxViews ?? DEFAULT_MAX_SEEN_VIEWS;
    const maxAgeMs = opts.retention?.maxAgeMs;
    if (!Number.isSafeInteger(maxViews) || maxViews < 1 || maxViews > MAX_VIEWS_CAP)
      throw new Error(`SeenLog: retention.maxViews must be an integer in 1..${MAX_VIEWS_CAP}`);
    if (maxAgeMs !== undefined && (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0))
      throw new Error("SeenLog: retention.maxAgeMs must be a positive number of milliseconds");
    if (typeof opts.keys?.getOrCreate !== "function")
      throw new Error("SeenLog: `keys` (a SeenKeyStore) is required");
    this.events = opts.events;
    this.content = opts.content;
    this.lineage = opts.lineage;
    this.keys = opts.keys;
    this.maxViews = maxViews;
    this.maxAgeMs = maxAgeMs;
    this.slack = Math.max(1, Math.ceil(maxViews / 10));
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** The content store value blobs live in (for the collector). */
  get contentStore(): ContentStore {
    return this.content;
  }
  /** The lineage the records name versions of (for the collector's roots). */
  get lineageOf(): Lineage {
    return this.lineage;
  }

  // ── log windows (bounded by retention, not by the age of the log) ───────────

  private async lastRecords(key: string, n: number): Promise<readonly StoredLineageRecord[]> {
    if (this.events.readTail !== undefined) return this.events.readTail(key, n);
    const all = await this.events.read(key);
    return all.slice(Math.max(0, all.length - n));
  }

  private async after(key: string, floor: number): Promise<readonly StoredLineageRecord[]> {
    if (this.events.readAfter !== undefined) return this.events.readAfter(key, floor);
    return (await this.events.read(key)).filter((r) => r.sequence > floor);
  }

  /** The live views (oldest first) of a window: after the floor, inside the age limit, newest `maxViews`. */
  private liveViews(window: readonly StoredLineageRecord[]): StoredLineageRecord[] {
    let views = window.filter((r) => r.type === VIEW_RECORDED);
    if (this.maxAgeMs !== undefined) {
      const cutoff = Date.parse(this.now()) - this.maxAgeMs;
      views = views.filter((r) => Date.parse(r.at) >= cutoff);
    }
    return views.length > this.maxViews ? views.slice(views.length - this.maxViews) : views;
  }

  /**
   * Record that `viewerId` was shown `snapshot` (built with core's `snapshotSeen`). The snapshot is
   * not trusted: its version must be a version of the line, its entries are re-validated, re-capped
   * and RESTAMPED against that version's artifact (a stamp laxer than the artifact says is raised; an
   * entry the recording viewer may not see is dropped), and values are measured again. An identical
   * consecutive view records nothing (`recorded: false`). A new view ALWAYS records: when the
   * viewer's window is full, the oldest views roll off (see the header). Refuses an erased viewer.
   * Performs no authorization: `viewerId` and `viewer` are the host's claims.
   */
  async record(input: {
    readonly experienceId: string;
    readonly viewerId: string;
    readonly snapshot: SeenSnapshot;
    readonly viewer?: Viewer;
    readonly projections?: ProjectionCatalog;
    readonly hydrationProjectionId?: string;
  }): Promise<SeenResult<{ readonly recorded: boolean; readonly sequence: number }>> {
    const { experienceId, viewerId, snapshot } = input;
    if (!validId(experienceId) || !validId(viewerId))
      return refused("seen-id-invalid", "experienceId and viewerId are 1-256 character strings");
    if (typeof snapshot !== "object" || snapshot === null || !Array.isArray(snapshot.entries))
      return refused("seen-snapshot-invalid", "the snapshot is not a snapshot");
    if (!Number.isSafeInteger(snapshot.omitted) || snapshot.omitted < 0)
      return refused("seen-snapshot-invalid", "`omitted` is not a non-negative integer");
    if (snapshot.entries.length > MAX_SEEN_SOURCES)
      return refused(
        "seen-too-many-sources",
        `a snapshot holds at most ${MAX_SEEN_SOURCES} sources`
      );
    const sourceKeys = new Set<string>();
    for (const e of snapshot.entries) {
      const k = sourceKey((e as { source?: unknown } | null)?.source);
      if (k !== undefined && sourceKeys.has(k))
        return refused("seen-duplicate-source", "a snapshot names one source twice");
      if (k !== undefined) sourceKeys.add(k);
    }
    if (snapshot.experienceId !== experienceId)
      return refused("seen-wrong-line", "the snapshot is of another experience");
    const key = seenStreamKey(experienceId, viewerId);
    // Gate on erasure BEFORE any blob is written, and obtain the data key (fail closed: no key, no record).
    const gate = await this.lastRecords(key, 1);
    if (gate[0]?.type === VIEWER_ERASED)
      return refused(
        "seen-viewer-erased",
        "this viewer was erased; nothing more is recorded for them"
      );
    let dataKey: ReturnType<typeof deriveSeenKeys>;
    try {
      dataKey = deriveSeenKeys(await this.keys.getOrCreate(seenKeySubject(key)));
    } catch {
      return refused(
        "seen-key-unavailable",
        "the viewer's data key is unavailable (erased, or the key store failed): nothing is recorded"
      );
    }
    const art = await this.lineage.get(experienceId, snapshot.versionHash);
    if (!art.ok)
      return refused(
        "seen-version-unknown",
        "the snapshot's version is not a version of this line"
      );

    // Restamp + drop what the recording viewer may not see, with core's one redactor.
    const checked = redactSeen(snapshot.entries, art.value, {
      ...(input.viewer !== undefined && { viewer: input.viewer }),
      ...(input.projections !== undefined && { projections: input.projections }),
      ...(input.hydrationProjectionId !== undefined && {
        hydrationProjectionId: input.hydrationProjectionId,
      }),
    });
    let total = 0;
    const shapes: Array<Omit<ViewRecordPayload["entries"][number], "sealed">> = [];
    const refs: Array<ContentRef | undefined> = [];
    for (const e of checked.entries) {
      const shape = EntrySchema.omit({ sealed: true }).safeParse({
        source: e.source,
        nodeIds: e.nodeIds,
        class: e.class,
        state: e.state,
        ...(e.status !== undefined && { status: e.status }),
        ...(e.bytes !== undefined && { bytes: e.bytes }),
      });
      if (!shape.success) return refused("seen-entry-invalid", "a snapshot entry is malformed");
      let ref: ContentRef | undefined;
      if (e.state === "seen") {
        let bytes: Uint8Array;
        try {
          bytes = encodeValue(e.value);
        } catch {
          return refused("seen-value-unencodable", "a seen value is not encodable");
        }
        if (bytes.length > MAX_SEEN_VALUE_BYTES)
          return refused("seen-value-too-large", `a value is over ${MAX_SEEN_VALUE_BYTES} bytes`);
        total += bytes.length;
        if (total > MAX_SEEN_TOTAL_BYTES)
          return refused("seen-over-budget", `the snapshot is over ${MAX_SEEN_TOTAL_BYTES} bytes`);
        // Blob BEFORE manifest: a crash between the two leaks a blob (reclaimed by the next sweep
        // past its grace period) and never loses a live value. A re-put of a held blob bumps its
        // touch time, which is what protects a value another record is about to cite.
        ref = await this.content.put(bytes);
      }
      shapes.push(shape.data);
      refs.push(ref);
    }
    const body = {
      experienceId,
      versionHash: snapshot.versionHash,
      viewerId,
      ...(input.viewer?.clearance !== undefined && { clearance: String(input.viewer.clearance) }),
      entries: shapes.map((s, i) => ({ ...s, ...(refs[i] !== undefined && { ref: refs[i] }) })),
      omitted: snapshot.omitted,
      restricted: snapshot.restricted === true || checked.restricted,
    };
    const digest = keyedDigest(dataKey.mac, JSON.stringify(body));

    for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
      const recent = await this.lastRecords(key, 3);
      const last = recent[recent.length - 1];
      if (last?.type === VIEWER_ERASED)
        return refused(
          "seen-viewer-erased",
          "this viewer was erased; nothing more is recorded for them"
        );
      const tip = last?.sequence ?? 0;
      const floor = floorOf(last);
      const lastView = [...recent].reverse().find((r) => r.type === VIEW_RECORDED);
      if (
        lastView !== undefined &&
        lastView.sequence > floor &&
        (lastView.payload as { digest?: unknown } | null)?.digest === digest
      )
        return { ok: true, value: { recorded: false, sequence: lastView.sequence } };
      const sequence = tip + 1;
      const payload: ViewRecordPayload = {
        ...body,
        entries: shapes.map((s, i) => {
          const ref = refs[i];
          return {
            ...s,
            ...(ref !== undefined && {
              sealed: sealText(
                dataKey.enc,
                refAad(experienceId, viewerId, sequence, i),
                JSON.stringify(ref)
              ),
            }),
          };
        }),
        digest,
        floor,
      };
      // The record must parse as what a READ will parse: one that does not would be counted
      // `malformed` forever (the log has no delete), so it is refused here.
      if (!ViewRecordPayload.safeParse(payload).success)
        return refused(
          "seen-record-invalid",
          "the record would not be readable (a field is out of bounds)"
        );
      const out = await this.events.append(key, tip, {
        type: VIEW_RECORDED,
        at: this.now(),
        payload,
      });
      if (out.ok) {
        await this.rollOff(key, out.sequence, floor);
        return { ok: true, value: { recorded: true, sequence: out.sequence } };
      }
    }
    return refused("seen-contended", "could not append after repeated lost races");
  }

  /**
   * Retention: append a watermark when enough has aged out. Best effort (a lost race or a failure
   * only defers it: reads and the collector apply the window themselves, so correctness never
   * depends on a watermark having been written). `slack` batches the writes: one watermark per
   * `slack` roll-offs, not one per view.
   */
  private async rollOff(key: string, tip: number, floor: number): Promise<void> {
    try {
      const countTrigger = tip - floor > this.maxViews + this.slack;
      const cutoff =
        this.maxAgeMs === undefined ? undefined : Date.parse(this.now()) - this.maxAgeMs;
      let ageTrigger = false;
      if (cutoff !== undefined) {
        const oldest = (
          this.events.readAfter !== undefined
            ? await this.events.readAfter(key, floor, 1)
            : await this.after(key, floor)
        )[0];
        ageTrigger = oldest !== undefined && Date.parse(oldest.at) < cutoff;
      }
      if (!countTrigger && !ageTrigger) return;
      // The window is read only when a watermark may be due (about once per `slack` views), so the
      // amortized cost per record is O(window / slack), and the floor is exact: it leaves `maxViews`
      // VIEWS (not records) readable.
      const window = await this.after(key, floor);
      const views = window.filter((r) => r.type === VIEW_RECORDED);
      let next = floor;
      if (views.length > this.maxViews)
        next = (views[views.length - this.maxViews - 1] as StoredLineageRecord).sequence;
      let byAge = floor;
      if (cutoff !== undefined)
        for (const r of window)
          if (Date.parse(r.at) < cutoff) byAge = Math.max(byAge, r.sequence);
          else break;
      // age-only roll-off is batched too (one watermark per `slack` expired views, not one per view)
      if (byAge - floor >= this.slack || (countTrigger && byAge > floor))
        next = Math.max(next, byAge);
      if (next > floor)
        await this.events.append(key, tip, {
          type: VIEWS_RETAINED,
          at: this.now(),
          payload: { floor: Math.min(next, tip) },
        });
    } catch {
      /* deferred to the next record */
    }
  }

  /**
   * Erase a viewer: destroy their data key (the irreversible step), then write a tombstone. After
   * it, the stream holds no decryptable ref, `read` reports `erased: true`, and `record` refuses.
   * Idempotent and safe to rerun after a crash (a rerun completes whichever half is missing). The
   * value BLOBS the viewer cited are reclaimed by the next `collectSeenGarbage` pass (unless another
   * viewer or the lineage still cites them). The stream's structure stays (see the header).
   */
  async eraseViewer(input: {
    readonly experienceId: string;
    readonly viewerId: string;
  }): Promise<SeenResult<{ readonly erased: true }>> {
    const { experienceId, viewerId } = input;
    if (!validId(experienceId) || !validId(viewerId))
      return refused("seen-id-invalid", "experienceId and viewerId are 1-256 character strings");
    const key = seenStreamKey(experienceId, viewerId);
    try {
      await this.keys.destroy(seenKeySubject(key));
    } catch {
      return refused(
        "seen-key-unavailable",
        "the key store failed to destroy the key: rerun the erasure"
      );
    }
    for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
      const last = (await this.lastRecords(key, 1))[0];
      if (last?.type === VIEWER_ERASED) return { ok: true, value: { erased: true } };
      const out = await this.events.append(key, last?.sequence ?? 0, {
        type: VIEWER_ERASED,
        at: this.now(),
        payload: { experienceId, viewerId },
      });
      if (out.ok) return { ok: true, value: { erased: true } };
    }
    return refused(
      "seen-erase-incomplete",
      "the key is destroyed (the viewer is unreadable) but the tombstone was not written: rerun the erasure"
    );
  }

  /**
   * What `viewerId` was shown, newest first (at most `limit`, default 20, hard cap
   * `MAX_SEEN_READ`), as seen by `reader`: entries the reader may not see are withheld (and
   * `restricted` says only that something was), BEFORE any value blob is fetched. Only views inside
   * the retention window are returned. A malformed record is counted in `malformed`, never thrown.
   * `until` (ISO time) keeps records at or before it: the view as of then. An erased viewer (key
   * destroyed or tombstoned) returns `{ erased: true, views: [] }`: nothing is decryptable, so
   * nothing is shown.
   */
  async read(input: {
    readonly experienceId: string;
    readonly viewerId: string;
    readonly reader?: Viewer;
    readonly limit?: number;
    readonly until?: string;
    readonly projections?: ProjectionCatalog;
    readonly hydrationProjectionId?: string;
  }): Promise<
    SeenResult<{
      readonly views: readonly SeenView[];
      readonly malformed: number;
      readonly erased: boolean;
    }>
  > {
    const { experienceId, viewerId } = input;
    if (!validId(experienceId) || !validId(viewerId))
      return refused("seen-id-invalid", "experienceId and viewerId are 1-256 character strings");
    const limit = Math.max(
      1,
      Math.min(MAX_SEEN_READ, Number.isInteger(input.limit) ? (input.limit as number) : 20)
    );
    const key = seenStreamKey(experienceId, viewerId);
    const tipRec = (await this.lastRecords(key, 1))[0];
    if (tipRec === undefined)
      return { ok: true, value: { views: [], malformed: 0, erased: false } };
    let master: Uint8Array | null;
    try {
      master = await this.keys.get(seenKeySubject(key));
    } catch {
      return refused("seen-key-unavailable", "the key store failed: nothing is shown");
    }
    if (tipRec.type === VIEWER_ERASED || master === null)
      return { ok: true, value: { views: [], malformed: 0, erased: true } };
    const dataKey = deriveSeenKeys(master);

    let malformed = 0;
    const picked: Array<{ rec: StoredLineageRecord; p: ViewRecordPayload }> = [];
    const live = this.liveViews(await this.after(key, floorOf(tipRec)));
    for (let i = live.length - 1; i >= 0 && picked.length < limit; i--) {
      const rec = live[i] as StoredLineageRecord;
      if (input.until !== undefined && rec.at > input.until) continue;
      const parsed = ViewRecordPayload.safeParse(rec.payload);
      if (
        !parsed.success ||
        parsed.data.experienceId !== experienceId ||
        parsed.data.viewerId !== viewerId
      ) {
        malformed += 1;
        continue;
      }
      picked.push({ rec, p: parsed.data });
    }
    // The line is folded ONCE for the whole read (not once per distinct version).
    const got = await this.lineage.getMany(
      experienceId,
      picked.map(({ p }) => p.versionHash)
    );
    const artifacts: ReadonlyMap<string, Experience | undefined> = got.ok ? got.value : new Map();
    const views: SeenView[] = [];
    for (const { rec, p } of picked) {
      const shown = redactSeen(
        p.entries.map((e) => ({
          source: e.source,
          nodeIds: e.nodeIds,
          class: e.class as SeenEntry["class"],
          state: e.state,
          ...(e.status !== undefined && { status: e.status }),
          ...(e.bytes !== undefined && { bytes: e.bytes }),
        })),
        artifacts.get(p.versionHash),
        {
          ...(input.reader !== undefined && { viewer: input.reader }),
          ...(input.projections !== undefined && { projections: input.projections }),
          ...(input.hydrationProjectionId !== undefined && {
            hydrationProjectionId: input.hydrationProjectionId,
          }),
        }
      );
      // A ref belongs to the entry at its POSITION in the record (`indexes`), never to a source:
      // two entries may not be told apart by what they name.
      let restricted = p.restricted || shown.restricted;
      const resolved: SeenEntry[] = [];
      for (const [k, e] of shown.entries.entries()) {
        if (e.state !== "seen") {
          resolved.push(e);
          continue;
        }
        const idx = shown.indexes[k] as number;
        const sealed = p.entries[idx]?.sealed;
        if (sealed === undefined) {
          resolved.push({ ...e, state: "absent" });
          continue;
        }
        const ref = this.openRef(dataKey.enc, experienceId, viewerId, rec.sequence, idx, sealed);
        if (ref === undefined) {
          // tampered, transplanted, or sealed under another key: withheld, never a plaintext fallback
          restricted = true;
          continue;
        }
        const bytes = await this.content.get(ref);
        if (bytes === undefined || bytes === null) {
          // erased or lost: the value is gone, the fact that it was seen is not
          resolved.push({ ...e, state: "absent" });
          continue;
        }
        if (contentAddress(bytes) !== ref.__loomContent) {
          // the store handed back bytes that are not what the manifest named
          resolved.push({ ...e, state: "corrupt" });
          continue;
        }
        try {
          resolved.push({ ...e, value: decodeValue(bytes) });
        } catch {
          restricted = true;
        }
      }
      views.push({
        sequence: rec.sequence,
        at: rec.at,
        versionHash: p.versionHash,
        entries: resolved,
        restricted,
        omitted: p.omitted,
      });
    }
    return { ok: true, value: { views, malformed, erased: false } };
  }

  private openRef(
    enc: Buffer,
    experienceId: string,
    viewerId: string,
    sequence: number,
    index: number,
    sealed: string
  ): ContentRef | undefined {
    const text = openText(enc, refAad(experienceId, viewerId, sequence, index), sealed);
    if (text === undefined) return undefined;
    try {
      const v = JSON.parse(text) as { __loomContent?: unknown };
      return isContentAddress(v?.__loomContent) ? (v as ContentRef) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Call `visit` with the content address of every DECRYPTABLE ref inside every viewer's retention
   * window: the seen log's half of the collector's root set. Erased viewers (key gone) and rolled-off
   * views contribute nothing, which is exactly what lets their unique blobs be swept. THROWS if the
   * store cannot enumerate its streams or the key store fails (a collector must then not sweep: an
   * unreadable root is not an absent one). A ref that fails to decrypt (tampered) is skipped: no
   * reader can resolve it either.
   */
  async forEachLiveRef(visit: (address: string) => void): Promise<void> {
    if (this.events.listStreams === undefined)
      throw new Error("SeenLog.forEachLiveRef: the store cannot enumerate its streams");
    for await (const key of this.events.listStreams()) {
      const slash = key.indexOf("/");
      let experienceId: string;
      let viewerId: string;
      try {
        experienceId = decodeURIComponent(key.slice(0, slash));
        viewerId = decodeURIComponent(key.slice(slash + 1));
      } catch {
        continue;
      }
      if (slash < 0 || seenStreamKey(experienceId, viewerId) !== key) continue;
      const tipRec = (await this.lastRecords(key, 1))[0];
      if (tipRec === undefined || tipRec.type === VIEWER_ERASED) continue;
      const master = await this.keys.get(seenKeySubject(key)); // a throw propagates: abort the pass
      if (master === null) continue;
      const { enc } = deriveSeenKeys(master);
      for (const rec of this.liveViews(await this.after(key, floorOf(tipRec)))) {
        const parsed = ViewRecordPayload.safeParse(rec.payload);
        if (
          !parsed.success ||
          parsed.data.experienceId !== experienceId ||
          parsed.data.viewerId !== viewerId
        )
          continue;
        for (const [i, e] of parsed.data.entries.entries()) {
          if (e.sealed === undefined) continue;
          const ref = this.openRef(enc, experienceId, viewerId, rec.sequence, i, e.sealed);
          if (ref !== undefined) visit(ref.__loomContent);
        }
      }
    }
  }
}

/** Convenience: the manifest stream a `SeenLog` over an `EventStore` should use. */
export const seenStoreOptions = {
  streamPrefix: SEEN_STREAM_PREFIX,
  workflowId: SEEN_WORKFLOW_ID,
} as const;

export type { LineageResult };
