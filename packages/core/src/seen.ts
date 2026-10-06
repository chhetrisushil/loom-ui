import type { DataClass } from "@loom/classify";
import { type ExperienceInspection, boundSummary, inspectExperience } from "./change";
import type { Experience } from "./experience";
import { walk } from "./node";
import type { ProjectionCatalog } from "./projections";
import { type Viewer, mayView, strictestClass } from "./viewer";

// ── What a viewer SAW (U12) ───────────────────────────────────────────────────
// A version is replayable by its ops, but a surface is the version PLUS the data hydrated into it,
// and the data is not in the log: two viewers (or one viewer a minute apart) of the same version see
// different numbers. `snapshotSeen` captures the values a viewer was actually shown, bounded and
// CLASSIFIED, so "what did they see when they approved this?" has an answer.
//
//   - only sources bound by nodes the viewer may see are read at all (the host's `read` is never
//     asked for a restricted one), and the snapshot says only that SOMETHING was restricted — no
//     count, no name;
//   - every entry carries the class it was captured under (`class`), stamped from the experience at
//     capture time: a stamp that is missing or not a known class is WITHHELD on read, never shown;
//   - a value over its byte cap is not stored (its entry says `oversize`), the whole snapshot has a
//     byte budget and a source cap, so a hostile or huge value cannot grow the record without bound;
//   - the record holds JSON values only (a value that is not JSON-safe is `unreadable`).
//
// `redactSeen` is the read-side half: it re-derives each entry's class from the artifact the record
// names and takes the STRICTER of the stamp and the artifact, so a record can never be read at a
// lower class than the experience now says its data carries.

export const MAX_SEEN_SOURCES = 256;
export const MAX_SEEN_VALUE_BYTES = 16 * 1024;
export const MAX_SEEN_TOTAL_BYTES = 512 * 1024;
export const MAX_SEEN_NODE_IDS = 64;
const MAX_STATUS = 64;

/** What a node reads its data from, in the terms the host's store already uses. */
export type SeenSource =
  | { readonly kind: "handle"; readonly handle: string }
  | {
      readonly kind: "projection";
      readonly id: string;
      readonly path: string;
      readonly version: string;
    };

export type SeenClass = DataClass | "unclassified";
export const SEEN_CLASSES: readonly SeenClass[] = [
  "secret",
  "sensitive",
  "internal",
  "unclassified",
];

/**
 * - `seen`: `value` is what the viewer was shown.
 * - `absent`: nothing was delivered (still pending, errored, or the source has no value); `status` says what the host knew.
 * - `oversize`: the value was over `MAX_SEEN_VALUE_BYTES` and is not kept.
 * - `over-budget`: the snapshot's total byte budget was already spent.
 * - `unreadable`: the value is not JSON-safe (a cycle, a bigint, a throwing getter).
 * - `corrupt`: a READ-side state, never recorded: the stored bytes no longer hash to the content
 *   address the manifest names, so they are not shown (the fact of the view stands, the value does not).
 */
export type SeenState = "seen" | "absent" | "oversize" | "over-budget" | "unreadable" | "corrupt";

export interface SeenEntry {
  readonly source: SeenSource;
  /** The viewable nodes that read this source (at most `MAX_SEEN_NODE_IDS`). */
  readonly nodeIds: readonly string[];
  readonly class: SeenClass;
  readonly state: SeenState;
  /** The host's delivery state for the source (`ready`, `pending`, `error`...), bounded. */
  readonly status?: string;
  /** Present only when `state` is `seen`. */
  readonly value?: unknown;
  /** The UTF-8 size of `value` as JSON, when it was measured. */
  readonly bytes?: number;
}

export interface SeenSnapshot {
  readonly experienceId: string;
  /** The version the viewer was looking at. */
  readonly versionHash: string;
  readonly entries: readonly SeenEntry[];
  /** Sources beyond `MAX_SEEN_SOURCES` that were not captured. */
  readonly omitted: number;
  /** A node bound to data this viewer may not see exists. Says nothing about which, or how many. */
  readonly restricted: boolean;
}

/** What the host's store holds for one source. `found: false` = nothing delivered. */
export interface SeenReading {
  readonly found: boolean;
  readonly value?: unknown;
  readonly status?: string;
}
export type SeenReader = (source: SeenSource) => SeenReading | undefined;

export interface SnapshotOptions {
  /** Who was shown the surface. Absent = no clearance (fail-closed). */
  readonly viewer?: Viewer;
  /** Reads what was delivered for a source. Called ONLY for sources the viewer may see. */
  readonly read: SeenReader;
  readonly projections?: ProjectionCatalog;
  readonly hydrationProjectionId?: string;
}

