import {
  type DeclaredToolClasses,
  type Experience,
  MAX_SEEN_NODE_IDS,
  MAX_SEEN_SOURCES,
  MAX_SEEN_TOTAL_BYTES,
  MAX_SEEN_VALUE_BYTES,
  type ProjectionCatalog,
  type ReadPolicy,
  type SeenEntry,
  type SeenSnapshot,
  type UndeclaredToolPolicy,
  type Viewer,
  mergeReadPolicy,
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
import type { Lineage, LineageResult, Refusal, Refused } from "./lineage";
import {
  MAX_SEALED_ADDRESS_CHARS,
  type SeenKeyStore,
  deriveSeenKeys,
  keyedDigest,
  openRef as openSealedRef,
  refAad,
  sealRef,
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
// transplanted between records or viewers. What the sealed payload holds is `{ref, bytes}`, padded
// to a constant length: the value's SIZE is inside the seal too, so neither a field nor the
// ciphertext length distinguishes `true` from `false` from a short enum.
//
// WHAT AN ERASED STREAM STILL REVEALS (precisely): that the viewer opened the experience; the
// sources each view named (handles / projection ids and paths); node ids; class stamps; delivery
// statuses; the version hash; record times; and, for an `oversize` / `over-budget` entry only, a
// power-of-two SIZE CLASS (never the exact byte count), because there the size class IS the recorded fact. It
// reveals NO value, no content address, and no size of a value that was recorded as `seen`.
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
  /** Only for `oversize` / `over-budget` (where the size is the recorded fact). A `seen` entry's size lives inside `sealed`. */
  bytes: z.number().int().nonnegative().optional(),
  /** `{ref, bytes}`, constant-length padded and AEAD-sealed under the viewer's data key (see the header). Never a plain address. */
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
  /**
   * The clock skew tolerated between writers (ms, default {@link DEFAULT_MAX_SKEW_MS}). READS apply
   * `maxAgeMs` exactly, but the two IRREVERSIBLE age actions are conservative by this much: a
   * persisted `VIEWS_RETAINED` watermark only covers views older than `maxAgeMs + maxSkewMs` by the
   * writer's clock, and the collector keeps the blobs of views younger than that. So a writer whose
   * clock runs ahead by up to `maxSkewMs` cannot roll off, or get swept, a view that is still inside
   * the window by true time (a writer further ahead than this is an operator clock fault).
   */
  readonly maxSkewMs?: number;
}

/** The smallest power of two >= `n` (0 stays 0): the only size an `oversize` / `over-budget` entry stores. */
export function sizeClass(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return 2 ** Math.ceil(Math.log2(n));
}

/** Default tolerated clock skew between writers (5 minutes). */
export const DEFAULT_MAX_SKEW_MS = 300_000;
/** Records read from the tail to find the floor in force (a malformed tip carries the last good one). */
const FLOOR_SCAN = 8;

/** What the collector could not read inside the live window (see {@link SeenLog.forEachLiveRef}). */
export interface SeenUnreadable {
  /** Streams whose key does not round-trip `seenStreamKey`. */
  readonly streams: number;
  /** `VIEW_RECORDED` records that failed to parse (a newer writer's shape, corruption) or name another viewer. */
  readonly records: number;
  /** Sealed refs that failed to open while the key IS present (unknown version, rotated key, tamper). */
  readonly refs: number;
  /** Where to look: at most {@link UNREADABLE_EXAMPLES} identifiers per kind (stream keys; `experience/viewer@sequence` records; `experience/viewer@sequence#entry` refs). */
  readonly examples: {
    readonly streams: readonly string[];
    readonly records: readonly string[];
    readonly refs: readonly string[];
  };
}
/** Cap on the offenders named per kind in {@link SeenUnreadable.examples}. */
export const UNREADABLE_EXAMPLES = 16;
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
  /**
   * The read policy bound ONCE: every `record` and `read` applies it, joined (raise-only) with the
   * `lineage`'s own bound policy and with any per-call values. Absent = the lineage's policy alone.
   */
  readonly readPolicy?: ReadPolicy;
}

/**
 * Why a seen-log call did not happen. It IS a lineage `Refused` (`kind`, `finding`), so a
 * `SeenResult<T>` is assignable to a `LineageResult<T>`, and it keeps the flat `code` / `message`
 * every seen-log caller already reads (the same values as `finding.code` / `finding.message`).
 */
export type SeenRefusal = Refused & { readonly code: string; readonly message: string };
export type SeenResult<T> = { ok: true; value: T } | { ok: false; refusal: SeenRefusal };

const refused = (code: string, message: string): { ok: false; refusal: SeenRefusal } => ({
  ok: false,
  refusal: {
    kind: "refused",
    finding: { code, severity: "error", message },
    code,
    message,
  },
});

