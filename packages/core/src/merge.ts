import { canonicalJson } from "@loom/core";
import { carryClasses } from "./classes";
import type { Experience, ProviderSpec } from "./experience";
import {
  type ContainerNode,
  type ExperienceNode,
  MAX_TREE_DEPTH,
  compareByOrder,
  isContainer,
  treeDepth,
} from "./node";

// ── The three-way merge of Experiences ───────────────────────────────────────────────────────────
// `mergeExperiences(base, ours, theirs)` joins two lines of edits that both started at `base`.
// Pure and deterministic: no clock, no randomness, no I/O, and it never throws on a well-typed
// input — a defect is a CONFLICT in the result. It always returns a usable partial: where the two
// sides disagree, OURS wins, and the disagreement is listed so a person or an agent can resolve it.
//
// What it merges, by plane:
//  - LAYOUT: a three-way ordered-tree merge on stable node ids. A node is merged on three
//    independent dimensions (its parent, its sibling order key, its own content), so one side
//    moving a node and the other editing it is clean.
//  - PROVIDERS: a keyed union by handle; a provider is ATOMIC (its execution graph lives inside
//    its spec, so there is no step-level merge to get wrong).
//  - CLASSES: `handleClasses` / `toolClasses` / `projectionClasses` are sticky and only ever
//    rise, so the merge keeps the strictest of everything either side (or the base) ever carried.
//  - VOCABULARY FLOOR: the union of the types either side requires.
//  - INTENT: no operation changes it, so it is merged three-way and a real disagreement is a
//    conflict.
//  - LOCALIZATION KEYS: two branches give the SAME key different text from DIFFERENT nodes. No
//    node id collides and every plane above merges cleanly, yet the result has one key meaning
//    two things. That is the one conflict a structural merge cannot see, so it is checked here.
//
// The result is UNSEALED: `versionHash` is "" and `parents` is [] — the caller decides what the
// merge commit's parents are (normally the two heads) and seals it.

export type MergeConflictKind =
  | "move/move" // the same node reparented, or reordered, differently on both sides
  | "remove/edit" // removed on one side, edited (or moved) on the other
  | "edit/edit" // a node's own content changed differently on both sides
  | "add/add" // the same id added with different content (or parent) on both sides
  | "orphan" // a survivor cannot be placed: its parent did not survive, or a move made a cycle
  | "provider/provider" // the same handle's spec changed differently on both sides
  | "message/message" // one localization key given different text by each side
  | "intent/intent" // the two sides disagree about the experience's intent
  | "depth"; // a tree (or the merged tree) nests past MAX_TREE_DEPTH

export interface MergeConflict {
  readonly plane: "layout" | "provider" | "intent";
  readonly kind: MergeConflictKind;
  /** The node id, provider handle or localization key in conflict; "" for a whole-tree condition. */
  readonly ref: string;
  readonly detail: string;
}

export interface MergeResult {
  /** The ours-biased merge, unsealed (`versionHash: ""`, `parents: []`). Always returned. */
  readonly experience: Experience;
  /** Empty when the merge is clean. Deterministic order: layout, providers, intent, keys. */
  readonly conflicts: readonly MergeConflict[];
}

/** A node's own fields: everything except where it sits (`id`, `order`, parent, `children`). */
function contentOf(node: ExperienceNode): string {
  const {
    id: _id,
    order: _order,
    children: _children,
    ...rest
  } = node as unknown as Record<string, unknown>;
  return canonicalJson(rest);
}

interface Flat {
  parentId: string | null;
  order: string;
  content: string;
  node: ExperienceNode;
}

/** id → place + content, by an explicit stack (no recursion, so depth is not a stack concern). */
function flatten(root: ExperienceNode): Map<string, Flat> {
  const out = new Map<string, Flat>();
  const stack: Array<{ node: ExperienceNode; parentId: string | null }> = [
    { node: root, parentId: null },
  ];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { node, parentId } = top;
    // A repeated id inside one (invalid) tree: the first occurrence wins, deterministically.
    if (!out.has(node.id))
      out.set(node.id, { parentId, order: node.order, content: contentOf(node), node });
    if (isContainer(node))
      for (let i = node.children.length - 1; i >= 0; i--)
        stack.push({ node: node.children[i] as ExperienceNode, parentId: node.id });
  }
  return out;
}

function threeWay<T>(
  base: T | undefined,
  ours: T,
  theirs: T
): { value: T; conflict: boolean; from: "ours" | "theirs" } {
  const oursChanged = base === undefined || base !== ours;
  const theirsChanged = base === undefined || base !== theirs;
  if (!theirsChanged) return { value: ours, conflict: false, from: "ours" };
  if (!oursChanged) return { value: theirs, conflict: false, from: "theirs" };
  if (ours === theirs) return { value: ours, conflict: false, from: "ours" };
  return { value: ours, conflict: true, from: "ours" };
}