const sourceKey = (s: SeenSource): string =>
  s.kind === "handle" ? `h\u0000${s.handle}` : `p\u0000${s.id}\u0000${s.path}\u0000${s.version}`;

/** The source a semantic node reads its data from, or undefined for a static node. */
function sourceOfNode(n: {
  readonly kind: string;
  readonly binding?: { readonly handle: string };
  readonly projection?: { readonly id: string; readonly path: string; readonly version: string };
}): SeenSource | undefined {
  if (n.kind !== "semantic") return undefined;
  if (n.binding !== undefined) return { kind: "handle", handle: n.binding.handle };
  if (n.projection !== undefined)
    return {
      kind: "projection",
      id: n.projection.id,
      path: n.projection.path,
      version: n.projection.version,
    };
  return undefined;
}

/** The key of an UNTRUSTED source (a stored entry's), or undefined when it is not well formed. */
function sourceKeyOf(s: unknown): string | undefined {
  const o = s as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null) return undefined;
  if (o.kind === "handle" && typeof o.handle === "string") return `h\u0000${o.handle}`;
  if (
    o.kind === "projection" &&
    typeof o.id === "string" &&
    typeof o.path === "string" &&
    typeof o.version === "string"
  )
    return `p\u0000${o.id}\u0000${o.path}\u0000${o.version}`;
  return undefined;
}

const encoder = new TextEncoder();

/** A detached JSON copy of `value` and its UTF-8 size, or undefined when it is not JSON-safe. */
function measure(value: unknown): { json: string; bytes: number } | undefined {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    return { json, bytes: encoder.encode(json).length };
  } catch {
    return undefined;
  }
}

/** Bounded, control- and bidi-stripped (`boundSummary`), then cut to a status-sized string. */
const cleanStatus = (s: unknown): string | undefined => boundSummary(s)?.slice(0, MAX_STATUS);

/**
 * Capture what `opts.read` delivered for every data source a viewer-visible node of `exp` binds.
 * Pure given `read`; total (a `read` that throws makes that source `unreadable`).
 */