/**
 * Why a snapshot's version could not be loaded or re-cited, said accurately: it is not a version of
 * the line (`seen-version-unknown`), its artifact was reclaimed (`seen-artifact-missing`), or anything
 * else (`seen-version-unreadable`, with the underlying code). Nothing is recorded in any case.
 */
const versionRefusal = (refusal: Refusal) => {
  const finding =
    refusal.kind === "refused"
      ? refusal.finding
      : { code: refusal.kind, message: "the line moved while recording" };
  if (finding.code === "version-unknown")
    return refused("seen-version-unknown", "the snapshot's version is not a version of this line");
  if (finding.code === "artifact-missing")
    return refused(
      "seen-artifact-missing",
      "the snapshot's version exists but its artifact is gone (already reclaimed); nothing is recorded"
    );
  return refused(
    "seen-version-unreadable",
    `the snapshot's version could not be loaded (${finding.code}): ${finding.message}`
  );
};

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

/**
 * The floor in force: the last well-formed floor among the tail records (a malformed record carries
 * none, so the scan goes back past it rather than resetting to 0 and undoing retention). Beyond the
 * scan there is nothing to go on: 0, which keeps more, never less.
 */
const floorOf = (tail: readonly StoredLineageRecord[]): number => {
  for (let i = tail.length - 1; i >= 0; i--) {
    const rec = tail[i] as StoredLineageRecord;
    if (rec.type !== VIEW_RECORDED && rec.type !== VIEWS_RETAINED) continue;
    const f = (rec.payload as { floor?: unknown } | null)?.floor;
    if (Number.isSafeInteger(f) && (f as number) >= 0 && (f as number) < rec.sequence)
      return f as number;
  }
  return 0;
};

/** The (experience, viewer) a stream key names, or `undefined` if it does not round-trip `seenStreamKey`. */
const parseStreamKey = (key: string): { experienceId: string; viewerId: string } | undefined => {
  const slash = key.indexOf("/");
  if (slash < 0) return undefined;
  try {
    const experienceId = decodeURIComponent(key.slice(0, slash));
    const viewerId = decodeURIComponent(key.slice(slash + 1));
    return seenStreamKey(experienceId, viewerId) === key ? { experienceId, viewerId } : undefined;
  } catch {
    return undefined;
  }
};

export class SeenLog {
  private readonly events: LineageStore;
  private readonly content: ContentStore;
  private readonly lineage: Lineage;
  private readonly keys: SeenKeyStore;
  private readonly maxViews: number;
  private readonly maxAgeMs: number | undefined;
  private readonly maxSkewMs: number;
  private readonly slack: number;
  private readonly now: () => string;
  private readonly policy: ReadPolicy;

