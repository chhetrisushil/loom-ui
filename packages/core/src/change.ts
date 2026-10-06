import type { DataClass } from "@loom/classify";
import { effectiveClasses } from "./classes";
import type { Experience } from "./experience";
import { type ExperienceNode, walk } from "./node";
import type { Operation, RecordedOperation } from "./operations";
import { type ProjectionCatalog, planProjectionBindings } from "./projections";
import { type Viewer, mayView, strictestClass } from "./viewer";

// ── What changed between two versions, for a viewer ───────────────────────────
// `describeChange(prev, next)` answers "what is different, in words an app can show" from the two
// artifacts alone (and, when the caller has them, the ops that produced `next`). It is PURE and
// DETERMINISTIC: the same inputs give the same description, in a fixed order, bounded in size.
//
// VIEWER-SAFE, FAIL-CLOSED. A description is for ONE viewer. Any node, provider, or intent whose
// data class the viewer may not see (in EITHER version: a node that became classified is as
// restricted as one that was) is never named. Every change touching such content collapses into
// ONE `restricted-changed` entry that carries no id, no type, no handle, no kind-of-change and no
// count: so the description of "a restricted node was edited" and "a different restricted node
// was removed" are byte-identical, and the output is no oracle for what the restricted part is or
// how many parts there are. No viewer = a viewer with no clearance (as `compile`). The identity
// report and the attention level are derived from the already-redacted description, so a
// host-supplied classifier can never see what the viewer may not.
//
// The summary a planner wrote is MODEL TEXT: it rides as `UntrustedText` (bounded, stripped of
// control and bidi characters, tagged `untrusted: true`), is never an instruction, and is written
// from the WHOLE experience (not the diff), so it may name anything either version holds. It is
// shown iff the viewer may see the strictest class of EVERYTHING either version carries (the
// "class floor": every node, effective class, tool class, projection class, both intents) AND of
// whatever the planner read (`summaryClass`, stamped by the host at compose); it is dropped
// whenever restricted content changed or any projection node is hidden from everyone.
//
// PROJECTIONS follow `compile`: which exist is the host's fact, so the caller passes the same
// `ProjectionCatalog`. No catalogue, an unknown id, or a version pin that drifted = the node is
// hidden (a restricted change when it changed), never shown by default.

/** Attention levels, weakest first. Generic: an app maps them to a badge, a toast, a page. */
export const ATTENTION_LEVELS = ["none", "info", "attention", "urgent"] as const;
export type Attention = (typeof ATTENTION_LEVELS)[number];