export function snapshotSeen(exp: Experience, opts: SnapshotOptions): SeenSnapshot {
  const inspected = inspectExperience(exp, opts);
  if (!inspected.readable)
    return {
      experienceId: exp.experienceId,
      versionHash: exp.versionHash,
      entries: [],
      omitted: 0,
      restricted: true,
    };
  type Acc = { source: SeenSource; nodeIds: string[]; cls: DataClass | undefined };
  const sources = new Map<string, Acc>();
  let restricted = false;
  walk(exp.root, (n) => {
    if (n.kind !== "semantic") return;
    const source = sourceOfNode(n);
    if (source === undefined) return;
    const view = inspected.nodes.get(n.id);
    if (view === undefined || view.blocked || !mayView(opts.viewer, view.cls)) {
      restricted = true;
      return;
    }
    const k = sourceKey(source);
    const cur = sources.get(k);
    if (cur === undefined) sources.set(k, { source, nodeIds: [n.id], cls: view.cls });
    else {
      if (cur.nodeIds.length < MAX_SEEN_NODE_IDS) cur.nodeIds.push(n.id);
      cur.cls = strictestClass(cur.cls, view.cls);
    }
  });

  const ordered = [...sources.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const entries: SeenEntry[] = [];
  let spent = 0;
  for (const [, acc] of ordered.slice(0, MAX_SEEN_SOURCES)) {
    const base = {
      source: acc.source,
      nodeIds: acc.nodeIds,
      class: (acc.cls ?? "unclassified") as SeenClass,
    };
    let reading: SeenReading | undefined;
    try {
      reading = opts.read(acc.source);
    } catch {
      entries.push({ ...base, state: "unreadable" });
      continue;
    }
    const status = cleanStatus(reading?.status);
    const withStatus = status === undefined ? {} : { status };
    if (reading === undefined || reading.found !== true) {
      entries.push({ ...base, state: "absent", ...withStatus });
      continue;
    }
    const m = measure(reading.value);
    if (m === undefined) {
      entries.push({ ...base, state: "unreadable", ...withStatus });
      continue;
    }
    if (m.bytes > MAX_SEEN_VALUE_BYTES) {
      entries.push({ ...base, state: "oversize", bytes: m.bytes, ...withStatus });
      continue;
    }
    if (spent + m.bytes > MAX_SEEN_TOTAL_BYTES) {
      entries.push({ ...base, state: "over-budget", bytes: m.bytes, ...withStatus });
      continue;
    }
    spent += m.bytes;
    entries.push({
      ...base,
      state: "seen",
      value: JSON.parse(m.json) as unknown,
      bytes: m.bytes,
      ...withStatus,
    });
  }
  return {
    experienceId: exp.experienceId,
    versionHash: exp.versionHash,
    entries,
    omitted: Math.max(0, ordered.length - MAX_SEEN_SOURCES),
    restricted,
  };
}

export interface RedactedSeen {
  readonly entries: readonly SeenEntry[];
  /** Some entry was withheld (its class, a missing artifact, an unreadable stamp): no count, no name. */
  readonly restricted: boolean;
  /** For each kept entry, its position in the input list (so a caller can carry side data by index). */
  readonly indexes: readonly number[];
}

/**
 * The entries of a STORED record a viewer may be shown. `experience` is the artifact the record
 * names (its `versionHash`): each entry's class is re-derived from it and the stricter of that and
 * the stamp governs, so a record is never readable at a class lower than the experience says.
 * FAIL-CLOSED: no artifact, a stamp that is not a known class, a node the artifact does not hold, a
 * node hidden from every viewer, a node that does NOT bind the entry's `source` (an entry is judged
 * by the class of what it actually names, never by a node it merely lists), an entry with no nodes,
 * and a class the viewer may not see all withhold the entry, and the
 * viewer learns only that `restricted` is true. Surviving entries are RESTAMPED with the effective
 * class (the stricter of the stamp and the artifact). Total.
 */
export function redactSeen(
  entries: readonly SeenEntry[],
  experience: Experience | undefined,
  opts: Pick<SnapshotOptions, "viewer" | "projections" | "hydrationProjectionId"> = {}
): RedactedSeen {
  if (experience === undefined || !Array.isArray(entries))
    return { entries: [], restricted: true, indexes: [] };
  let inspected: ExperienceInspection;
  try {
    inspected = inspectExperience(experience, opts);
  } catch {
    return { entries: [], restricted: true, indexes: [] };
  }
  if (!inspected.readable) return { entries: [], restricted: true, indexes: [] };
  // What each node of the artifact really binds. A duplicated node id is ambiguous: bound to nothing.
  const bound = new Map<string, string | null>();
  walk(experience.root, (n) => {
    const src = sourceOfNode(n);
    const k = src === undefined ? null : sourceKey(src);
    bound.set(n.id, bound.has(n.id) ? null : k);
  });
  const out: SeenEntry[] = [];
  const indexes: number[] = [];
  let restricted = false;
  for (const [index, e] of entries.entries()) {
    try {
      const stamp = (e as { class?: unknown } | null)?.class;
      if (typeof stamp !== "string" || !SEEN_CLASSES.includes(stamp as SeenClass)) {
        restricted = true;
        continue;
      }
      let cls: DataClass | undefined = stamp === "unclassified" ? undefined : (stamp as DataClass);
      const want = sourceKeyOf(e.source);
      let known = want !== undefined && Array.isArray(e.nodeIds) && e.nodeIds.length > 0;
      for (const id of known && Array.isArray(e.nodeIds) ? e.nodeIds : []) {
        const v = inspected.nodes.get(id);
        if (v === undefined || v.blocked || bound.get(id) !== want) {
          known = false;
          break;
        }
        cls = strictestClass(cls, v.cls);
      }
      if (!known || !mayView(opts.viewer, cls)) {
        restricted = true;
        continue;
      }
      // Restamped to the effective class, so a stored stamp can only ever be raised by a read.
      out.push({ ...e, class: (cls ?? "unclassified") as SeenClass });
      indexes.push(index);
    } catch {
      restricted = true;
    }
  }
  return { entries: out, restricted, indexes };
}

/**
 * The hydration-store shape of what was seen, for replaying a surface as it was shown:
 * `values.<handle>` and `status.<handle>` for handle sources (the keys `compile` binds), and the
 * projection id → path → value for projection sources. Only entries that were `seen` carry a value.
 */
export function seenToState(entries: readonly SeenEntry[]): {
  values: Record<string, unknown>;
  status: Record<string, string>;
  projections: Array<{ id: string; path: string; version: string; value: unknown }>;
} {
  const values: Record<string, unknown> = Object.create(null);
  const status: Record<string, string> = Object.create(null);
  const projections: Array<{ id: string; path: string; version: string; value: unknown }> = [];
  for (const e of entries) {
    if (e.source.kind === "handle") {
      if (e.state === "seen") values[e.source.handle] = e.value;
      if (e.status !== undefined) status[e.source.handle] = e.status;
    } else if (e.state === "seen")
      projections.push({
        id: e.source.id,
        path: e.source.path,
        version: e.source.version,
        value: e.value,
      });
  }
  return { values, status, projections };
}
