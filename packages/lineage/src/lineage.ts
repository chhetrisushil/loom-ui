import { isKeyUnavailable, isPayloadShredded } from "@loomwork/event-runtime";
import type { ContentAccess, ContentRef, ContentStore } from "@loomwork/plugin-content";
import {
  type ApplyOptions,
  type Audience,
  type DeclaredToolClasses,
  type Experience,
  type ExplainOptions,
  type Finding,
  type NodeExplanation,
  type ProjectionCatalog,
  type Provenance,
  type ProvenanceLedger,
  Provenance as ProvenanceSchema,
  type ReadPolicy,
  type RecordedOperation,
  Sensitivity,
  type UndeclaredToolPolicy,
  type VersionNote,
  type Viewer,
  apply,
  applyAt,
  boundSummary,
  emptyLedger,
  experienceClassFloor,
  explainNode,
  foldProvenance,
  mergeReadPolicy,
  replay,
} from "@loomwork/ui-core";
import { getExperience, putExperience, seal } from "@loomwork/ui-core/log";
import { authorOf, branchArtifact, revertArtifact } from "./derive";
import {
  EXPERIENCE_BRANCHED,
  EXPERIENCE_COMPOSED,
  EXPERIENCE_PROMOTED,
  EXPERIENCE_REVERTED,
  type SummaryClass,
} from "./events";
import { type RetentionPolicy, retainedVersions, validateRetentionPolicy } from "./retention";
import { type LineageState, type VersionRecord, foldLineage, payloadRefusal } from "./state";
import {
  InMemoryLineageStore,
  LINEAGE_STREAM_PREFIX,
  LINEAGE_WORKFLOW_ID,
  type LineageStore,
} from "./store";

// ── The lineage runtime ───────────────────────────────────────────────────────
// loom-ui core is a library: it can fold ops onto an artifact and hash it, but nothing remembered
// which artifact is CURRENT, who won a race to change it, or how to go back. A `Lineage` is that
// memory for one app: a head pointer per experienceId advanced by compare-and-set, an append-only
// version history, and the ops-log protocol with the check that closes its gap — ops are not in the
// content address, so a stored `ops` list could disagree with the artifact it claims to produce;
// here every version is refused unless replaying its ops from the parent reproduces its address.
//
// Storage is two loom seams: bytes in a `ContentStore` (as `putExperience` already writes them),
// the version/promotion events in a `LineageStore` (an EventStore-shaped log; see store.ts).
// Nothing is ever rewritten: revert, undo and branch each append a NEW version.

export type HeadMoved = {
  readonly kind: "head-moved";
  readonly expectedHead: string | null;
  readonly actualHead: string | null;
};
export type PromotedMoved = {
  readonly kind: "promoted-moved";
  readonly expectedPromoted: string | null;
  readonly actualPromoted: string | null;
};
export type Refused = { readonly kind: "refused"; readonly finding: Finding };
/** Why a write did not happen. A lost race is typed (`head-moved`) and carries the winner. */
export type Refusal = HeadMoved | PromotedMoved | Refused;

export type LineageResult<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

export interface Committed {
  readonly experience: Experience;
  readonly version: VersionRecord;
}

export interface LineageOptions {
  readonly events: LineageStore;
  readonly content: ContentStore;
  /** Clock for event times; injectable so a test (or a replaying host) is deterministic. */
  readonly now?: () => string;
  /**
   * The host's read policy, bound ONCE: every read this lineage serves under a viewer (`explain`)
   * applies it, and a `SeenLog` or `LineageChangeFeed` built over this lineage inherits it. A
   * per-call value may only ADD to it (`mergeReadPolicy`). Absent = no policy (the experience's own
   * classes only).
   */
  readonly readPolicy?: ReadPolicy;
  /**
   * Host hook: has this line's erasure been CONFIRMED? A read that hits a sealed line whose key is
   * unavailable (`isKeyUnavailable`) or whose blob is shredded (`isPayloadShredded`) cannot tell an
   * erasure from "the key is not on this node" or "the ciphertext does not open" (loom says so
   * itself). The line is reported `line-erased` ONLY when this returns true, else `line-unreadable`.
   * Implement it with your KeyStore: `(id) => keys.wasDestroyed(subjectOf({ executionId: stream(id) }))`.
   * Absent = nothing is ever confirmed. A throwing hook counts as "not confirmed". Both outcomes
   * fail closed; only a confirmed erasure is skipped by the GC root walks.
   */
  readonly confirmErased?: (experienceId: string) => Promise<boolean>;
}

/**
 * Thrown by the reads that return plain values (`forEachContentRef`, `pins` and so `rootsFor`) when
 * a line's key is gone AND the host confirmed the erasure (`LineageOptions.confirmErased`). Those
 * reads SKIP a confirmed-erased line (it contributes no roots), so this reaches a caller only from a
 * single-line read; every method that returns a `LineageResult` (or `verify`'s findings) reports the
 * same condition as a `refused` result with code `line-erased` instead of throwing.
 */
export class LineErasedError extends Error {
  override readonly name = "LineErasedError";
  readonly code = "line-erased" as const;
  readonly confirmed = true as const;
  constructor(
    readonly experienceId: string,
    options?: { readonly cause?: unknown }
  ) {
    super(
      `lineage "${experienceId}" is erased: its key is destroyed (confirmed by the host)`,
      options
    );
    Object.setPrototypeOf(this, LineErasedError.prototype);
  }
}

/**
 * The line's key is unavailable on this node, or its ciphertext / artifact does not open, and the
 * erasure is NOT confirmed (no `confirmErased` hook, or it said no). Could be a destroyed key, a key
 * this node does not hold, a tampered event, a drifted `subjectOf`, or an artifact written before an
 * `EncryptingContentStore` was composed (`reason: "artifact-unsealed"`). Fail closed, but not an
 * erasure: GC refuses rather than guess, and a read says so. `reason` is also the refusal's finding code.
 */
export class LineUnreadableError extends Error {
  override readonly name = "LineUnreadableError";
  readonly code = "line-unreadable" as const;
  readonly confirmed = false as const;
  readonly reason: "line-unreadable" | "artifact-unsealed";
  constructor(
    readonly experienceId: string,
    options?: {
      readonly cause?: unknown;
      readonly reason?: "line-unreadable" | "artifact-unsealed";
    }
  ) {
    super(
      `lineage "${experienceId}" is unreadable: its key is unavailable on this node or its ciphertext does not open; not confirmed erased`,
      options?.cause === undefined ? undefined : { cause: options.cause }
    );
    this.reason = options?.reason ?? "line-unreadable";
    Object.setPrototypeOf(this, LineUnreadableError.prototype);
  }
}

export type LineBlockedError = LineErasedError | LineUnreadableError;

/** Is `err` a read failure that makes a line unreadable? The kernel's stable predicates, never message text. */
const isUnreadableCause = (err: unknown): boolean =>
  isKeyUnavailable(err) || isPayloadShredded(err);
/** loom's "the blob exists but does not open although the key exists" (plaintext or damaged bytes). */
const isUndecryptable = (err: unknown): boolean =>
  err instanceof Error && err.name === "ContentUndecryptableError";

/**
 * Classify a read failure of one line: `undefined` when it is not an unreadable-line failure
 * (rethrow it), else a typed error. ONE rule: `line-erased` iff the host's `confirmErased` says so;
 * `isPayloadShredded` alone is not confirmation. An undecryptable blob is never an erasure.
 */
export async function classifyLineFailure(
  experienceId: string,
  err: unknown,
  confirmErased?: (experienceId: string) => Promise<boolean>
): Promise<LineBlockedError | undefined> {
  if (isUndecryptable(err))
    return new LineUnreadableError(experienceId, { cause: err, reason: "artifact-unsealed" });
  if (!isUnreadableCause(err)) return undefined;
  let confirmed = false;
  if (confirmErased !== undefined) {
    try {
      confirmed = (await confirmErased(experienceId)) === true;
    } catch {
      confirmed = false;
    }
  }
  return confirmed
    ? new LineErasedError(experienceId, { cause: err })
    : new LineUnreadableError(experienceId, { cause: err });
}

const blockedFinding = (e: LineBlockedError): Finding =>
  e instanceof LineErasedError
    ? {
        code: "line-erased",
        severity: "error",
        message: `lineage "${e.experienceId}" is erased: its key is destroyed (confirmed); nothing readable or writable`,
      }
    : {
        code: e.reason,
        severity: "error",
        message:
          e.reason === "artifact-unsealed"
            ? `lineage "${e.experienceId}" is unreadable: an artifact blob did not open under the line's key (written before sealing was composed, or damaged); not an erasure`
            : `lineage "${e.experienceId}" is unreadable: its key is unavailable on this node or its ciphertext does not open; not confirmed erased`,
      };
