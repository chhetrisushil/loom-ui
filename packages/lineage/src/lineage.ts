import {
  type ApplyOptions,
  type Experience,
  type ExplainOptions,
  type Finding,
  type NodeExplanation,
  type ProjectionCatalog,
  type Provenance,
  type ProvenanceLedger,
  Provenance as ProvenanceSchema,
  type RecordedOperation,
  Sensitivity,
  type VersionNote,
  type Viewer,
  apply,
  applyAt,
  boundSummary,
  emptyLedger,
  experienceClassFloor,
  explainNode,
  foldProvenance,
  replay,
} from "@loom-ui/core";
import { getExperience, putExperience, seal } from "@loom-ui/core/log";
import type { ContentRef, ContentStore } from "@loom/plugin-content";
import { authorOf, branchArtifact, revertArtifact } from "./derive";
import {
  EXPERIENCE_BRANCHED,
  EXPERIENCE_COMPOSED,
  EXPERIENCE_PROMOTED,
  EXPERIENCE_REVERTED,
  type SummaryClass,
} from "./events";
import { type LineageState, type VersionRecord, foldLineage, payloadRefusal } from "./state";
import { InMemoryLineageStore, LINEAGE_STREAM_PREFIX, type LineageStore } from "./store";

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
}

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

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

export class Lineage {
  private readonly events: LineageStore;
  private readonly content: ContentStore;
  private readonly now: () => string;

  constructor(opts: LineageOptions) {
    this.events = opts.events;
    this.content = opts.content;
    this.now = opts.now ?? (() => new Date().toISOString());
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
    for await (const id of this.events.listStreams())
      for (const rec of await this.events.read(id)) walkContentRefs(rec.payload, visit);
  }

  // ── reads ───────────────────────────────────────────────────────────────────

  /** The folded state of a line (empty state for an unknown one). A malformed log is a finding. */
  async state(experienceId: string): Promise<LineageResult<LineageState>> {
    const fold = foldLineage(experienceId, await this.events.read(experienceId));
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
    const r = await getExperience(this.content, v.ref as ContentRef);
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
      readonly versionHash?: string;
      readonly projections?: ProjectionCatalog;
      readonly hydrationProjectionId?: string;
    } = {}
  ): Promise<LineageResult<NodeExplanation>> {
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
      ...(opts.projections !== undefined && { projections: opts.projections }),
      ...(opts.hydrationProjectionId !== undefined && {
        hydrationProjectionId: opts.hydrationProjectionId,
      }),
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
        extraFloor = art.ok ? experienceClassFloor(art.value, opts.projections) : "secret";
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
    return this.commit(experienceId, null, async () => {
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
      const out = await this.events.append(experienceId, s.value.sequence, {
        type: EXPERIENCE_PROMOTED,
        at: this.now(),
        payload: promotedPayload,
      });
      if (out.ok) return { ok: true, value: { promoted: versionHash, sequence: out.sequence } };
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
    const put = await putExperience(this.content, artifact);
    if (!put.ok) return fromFinding(put.finding);
    for (let attempt = 0; attempt < MAX_TIP_RETRIES; attempt++) {
      const out = await this.events.append(experienceId, s.value.sequence, {
        type,
        at: this.now(),
        payload: payload(put.ref),
      });
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
const VERIFY_APPLY: ApplyOptions = { allowDeclassify: true };

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
