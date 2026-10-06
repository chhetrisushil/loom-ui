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
import type { LineageStore } from "./store";

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
// state and — for a value that fit the caps — a content reference. The VALUE BYTES live in the
// ContentStore, content-addressed (identical values dedupe; deleting a blob erases the value while
// the manifest, which holds none, stays valid: that is the erasure story). Nothing here is part of
// any artifact or content address.
//
// Reads are viewer-safe: the entries are redacted against the recorded version's artifact with
// core's `redactSeen` BEFORE any blob is fetched (a viewer is never even handed a restricted ref),
// and a stamp that is missing or unknown is withheld.

export const VIEW_RECORDED = "VIEW_RECORDED";
/** The reserved-stream namespace a viewer's record lives under (distinct from the lineage's). */
export const SEEN_STREAM_PREFIX = "__loom_ui_seen__:";
export const SEEN_WORKFLOW_ID = "loom-ui.seen";
/** Most records one viewer's stream holds before a write is refused (retention is the host's). */
export const MAX_SEEN_RECORDS = 10_000;
/** Most records one read returns. */
export const MAX_SEEN_READ = 500;
const MAX_APPEND_RETRIES = 16;
const MAX_ID = 256;

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
  ref: z.object({ __loomContent: z.string().min(1).max(256) }).optional(),
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
  /** Content address of the manifest's meaning (built in a fixed key order): an identical consecutive view is not re-recorded. */
  digest: z.string().min(1).max(128),
});
export type ViewRecordPayload = z.infer<typeof ViewRecordPayload>;

export interface SeenLogOptions {
  /** A `LineageStore` over a namespace of its own (`eventStoreLineageStore(store, { streamPrefix: SEEN_STREAM_PREFIX, workflowId: SEEN_WORKFLOW_ID })`). */
  readonly events: LineageStore;
  /** Where value bytes live. The same store the lineage uses is fine: addresses are content hashes. */
  readonly content: ContentStore;
  /** Resolves the version a record names (and refuses one that is not a version of the line). */
  readonly lineage: Lineage;
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

const streamKey = (experienceId: string, viewerId: string): string =>
  `${encodeURIComponent(experienceId)}/${encodeURIComponent(viewerId)}`;

const validId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID;

export class SeenLog {
  private readonly events: LineageStore;
  private readonly content: ContentStore;
  private readonly lineage: Lineage;
  private readonly now: () => string;