export const CHANGE_KINDS = [
  "node-added",
  "node-removed",
  "node-moved",
  "node-rebound",
  "node-reclassified",
  "node-edited",
  "provider-added",
  "provider-removed",
  "provider-changed",
  "intent-changed",
  "restricted-changed",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** One described change. `restricted-changed` carries NO other field. */
export interface ChangeEntry {
  readonly kind: ChangeKind;
  /** A node id (`node-*` kinds). */
  readonly nodeId?: string;
  /** A provider handle (`provider-*` kinds). */
  readonly handle?: string;
  /** The catalogue type of an added or removed semantic node (a container has none). */
  readonly type?: string;
}

/** Text a model (or any untrusted writer) produced. Display it as text; never act on it. */
export interface UntrustedText {
  readonly untrusted: true;
  readonly text: string;
}

export const MAX_SUMMARY_LENGTH = 600;
export const DEFAULT_MAX_ENTRIES = 50;
export const MAX_ENTRIES_CAP = 500;

// C0/C1 controls (newlines included), DEL, and the bidi-override/isolate and zero-width marks that
// reorder or hide text in a UI.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g;

/**
 * Bound untrusted text for display and storage: control and bidi characters become one space,
 * whitespace collapses, the result is cut to {@link MAX_SUMMARY_LENGTH} code points (an ellipsis
 * marks a cut). Total: a non-string is the empty string. Returns undefined for an empty result.
 */
export function boundSummary(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const clean = text
    .slice(0, MAX_SUMMARY_LENGTH * 8)
    .replace(UNSAFE_TEXT, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean === "") return undefined;
  const points = [...clean];
  return points.length <= MAX_SUMMARY_LENGTH
    ? clean
    : `${points.slice(0, MAX_SUMMARY_LENGTH - 1).join("")}…`;
}

/** Wrap bounded text as untrusted; undefined when there is nothing to show. */
export function untrustedSummary(text: unknown): UntrustedText | undefined {
  const bounded = boundSummary(text);
  return bounded === undefined ? undefined : { untrusted: true, text: bounded };
}

export interface ChangeDescription {
  readonly from: string | null;
  readonly to: string;
  /** Visible changes in a fixed order (kind, then id), at most `maxEntries`. */
  readonly entries: readonly ChangeEntry[];
  /** Visible changes beyond the bound. */
  readonly omitted: number;
  /** Anything this viewer may not see changed (also the single `restricted-changed` entry). */
  readonly restricted: boolean;
  /** Node ids over the VISIBLE nodes only: how many of the previous ones survive, which are new. */
  readonly identity: {
    readonly compared: number;
    readonly dropped: readonly string[];
    readonly added: readonly string[];
  };
  readonly attention: Attention;
  /** Only when `ops` were supplied: whether a prompt produced the change. */
  readonly origin?: "prompt" | "edit";
  /** Present only when no restricted content changed. Untrusted model text. */
  readonly summary?: UntrustedText;
}

export interface DescribeOptions {
  /** Who the description is for. Absent = no clearance (fail-closed). */
  readonly viewer?: Viewer;
  /** The ops that produced `next` from `prev`, when the caller has them. */
  readonly ops?: readonly RecordedOperation[];
  /** The planner's summary (untrusted; bounded here). */
  readonly summary?: string;
  /** Host classifier over the REDACTED description. Default {@link defaultAttention}. */
  readonly classify?: (description: Omit<ChangeDescription, "attention">) => Attention;
  /** Cap on entries returned (default 50, hard cap 500). */
  readonly maxEntries?: number;
  /**
   * The projections the host offers: the SAME catalogue `compile` takes. Absent = offers nothing,
   * so every projection-bound node is hidden (fail-closed); an id it does not list, or a pinned
   * version that differs, hides the node too. Its classes can only raise a node's own.
   */
  readonly projections?: ProjectionCatalog;
  /** The host's hydration projection id (reserved: a node binding it through `projection` is hidden). */
  readonly hydrationProjectionId?: string;
  /**
   * The strictest class of everything the planner read to write `summary` (host-stamped at compose;
   * see `ComposedPayload.summaryClass`). Absent = the summary is judged by the class floor alone.
   */
  readonly summaryClass?: DataClass;
}

const KIND_ATTENTION: Record<ChangeKind, Attention> = {
  "node-added": "attention",
  "node-removed": "attention",
  "node-moved": "info",
  "node-rebound": "attention",
  "node-reclassified": "attention",
  "node-edited": "info",
  "provider-added": "attention",
  "provider-removed": "attention",
  "provider-changed": "attention",
  "intent-changed": "attention",
  "restricted-changed": "info",
};

const levelOf = (a: Attention): number => ATTENTION_LEVELS.indexOf(a);

/** No change = none; otherwise the strongest level any visible change maps to. */
export function defaultAttention(d: Omit<ChangeDescription, "attention">): Attention {
  let best: Attention = "none";
  for (const e of d.entries)
    if (levelOf(KIND_ATTENTION[e.kind]) > levelOf(best)) best = KIND_ATTENTION[e.kind];
  if (d.restricted && levelOf(best) < levelOf("info")) best = "info";
  if (d.omitted > 0 && levelOf(best) < levelOf("attention")) best = "attention";
  return best;
}

const own = <V>(rec: Readonly<Record<string, V>> | undefined, key: string): V | undefined =>
  rec !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;

/** Canonical JSON: keys sorted, `undefined` dropped. Depth-bounded so a hostile value cannot blow the stack. */
function canon(value: unknown, depth = 0): string {
  if (depth > 64) return '"…"';
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canon(v, depth + 1)).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(o[k], depth + 1)}`).join(",")}}`;
}

interface NodeView {
  readonly node: ExperienceNode;
  readonly parentId: string | null;
  /** The strictest class this node's data carries in its version. */
  readonly cls: DataClass | undefined;
  /** Hidden from EVERY viewer: a projection the host does not offer (or offers at another version). */
  readonly blocked: boolean;
}

const NO_HYDRATION = "\u0000";

function nodesOf(exp: Experience, opts: DescribeOptions) {
  const classes = effectiveClasses(exp);
  const refused = planProjectionBindings(
    exp,
    opts.projections,
    opts.hydrationProjectionId ?? NO_HYDRATION,
    undefined
  ).verdicts;
  const out = new Map<string, NodeView>();
  let floor: DataClass | undefined;
  let anyBlocked = false;
  walk(exp.root, (node, parent) => {
    let cls: DataClass | undefined;
    let blocked = false;
    if (node.kind === "semantic") {
      if (node.binding !== undefined)
        cls = strictestClass(node.binding.sensitivity, classes.get(node.binding.handle));
      if (node.projection !== undefined) {
        cls = strictestClass(
          cls,
          strictestClass(
            node.projection.sensitivity,
            own(exp.projectionClasses, node.projection.id)
          )
        );
        const offered = (opts.projections ?? []).filter((d) => d.id === node.projection?.id);
        const known =
          offered.length > 0 && offered.every((d) => d.version === node.projection?.version);
        if (!known || refused.get(node.id)?.kind === "refused") blocked = true;
        for (const d of offered) cls = strictestClass(cls, d.sensitivity);
      }
    }
    if (blocked) anyBlocked = true;
    floor = strictestClass(floor, cls);
    out.set(node.id, { node, parentId: parent?.id ?? null, cls, blocked });
  });
  for (const c of classes.values()) floor = strictestClass(floor, c);
  for (const c of Object.values(exp.toolClasses ?? {})) floor = strictestClass(floor, c);
  for (const c of Object.values(exp.handleClasses ?? {})) floor = strictestClass(floor, c);
  for (const c of Object.values(exp.projectionClasses ?? {})) floor = strictestClass(floor, c);
  floor = strictestClass(floor, exp.intent?.sensitivity);
  return { nodes: out, classes, floor, anyBlocked };
}