interface Survivor {
  parentId: string | null;
  order: string;
  node: ExperienceNode;
}

/**
 * Rebuild a tree from the survivors, iteratively. Returns the root, or why it cannot: the
 * unreachable ids (parent gone, or a cycle two moves made together), a root count other than one,
 * or a depth past the cap.
 */
function unflatten(
  survivors: Map<string, Survivor>,
  rank: Map<string, number>
): { ok: true; root: ExperienceNode } | { ok: false; unreachable: string[]; reason: string } {
  const roots: string[] = [];
  const kids = new Map<string, string[]>();
  for (const [id, s] of survivors) {
    if (s.parentId === null) roots.push(id);
    else {
      const list = kids.get(s.parentId) ?? [];
      list.push(id);
      kids.set(s.parentId, list);
    }
  }
  if (roots.length !== 1)
    return {
      ok: false,
      unreachable: [],
      reason: `the merged tree has ${roots.length} roots, not one`,
    };
  const rootId = roots[0] as string;
  const preorder: string[] = [];
  const seen = new Set<string>();
  const stack: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 1 }];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    if (seen.has(top.id)) continue;
    if (top.depth > MAX_TREE_DEPTH)
      return {
        ok: false,
        unreachable: [],
        reason: `the merged tree nests past ${MAX_TREE_DEPTH} levels`,
      };
    seen.add(top.id);
    preorder.push(top.id);
    for (const k of kids.get(top.id) ?? []) stack.push({ id: k, depth: top.depth + 1 });
  }
  if (seen.size !== survivors.size)
    return {
      ok: false,
      unreachable: [...survivors.keys()].filter((id) => !seen.has(id)).sort(),
      reason: "unreachable from the root",
    };
  const built = new Map<string, ExperienceNode>();
  for (let i = preorder.length - 1; i >= 0; i--) {
    const id = preorder[i] as string;
    const s = survivors.get(id) as Survivor;
    if (!isContainer(s.node)) {
      built.set(id, { ...s.node, order: s.order });
      continue;
    }
    const children = (kids.get(id) ?? [])
      .map((k) => built.get(k) as ExperienceNode)
      // Equal order keys keep the position they had in ours, else theirs, else base — so a side
      // that merges with itself gets itself back, byte for byte, and the tie is never an accident.
      .sort(
        (x, y) => compareByOrder(x, y) || (rank.get(x.id) as number) - (rank.get(y.id) as number)
      );
    built.set(id, { ...s.node, order: s.order, children } as ContainerNode);
  }
  return { ok: true, root: built.get(rootId) as ExperienceNode };
}

// ── Localization key conflicts ───────────────────────────────────────────────────────────────────

export interface KeyConflict {
  readonly key: string;
  /** The text each side gave it, and the node it came from. */
  readonly sides: readonly { nodeId: string; message: string; from: "ours" | "theirs" }[];
}

const MAX_SCAN_DEPTH = 6;

const isLocalized = (v: unknown): v is { key: string; fallback: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { key?: unknown }).key === "string" &&
  (v as { key: string }).key !== "" &&
  typeof (v as { fallback?: unknown }).fallback === "string";

/** Every keyed message in a tree — a node's `label`/`title`, and any in its props — by key. */
function keyedMessages(root: ExperienceNode): Map<string, { nodeId: string; message: string }[]> {
  const found = new Map<string, { nodeId: string; message: string }[]>();
  const add = (nodeId: string, v: { key: string; fallback: string }): void => {
    const list = found.get(v.key) ?? [];
    list.push({ nodeId, message: v.fallback });
    found.set(v.key, list);
  };
  const scan = (nodeId: string, value: unknown, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    if (isLocalized(value)) {
      add(nodeId, value);
      return;
    }
    if (Array.isArray(value)) for (const v of value) scan(nodeId, v, depth + 1);
    else if (typeof value === "object" && value !== null)
      for (const v of Object.values(value)) scan(nodeId, v, depth + 1);
  };
  const stack: ExperienceNode[] = [root];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (n.kind === "semantic") {
      if (n.label !== undefined) scan(n.id, n.label, 0);
      scan(n.id, n.props, 0);
    } else {
      if (n.title !== undefined) scan(n.id, n.title, 0);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i] as ExperienceNode);
    }
  }
  return found;
}

/**
 * Keys that mean two different things in the merged tree. Compared against BOTH sides, not only
 * the result, so the report can say which branch contributed which wording. A key used twice
 * with the SAME text is reuse — what keys are for — and is not a conflict.
 */