  constructor(opts: SeenLogOptions) {
    this.events = opts.events;
    this.content = opts.content;
    this.lineage = opts.lineage;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /**
   * Record that `viewerId` was shown `snapshot` (built with core's `snapshotSeen`). The snapshot is
   * not trusted: its version must be a version of the line, its entries are re-validated, re-capped
   * and RESTAMPED against that version's artifact (a stamp laxer than the artifact says is raised; an
   * entry the recording viewer may not see is dropped), and values are measured again. An identical
   * consecutive view records nothing (`recorded: false`). Performs no authorization: `viewerId` and
   * `viewer` are the host's claims.
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
    if (snapshot.experienceId !== experienceId)
      return refused("seen-wrong-line", "the snapshot is of another experience");
    const art = await this.lineage.get(experienceId, snapshot.versionHash);
    if (!art.ok)
      return refused(
        "seen-version-unknown",
        "the snapshot's version is not a version of this line"
      );
    if (!Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_SEEN_SOURCES)
      return refused(
        "seen-too-many-sources",
        `a snapshot holds at most ${MAX_SEEN_SOURCES} sources`
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
    const entries: ViewRecordPayload["entries"] = [];
    for (const e of checked.entries) {
      const shape = EntrySchema.omit({ ref: true }).safeParse({
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
        ref = await this.content.put(bytes);
      }
      entries.push({ ...shape.data, ...(ref !== undefined && { ref }) });
    }
    const body = {
      experienceId,
      versionHash: snapshot.versionHash,
      viewerId,
      ...(input.viewer?.clearance !== undefined && { clearance: String(input.viewer.clearance) }),
      entries,
      omitted: Math.max(0, Math.trunc(snapshot.omitted) || 0),
      restricted: snapshot.restricted === true || checked.restricted,
    };
    const digest = contentAddress(new TextEncoder().encode(JSON.stringify(body)));
    const payload: ViewRecordPayload = { ...body, digest };

    const key = streamKey(experienceId, viewerId);
    for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
      const log = await this.events.read(key);
      const tip = log.length;
      const last = log[tip - 1];
      if (last !== undefined && (last.payload as { digest?: unknown } | null)?.digest === digest)
        return { ok: true, value: { recorded: false, sequence: last.sequence } };
      if (tip >= MAX_SEEN_RECORDS)
        return refused(
          "seen-log-full",
          `a viewer's record holds at most ${MAX_SEEN_RECORDS} views`
        );
      const out = await this.events.append(key, tip, {
        type: VIEW_RECORDED,
        at: this.now(),
        payload,
      });
      if (out.ok) return { ok: true, value: { recorded: true, sequence: out.sequence } };
    }
    return refused("seen-contended", "could not append after repeated lost races");
  }

  /**
   * What `viewerId` was shown, newest first (at most `limit`, default 20, hard cap
   * `MAX_SEEN_READ`), as seen by `reader`: entries the reader may not see are withheld (and
   * `restricted` says only that something was), BEFORE any value blob is fetched. A malformed record
   * is counted in `malformed`, never thrown. `until` (ISO time) keeps records at or before it: the
   * view as of then.
   */
  async read(input: {
    readonly experienceId: string;
    readonly viewerId: string;
    readonly reader?: Viewer;
    readonly limit?: number;
    readonly until?: string;
    readonly projections?: ProjectionCatalog;
    readonly hydrationProjectionId?: string;
  }): Promise<SeenResult<{ readonly views: readonly SeenView[]; readonly malformed: number }>> {
    const { experienceId, viewerId } = input;
    if (!validId(experienceId) || !validId(viewerId))
      return refused("seen-id-invalid", "experienceId and viewerId are 1-256 character strings");
    const limit = Math.max(
      1,
      Math.min(MAX_SEEN_READ, Number.isInteger(input.limit) ? (input.limit as number) : 20)
    );
    const log = await this.events.read(streamKey(experienceId, viewerId));
    const views: SeenView[] = [];
    let malformed = 0;
    const artifacts = new Map<string, Experience | undefined>();
    for (let i = log.length - 1; i >= 0 && views.length < limit; i--) {
      const rec = log[i];
      if (rec === undefined || rec.type !== VIEW_RECORDED) continue;
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
      const p = parsed.data;
      if (!artifacts.has(p.versionHash)) {
        const a = await this.lineage.get(experienceId, p.versionHash);
        artifacts.set(p.versionHash, a.ok ? a.value : undefined);
      }
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
      // Refs are looked up by the entry's position in the RECORD, matched on source: redaction
      // preserves order and only removes, so walk both lists together.
      const refs = new Map(p.entries.map((e) => [JSON.stringify(e.source), e.ref]));
      let restricted = p.restricted || shown.restricted;
      const resolved: SeenEntry[] = [];
      for (const e of shown.entries) {
        if (e.state !== "seen") {
          resolved.push(e);
          continue;
        }
        const ref = refs.get(JSON.stringify(e.source));
        const bytes = ref === undefined ? undefined : await this.content.get(ref as ContentRef);
        if (bytes === undefined || bytes === null) {
          // erased or lost: the value is gone, the fact that it was seen is not
          resolved.push({ ...e, state: "absent" });
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
    return { ok: true, value: { views, malformed } };
  }
}

/** Convenience: the manifest stream a `SeenLog` over an `EventStore` should use. */
export const seenStoreOptions = {
  streamPrefix: SEEN_STREAM_PREFIX,
  workflowId: SEEN_WORKFLOW_ID,
} as const;

export type { LineageResult };