/** What is not a node's identity-or-placement: everything an edit may change. */
const placementKey = (n: ExperienceNode): string => canon([n.order, n.row, n.rowSpan, n.column]);
const bindingKey = (n: ExperienceNode): string =>
  n.kind === "semantic"
    ? canon([
        n.binding?.handle,
        n.projection?.id,
        n.projection?.path,
        n.projection?.statusPath,
        n.projection?.version,
      ])
    : "";
const classKey = (v: NodeView): string =>
  canon([
    v.cls,
    v.node.kind === "semantic"
      ? [v.node.binding?.sensitivity, v.node.projection?.sensitivity]
      : null,
  ]);
/** Everything else on a node (children excluded: they are nodes of their own). */
function contentKey(n: ExperienceNode): string {
  if (n.kind === "container") return canon([n.direction, n.span, n.title, n.role, n.gap]);
  return canon([n.type, n.typeVersion, n.span, n.label, n.props, n.binding?.priority]);
}

/**
 * The strictest class anything in `exp` carries: every node, effective handle class, tool class,
 * projection class and the intent. What a summary written from the whole experience may reveal.
 * Total: an unreadable experience has no readable floor, so it returns `"secret"` (fail-closed).
 */
export function experienceClassFloor(
  exp: Experience,
  projections?: ProjectionCatalog
): DataClass | undefined {
  try {
    return nodesOf(exp, projections === undefined ? {} : { projections }).floor;
  } catch {
    return "secret";
  }
}