const blocked = (e: LineBlockedError): { ok: false; refusal: Refusal } =>
  fromFinding(blockedFinding(e));
const BLOCKED_CODES: ReadonlySet<string> = new Set([
  "line-erased",
  "line-unreadable",
  "artifact-unsealed",
]);
const isBlockedRefusal = (r: { ok: false; refusal: Refusal }): boolean =>
  r.refusal.kind === "refused" && BLOCKED_CODES.has(r.refusal.finding.code);
const isErasedRefusal = (r: { ok: false; refusal: Refusal }): boolean =>
  r.refusal.kind === "refused" && r.refusal.finding.code === "line-erased";

const refused = (code: string, message: string): { ok: false; refusal: Refusal } => ({
  ok: false,
  refusal: { kind: "refused", finding: { code, severity: "error", message } },
});
const fromFinding = (finding: Finding): { ok: false; refusal: Refusal } => ({
  ok: false,
  refusal: { kind: "refused", finding },
});

/** Bound on re-reading after a lost append whose head did not move (a promotion slipped in). */
const MAX_TIP_RETRIES = 16;

/** Bound on how many source lines `verify` follows through branches (a branch of a branch of ...). */
const MAX_VERIFY_DEPTH = 32;

/** Whether `hash` is `ancestor` or reaches it through `parents` within the line (iterative, cycle-safe). */
function descendsFrom(state: LineageState, hash: string, ancestor: string): boolean {
  const seen = new Set<string>();
  const stack = [hash];
  for (let h = stack.pop(); h !== undefined; h = stack.pop()) {
    if (h === ancestor) return true;
    if (seen.has(h)) continue;
    seen.add(h);
    for (const p of state.versions.get(h)?.parents ?? []) stack.push(p);
  }
  return false;
}

/**
 * Every `by` a write would record (the write's own and each op's) must satisfy core's `Provenance`,
 * the schema the fold enforces on read. The fold stays strict; the REFUSAL is here, because the log
 * has no delete and one event that does not fold bricks the line for every reader.
 */
function provenanceRefusal(
  by: unknown,
  ops?: readonly RecordedOperation[]
): { ok: false; refusal: Refusal } | undefined {
  const bad = (what: string) =>
    refused("provenance-invalid", `${what} is not a valid provenance (nothing was written)`);
  if (!ProvenanceSchema.safeParse(by).success) return bad("`by`");
  if (ops !== undefined) {
    if (!Array.isArray(ops)) return refused("ops-invalid", "ops must be an array");
    for (const [i, r] of ops.entries())
      if (typeof r !== "object" || r === null || !ProvenanceSchema.safeParse(r.by).success)
        return bad(`op #${i}'s \`by\``);
  }
  return undefined;
}

/** Iterative (no recursion limit) walk for `{ __loomContent: string }` leaves. */
function walkContentRefs(root: unknown, visit: (address: string) => void): void {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const cur = stack.pop();
    if (typeof cur !== "object" || cur === null || seen.has(cur)) continue;
    seen.add(cur);
    const a = (cur as { __loomContent?: unknown }).__loomContent;
    if (typeof a === "string") visit(a);
    for (const v of Array.isArray(cur) ? cur : Object.values(cur)) stack.push(v);
  }
}

/** What else uses the lineage's content store, for {@link Lineage.pins}. */
export interface PinsExtra {
  /** Versions to retain whatever the policy says (e.g. the ones a seen log still records views of). */
  readonly keepVersions?: Iterable<{ readonly experienceId: string; readonly versionHash: string }>;
  /** Addresses of other users of the same store (e.g. a seen log's sealed value blobs). */
  readonly keepAddresses?: Iterable<string> | AsyncIterable<string>;
  /**
   * How many retained artifacts of ONE line are read at once, to find the refs inside their bytes.
   * Default 8; a positive integer (anything else throws). 1 reads strictly one after another.
   */
  readonly concurrency?: number;
}