  constructor(opts: SeenLogOptions) {
    this.policy = mergeReadPolicy(opts.lineage.readPolicy, opts.readPolicy);
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
    const maxSkewMs = opts.retention?.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
    if (!Number.isFinite(maxSkewMs) || maxSkewMs < 0)
      throw new Error("SeenLog: retention.maxSkewMs must be a non-negative number of milliseconds");
    if (typeof opts.keys?.getOrCreate !== "function")
      throw new Error("SeenLog: `keys` (a SeenKeyStore) is required");
    this.events = opts.events;
    this.content = opts.content;
    this.lineage = opts.lineage;
    this.keys = opts.keys;
    this.maxViews = maxViews;
    this.maxAgeMs = maxAgeMs;
    this.maxSkewMs = maxSkewMs;
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
  private liveViews(
    window: readonly StoredLineageRecord[],
    conservative = false
  ): StoredLineageRecord[] {
    let views = window.filter((r) => r.type === VIEW_RECORDED);
    if (this.maxAgeMs !== undefined) {
      // the collector (irreversible) keeps everything inside `maxAgeMs + maxSkewMs`; a read is exact
      const cutoff = Date.parse(this.now()) - this.maxAgeMs - (conservative ? this.maxSkewMs : 0);
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
    readonly declaredToolClasses?: DeclaredToolClasses;
    readonly undeclared?: UndeclaredToolPolicy;
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
    if (!art.ok) return versionRefusal(art.refusal);
    // The record will cite this version for as long as the view is in retention: tell the store it
    // was just re-cited (touch, no put) so a collector racing this write spares the artifact.
    const cited = await this.lineage.cite(experienceId, [snapshot.versionHash]);
    if (!cited.ok) return versionRefusal(cited.refusal);

    // Restamp + drop what the recording viewer may not see, with core's one redactor.
    const checked = redactSeen(snapshot.entries, art.value, {
      ...(input.viewer !== undefined && { viewer: input.viewer }),
      ...mergeReadPolicy(this.policy, input),
    });
    let total = 0;
    const shapes: Array<Omit<ViewRecordPayload["entries"][number], "sealed">> = [];
    const refs: Array<{ ref: ContentRef; bytes: number } | undefined> = [];
    for (const e of checked.entries) {
      const shape = EntrySchema.omit({ sealed: true }).safeParse({
        source: e.source,
        nodeIds: e.nodeIds,
        class: e.class,
        state: e.state,
        ...(e.status !== undefined && { status: e.status }),
        // a `seen` entry's size is sealed with its ref, never stored in the clear
        // `oversize` / `over-budget`: only a power-of-two size class survives, never the exact count
        ...(e.bytes !== undefined && e.state !== "seen" && { bytes: sizeClass(e.bytes) }),
      });
      if (!shape.success) return refused("seen-entry-invalid", "a snapshot entry is malformed");
      let ref: { ref: ContentRef; bytes: number } | undefined;
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
        const put = await this.content.put(bytes);
        if (put.__loomContent.length > MAX_SEALED_ADDRESS_CHARS)
          return refused(
            "seen-address-invalid",
            "the content store returned an unexpectedly long address"
          );
        ref = { ref: put, bytes: bytes.length };
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
      const recent = await this.lastRecords(key, FLOOR_SCAN);
      const last = recent[recent.length - 1];
      if (last?.type === VIEWER_ERASED)
        return refused(
          "seen-viewer-erased",
          "this viewer was erased; nothing more is recorded for them"
        );
      const tip = last?.sequence ?? 0;
      const floor = floorOf(recent);
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
              sealed: sealRef(
                dataKey.enc,
                refAad(experienceId, viewerId, sequence, i),
                ref.ref,
                ref.bytes
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
      // Re-read the key IMMEDIATELY before the append: an erasure that landed since `getOrCreate`
      // (a destroyed key, or a tombstone not yet written) must not be followed by a sealed record.
      let current: Uint8Array | null;
      try {
        current = await this.keys.get(seenKeySubject(key));
      } catch {
        return refused(
          "seen-key-unavailable",
          "the viewer's data key is unavailable (erased, or the key store failed): nothing is recorded"
        );
      }
      if (current === null)
        return refused(
          "seen-viewer-erased",
          "this viewer was erased; nothing more is recorded for them"
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
      // The persisted (irreversible) age watermark is conservative by `maxSkewMs`: a writer whose
      // clock runs ahead cannot roll off views still inside the window by true time (see SeenRetention).
      const cutoff =
        this.maxAgeMs === undefined
          ? undefined
          : Date.parse(this.now()) - this.maxAgeMs - this.maxSkewMs;
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
   * AUTHORIZATION IS THE HOST'S: erasing a (experience, viewer) pair that never existed still
   * writes a tombstone stream (and permanently bars that viewer from recording there), so the host
   * decides who may erase what; this method performs no check.
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
   * Erase ONE data subject across every experience: enumerate the seen streams (`listStreams`;
   * refused with `seen-enumeration-unavailable` if the store cannot), and erase `viewerId`'s stream in
   * each experience (see {@link eraseViewer}, including its authorization note). Idempotent and
   * resumable: a rerun skips what is erased and completes what is not. A per-experience failure does
   * not stop the others; `complete` is true only when every experience was erased.
   *
   * COVERAGE: only streams that EXIST when enumeration runs are erased. A stream created after
   * that point (a new view by this viewer during the erase) is not covered: the host must serialize
   * erasure against new views for the subject, or rerun. An orphan key with no stream (a crash
   * between `getOrCreate` and the first append) is not destroyed by this enumeration; it holds no
   * data (a key and nothing sealed under it).
   */
  async eraseViewerEverywhere(input: { readonly viewerId: string }): Promise<
    SeenResult<{
      readonly results: ReadonlyArray<{
        readonly experienceId: string;
        readonly erased: boolean;
        readonly refusal?: SeenRefusal;
      }>;
      readonly complete: boolean;
    }>
  > {
    const { viewerId } = input;
    if (!validId(viewerId))
      return refused("seen-id-invalid", "viewerId is a 1-256 character string");
    if (this.events.listStreams === undefined)
      return refused(
        "seen-enumeration-unavailable",
        "the store cannot enumerate its streams, so a viewer cannot be erased across experiences"
      );
    const experiences: string[] = [];
    try {
      for await (const key of this.events.listStreams()) {
        const parsed = parseStreamKey(key);
        if (parsed !== undefined && parsed.viewerId === viewerId)
          experiences.push(parsed.experienceId);
      }
    } catch {
      return refused("seen-enumeration-unavailable", "listing the seen streams failed: rerun");
    }
    const results: Array<{ experienceId: string; erased: boolean; refusal?: SeenRefusal }> = [];
    for (const experienceId of experiences) {
      const r = await this.eraseViewer({ experienceId, viewerId });
      results.push(
        r.ok ? { experienceId, erased: true } : { experienceId, erased: false, refusal: r.refusal }
      );
    }
    return { ok: true, value: { results, complete: results.every((r) => r.erased) } };
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
    readonly declaredToolClasses?: DeclaredToolClasses;
    readonly undeclared?: UndeclaredToolPolicy;
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
    const tail = await this.lastRecords(key, FLOOR_SCAN);
    const tipRec = tail[tail.length - 1];
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
    const live = this.liveViews(await this.after(key, floorOf(tail)));
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
          ...mergeReadPolicy(this.policy, input),
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
        const opened = this.openRef(dataKey.enc, experienceId, viewerId, rec.sequence, idx, sealed);
        if (opened === undefined) {
          // tampered, transplanted, or sealed under another key: withheld, never a plaintext fallback
          restricted = true;
          continue;
        }
        const { ref, bytes: size } = opened;
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
          resolved.push({ ...e, value: decodeValue(bytes), bytes: size });
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
  ): { ref: ContentRef; bytes: number } | undefined {
    return openSealedRef(enc, refAad(experienceId, viewerId, sequence, index), sealed);
  }

  /**
   * Call `visit` with the content address of every DECRYPTABLE ref inside every viewer's retention
   * window (kept conservatively: views inside `maxAgeMs + maxSkewMs`; with out-of-order timestamps within `maxSkewMs` at the `maxViews` cap this window can differ from the exact read window's newest-N, in the direction of keeping MORE): the seen log's half of the
   * collector's root set. Erased viewers (key ABSENT: the shred path) and rolled-off views
   * contribute nothing, which is exactly what lets their unique blobs be swept. THROWS if the store
   * cannot enumerate its streams or the key store fails (an unreadable root is not an absent one).
   *
   * Returns what it could NOT read inside the live window (a stream key that does not round-trip, a
   * record that fails to parse, a sealed ref that fails to open under a PRESENT key). Those are not
   * absent either: whatever they cite is unrooted here, so a collector must refuse to sweep on a
   * non-zero count (see `collectSeenGarbage`).
   *
   * `visitVersion` (optional) is called with the (experience, version) of every live view: the seen log
   * READS that version's artifact from the lineage, so a collector that reclaims old versions must
   * keep it (see `collectSeenRoots`).
   */
  async forEachLiveRef(
    visit: (address: string) => void,
    visitVersion?: (experienceId: string, versionHash: string) => void
  ): Promise<SeenUnreadable> {
    if (this.events.listStreams === undefined)
      throw new Error("SeenLog.forEachLiveRef: the store cannot enumerate its streams");
    let streams = 0;
    let records = 0;
    let refs = 0;
    const ex = { streams: [] as string[], records: [] as string[], refs: [] as string[] };
    const note = (list: string[], what: string) => {
      if (list.length < UNREADABLE_EXAMPLES) list.push(what);
    };
    for await (const key of this.events.listStreams()) {
      const id = parseStreamKey(key);
      if (id === undefined) {
        streams += 1;
        note(ex.streams, key);
        continue;
      }
      const { experienceId, viewerId } = id;
      const tail = await this.lastRecords(key, FLOOR_SCAN);
      const tipRec = tail[tail.length - 1];
      if (tipRec === undefined || tipRec.type === VIEWER_ERASED) continue;
      const master = await this.keys.get(seenKeySubject(key)); // a throw propagates: abort the pass
      if (master === null) continue; // erased (key absent): nothing here is a root, by design
      const { enc } = deriveSeenKeys(master);
      for (const rec of this.liveViews(await this.after(key, floorOf(tail)), true)) {
        const parsed = ViewRecordPayload.safeParse(rec.payload);
        if (
          !parsed.success ||
          parsed.data.experienceId !== experienceId ||
          parsed.data.viewerId !== viewerId
        ) {
          records += 1;
          note(ex.records, `${key}@${rec.sequence}`);
          continue;
        }
        visitVersion?.(experienceId, parsed.data.versionHash);
        for (const [i, e] of parsed.data.entries.entries()) {
          if (e.sealed === undefined) continue;
          const opened = this.openRef(enc, experienceId, viewerId, rec.sequence, i, e.sealed);
          if (opened === undefined) {
            refs += 1;
            note(ex.refs, `${key}@${rec.sequence}#${i}`);
          } else visit(opened.ref.__loomContent);
        }
      }
    }
    return { streams, records, refs, examples: ex };
  }
}

/** Convenience: the manifest stream a `SeenLog` over an `EventStore` should use. */
export const seenStoreOptions = {
  streamPrefix: SEEN_STREAM_PREFIX,
  workflowId: SEEN_WORKFLOW_ID,
} as const;

export type { LineageResult };