const KIND_ORDER = new Map(CHANGE_KINDS.map((k, i) => [k, i]));
const cmp = (a: string | undefined, b: string | undefined): number =>
  (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;

/**
 * Describe what changed from `prev` (null for a first version) to `next`, for `opts.viewer`.
 * Never throws: an input it cannot read is reported as a restricted change (fail-closed).
 */
export function describeChange(
  prev: Experience | null,
  next: Experience,
  opts: DescribeOptions = {}
): ChangeDescription {
  const maxEntries = Math.max(
    0,
    Math.min(
      MAX_ENTRIES_CAP,
      Number.isInteger(opts.maxEntries) ? (opts.maxEntries as number) : DEFAULT_MAX_ENTRIES
    )
  );
  let from: string | null = null;
  let to = "";
  try {
    from = prev?.versionHash ?? null;
    to = next.versionHash;
  } catch {
    // unreadable: the description below is already a restricted one
  }
  let floor: DataClass | undefined;
  let blockedAny = false;
  const entries: ChangeEntry[] = [];
  let restricted = false;
  let compared = 0;
  const dropped: string[] = [];
  const added: string[] = [];
  const seeable = (c: DataClass | undefined): boolean => mayView(opts.viewer, c);
  try {
    const a = prev === null ? null : nodesOf(prev, opts);
    const b = nodesOf(next, opts);
    floor = strictestClass(a?.floor, b.floor);
    blockedAny = (a?.anyBlocked ?? false) || b.anyBlocked;
    const seeableNode = (v: NodeView | undefined): boolean =>
      v === undefined || (!v.blocked && seeable(v.cls));
    // A node is restricted when ANY version of it is: a declassified one must not be named either
    // (its previous content was never the viewer's), nor one that became classified.
    const hidden = (id: string): boolean => {
      const x = a?.nodes.get(id);
      const y = b.nodes.get(id);
      return !seeableNode(x) || !seeableNode(y);
    };
    const touched = new Set<string>();
    for (const id of a?.nodes.keys() ?? []) touched.add(id);
    for (const id of b.nodes.keys()) touched.add(id);
    const hiddenIds = new Set([...touched].filter(hidden));

    const push = (e: ChangeEntry) => entries.push(e);
    for (const [id, y] of b.nodes) {
      if (hiddenIds.has(id)) {
        const x = a?.nodes.get(id);
        if (x === undefined || nodeDiffers(x, y)) restricted = true;
        continue;
      }
      const x = a?.nodes.get(id);
      if (x === undefined) {
        added.push(id);
        push({
          kind: "node-added",
          nodeId: id,
          ...(y.node.kind === "semantic" && { type: y.node.type }),
        });
        continue;
      }
      compared += 1;
      if (x.parentId !== y.parentId || placementKey(x.node) !== placementKey(y.node))
        push({ kind: "node-moved", nodeId: id });
      if (bindingKey(x.node) !== bindingKey(y.node)) push({ kind: "node-rebound", nodeId: id });
      if (classKey(x) !== classKey(y)) push({ kind: "node-reclassified", nodeId: id });
      if (contentKey(x.node) !== contentKey(y.node)) push({ kind: "node-edited", nodeId: id });
    }
    for (const [id, x] of a?.nodes ?? []) {
      if (b.nodes.has(id)) continue;
      if (hiddenIds.has(id)) {
        restricted = true;
        continue;
      }
      dropped.push(id);
      push({
        kind: "node-removed",
        nodeId: id,
        ...(x.node.kind === "semantic" && { type: x.node.type }),
      });
    }
    compared += dropped.length;

    // Providers: a handle's class is the effective class in either version.
    const handles = new Set([
      ...Object.keys(prev?.providers ?? {}),
      ...Object.keys(next.providers),
    ]);
    for (const h of handles) {
      const before = own(prev?.providers, h);
      const after = own(next.providers, h);
      const cls = strictestClass(a?.classes.get(h), b.classes.get(h));
      const changed = before === undefined || after === undefined || canon(before) !== canon(after);
      if (!changed) continue;
      if (!seeable(cls)) {
        restricted = true;
        continue;
      }
      push({
        kind:
          before === undefined
            ? "provider-added"
            : after === undefined
              ? "provider-removed"
              : "provider-changed",
        handle: h,
      });
    }

    if (prev !== null && canon(prev.intent) !== canon(next.intent)) {
      if (!seeable(prev.intent.sensitivity) || !seeable(next.intent.sensitivity)) restricted = true;
      else push({ kind: "intent-changed" });
    }
  } catch {
    // Unreadable input: say nothing specific, and never say it was a clean no-op.
    entries.length = 0;
    restricted = true;
    blockedAny = true;
    dropped.length = 0;
    added.length = 0;
    compared = 0;
  }

  entries.sort(
    (x, y) =>
      (KIND_ORDER.get(x.kind) as number) - (KIND_ORDER.get(y.kind) as number) ||
      cmp(x.nodeId ?? x.handle, y.nodeId ?? y.handle)
  );
  dropped.sort(cmp);
  added.sort(cmp);
  const visible = entries.slice(0, maxEntries);
  if (restricted) visible.push({ kind: "restricted-changed" });
  // The summary was written from the WHOLE experience, so it is judged against everything either
  // version holds (the floor) and whatever the planner read, not against this diff.
  const summaryOk =
    !restricted && !blockedAny && mayView(opts.viewer, strictestClass(floor, opts.summaryClass));
  const said = summaryOk ? untrustedSummary(opts.summary) : undefined;
  const origin = originOf(opts.ops, visible.length > 0 && !(visible.length === 1 && restricted));
  const base: Omit<ChangeDescription, "attention"> = {
    from,
    to,
    entries: visible,
    omitted: Math.max(0, entries.length - maxEntries),
    restricted,
    identity: { compared, dropped, added },
    ...(origin !== undefined && { origin }),
    ...(said !== undefined && { summary: said }),
  };
  let attention: Attention = defaultAttention(base);
  if (opts.classify !== undefined) {
    try {
      // A frozen deep copy: the hook cannot mutate what is returned, nor see a shared reference.
      const chosen = opts.classify(deepFreeze(structuredClone(base)));
      if (ATTENTION_LEVELS.includes(chosen)) attention = chosen;
    } catch {
      // a throwing classifier falls back to the default: a change is never lost to a bad hook
    }
  }
  return { ...base, attention };
}

/** `prompt` when any op is one, else `edit`; undefined when no ops were given, none can be read, or nothing visible changed. */
function originOf(ops: DescribeOptions["ops"], anyVisible: boolean): "prompt" | "edit" | undefined {
  if (ops === undefined || !anyVisible) return undefined;
  try {
    if (!Array.isArray(ops)) return undefined;
    return ops.some((r) => (r?.op as Operation | undefined)?.type === "prompt") ? "prompt" : "edit";
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

function nodeDiffers(x: NodeView, y: NodeView): boolean {
  return (
    x.parentId !== y.parentId ||
    placementKey(x.node) !== placementKey(y.node) ||
    bindingKey(x.node) !== bindingKey(y.node) ||
    classKey(x) !== classKey(y) ||
    contentKey(x.node) !== contentKey(y.node)
  );
}