/** Run `fn` over `items` with at most `limit` in flight; rejects on the first failure (nothing after it starts). */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export class Lineage {
  private readonly events: LineageStore;
  private readonly content: ContentStore;
  private readonly now: () => string;
  private readonly policy: ReadPolicy;
  private readonly streamPrefix: string;
  private readonly workflowId: string;
  private readonly confirmErased: LineageOptions["confirmErased"];

  constructor(opts: LineageOptions) {
    this.policy = mergeReadPolicy(opts.readPolicy);
    this.events = opts.events;
    this.content = opts.content;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.confirmErased = opts.confirmErased;
    const p = (opts.events as { streamPrefix?: unknown }).streamPrefix;
    if (
      (opts.content as { sealsContent?: unknown }).sealsContent === true &&
      !(typeof p === "string" && p.length > 0)
    )
      throw new Error(
        "Lineage: the content store seals per subject (sealsContent: true) but the events store does not expose a streamPrefix (use eventStoreLineageStore): the blobs could be sealed under a different subject than the line's events"
      );
    this.streamPrefix = typeof p === "string" && p.length > 0 ? p : LINEAGE_STREAM_PREFIX;
    const w = (opts.events as { workflowId?: unknown }).workflowId;
    this.workflowId = typeof w === "string" && w.length > 0 ? w : LINEAGE_WORKFLOW_ID;
  }

  /**
   * The `ContentAccess` of one line's artifact blobs: the line's STREAM id (the id its events live
   * under) and the lineage workflow id. A content store that seals by owner (`EncryptingContentStore`)
   * resolves it through the host's `subjectOf`, the same mapping its event store applies to the
   * stream, so one mapping covers a line's events and blobs. A plain store ignores it.
   */
  private accessFor(experienceId: string): ContentAccess {
    return { executionId: `${this.streamPrefix}${experienceId}`, workflowId: this.workflowId };
  }

  /**
   * Classify a read failure of `experienceId` with this lineage's `confirmErased` hook: a typed
   * {@link LineErasedError} (confirmed) or {@link LineUnreadableError}, or `undefined` when `err` is
   * not an unreadable-line failure. Readers built over this lineage (the change feed) use it.
   */
  block(experienceId: string, err: unknown): Promise<LineBlockedError | undefined> {
    return classifyLineFailure(experienceId, err, this.confirmErased);
  }

  /** Every record of a line; an unreadable line THROWS a {@link LineBlockedError}, anything else propagates. */
  private async readLine(experienceId: string) {
    try {
      return await this.events.read(experienceId);
    } catch (err) {
      throw (await this.block(experienceId, err)) ?? err;
    }
  }

  private async confirms(experienceId: string): Promise<boolean> {
    if (this.confirmErased === undefined) return false;
    try {
      return (await this.confirmErased(experienceId)) === true;
    } catch {
      return false;
    }
  }

  /**
   * A write step failed with `err`: a typed refusal when the line is (now) unreadable, else rethrow.
   * The re-read catches a key destroyed between `state()` and the append, whose own error is untyped.
   */
  private async failedWrite(
    experienceId: string,
    err: unknown
  ): Promise<never | { ok: false; refusal: Refusal }> {
    const b = await this.block(experienceId, err);
    if (b !== undefined) return blocked(b);
    const after = await this.state(experienceId).catch(() => undefined);
    if (after !== undefined && !after.ok && isBlockedRefusal(after)) return after;
    throw err;
  }

  /** The read policy bound at construction (empty when none); readers built over this lineage inherit it. */
  get readPolicy(): ReadPolicy {
    return this.policy;
  }

  /**
   * Whether `other` is this lineage's own store, or may write under a stream prefix that overlaps its
   * own (`a.startsWith(b) || b.startsWith(a)`: `x:` and `x:y:` collide). A `SeenLog` refuses such a
   * store: a viewer's record must never share streams with the line it describes.
   *
   * FAIL-CLOSED: the vetted store's `streamPrefix` must be readable (the package's prefixed stores
   * and `InMemoryLineageStore` are). A decorator that HIDES `streamPrefix` cannot be told apart from a
   * colliding store, so it is refused: re-expose `streamPrefix` on the wrapper (copied from the inner
   * store) if it is legitimate. The reverse is a documented limit: if THIS lineage's store is such a
   * wrapper its prefix is assumed to be the default (`LINEAGE_STREAM_PREFIX`).
   */
  sharesStreamsWith(other: LineageStore): boolean {
    if (other === this.events) return true;
    const prefixOf = (s: LineageStore): string | undefined | null => {
      const p = (s as { streamPrefix?: unknown }).streamPrefix;
      if (typeof p === "string" && p.length > 0) return p;
      return s instanceof InMemoryLineageStore ? null : undefined; // null: isolated by identity
    };
    // `other` is the store being vetted: with no readable prefix it cannot be proven disjoint, so it
    // is refused. This lineage's OWN store may be a wrapper that hides its prefix (a counting or
    // tracing decorator): it is assumed to use the package default.
    const b = prefixOf(other);
    if (b === undefined) return true;
    const a = prefixOf(this.events) ?? LINEAGE_STREAM_PREFIX;
    if (a === null || b === null) return false; // a distinct in-memory object shares nothing
    return a.startsWith(b) || b.startsWith(a);
  }

  /**
   * Call `visit` with every content address any version of any line cites (artifacts, op payloads,
   * anything stored as a content ref in an event), CONSERVATIVELY: any `__loomContent` string found
   * anywhere in a payload counts, claim-check envelopes included. This is the lineage's half of the
   * root set a content collector marks. One line is held in memory at a time. Throws if the store
   * cannot enumerate its lines (`listStreams`): a collector must refuse then, never guess.
   */
  async forEachContentRef(visit: (address: string) => void): Promise<void> {
    if (this.events.listStreams === undefined)
      throw new Error("Lineage.forEachContentRef: the LineageStore cannot enumerate its lines");
    for await (const id of this.events.listStreams()) {
      let records: Awaited<ReturnType<LineageStore["read"]>>;
      try {
        records = await this.readLine(id);
      } catch (err) {
        if (err instanceof LineErasedError) continue; // confirmed erased: no roots, its blobs are reclaimable
        throw err; // unconfirmed: refuse rather than guess
      }
      for (const rec of records) walkContentRefs(rec.payload, visit);
    }
  }

  /**
   * U17 — the content addresses a collector must KEEP, as the `roots` of loom's `sweepUnpinnedContent`:
   * for every line, the artifact of each version `policy` retains (`retainedVersions`: the newest N,
   * the head, the promoted version, the genesis, every fork's source) plus every OTHER content ref the
   * line's events cite (anything an op carries) plus every content ref found INSIDE a retained
   * artifact's own bytes (a node whose props hold a media ref: the sweep does not read blobs, so
   * nothing else would root it). The artifact ref of a version the policy does not keep is
   * deliberately absent, so that blob becomes reclaimable.
   *
   * USE IT INSTEAD OF scanning the lineage's streams, never as well: a scanned stream pins every
   * version's artifact for ever (a bare ref is load-bearing to loom's sweep), so pass the lineage's
   * `LineageStore` to neither `eventStores` nor `snapshotStores`. Mind the consequence: a reclaimed
   * version's event stays in the log, `get` of it reports the missing artifact, and `verify` of a line
   * that has had versions reclaimed reports them (and the versions derived from them) until the line
   * is verified from a retained checkpoint. Reclaim only versions nobody needs to re-open.
   *
   * THE ROOT SET MUST BE COMPLETE. With `reclaimOrphans: { completeScan: true }` loom erases every
   * blob in the store that no root names. The lineage is only ONE user of its content store: pass
   * the others through `extra` (a {@link SeenLog} sharing the store: `collectSeenRoots(log)`), and
   * add any other lineage's `pins()` and loom's own execution scan to the same `roots`. A
   * version a viewer's recorded view still names is kept via `extra.keepVersions`.
   *
   * RACES. A promote, a branch (and a seen-log record) TOUCH the artifact they newly cite
   * (`ContentStore.touch`, SPI 1.4.0, ADR 0055 D6 amendment 2), so a sweep whose roots were computed
   * a moment earlier still refuses to delete it. That also covers a fork made between this method's
   * two passes. It needs a store with `touch`; loom's sweep refuses to erase through one without it.
   *
   * COST. Linear in the number of RETAINED, DISTINCT artifacts, and each one is read in full: the
   * refs a version cites (media, blobs) live only inside its artifact's bytes, and neither the version
   * event nor the store records which artifacts hold any, so there is nothing to skip on without
   * reading. The reads are bounded, not avoided: a retention policy that keeps fewer versions reads
   * fewer artifacts, artifacts shared by versions or forks are read once per call, and `extra.concurrency`
   * sets how many of a line are in flight. Run it from the collector, not on a request path. (Skipping
   * ref-free artifacts would need a "cites refs" flag stamped on the version event at write time: a
   * lineage event-schema change, not done here.)
   *
   * Two passes, one line in memory at a time. Throws if the store cannot enumerate its lines, if
   * any line fails to fold, if a retained artifact cannot be read for a reason other than being
   * already gone, or on a malformed policy (a collector must refuse, never guess).
   */
  async *pins(
    policy: RetentionPolicy = {},
    extra: PinsExtra = {}
  ): AsyncGenerator<string, void, undefined> {
    validateRetentionPolicy(policy);
    const concurrency = extra.concurrency ?? 8;
    if (!Number.isInteger(concurrency) || concurrency < 1)
      throw new Error("Lineage.pins: concurrency must be a positive integer");
    if (this.events.listStreams === undefined)
      throw new Error("Lineage.pins: the LineageStore cannot enumerate its lines");
    // Pass 1: the versions that must outlive their referrers: other lines' forks, and `extra`.
    const kept = new Map<string, Set<string>>();
    const addKept = (experienceId: string, versionHash: string) => {
      const set = kept.get(experienceId) ?? new Set<string>();
      kept.set(experienceId, set);
      set.add(versionHash);
    };
    for (const v of extra.keepVersions ?? []) addKept(v.experienceId, v.versionHash);
    for await (const id of this.events.listStreams()) {
      let records1: Awaited<ReturnType<LineageStore["read"]>>;
      try {
        records1 = await this.readLine(id);
      } catch (err) {
        if (err instanceof LineErasedError) continue; // confirmed erased: contributes nothing
        throw err; // unconfirmed: refuse rather than guess
      }
      const fold = foldLineage(id, records1);
      if (!fold.ok) throw new Error(`Lineage.pins: "${id}" does not fold: ${fold.finding.message}`);
      for (const v of fold.state.versions.values())
        if (v.from !== undefined) addKept(v.from.experienceId, v.from.versionHash);
    }
    // Pass 2: the roots.
    const yielded = new Set<string>();
    const walked = new Set<string>();
    const pending: string[] = [];
    const emit = (a: string) => {
      if (yielded.has(a)) return;
      yielded.add(a);
      pending.push(a);
    };
    for await (const id of this.events.listStreams()) {
      let records: Awaited<ReturnType<LineageStore["read"]>>;
      try {
        records = await this.readLine(id);
      } catch (err) {
        if (err instanceof LineErasedError) continue;
        throw err;
      }
      const fold = foldLineage(id, records);
      if (!fold.ok) throw new Error(`Lineage.pins: "${id}" does not fold: ${fold.finding.message}`);
      const { keep } = retainedVersions(fold.state, policy, kept.get(id));
      // This line's roots are gathered locally and emitted once its artifacts read. If its blobs turn
      // out to be confirmed erased (events readable, blobs gone), only its OWN version artifacts are
      // dropped (they are the erased ciphertext, reclaimable by design); every other address its
      // plain events cite (a shared blob an op points at) stays rooted, which is the conservative side.
      const lineRoots: string[] = [];
      const ownArtifacts = new Set<string>();
      for (const rec of records) {
        const p = rec.payload as {
          ref?: { __loomContent?: unknown };
          versionHash?: unknown;
        } | null;
        // The artifact ref of a version event is pinned only if its version is retained.
        const artifact =
          typeof p?.ref?.__loomContent === "string" ? p.ref.__loomContent : undefined;
        if (artifact !== undefined) ownArtifacts.add(artifact);
        // (a PROMOTED event cites the same artifact; it counts as a citation of that version too)
        const droppedVersion = typeof p?.versionHash === "string" && !keep.has(p.versionHash);
        walkContentRefs(rec.payload, (a) => {
          if (a === artifact && droppedVersion) return;
          lineRoots.push(a);
        });
      }
      // Refs that live only inside a retained artifact's bytes. Artifacts are content-addressed, so
      // versions (and forks) that share an artifact are read ONCE per call; a line's reads run with
      // bounded concurrency and any failure but "missing" throws before this line yields anything.
      const toWalk: ContentRef[] = [];
      for (const h of keep) {
        const v = fold.state.versions.get(h);
        if (v === undefined) continue;
        const ref = v.ref as ContentRef;
        // Marked walked only once this line's reads succeed (below): a line skipped as erased must not
        // stop a later line that cites the same address from walking it.
        if (
          walked.has(ref.__loomContent) ||
          toWalk.some((r) => r.__loomContent === ref.__loomContent)
        )
          continue;
        toWalk.push(ref);
      }
      let arts: (Experience | undefined)[];
      try {
        arts = await mapLimit(toWalk, concurrency, async (ref) => {
          let art: Awaited<ReturnType<typeof getExperience>>;
          try {
            art = await getExperience(this.content, ref, this.accessFor(id));
          } catch (err) {
            throw (await this.block(id, err)) ?? err;
          }
          if (art.ok) return art.experience;
          if (art.finding.code === "artifact-missing") return undefined; // already gone: nothing inside to root
          throw new Error(
            `Lineage.pins: "${id}" artifact ${ref.__loomContent}: ${art.finding.message}`
          );
        });
      } catch (err) {
        if (!(err instanceof LineErasedError)) throw err;
        // Confirmed erased: drop this line's own artifacts, keep what its events cite elsewhere.
        for (const a of lineRoots) if (!ownArtifacts.has(a)) emit(a);
        while (pending.length > 0) yield pending.shift() as string;
        continue;
      }
      for (const ref of toWalk) walked.add(ref.__loomContent);
      for (const a of lineRoots) emit(a);
      for (const exp of arts) if (exp !== undefined) walkContentRefs(exp, emit);
      while (pending.length > 0) yield pending.shift() as string;
    }
    if (extra.keepAddresses !== undefined)
      for await (const a of extra.keepAddresses) {
        emit(a);
        while (pending.length > 0) yield pending.shift() as string;
      }
  }

  /**
   * Tell the content store that `versionHashes` of `experienceId` were JUST re-cited (by a promote,
   * a branch, a recorded view): `ContentStore.touch` on their artifacts, so a collector's
   * conditional delete spares them (loom ADR 0055 D6 amendment 2). A store without `touch` is
   * left alone (loom's sweep will not erase through one). Refuses when an artifact is already gone.
   */
  async cite(experienceId: string, versionHashes: readonly string[]): Promise<LineageResult<void>> {
    const touch = this.content.touch;
    if (touch === undefined) return { ok: true, value: undefined };
    const s = await this.state(experienceId);
    if (!s.ok) return s;
    const refs: string[] = [];
    for (const h of versionHashes) {
      const v = s.value.versions.get(h);
      if (v === undefined)
        return refused("version-unknown", `"${h}" is not a version of "${experienceId}"`);
      refs.push(v.ref.__loomContent);
    }
    const missing = await touch.call(this.content, refs);
    if (missing.length > 0)
      return refused("artifact-missing", `no content at ${missing[0]} (already reclaimed)`);
    return { ok: true, value: undefined };
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  /** The folded state of a line (empty state for an unknown one). A malformed log is a finding. */
  async state(experienceId: string): Promise<LineageResult<LineageState>> {
    let records: Awaited<ReturnType<LineageStore["read"]>>;
    try {
      records = await this.readLine(experienceId);
    } catch (err) {
      if (err instanceof LineErasedError || err instanceof LineUnreadableError) return blocked(err);
      throw err;
    }
    const fold = foldLineage(experienceId, records);
    return fold.ok ? { ok: true, value: fold.state } : fromFinding(fold.finding);
  }

  /** The latest version's hash, or null for a line with no version. */
  async head(experienceId: string): Promise<LineageResult<string | null>> {
    const s = await this.state(experienceId);
    return s.ok ? { ok: true, value: s.value.head } : s;
  }

  /** Every version, oldest first. */
  async versions(experienceId: string): Promise<LineageResult<readonly VersionRecord[]>> {
    const s = await this.state(experienceId);
    if (!s.ok) return s;
    return {
      ok: true,
      value: s.value.order.map((h) => s.value.versions.get(h) as VersionRecord),
    };
  }

  /**
   * `from` (default the head) and its ancestors WITHIN this line, newest first, following
   * `parents`. A branch's first version stops the walk (its parent is in another line; see
   * `VersionRecord.from`). Iterative with a visited set: a forged cycle cannot loop it.
   */
  async walk(
    experienceId: string,
    from?: string
  ): Promise<LineageResult<readonly VersionRecord[]>> {
    const s = await this.state(experienceId);
    if (!s.ok) return s;
    const start = from ?? s.value.head;
    if (start === null) return { ok: true, value: [] };
    if (!s.value.versions.has(start))
      return refused("version-unknown", `"${start}" is not a version of "${experienceId}"`);
    const out: VersionRecord[] = [];
    const seen = new Set<string>();
    const stack = [start];
    for (let h = stack.pop(); h !== undefined; h = stack.pop()) {
      const v = s.value.versions.get(h);
      if (v === undefined || seen.has(h)) continue;
      seen.add(h);
      out.push(v);
      for (let i = v.parents.length - 1; i >= 0; i--) stack.push(v.parents[i] as string);
    }
    return { ok: true, value: out };
  }

  /** One version's artifact, hash-verified (`getExperience`). */
  async get(experienceId: string, versionHash: string): Promise<LineageResult<Experience>> {
    const s = await this.state(experienceId);
    if (!s.ok) return s;
    return this.load(s.value, versionHash);
  }

  /** The latest version's artifact. */
  async resolveLatest(experienceId: string): Promise<LineageResult<Experience>> {
    const s = await this.state(experienceId);
    if (!s.ok) return s;
    if (s.value.head === null) return refused("lineage-empty", `"${experienceId}" has no versions`);
    return this.load(s.value, s.value.head);
  }

  /** The promoted (shown) version's artifact, or refused when nothing is promoted. */
  async resolvePromoted(experienceId: string): Promise<LineageResult<Experience>> {
    const s = await this.state(experienceId);
    if (!s.ok) return s;
    if (s.value.promoted === null)
      return refused("nothing-promoted", `"${experienceId}" has no promoted version`);
    return this.load(s.value, s.value.promoted);
  }

  private async load(state: LineageState, versionHash: string): Promise<LineageResult<Experience>> {
    const v = state.versions.get(versionHash);
    if (v === undefined)
      return refused(
        "version-unknown",
        `"${versionHash}" is not a version of "${state.experienceId}"`
      );
    let r: Awaited<ReturnType<typeof getExperience>>;
    try {
      r = await getExperience(
        this.content,
        v.ref as ContentRef,
        this.accessFor(state.experienceId)
      );
    } catch (err) {
      const b = await this.block(state.experienceId, err);
      if (b !== undefined) return blocked(b);
      throw err;
    }
    if (!r.ok) return fromFinding(r.finding);
    if (
      r.experience.versionHash !== versionHash ||
      r.experience.experienceId !== state.experienceId
    )
      return refused(
        "artifact-mismatch",
        `the content at ${v.ref.__loomContent} is not version ${versionHash} of "${state.experienceId}"`
      );
    return { ok: true, value: r.experience };
  }

  // ── provenance (U12) ────────────────────────────────────────────────────────

  /**
   * The per-node ledger of version `versionHash` (default the head): which recorded op created and
   * last changed each node, derived from the log alone (no artifact is read, nothing is stored).
   * A revert has the ledger of the version it restores; a branch starts from its source version's.
   * Bounded: a chain of reverts or branches deeper than `MAX_VERIFY_DEPTH` ends in an unknown
   * origin rather than recursing without limit.
   */
  async provenance(
    experienceId: string,
    versionHash?: string
  ): Promise<LineageResult<ProvenanceLedger>> {
    const s = await this.state(experienceId);
    if (!s.ok) return s;
    const target = versionHash ?? s.value.head;
    if (target === null) return refused("lineage-empty", `"${experienceId}" has no versions`);
    if (!s.value.versions.has(target))
      return refused("version-unknown", `"${target}" is not a version of "${experienceId}"`);
    return { ok: true, value: await this.ledgerAt(s.value, target, 0) };
  }

  private async ledgerAt(
    state: LineageState,
    target: string,
    depth: number
  ): Promise<ProvenanceLedger> {
    const unknown = { ...emptyLedger(null), truncated: true };
    if (depth > MAX_VERIFY_DEPTH) return unknown;
    const chain: VersionRecord[] = [];
    const seen = new Set<string>();
    let base: ProvenanceLedger = unknown;
    for (let h: string | undefined = target; h !== undefined; ) {
      const v = state.versions.get(h);
      if (v === undefined || seen.has(h)) break;
      seen.add(h);
      if (v.kind === "reverted" && v.revertedTo !== undefined) {
        base = await this.ledgerAt(state, v.revertedTo, depth + 1);
        break;
      }
      if (v.kind === "branched" && v.from !== undefined) {
        const src = await this.state(v.from.experienceId);
        base =
          src.ok && src.value.versions.has(v.from.versionHash)
            ? await this.ledgerAt(src.value, v.from.versionHash, depth + 1)
            : unknown;
        break;
      }
      if (v.parents.length === 0) {
        base = emptyLedger({ versionHash: v.versionHash, at: v.at, by: v.by });
        chain.push(v);
        break;
      }
      chain.push(v);
      h = v.parents[0];
    }
    return foldProvenance(base, chain.reverse());
  }

  /**
   * Why is `nodeId` in version `versionHash` (default the head), FOR `viewer`? The ledger of that
   * version read through core's `explainNode`: unknown, restricted and unreadable all answer the
   * same bare `{ available: false }`. The creating version's summary and the request that prompted
   * it are shown only when the viewer may see the strictest class of the viewed version, of the
   * version that wrote them, and of what the planner read (`summaryClass`); a version that cannot be
   * read counts as `secret`. Performs no authorization: `viewer` is the host's claim.
   */
  async explain(
    experienceId: string,
    nodeId: string,
    opts: {
      readonly viewer?: Viewer;
      /** The surface's audience: `"broadcast"` explains as a viewer with no clearance. */
      readonly audience?: Audience;
      readonly versionHash?: string;
      readonly projections?: ProjectionCatalog;
      readonly hydrationProjectionId?: string;
      readonly declaredToolClasses?: DeclaredToolClasses;
      readonly undeclared?: UndeclaredToolPolicy;
    } = {}
  ): Promise<LineageResult<NodeExplanation>> {
    // The bound policy applies; a per-call value can only add to it.
    const policy = mergeReadPolicy(this.policy, opts);
    const s = await this.state(experienceId);
    if (!s.ok) return s;
    const target = opts.versionHash ?? s.value.head;
    if (target === null) return refused("lineage-empty", `"${experienceId}" has no versions`);
    const exp = await this.load(s.value, target);
    if (!exp.ok) return exp;
    const ledger = await this.ledgerAt(s.value, target, 0);
    const viewOpts = {
      ledger,
      ...(opts.viewer !== undefined && { viewer: opts.viewer }),
      ...(opts.audience !== undefined && { audience: opts.audience }),
      ...(policy.projections !== undefined && { projections: policy.projections }),
      ...(policy.hydrationProjectionId !== undefined && {
        hydrationProjectionId: policy.hydrationProjectionId,
      }),
      ...(policy.declaredToolClasses !== undefined && {
        declaredToolClasses: policy.declaredToolClasses,
      }),
      ...(policy.undeclared !== undefined && { undeclared: policy.undeclared }),
    };
    // Ask first with no notes: an unknown, hidden or unreadable node answers `{ available: false }`
    // HERE, before the writer is loaded, so the I/O a probe costs is the same for all three (a
    // hidden node must not be told apart from an unknown id by how many blobs a call fetched).
    const first = explainNode(exp.value, nodeId, viewOpts);
    if (!first.available) return { ok: true, value: first };
    const entry = ledger.nodes.get(nodeId)?.created;
    const wrote = entry?.versionHash ?? ledger.origin?.versionHash;
    if (wrote === undefined) return { ok: true, value: first };
    const notes = new Map<string, VersionNote>();
    let extraFloor: ExplainOptions["extraFloor"];
    // The writer may live on ANOTHER line (a branch's ledger starts from its source's): resolve it
    // across lines, bounded. Unresolvable = fail closed (the text it wrote cannot be classed).
    const found = await this.findVersion(s.value, wrote);
    if (found === undefined) extraFloor = "secret";
    else {
      notes.set(wrote, {
        ...(found.record.summary !== undefined && { summary: found.record.summary }),
        ...(found.record.summaryClass !== undefined && {
          summaryClass: found.record.summaryClass,
        }),
      });
      if (found.record.summary !== undefined || entry?.prompt !== undefined) {
        const art = await this.load(found.state, wrote);
        extraFloor = art.ok
          ? experienceClassFloor(
              art.value,
              policy.projections,
              policy.declaredToolClasses,
              policy.undeclared
            )
          : "secret";
      }
    }
    return {
      ok: true,
      value: explainNode(exp.value, nodeId, {
        ...viewOpts,
        notes,
        ...(extraFloor !== undefined && { extraFloor }),
      }),
    };
  }

  /**
   * The line state and record of version `hash`, on this line or on a line it was branched from
   * (breadth-first through `branched` versions, at most `MAX_VERIFY_DEPTH` lines, each visited once).
   */
  private async findVersion(
    state: LineageState,
    hash: string
  ): Promise<{ state: LineageState; record: VersionRecord } | undefined> {
    const visited = new Set<string>([state.experienceId]);
    const queue: LineageState[] = [state];
    for (let i = 0; i < queue.length; i++) {
      const st = queue[i] as LineageState;
      const record = st.versions.get(hash);
      if (record !== undefined) return { state: st, record };
      for (const v of st.versions.values()) {
        const from = v.kind === "branched" ? v.from : undefined;
        if (from === undefined || visited.has(from.experienceId)) continue;
        if (visited.size >= MAX_VERIFY_DEPTH) return undefined;
        visited.add(from.experienceId);
        const src = await this.state(from.experienceId);
        if (src.ok) queue.push(src.value);
      }
    }
    return undefined;
  }

  /**
   * Several versions' artifacts from ONE fold of the line (`get` refolds the whole log per call).
   * A version that is unknown or cannot be read maps to `undefined`.
   */
  async getMany(
    experienceId: string,
    versionHashes: readonly string[]
  ): Promise<LineageResult<ReadonlyMap<string, Experience | undefined>>> {
    const s = await this.state(experienceId);
    if (!s.ok) return s;
    const out = new Map<string, Experience | undefined>();
    for (const h of new Set(versionHashes)) {
      const r = await this.load(s.value, h);
      if (!r.ok && isBlockedRefusal(r)) return r;
      out.set(h, r.ok ? r.value : undefined);
    }
    return { ok: true, value: out };
  }

  // ── writes ──────────────────────────────────────────────────────────────────

  /** Begin a line: the genesis artifact becomes its first version. Refused when the line exists. */
  async start(genesis: Experience, by: Provenance): Promise<LineageResult<Committed>> {
    if (genesis.parents.length > 0)
      return refused("genesis-has-parents", "a lineage starts from a parentless artifact");
    return this.advance({
      experienceId: genesis.experienceId,
      expectedHead: null,
      artifact: genesis,
      ops: [],
      by,
    });
  }

  /**
   * Advance the head to `artifact`, which `ops` produce from the version `expectedHead`.
   *
   * REFUSES, writing nothing, when: `expectedHead` is not the head (`head-moved`, carrying the real
   * one — the caller re-reads and re-authors; nothing is ever silently overwritten); the artifact
   * does not name `expectedHead` as its only parent; or replaying `ops` from the parent does not
   * reproduce the artifact's content address (`ops-artifact-mismatch`), including an op the host
   * will not allow or one declared against a different base. `ops` is empty only for the first
   * version of a line. The artifact may arrive unsealed.
   */
  async advance(input: {
    readonly experienceId: string;
    readonly expectedHead: string | null;
    readonly artifact: Experience;
    readonly ops: readonly RecordedOperation[];
    readonly by: Provenance;
    /**
     * Whether a recorded `declassify*` op may be replayed. Per call and HOST-ONLY: it lowers a
     * class, so the code that authored the ops (never a planner's output, never stored config)
     * passes it for this one write. Default false. `verify` does not need it (see there).
     */
    readonly allowDeclassify?: boolean;
    /** What the author said about the change (a planner's `PlanResult.summary`): untrusted, bounded on the way in. */
    readonly summary?: string;
    /**
     * The strictest class of everything the author read to write `summary` (the planner's inputs,
     * context and samples included). HOST-STAMPED; a viewer sees the summary only when cleared for
     * it AND for the version's own class floor. Absent: only the floor gates it, so a host whose
     * planner saw classified context MUST pass it. Refused when it is not a known class.
     */
    readonly summaryClass?: SummaryClass;
  }): Promise<LineageResult<Committed>> {
    const { experienceId, expectedHead, artifact, ops, by } = input;
    const badBy = provenanceRefusal(by, ops);
    if (badBy !== undefined) return badBy;
    const summary = boundSummary(input.summary);
    if (input.summaryClass !== undefined && !Sensitivity.safeParse(input.summaryClass).success)
      return refused("summary-class-invalid", "summaryClass is not a known data class");
    const applyOpts: ApplyOptions = { allowDeclassify: input.allowDeclassify === true };
    return this.commit(experienceId, expectedHead, async (_state, parent) => {
      if (artifact.experienceId !== experienceId)
        return refused(
          "artifact-wrong-line",
          `the artifact is "${artifact.experienceId}", not "${experienceId}"`
        );
      const want = expectedHead === null ? [] : [expectedHead];
      if (!sameSet(artifact.parents, want))
        return refused(
          "artifact-parent-mismatch",
          `the artifact's parents ${JSON.stringify(artifact.parents)} are not ${JSON.stringify(want)}`
        );
      let sealed: Experience;
      try {
        sealed = seal(artifact);
      } catch (err) {
        return refused("artifact-unhashable", `the artifact cannot be hashed: ${msg(err)}`);
      }
      if (artifact.versionHash !== "" && artifact.versionHash !== sealed.versionHash)
        return refused(
          "artifact-tampered",
          `versionHash ${artifact.versionHash} does not match the artifact (${sealed.versionHash})`
        );
      const check =
        parent === null ? checkGenesis(ops) : checkOps(parent, ops, sealed.versionHash, applyOpts);
      if (check !== undefined) return fromFinding(check);
      // `meta` is not part of the address and the caller's claim about it is unverified, so the
      // stored artifact's authorship is derived from the recorded provenance and the clock (as a
      // revert's is), never taken from the argument.
      const stored: Experience = {
        ...sealed,
        meta: { author: authorOf(by), createdAt: this.now(), sourceKind: "compose" },
      };
      return {
        ok: true,
        value: {
          artifact: stored,
          type: EXPERIENCE_COMPOSED,
          payload: (ref: ContentRef) => ({
            experienceId,
            versionHash: sealed.versionHash,
            ref,
            parents: sealed.parents,
            ops,
            by,
            ...(summary !== undefined && { summary }),
            ...(input.summaryClass !== undefined && { summaryClass: input.summaryClass }),
          }),
        },
      };
    });
  }

  /**
   * The concurrent-author path: fold `ops` onto the head yourself. The first op is applied with
   * `applyAt`, so one that declares a `baseVersion` other than the head is refused
   * (`stale-base-version`) instead of landing on a surface its author never saw; then the result is
   * committed through {@link advance}'s verification, so what is recorded is exactly what replays.
   */
  async compose(input: {
    readonly experienceId: string;
    readonly expectedHead: string;
    readonly ops: readonly RecordedOperation[];
    readonly by: Provenance;
    /** As on {@link advance}: per call, host-only, default false. */
    readonly allowDeclassify?: boolean;
    /** As on {@link advance}. */
    readonly summary?: string;
    /** As on {@link advance}. */
    readonly summaryClass?: SummaryClass;
  }): Promise<LineageResult<Committed>> {
    const { experienceId, expectedHead, ops, by } = input;
    const badBy = provenanceRefusal(by, ops);
    if (badBy !== undefined) return badBy;
    const applyOpts: ApplyOptions = { allowDeclassify: input.allowDeclassify === true };
    const s = await this.state(experienceId);
    if (!s.ok) return s;
    if (s.value.head !== expectedHead)
      return { ok: false, refusal: { kind: "head-moved", expectedHead, actualHead: s.value.head } };
    const parent = await this.load(s.value, expectedHead);
    if (!parent.ok) return parent;
    if (ops.length === 0) return refused("empty-ops", "a composition needs at least one op");
    const first = ops[0] as RecordedOperation;
    let cur = applyAt(parent.value, first.op, {
      ...applyOpts,
      ...(first.baseVersion !== undefined && { baseVersion: first.baseVersion }),
    });
    for (let i = 1; cur.ok && i < ops.length; i++)
      cur = apply(cur.value, (ops[i] as RecordedOperation).op, applyOpts);
    if (!cur.ok) return fromFinding(cur.finding);
    return this.advance({
      experienceId,
      expectedHead,
      artifact: cur.value,
      ops,
      by,
      allowDeclassify: input.allowDeclassify === true,
      ...(input.summary !== undefined && { summary: input.summary }),
      ...(input.summaryClass !== undefined && { summaryClass: input.summaryClass }),
    });
  }

  /**
   * Restore the content of version `to` as a NEW version on top of `expectedHead` — history is
   * never rewritten, and the revert itself can be reverted. Sticky classes the line learned since
   * `to` are carried forward (never lowered; see derive.ts). `to` may be any version of the line
   * except the head (which would restore nothing).
   */
  async revert(input: {
    readonly experienceId: string;
    readonly expectedHead: string;
    readonly to: string;
    readonly by: Provenance;
  }): Promise<LineageResult<Committed>> {
    const { experienceId, expectedHead, to, by } = input;
    const badBy = provenanceRefusal(by);
    if (badBy !== undefined) return badBy;
    return this.commit(experienceId, expectedHead, async (state, head) => {
      if (head === null) return refused("lineage-empty", `"${experienceId}" has no versions`);
      if (to === expectedHead) return refused("revert-to-head", "the head is already that version");
      const target = await this.load(state, to);
      if (!target.ok) return target;
      const sealed = sealed_(revertArtifact(head, target.value, { by, at: this.now() }));
      if (!sealed.ok) return sealed;
      return {
        ok: true,
        value: {
          artifact: sealed.value,
          type: EXPERIENCE_REVERTED,
          payload: (ref: ContentRef) => ({
            experienceId,
            versionHash: sealed.value.versionHash,
            ref,
            parents: sealed.value.parents,
            revertedTo: to,
            by,
          }),
        },
      };
    });
  }

  /** Undo: revert to the head's parent, as a new version. Redo is `revert` to the hash you left. */
  async undo(input: {
    readonly experienceId: string;
    readonly expectedHead: string;
    readonly by: Provenance;
  }): Promise<LineageResult<Committed>> {
    const s = await this.state(input.experienceId);
    if (!s.ok) return s;
    const headRec = s.value.head === null ? undefined : s.value.versions.get(s.value.head);
    if (s.value.head !== input.expectedHead)
      return {
        ok: false,
        refusal: { kind: "head-moved", expectedHead: input.expectedHead, actualHead: s.value.head },
      };
    const parent = headRec?.parents[0];
    if (headRec === undefined || parent === undefined || !s.value.versions.has(parent))
      return refused("nothing-to-undo", "the head has no earlier version in this line");
    return this.revert({ ...input, to: parent });
  }

  /**
   * Fork version `from` of one line into a NEW line `experienceId`. The new line's first version
   * has `from` as its (cross-line) parent and carries the sticky classes of the source line's head
   * at the fork, so branching an old version never launders a class the source learned later.
   * Refused when the new line already exists.
   */
  async branch(input: {
    readonly from: { readonly experienceId: string; readonly versionHash: string };
    readonly experienceId: string;
    readonly by: Provenance;
  }): Promise<LineageResult<Committed>> {
    const { from, experienceId, by } = input;
    const badBy = provenanceRefusal(by);
    if (badBy !== undefined) return badBy;
    if (experienceId === from.experienceId)
      return refused("branch-same-line", "a branch is a NEW line; use revert within one");
    const src = await this.state(from.experienceId);
    if (!src.ok) return src;
    if (src.value.head === null)
      return refused("lineage-empty", `"${from.experienceId}" has no versions`);
    const carriedFrom = src.value.head;
    const [source, carried] = await Promise.all([
      this.load(src.value, from.versionHash),
      this.load(src.value, carriedFrom),
    ]);
    if (!source.ok) return source;
    if (!carried.ok) return carried;
    // The fork records its source by hash with no `put` of that artifact: touch the source (and the
    // head whose classes it carries) BEFORE the append, so a concurrent sweep spares them.
    const cited = await this.cite(from.experienceId, [from.versionHash, carriedFrom]);
    if (!cited.ok) return cited;
    const committed = await this.commit(experienceId, null, async () => {
      const sealed = sealed_(
        branchArtifact(source.value, carried.value, experienceId, { by, at: this.now() })
      );
      if (!sealed.ok) return sealed;
      return {
        ok: true,
        value: {
          artifact: sealed.value,
          type: EXPERIENCE_BRANCHED,
          payload: (ref: ContentRef) => ({
            experienceId,
            versionHash: sealed.value.versionHash,
            ref,
            parents: sealed.value.parents,
            from,
            carriedFrom,
            by,
          }),
        },
      };
    });
    if (committed.ok)
      await this.cite(from.experienceId, [from.versionHash, carriedFrom]).catch(() => undefined);
    return committed;
  }

  /**
   * Mark version `versionHash` as the one the app SHOWS (an agent's ops yield a new version; showing
   * it is this separate act). Compare-and-set on the promoted pointer: `expectedPromoted` is what
   * the caller saw (null = nothing promoted yet).
   */
  async promote(input: {
    readonly experienceId: string;
    readonly versionHash: string;
    readonly expectedPromoted: string | null;
    readonly by: Provenance;
  }): Promise<LineageResult<{ readonly promoted: string; readonly sequence: number }>> {
    const { experienceId, versionHash, expectedPromoted, by } = input;
    const badBy = provenanceRefusal(by);
    if (badBy !== undefined) return badBy;
    for (let attempt = 0; attempt < MAX_TIP_RETRIES; attempt++) {
      const s = await this.state(experienceId);
      if (!s.ok) return s;
      if (s.value.promoted !== expectedPromoted)
        return {
          ok: false,
          refusal: { kind: "promoted-moved", expectedPromoted, actualPromoted: s.value.promoted },
        };
      const art = await this.load(s.value, versionHash);
      if (!art.ok) return art;
      const v = s.value.versions.get(versionHash) as VersionRecord;
      const promotedPayload = { ref: v.ref, experienceId, versionHash, by };
      const badPayload = payloadRefusal(EXPERIENCE_PROMOTED, promotedPayload);
      if (badPayload !== undefined) return refused(badPayload.code, badPayload.message);
      // The promotion cites an artifact that already exists, with no `put`: touch it BEFORE the
      // append so a sweep that marked earlier cannot delete it, and AFTER to extend the window.
      const cited = await this.cite(experienceId, [versionHash]);
      if (!cited.ok) return cited;
      let out: Awaited<ReturnType<LineageStore["append"]>>;
      try {
        out = await this.events.append(experienceId, s.value.sequence, {
          type: EXPERIENCE_PROMOTED,
          at: this.now(),
          payload: promotedPayload,
        });
      } catch (err) {
        return this.failedWrite(experienceId, err);
      }
      if (out.ok) {
        await this.cite(experienceId, [versionHash]).catch(() => undefined); // best effort: the write is durable
        return { ok: true, value: { promoted: versionHash, sequence: out.sequence } };
      }
    }
    return refused(
      "lineage-contended",
      `could not append to "${experienceId}" after ${MAX_TIP_RETRIES} attempts`
    );
  }

  // ── verification ────────────────────────────────────────────────────────────

  /**
   * Rebuild a whole line from its log and compare it to what is stored — the consumer of
   * `EXPERIENCE_COMPOSED`. Starting from the genesis artifact (attested by its address alone: there
   * is nothing before it to replay from), each version is REBUILT, never read back from its blob:
   * a composed version by replaying its ops on the rebuilt parent, a revert or branch by recomputing
   * it from the rebuilt artifacts it names. The rebuilt content address must equal the logged one
   * and the stored blob must hash to it. Returns every finding; `[]` = the line is consistent.
   *
   * A branch is only as sound as its source: `verify` also verifies the source line up to the
   * version the fork carried classes from (`carriedFrom`), recursively (a visited set and a depth
   * bound stop a forged cycle), and reports what it finds on the branch, prefixed with the source
   * line; `carriedFrom` must be the forked version or a descendant of it on the source line. A
   * version whose parent could not be rebuilt is reported, not skipped silently. Ops replay with
   * `declassify*` ALLOWED: this checks that addresses reproduce, and the write path is the gate.
   */
  async verify(experienceId: string): Promise<Finding[]> {
    return this.verifyLine(experienceId, null, new Set(), 0);
  }

  /** Verify `experienceId` from its start through version `upTo` (null = the whole line). */
  private async verifyLine(
    experienceId: string,
    upTo: string | null,
    visited: Set<string>,
    depth: number
  ): Promise<Finding[]> {
    const key = `${experienceId}@${upTo ?? ""}`;
    if (visited.has(key)) return [];
    visited.add(key);
    const s = await this.state(experienceId);
    if (!s.ok) return [s.refusal.kind === "refused" ? s.refusal.finding : unreachable()];
    const findings: Finding[] = [];
    const rebuilt = new Map<string, Experience>();
    const err = (code: string, message: string) =>
      findings.push({ code, severity: "error", message });
    let order = s.value.order;
    if (upTo !== null) {
      const at = order.indexOf(upTo);
      if (at < 0)
        return [
          {
            code: "version-unknown",
            severity: "error",
            message: `"${upTo}" is not a version of "${experienceId}"`,
          },
        ];
      order = order.slice(0, at + 1);
    }
    for (const hash of order) {
      const v = s.value.versions.get(hash) as VersionRecord;
      const stored = await this.load(s.value, hash);
      if (!stored.ok) {
        findings.push(stored.refusal.kind === "refused" ? stored.refusal.finding : unreachable());
        continue;
      }
      if (!sameSet(stored.value.parents, v.parents))
        err(
          "artifact-parent-mismatch",
          `version ${hash}: the stored artifact's parents differ from the log's`
        );
      let derived: Experience | undefined;
      if (v.kind === "composed") {
        const parent = v.parents[0] === undefined ? undefined : rebuilt.get(v.parents[0]);
        if (v.parents.length === 0) {
          if (v.ops.length > 0)
            err("ops-on-genesis", `version ${hash}: a genesis records ${v.ops.length} ops`);
          derived = stored.value;
        } else if (parent === undefined) {
          err("lineage-parent-unverified", `version ${hash}: its parent could not be rebuilt`);
          continue;
        } else {
          // verify replays with declassify allowed (it checks addresses; the write path is the gate),
          // so a declassify that reached the log is SURFACED (warn) — a raw append bypasses that gate.
          if (recordsDeclassify(v.ops))
            findings.push({
              code: "declassify-op-present",
              severity: "warn",
              message: `version ${hash}: records a declassify op — confirm it was authorized when written`,
            });
          const f = checkOps(parent, v.ops, hash, VERIFY_APPLY);
          if (f !== undefined) err(f.code, `version ${hash}: ${f.message}`);
          derived = replayed(parent, v.ops, VERIFY_APPLY);
        }
      } else if (v.kind === "reverted") {
        const head = v.parents[0] === undefined ? undefined : rebuilt.get(v.parents[0]);
        const target = v.revertedTo === undefined ? undefined : rebuilt.get(v.revertedTo);
        if (head === undefined || target === undefined) {
          err(
            "lineage-parent-unverified",
            `version ${hash}: the revert's head or target could not be rebuilt`
          );
          continue;
        }
        const d = sealed_(revertArtifact(head, target, { by: v.by, at: v.at }));
        if (!d.ok) {
          err("artifact-unhashable", `version ${hash}: cannot recompute the revert`);
          continue;
        }
        derived = d.value;
        if (derived.versionHash !== hash)
          err(
            "revert-artifact-mismatch",
            `version ${hash}: recomputing the revert gives ${derived.versionHash}`
          );
      } else {
        const srcState = v.from === undefined ? undefined : await this.state(v.from.experienceId);
        // The source line's erasure is CONFIRMED (the host's hook), either because it refuses
        // `line-erased` or because its events were deleted too (the version is simply absent) and the
        // hook still confirms: the fork cannot be recomputed. Like a genesis it is attested by its
        // address alone (the stored blob hashed to `hash` when it was loaded above), and the gap is
        // surfaced as a warning. An UNCONFIRMED unreadable source is an error (below).
        const srcErased =
          v.from !== undefined &&
          srcState !== undefined &&
          (srcState.ok
            ? !srcState.value.versions.has(v.from.versionHash) &&
              (await this.confirms(v.from.experienceId))
            : isErasedRefusal(srcState));
        if (srcErased) {
          findings.push({
            code: "branch-source-erased",
            severity: "warn",
            message: `version ${hash}: the source line "${v.from?.experienceId}" is erased, so this branch is attested by its content address only`,
          });
          rebuilt.set(hash, stored.value);
          continue;
        }
        if (srcState !== undefined && !srcState.ok && isBlockedRefusal(srcState)) {
          const f = srcState.refusal.kind === "refused" ? srcState.refusal.finding : unreachable();
          err(
            f.code,
            `version ${hash}: source line "${v.from?.experienceId}" cannot be read and its erasure is not confirmed: ${f.message}`
          );
          continue;
        }
        if (
          v.from === undefined ||
          v.carriedFrom === undefined ||
          srcState === undefined ||
          !srcState.ok
        ) {
          err(
            "lineage-parent-unverified",
            `version ${hash}: the branch's source line could not be read`
          );
          continue;
        }
        if (depth >= MAX_VERIFY_DEPTH) {
          err(
            "lineage-verify-depth",
            `version ${hash}: branches nest over ${MAX_VERIFY_DEPTH} lines deep`
          );
          continue;
        }
        if (!descendsFrom(srcState.value, v.carriedFrom, v.from.versionHash)) {
          err(
            "branch-carried-from-invalid",
            `version ${hash}: carriedFrom ${v.carriedFrom} is neither ${v.from.versionHash} nor a descendant of it on "${v.from.experienceId}"`
          );
          continue;
        }
        for (const f of await this.verifyLine(
          v.from.experienceId,
          v.carriedFrom,
          visited,
          depth + 1
        ))
          err(f.code, `version ${hash}: source line "${v.from.experienceId}": ${f.message}`);
        const [src, carried] = await Promise.all([
          this.load(srcState.value, v.from.versionHash),
          this.load(srcState.value, v.carriedFrom),
        ]);
        if (!src.ok || !carried.ok) {
          err(
            "lineage-parent-unverified",
            `version ${hash}: the branch's source versions could not be loaded`
          );
          continue;
        }
        const d = sealed_(
          branchArtifact(src.value, carried.value, experienceId, { by: v.by, at: v.at })
        );
        if (!d.ok) {
          err("artifact-unhashable", `version ${hash}: cannot recompute the branch`);
          continue;
        }
        derived = d.value;
        if (derived.versionHash !== hash)
          err(
            "branch-artifact-mismatch",
            `version ${hash}: recomputing the branch gives ${derived.versionHash}`
          );
      }
      if (derived !== undefined && derived.versionHash === hash) rebuilt.set(hash, derived);
      else if (derived === undefined)
        err("lineage-parent-unverified", `version ${hash}: could not be rebuilt`);
    }
    return findings;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * The one write path: check `expectedHead` against the head, let `prepare` verify and build the
   * version, store its bytes, then append at the log's tip. A lost append re-reads: if the head is
   * still `expectedHead` (only a promotion slipped in) it retries at the new tip; otherwise it is
   * `head-moved`. The blob is written BEFORE the event and is content-addressed, so a lost race
   * leaves an unreferenced, harmless blob — never a log entry without bytes.
   */
  private async commit(
    experienceId: string,
    expectedHead: string | null,
    prepare: (state: LineageState, head: Experience | null) => Promise<LineageResult<Prepared>>
  ): Promise<LineageResult<Committed>> {
    let s = await this.state(experienceId);
    if (!s.ok) return s;
    const moved = (actual: string | null): { ok: false; refusal: Refusal } => ({
      ok: false,
      refusal: { kind: "head-moved", expectedHead, actualHead: actual },
    });
    if (s.value.head !== expectedHead) return moved(s.value.head);
    let head: Experience | null = null;
    if (expectedHead !== null) {
      const loaded = await this.load(s.value, expectedHead);
      if (!loaded.ok) return loaded;
      head = loaded.value;
    }
    const prepared = await prepare(s.value, head);
    if (!prepared.ok) return prepared;
    const { artifact, type, payload } = prepared.value;
    // The write-side twin of the fold: an event the fold would refuse must never reach the log.
    const badPayload = payloadRefusal(type, payload({ __loomContent: "sha256:pending" }));
    if (badPayload !== undefined) return refused(badPayload.code, badPayload.message);
    // The blob goes in under THIS line's access (never the source line's, for a branch), so erasing
    // the owner of this line makes it unreadable, and erasing a source line does not touch it.
    let put: Awaited<ReturnType<typeof putExperience>>;
    try {
      put = await putExperience(this.content, artifact, this.accessFor(experienceId));
    } catch (err) {
      return this.failedWrite(experienceId, err);
    }
    if (!put.ok) return fromFinding(put.finding);
    for (let attempt = 0; attempt < MAX_TIP_RETRIES; attempt++) {
      let out: Awaited<ReturnType<LineageStore["append"]>>;
      try {
        out = await this.events.append(experienceId, s.value.sequence, {
          type,
          at: this.now(),
          payload: payload(put.ref),
        });
      } catch (err) {
        return this.failedWrite(experienceId, err);
      }
      if (out.ok) {
        const after = await this.state(experienceId);
        if (!after.ok) return after;
        return {
          ok: true,
          value: {
            experience: put.experience,
            version: after.value.versions.get(put.experience.versionHash) as VersionRecord,
          },
        };
      }
      s = await this.state(experienceId);
      if (!s.ok) return s;
      if (s.value.head !== expectedHead) return moved(s.value.head);
    }
    return refused(
      "lineage-contended",
      `could not append to "${experienceId}" after ${MAX_TIP_RETRIES} attempts`
    );
  }
}

/** Why replaying `ops` on `parent` does NOT yield `expectedHash`, or undefined when it does. */
function checkOps(
  parent: Experience,
  ops: readonly RecordedOperation[],
  expectedHash: string,
  applyOpts: ApplyOptions
): Finding | undefined {
  const f = (code: string, message: string): Finding => ({ code, severity: "error", message });
  if (ops.length === 0) return f("empty-ops", "a version after the first records at least one op");
  for (const [i, r] of ops.entries())
    if (r.baseVersion !== undefined && r.baseVersion !== parent.versionHash)
      return f(
        "stale-base-version",
        `op #${i} (${r.op.type}) was authored against ${r.baseVersion} but its parent is ${parent.versionHash}`
      );
  const out = replay(
    parent,
    ops.map((r) => r.op),
    applyOpts
  );
  if (!out.ok) return f("ops-refused", out.finding.message);
  const sealed = sealed_(out.value);
  if (!sealed.ok) return sealed.refusal.kind === "refused" ? sealed.refusal.finding : undefined;
  if (sealed.value.versionHash !== expectedHash)
    return f(
      "ops-artifact-mismatch",
      `replaying the recorded ops from ${parent.versionHash} gives ${sealed.value.versionHash}, not ${expectedHash}: the ops do not produce this artifact`
    );
  return undefined;
}

function replayed(
  parent: Experience,
  ops: readonly RecordedOperation[],
  applyOpts: ApplyOptions
): Experience | undefined {
  const out = replay(
    parent,
    ops.map((r) => r.op),
    applyOpts
  );
  if (!out.ok) return undefined;
  const sealed = sealed_(out.value);
  return sealed.ok ? sealed.value : undefined;
}

/**
 * `verify` checks ADDRESSES, not authority: the write path (`advance`/`compose`) is where a
 * `declassify*` op is gated, so a version that is already in the log replays with declassify
 * allowed. Refusing it here would report a legitimately host-authorized version as `ops-refused`.
 */
const VERIFY_APPLY: ApplyOptions = { allowDeclassify: true, legacyBind: true };

/** Does any recorded op (or a prompt's materialized ops, nested) declassify? Iterative, bounded. */
function recordsDeclassify(ops: readonly { op: unknown }[]): boolean {
  const stack: unknown[] = ops.map((r) => r.op);
  for (let seen = 0; stack.length > 0 && seen < 100_000; seen++) {
    const op = stack.pop() as { type?: unknown; materialized?: unknown } | null;
    if (op === null || typeof op !== "object") continue;
    if (typeof op.type === "string" && op.type.startsWith("declassify")) return true;
    if (Array.isArray(op.materialized)) stack.push(...op.materialized);
  }
  return false;
}

interface Prepared {
  readonly artifact: Experience;
  readonly type: string;
  readonly payload: (ref: ContentRef) => unknown;
}

function checkGenesis(ops: readonly RecordedOperation[]): Finding | undefined {
  return ops.length === 0
    ? undefined
    : {
        code: "ops-on-genesis",
        severity: "error",
        message:
          "the first version of a line has no parent to replay ops from; compose on top of it",
      };
}

function sealed_(
  exp: Experience
): { ok: true; value: Experience } | { ok: false; refusal: Refusal } {
  try {
    return { ok: true, value: seal(exp) };
  } catch (err) {
    return refused("artifact-unhashable", `the artifact cannot be hashed: ${msg(err)}`);
  }
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A `Refusal` that is not `refused` cannot come out of a read; keeps the narrowing total. */
function unreachable(): Finding {
  return {
    code: "lineage-internal",
    severity: "error",
    message: "unexpected refusal kind on a read",
  };
}