export function keyConflicts(
  ours: ExperienceNode,
  theirs: ExperienceNode,
  merged: ExperienceNode
): KeyConflict[] {
  const inMerged = keyedMessages(merged);
  const inOurs = keyedMessages(ours);
  const inTheirs = keyedMessages(theirs);
  const conflicts: KeyConflict[] = [];
  for (const [key, uses] of inMerged) {
    if (new Set(uses.map((u) => u.message)).size < 2) continue;
    const had = (m: Map<string, { nodeId: string; message: string }[]>, u: (typeof uses)[number]) =>
      (m.get(key) ?? []).some((x) => x.nodeId === u.nodeId && x.message === u.message);
    const sides: Array<KeyConflict["sides"][number]> = [];
    for (const use of uses) {
      const fromOurs = had(inOurs, use);
      const fromTheirs = had(inTheirs, use);
      // A use both sides already had did not cause the split; blaming one branch would send
      // someone to the wrong diff.
      if (fromOurs && !fromTheirs) sides.push({ ...use, from: "ours" });
      else if (fromTheirs && !fromOurs) sides.push({ ...use, from: "theirs" });
    }
    if (sides.length > 0) conflicts.push({ key, sides });
  }
  return conflicts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const describeKeyConflict = (c: KeyConflict): string =>
  `key "${c.key}" means two different things: ${c.sides
    .map((s) => `${s.from} says "${s.message}" (${s.nodeId})`)
    .join(", ")}`;

// ── The merge ────────────────────────────────────────────────────────────────────────────────────

function mergeLayout(
  base: ExperienceNode,
  ours: ExperienceNode,
  theirs: ExperienceNode,
  conflicts: MergeConflict[]
): ExperienceNode {
  const fb = flatten(base);
  const fo = flatten(ours);
  const ft = flatten(theirs);
  const ids = new Set<string>([...fb.keys(), ...fo.keys(), ...ft.keys()]);
  const survivors = new Map<string, Survivor>();
  const layout = (kind: MergeConflictKind, ref: string, detail: string): void => {
    conflicts.push({ plane: "layout", kind, ref, detail });
  };
  const keep = (f: Flat): Survivor => ({ parentId: f.parentId, order: f.order, node: f.node });

  for (const id of ids) {
    const b = fb.get(id);
    const o = fo.get(id);
    const t = ft.get(id);

    if (b === undefined) {
      // Added on one or both sides.
      if (o !== undefined && t === undefined) survivors.set(id, keep(o));
      else if (t !== undefined && o === undefined) survivors.set(id, keep(t));
      else if (o !== undefined && t !== undefined) {
        if (o.content !== t.content || o.parentId !== t.parentId || o.order !== t.order)
          layout(
            "add/add",
            id,
            "the same node id was added differently (content or position) on both sides"
          );
        survivors.set(id, keep(o));
      }
      continue;
    }

    if (o === undefined && t === undefined) continue; // removed on both
    if (o === undefined || t === undefined) {
      const kept = (o ?? t) as Flat;
      const edited = kept.content !== b.content || kept.parentId !== b.parentId;
      if (!edited) continue; // a clean removal wins
      layout("remove/edit", id, "the node was removed on one side and edited on the other");
      survivors.set(id, keep(kept));
      continue;
    }

    const parent = threeWay<string | null>(b.parentId, o.parentId, t.parentId);
    if (parent.conflict)
      layout("move/move", id, "the node was reparented to different parents on both sides");
    const order = threeWay(b.order, o.order, t.order);
    // The same node given two different positions among its siblings is as much a move/move as
    // two parents (a plain ours-wins would hide it).
    if (order.conflict && !parent.conflict)
      layout("move/move", id, "the node was reordered differently on both sides");
    const content = threeWay(b.content, o.content, t.content);
    if (content.conflict)
      layout("edit/edit", id, "the node's content was edited differently on both sides");
    survivors.set(id, {
      parentId: parent.value,
      order: order.value,
      node: content.from === "ours" ? o.node : t.node,
    });
  }

  const rank = new Map<string, number>();
  for (const f of [fo, ft, fb])
    for (const id of f.keys()) if (!rank.has(id)) rank.set(id, rank.size);
  const rebuilt = unflatten(survivors, rank);
  if (rebuilt.ok) return rebuilt.root;
  if (rebuilt.unreachable.length > 0)
    for (const id of rebuilt.unreachable)
      layout(
        "orphan",
        id,
        "the node cannot be placed: its parent was removed, or the two sides' moves made a cycle"
      );
  else layout(/nests past/.test(rebuilt.reason) ? "depth" : "orphan", "", rebuilt.reason);
  return ours; // the partial stays renderable
}

function mergeProviders(
  base: Experience,
  ours: Experience,
  theirs: Experience,
  conflicts: MergeConflict[]
): Record<string, ProviderSpec> {
  const out = new Map<string, ProviderSpec>();
  const own = (r: Record<string, ProviderSpec>, h: string): ProviderSpec | undefined =>
    Object.hasOwn(r, h) ? r[h] : undefined;
  const handles = new Set<string>([
    ...Object.keys(base.providers),
    ...Object.keys(ours.providers),
    ...Object.keys(theirs.providers),
  ]);
  for (const h of handles) {
    const b = own(base.providers, h);
    const o = own(ours.providers, h);
    const t = own(theirs.providers, h);
    if (o === undefined && t === undefined) continue;
    const bs = b === undefined ? undefined : canonicalJson(b);
    if (t === undefined) {
      // Ours only: added by us, or removed by them — a removal of an unchanged spec is honoured.
      if (bs !== undefined && bs === canonicalJson(o)) continue;
      out.set(h, o as ProviderSpec);
      continue;
    }
    if (o === undefined) {
      if (bs !== undefined && bs === canonicalJson(t)) continue;
      out.set(h, t);
      continue;
    }
    const merged = threeWay(bs, canonicalJson(o), canonicalJson(t));
    if (merged.conflict)
      conflicts.push({
        plane: "provider",
        kind: "provider/provider",
        ref: h,
        detail: "the same handle's provider spec changed differently on both sides",
      });
    out.set(h, merged.from === "ours" ? o : t);
  }
  return Object.fromEntries(out);
}

function mergeFloor(ours: Experience, theirs: Experience): Experience["vocabularyFloor"] {
  if (canonicalJson(ours.vocabularyFloor) === canonicalJson(theirs.vocabularyFloor))
    return ours.vocabularyFloor;
  const seen = new Map<string, { name: string; version: string }>();
  for (const t of [...ours.vocabularyFloor.types, ...theirs.vocabularyFloor.types])
    seen.set(canonicalJson([t.name, t.version]), t);
  const types = [...seen.values()].sort((a, b) =>
    a.name !== b.name
      ? a.name < b.name
        ? -1
        : 1
      : a.version < b.version
        ? -1
        : a.version > b.version
          ? 1
          : 0
  );
  return { types };
}

/**
 * Three-way merge of two Experiences that share `base`. See the header for the semantics.
 * `experienceId`, `meta` and the tie-breaks all come from `ours`.
 */
export function mergeExperiences(
  base: Experience,
  ours: Experience,
  theirs: Experience
): MergeResult {
  const conflicts: MergeConflict[] = [];

  // `flatten` is iterative, but refuse an over-deep input up front: a tree past the cap is not one
  // any entry point accepts, and merging it would only launder it into a result.
  const deep = [base, ours, theirs].find((e) => treeDepth(e.root) > MAX_TREE_DEPTH);
  let root = ours.root;
  if (deep === undefined) root = mergeLayout(base.root, ours.root, theirs.root, conflicts);
  else
    conflicts.push({
      plane: "layout",
      kind: "depth",
      ref: "",
      detail: `a tree nests past ${MAX_TREE_DEPTH} levels; the layout is not merged`,
    });

  const providers = mergeProviders(base, ours, theirs, conflicts);

  const intent = threeWay(
    canonicalJson(base.intent),
    canonicalJson(ours.intent),
    canonicalJson(theirs.intent)
  );
  if (intent.conflict)
    conflicts.push({
      plane: "intent",
      kind: "intent/intent",
      ref: "",
      detail: "the two sides disagree about the experience's intent",
    });

  // Key conflicts are about the INTERACTION of two lines of edits. When one side changed nothing
  // in the layout (or both made the same change) there is no interaction: whatever one key means
  // twice inside a single side was that side's own state, not something the merge introduced.
  const [rb, ro, rt] = [base.root, ours.root, theirs.root].map((r) => canonicalJson(r));
  const interacting = deep === undefined && ro !== rt && rb !== ro && rb !== rt;
  if (interacting)
    for (const c of keyConflicts(ours.root, theirs.root, root))
      conflicts.push({
        plane: "layout",
        kind: "message/message",
        ref: c.key,
        detail: describeKeyConflict(c),
      });

  const partial: Experience = {
    experienceId: ours.experienceId,
    versionHash: "",
    parents: [],
    intent: intent.from === "ours" ? ours.intent : theirs.intent,
    root,
    providers,
    vocabularyFloor: mergeFloor(ours, theirs),
    meta: ours.meta,
  };
  // Sticky classes: the strictest anything on either side (or the base) ever carried.
  const experience = carryClasses(base, carryClasses(theirs, carryClasses(ours, partial)));
  return { experience, conflicts };
}
