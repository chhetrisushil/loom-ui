import {
  type ContainerNode,
  type ContainerRoleSpec,
  type Experience,
  type ExperienceNode,
  type Finding,
  GRID_COLUMNS,
  type MCPToolNode,
  type Operation,
  type ProviderSpec,
  type RoleChild,
  type SemanticCatalog,
  type SemanticNode,
  experienceHandles,
  inheritedClass,
  isContainer,
  isPlaced,
  nodeIds,
  orderKeyAfterAll,
  orderKeyBetween,
  replay,
  toolKey,
  walk,
} from "@loom-ui/core";
import {
  jsonPathSelect,
  outputShapeHashOf,
  stepReferences,
  terminalSteps,
  topoWaves,
} from "@loom-ui/hydration/client";
import { strictest, unwrapTainted } from "@loom/classify";
import { canonicalJson, fnv1a64 } from "@loom/core";
import { requiredClass } from "./capabilityClass";
import {
  type DraftBinding,
  type DraftContainer,
  type DraftEntry,
  type DraftNode,
  PLAIN_CONTAINERS,
  type PlanDraft,
  draftStructureIssues,
  entryFor,
  isDraftContainer,
} from "./contract";
import type { CapabilityRef, ReviseInput } from "./spi";

export const DEFAULT_TTL_SECONDS = 60;

const err = (code: string, message: string, nodeId?: string): Finding => ({
  code,
  severity: "error",
  message,
  ...(nodeId !== undefined && { nodeId }),
});
const warn = (code: string, message: string, nodeId?: string): Finding => ({
  code,
  severity: "warn",
  message,
  ...(nodeId !== undefined && { nodeId }),
});

/**
 * What a rebuilt call keeps of the step it replaces. When a binding's call is the terminal step
 * of a multi-step provider, `upstream` is that step's dependency closure (every step it depends on
 * or references, transitively, in the base graph's order, ids and specs unchanged) and `stepId` /
 * `dependsOn` are the terminal's own: the terminal's arguments may name those steps' outputs
 * (`{{steps.<id>.output…}}`), so a rebuild that dropped them would keep an argument that no longer
 * resolves. `idempotent` (only when `false`) and `overridable` are the replaced step's own flags,
 * carried so a rebuild never widens what may be retried or narrows what a per-load param may
 * replace. `undefined` from `callGraphOf` means a plain single step with default flags.
 */
export interface CallGraph {
  readonly stepId: string;
  readonly dependsOn: readonly string[];
  readonly upstream: readonly MCPToolNode[];
  readonly idempotent?: false;
  readonly overridable?: readonly string[];
}

/**
 * `terminal`'s call graph within `graph`: its transitive closure over `dependsOn` AND template
 * references, restricted to steps the graph declares (a `dependsOn` naming an absent step is
 * satisfied by hydration's scheduler, so there is nothing to keep), in the graph's own order.
 * A terminal with no upstream is normalised to `s1` with no `dependsOn` — the single-step layout —
 * and to `undefined` when its flags are the defaults too, so a plain single step hashes as before.
 */
export function callGraphOf(
  graph: readonly MCPToolNode[],
  terminal: MCPToolNode
): CallGraph | undefined {
  const byId = new Map(graph.map((s) => [s.stepId, s] as const));
  const keep = new Set<string>();
  const stack = [terminal];
  while (stack.length > 0) {
    const step = stack.pop() as MCPToolNode;
    for (const id of [...step.dependsOn, ...stepReferences(step.arguments)]) {
      const dep = byId.get(id);
      if (dep === undefined || keep.has(id) || id === terminal.stepId) continue;
      keep.add(id);
      stack.push(dep);
    }
  }
  const flags = {
    ...(terminal.idempotent === false && { idempotent: false as const }),
    ...(terminal.overridable !== undefined && { overridable: [...terminal.overridable] }),
  };
  if (keep.size === 0) {
    if (Object.keys(flags).length === 0) return undefined;
    return { stepId: "s1", dependsOn: [], upstream: [], ...flags };
  }
  return {
    stepId: terminal.stepId,
    dependsOn: [...terminal.dependsOn],
    upstream: graph.filter((s) => keep.has(s.stepId)),
    ...flags,
  };
}

/**
 * The invariant every graph `materialize` emits must hold — hydration's own rule, not a stricter
 * one: the graph schedules (`topoWaves` finds no cycle), and each `{{steps.<id>.output…}}`
 * reference names a step in a STRICTLY EARLIER wave than the referencing step — the only steps
 * whose output exists when it runs. A reference to a step outside the graph, or in the same or a
 * later wave, is `unresolved-step-reference` at execution: a provider that replays but cannot run.
 * Linear in the graph. The first violation, or `undefined`.
 */
export function danglingStepReference(graph: readonly MCPToolNode[]): string | undefined {
  const { waves, cycle } = topoWaves(graph);
  if (cycle.length > 0) return `the graph has a dependency cycle through ${cycle.join(", ")}`;
  const waveOf = new Map<string, number>();
  waves.forEach((wave, i) => {
    for (const step of wave) waveOf.set(step.stepId, i);
  });
  for (const step of graph) {
    const at = waveOf.get(step.stepId) as number;
    for (const ref of stepReferences(step.arguments)) {
      const refAt = waveOf.get(ref);
      if (refAt === undefined)
        return `step "${step.stepId}" references step "${ref}", which is not in the provider's graph`;
      if (refAt >= at)
        return `step "${step.stepId}" references step "${ref}", which does not run before it`;
    }
  }
  return undefined;
}

/**
 * Identical (tool, version, SCHEMA PIN, arguments, path) → identical handle, so two nodes share
 * one fetch. The schema hash is part of the identity, not just the spec: two capabilities can
 * offer the same tool@version pinned to DIFFERENT input schemas (one stale, one current), and
 * without the pin in the hash they would collide on one handle whose spec pins whichever
 * capability materialised first — a silent mis-pin, where including it makes them two providers.
 * A call made behind upstream steps (`graph`) is a different fetch from the same call alone, so
 * its graph is part of the identity too; a single-step call hashes exactly as it always has.
 */
export function providerHandle(
  toolName: string,
  toolVersion: string,
  toolSchemaHash: string,
  args: Record<string, unknown>,
  path: string,
  graph?: CallGraph
): string {
  return `p-${fnv1a64(
    canonicalJson({
      toolName,
      toolVersion,
      toolSchemaHash,
      args,
      path,
      ...(graph !== undefined && { graph }),
    })
  )}`;
}

export function buildProviderSpec(
  cap: CapabilityRef,
  binding: DraftBinding,
  nodeId?: string,
  graph?: CallGraph
): { ok: true; spec: ProviderSpec } | { ok: false; finding: Finding } {
  if (cap.sampleOutput === undefined)
    return {
      ok: false,
      finding: err(
        "capability-unsampled",
        `capability "${cap.handle}" offers no output sample, so its output shape cannot be pinned; it is not bindable`,
        nodeId
      ),
    };
  const reshaped = jsonPathSelect(cap.sampleOutput, binding.path);
  if (!reshaped.ok)
    return {
      ok: false,
      finding: {
        ...reshaped.finding,
        code: "reshape-invalid",
        ...(nodeId !== undefined && { nodeId }),
      },
    };
  let outputShapeHash: string;
  try {
    outputShapeHash = outputShapeHashOf(reshaped.value);
  } catch (e) {
    return {
      ok: false,
      finding: err(
        "unhashable-sample",
        `capability "${cap.handle}" sample at "${binding.path}" cannot be shape-hashed: ${e instanceof Error ? e.message : String(e)}`,
        nodeId
      ),
    };
  }
  const handle = providerHandle(
    toolKey(cap),
    cap.toolVersion,
    cap.toolSchemaHash,
    binding.arguments,
    binding.path,
    graph
  );
  const executionGraph: MCPToolNode[] = [
    ...(graph?.upstream ?? []),
    {
      stepId: graph?.stepId ?? "s1",
      ...(cap.kind !== undefined && { kind: cap.kind }),
      toolName: cap.toolName,
      toolVersion: cap.toolVersion,
      toolSchemaHash: cap.toolSchemaHash,
      arguments: binding.arguments,
      dependsOn: [...(graph?.dependsOn ?? [])],
      idempotent: graph?.idempotent ?? true,
      ...(graph?.overridable !== undefined && { overridable: [...graph.overridable] }),
    },
  ];
  // THE enforcement point — every provider `materialize` emits is built here. Never emit one
  // that replays but cannot run: a binding whose arguments name a step this graph does not carry
  // (a model-authored template, or a call rebuilt without the steps it was observed behind), or a
  // graph that cannot be scheduled, is refused here, by name.
  const dangling = danglingStepReference(executionGraph);
  if (dangling !== undefined)
    return {
      ok: false,
      finding: err(
        "dangling-step-reference",
        `capability "${cap.handle}" cannot be bound as authored: ${dangling}`,
        nodeId
      ),
    };
  return {
    ok: true,
    spec: {
      handle,
      executionGraph,
      reshaping: { engine: "JSONPath", scriptRef: binding.path },
      outputShapeHash,
      cachePolicy: { ttlSeconds: DEFAULT_TTL_SECONDS, scope: "principal" },
    },
  };
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** One CALL's identity: the tool AND the arguments it is called with. A sample belongs to a call. */
const callKey = (toolName: string, toolVersion: string, args: unknown): string =>
  `${toolName}@${toolVersion}#${canonicalJson(args)}`;

/** A call made behind upstream steps (`callGraphOf`): the graph is part of its identity. */
const graphCallKey = (
  toolName: string,
  toolVersion: string,
  args: unknown,
  graph: CallGraph | undefined
): string => `${callKey(toolName, toolVersion, args)}|${canonicalJson(graph ?? null)}`;

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * `observed` (per-handle raw samples) indexed by the CALL each handle's single terminal step
 * makes. A handle with several terminals (its sample is a stepId-keyed record, not one call's
 * output) or with no declared spec in `base` contributes nothing. Two handles making the same
 * call with disagreeing samples leave that call unresolved (`undefined`) — no arbitrary pick.
 */
function indexObserved(base: Experience, observed: ReviseInput["observed"]) {
  const byHandle = new Map<string, { call: string; sample: unknown }>();
  const byCall = new Map<string, unknown>();
  const conflicted = new Set<string>();
  const tools = new Set<string>();
  for (const handle of Object.keys(observed ?? {})) {
    if (!own(base.providers, handle)) continue;
    const terminals = terminalSteps((base.providers[handle] as ProviderSpec).executionGraph);
    const step = terminals.length === 1 ? terminals[0] : undefined;
    if (step === undefined) continue;
    const sample = unwrapTainted((observed as NonNullable<typeof observed>)[handle]);
    // The call INCLUDES the steps it runs behind: the same terminal behind different upstream
    // steps resolves its templated arguments against different outputs — a different call.
    const graph = callGraphOf((base.providers[handle] as ProviderSpec).executionGraph, step);
    const call = graphCallKey(toolKey(step), step.toolVersion, step.arguments, graph);
    tools.add(`${toolKey(step)}@${step.toolVersion}`);
    byHandle.set(handle, { call, sample });
    if (conflicted.has(call)) continue;
    if (byCall.has(call) && !sameJson(byCall.get(call), sample)) {
      byCall.delete(call);
      conflicted.add(call);
    } else byCall.set(call, sample);
  }
  return { byHandle, byCall, tools };
}

/**
 * The providers a plan ORPHANS: every handle the base declares AND some base node binds, that no
 * node binds once `ops` apply. Computed EXACTLY, not approximated per op-type: `ops` is folded
 * onto `base` with core's own `replay` (the same apply semantics core uses to actually commit a
 * plan), and the resulting tree is walked once for its bound handles — so a `moveNode` that
 * relocates a binder, a subtree removed two containers deep, a node rebound twice, or an op
 * nested inside a `prompt`'s `materialized` all resolve the same way core itself would resolve
 * them, with no op-type-specific case to fall out of sync with `apply`. One `removeProvider`
 * each, sorted by handle, for handles still DECLARED once `ops` apply (one `ops` already removed
 * is not returned again), so replaying `[...ops, ...orphaned]` orphans exactly this set and never
 * trips `provider-still-bound` or `missing-provider`. A provider the base declared with no binder is not this plan's to
 * retire: the app may hold it on purpose. If `ops` do not replay cleanly onto `base`, the plan is
 * invalid and will be refused on its own; there is nothing here to orphan.
 */
export function orphanedProviders(base: Experience, ops: readonly Operation[]): Operation[] {
  const before = new Set<string>();
  walk(base.root, (n) => {
    if (n.kind === "semantic" && n.binding !== undefined) before.add(n.binding.handle);
  });
  const after = replay(base, ops);
  if (!after.ok) return [];
  const bound = new Set<string>();
  walk(after.value.root, (n) => {
    if (n.kind === "semantic" && n.binding !== undefined) bound.add(n.binding.handle);
  });
  // Still declared in the AFTER state: a handle `ops` already retired is not retired twice, so
  // the result is idempotent (`orphanedProviders(base, [...ops, ...orphaned])` is empty).
  const declared = (h: string) => Object.prototype.hasOwnProperty.call(after.value.providers, h);
  return [...before]
    .filter((h) => !bound.has(h) && declared(h))
    .sort()
    .map((handle) => ({ type: "removeProvider", handle }));
}

/** An editable node and the container it sits in. */
interface Slot {
  readonly node: ExperienceNode;
  readonly parentId: string;
}

/**
 * What a plan may edit (U15). Walks from the root and descends ONLY through containers a planner
 * authored (`owner: "planner"`): their children are `slots`; an application-owned container met on
 * the way is `locked` (with the id of the container it sits in) and is never entered. `containers`
 * is every container whose membership the plan may change — the root and the planner-owned ones.
 * Iterative, linear in the editable region.
 */
interface Region {
  readonly slots: Map<string, Slot>;
  readonly containers: Map<string, ContainerNode>;
  /** Planner-owned containers (the root excluded). */
  readonly owned: Set<string>;
  /** Application-owned containers inside the region, by id → the editable container holding them. */
  readonly locked: Map<string, string>;
}

function editableRegion(root: ContainerNode): Region {
  const slots = new Map<string, Slot>();
  const containers = new Map<string, ContainerNode>([[root.id, root]]);
  const owned = new Set<string>();
  const locked = new Map<string, string>();
  const stack: ContainerNode[] = [root];
  for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
    for (const k of c.children) {
      if (isContainer(k) && k.owner !== "planner") {
        locked.set(k.id, c.id);
        continue;
      }
      slots.set(k.id, { node: k, parentId: c.id });
      if (isContainer(k)) {
        owned.add(k.id);
        containers.set(k.id, k);
        stack.push(k);
      }
    }
  }
  return { slots, containers, owned, locked };
}

/**
 * Per parent, the draft entries that keep their place: existing children of that parent, in the
 * longest run whose draft order agrees with their current order keys (patience sorting, O(n log n)
 * over the entries). Everything else under that parent — new, moved in, out of order — gets a key.
 */
function staySet(
  entries: readonly DraftEntry[],
  slots: ReadonlyMap<string, Slot>,
  parentOf: (e: DraftEntry) => string
): Set<string> {
  const byParent = new Map<string, ExperienceNode[]>();
  const listed = new Set<string>();
  for (const e of entries) {
    if (listed.has(e.id)) continue;
    listed.add(e.id);
    const slot = slots.get(e.id);
    if (slot === undefined || slot.parentId !== parentOf(e)) continue;
    const list = byParent.get(slot.parentId) ?? [];
    list.push(slot.node);
    byParent.set(slot.parentId, list);
  }
  const stays = new Set<string>();
  for (const seq of byParent.values()) {
    const rank = new Map(
      [...seq]
        .sort((x, y) => (x.order < y.order ? -1 : x.order > y.order ? 1 : x.id < y.id ? -1 : 1))
        .map((n, i) => [n.id, i] as const)
    );
    const tails: number[] = []; // tails[k] = index in seq ending the best run of length k+1
    const prev: number[] = new Array(seq.length).fill(-1);
    const r = (i: number): number => rank.get((seq[i] as ExperienceNode).id) as number;
    seq.forEach((_, i) => {
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (r(tails[mid] as number) < r(i)) lo = mid + 1;
        else hi = mid;
      }
      prev[i] = lo > 0 ? (tails[lo - 1] as number) : -1;
      tails[lo] = i;
    });
    for (
      let i = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
      i >= 0;
      i = prev[i] as number
    )
      stays.add((seq[i] as ExperienceNode).id);
  }
  return stays;
}

/**
 * The removals of a plan: every editable node the draft does not list, TOP-MOST only (a removed
 * container takes what is still inside it). A container that would take an application-owned one
 * with it is refused (`locked-descendant`) rather than destroying what the planner does not own.
 */
function removals(
  slots: ReadonlyMap<string, Slot>,
  region: Region,
  seen: ReadonlySet<string>,
  findings: Finding[],
  ops: Operation[]
): void {
  const gone = new Set<string>();
  for (const id of slots.keys()) if (!seen.has(id)) gone.add(id);
  const blocked = new Map<string, string>();
  for (const [lockedId, holder] of region.locked) {
    if (!gone.has(holder)) continue;
    let top = holder;
    for (;;) {
      const up = (slots.get(top) as Slot).parentId;
      if (!gone.has(up)) break;
      top = up;
    }
    if (!blocked.has(top)) blocked.set(top, lockedId);
  }
  for (const id of gone) {
    const slot = slots.get(id) as Slot;
    if (gone.has(slot.parentId)) continue;
    const lockedId = blocked.get(id);
    if (lockedId !== undefined)
      findings.push(
        err(
          "locked-descendant",
          `"${id}" cannot be removed: it holds "${lockedId}", an application-owned container`,
          id
        )
      );
    else ops.push({ type: "removeNode", nodeId: id });
  }
}

const containerDirection = (kind: string): ContainerNode["direction"] =>
  kind === "row" ? "row" : kind === "grid" ? "grid" : "column";
const isPlainContainer = (kind: string): boolean =>
  (PLAIN_CONTAINERS as readonly string[]).includes(kind);

/**
 * Draft → operations by DIFFING against the region of `base` the planner may edit (U15): the
 * root's children and, recursively, the children of every container a planner authored
 * (`owner: "planner"`). Compose is the special case where the base is an empty genesis. A draft
 * entry is a widget or a container; its `parent` (absent = the root) says where it sits, and its
 * position in the list says in which order. An entry that exists is diffed field by field, MOVED
 * (`moveNode`) when its parent changed or it is out of order — the longest run of siblings already
 * in order stays put, so a reorder costs the fewest moves — and one the draft omits is removed
 * (top-most only: a removed container takes what is left in it). New entries are inserted one op
 * each, parent first, so a plan for a new tab set reads as the nodes it adds.
 *
 * What it refuses, by name: an id naming an application-owned container (`not-semantic` for a
 * widget entry, `not-owned` for a container entry) or a node inside one (`nested-node`), a parent
 * that is not editable (`parent-locked`) or was itself refused (`parent-refused`), a widget that
 * would become a container or the reverse (`kind-changed`), a removal that would take an
 * application-owned container with it (`locked-descendant`), and a draft whose nesting breaks a
 * bound (`draft-structure`, no ops). Order: remapProvider before the bindProvider/insertNode that needs it; removals last — `removeNode`, then a `removeProvider` for every handle the plan orphaned (`orphanedProviders`).
 *
 * `setProps` (core's `apply`) MERGES the patch into the existing props, so there is no way to
 * DELETE a key through this op: a patch value of `undefined` round-trips through `Operation`'s
 * zod (`z.record(z.unknown())` accepts it) but the merge (`{...n.props, ...patch}`) still leaves
 * the key present with value `undefined`, and `canonicalJson` only drops undefined-valued keys
 * from its OWN output — it does not delete them from the live object `apply` returns, so the
 * live experience still carries the key. Rather than emit a patch that looks like a removal but
 * is not one, a props change that would need a key gone is reported as a `props-not-removed`
 * warn and the patch still carries every key the draft wants SET (additions/changes go through
 * normally; nothing here can make a key vanish).
 *
 * A confidentiality class is the same shape of limit, one notch tighter: an existing node's class
 * is clamped to `strictest(current, proposed)`, so a draft may raise it but never lower it
 * (`sensitivity-not-lowered`) nor remove it (`sensitivity-not-removed`) — both warns, neither an
 * op. Only a type the catalogue marks `model-may-set` gets those warns; everywhere else the class
 * is the caller's and the model never saw it.
 *
 * `observed` (a revise's per-handle raw samples, `ReviseInput.observed`) pins each rebuilt
 * provider against the output of THE CALL it makes, never against another call's. For a binding
 * on a tool some handle observed: the node's own handle's sample when the draft keeps that call,
 * else the sample every handle making the same call agrees on. With no observation of this call,
 * the draft does not guess from the capability's (pre-drift, or another call's) sample: a handle
 * the base already declares is kept with its current spec; an existing node the draft re-binds
 * keeps its binding (`sample-not-observed`, warn — unrepaired, never mis-repaired); a new node is
 * dropped (`sample-not-observed`, warn — not an error, so the plan's other repairs survive).
 * Absent `observed`, or a tool nobody observed, the
 * capability's `sampleOutput` pins as before.
 */
export function materialize(
  draft: PlanDraft,
  base: Experience,
  catalog: SemanticCatalog,
  capabilities: readonly CapabilityRef[],
  observed?: ReviseInput["observed"],
  /**
   * `orderSalt`: an AUTHOR id mixed into the order keys of the nodes this plan inserts, so two
   * planners (authors) appending into the same gap mint different keys. Absent = the unsalted
   * legacy key, so ops (and every hash over them) are byte-identical to before.
   */
  mint: { readonly orderSalt?: string } = {},
  /**
   * How strictly the draft's structure is judged. The default is the FULL bar (every container
   * non-empty, at most `MAX_DRAFT_NODES` entries): a direct caller fails closed. `roles` adds the
   * role child rules (min/max children, `panels`) — `ReferencePlanner` passes the roles it offered
   * plus those already on planner containers in the base; without them a role container is only
   * judged as a plain one. `partial` is for a streamed PREFIX, where a container's children may
   * still be coming (`ReferencePlanner`'s partials pass it).
   */
  structure: {
    readonly roles?: readonly ContainerRoleSpec[];
    /**
     * Roles in `roles` that were NOT offered (they came from containers already in the base): a
     * container that already carries one keeps it, a new or re-roled container may not take it.
     */
    readonly carriedOnly?: ReadonlySet<string>;
    readonly partial?: boolean;
  } = {}
): { ops: Operation[]; findings: Finding[] } {
  const ops: Operation[] = [];
  const findings: Finding[] = [];
  if (!isContainer(base.root))
    return {
      ops,
      findings: [
        err(
          "not-a-container",
          `experience root "${base.root.id}" is not a container`,
          base.root.id
        ),
      ],
    };
  const root = base.root;
  const caps = new Map(capabilities.map((c) => [c.handle, c] as const));
  // The region the planner may edit (U15): the root's children, and — descending only through
  // containers a planner authored (`owner: "planner"`) — theirs. An application-owned container is
  // LOCKED: it and everything under it is the app's, as the root's direct containers always were.
  const region = editableRegion(root);
  const existing = region.slots;
  // Handle -> class the experience already holds (sticky; includes handles no node binds now).
  const classByHandle = new Map<string, NonNullable<ReturnType<typeof strictest>>>(
    Object.entries(base.handleClasses ?? {})
  );
  // Id/class collection from the STORED classes only (the planner's clamp is against what the
  // experience holds; the declared floor is applied separately via `requiredClass`).
  for (const u of experienceHandles(base))
    if (u.sensitivity !== undefined) classByHandle.set(u.handle, u.sensitivity);
  // WHOLE-TREE id index, root included. `existing` covers only what this function may author
  // (the root's direct children), so an id that is in the tree but not in `existing` names a
  // node nested inside an application-owned container: not editable here, and not insertable
  // either (replay would refuse the duplicate id). It is refused by name, before anything else
  // observable — a binding resolved, a provider declared — can happen for it.
  const allIds = new Set(nodeIds(root));
  // Seeded from the base: a handle already declared with THIS spec needs no new remapProvider.
  // A capability's sample can change under an unchanged (tool, version, args, path) — Task 5
  // feeds an OBSERVED sample this way — so the gate compares specs, not just handle presence,
  // or a re-shaped/re-hashed spec would pin silently stale.
  const declaredSpecs = new Map<string, ProviderSpec>(Object.entries(base.providers));
  // What THIS run has already emitted a spec for, and under which capability — so a second node
  // naming a DIFFERENT capability that happens to collide on the same (tool, version, args, path)
  // handle is caught as a conflict instead of one spec silently overwriting the other.
  const emittedThisRun = new Map<string, { spec: ProviderSpec; capability: string }>();
  // Per parent, every child's order key as the plan leaves it (existing + inserted/moved so far).
  const siblingKeys = new Map<string, Array<{ order: string }>>();
  const keysOf = (parentId: string): Array<{ order: string }> => {
    let list = siblingKeys.get(parentId);
    if (list === undefined) {
      const p = region.containers.get(parentId);
      list = p === undefined ? [] : [...p.children];
      siblingKeys.set(parentId, list);
    }
    return list;
  };
  const observations = indexObserved(base, observed);
  // Draft nodes left out whole (`sample-not-observed`): never inserted, never edited.
  const dropped = new Set<string>();
  const seen = new Set<string>();

  // Exactly a node's binding — the shape this resolver exists to produce — so `sensitivity`
  // cannot drift from what `insertNode` will carry.
  const resolveBindingRaw = (
    n: DraftNode,
    current: SemanticNode | undefined
  ): NonNullable<SemanticNode["binding"]> | undefined => {
    if (n.binding === undefined) return undefined;
    const cap = caps.get(n.binding.capability);
    if (cap === undefined) {
      findings.push(
        err(
          "unknown-capability",
          `node "${n.id}" binds capability "${n.binding.capability}", which was not offered`,
          n.id
        )
      );
      return undefined;
    }
    // The class the MODEL proposed (only ever present where the type is `model-may-set`). What the
    // capabilities DECLARE is joined in by `resolveBinding` below, over the final spec.
    const klass = n.binding.sensitivity;
    let pinFrom = cap;
    // The node's CURRENT call graph, kept when the draft keeps the tool: a call made behind
    // upstream steps is rebuilt behind the same steps (`CallGraph`) — with the draft's arguments,
    // which may edit literals and keep, drop or re-point templates among those steps (one naming
    // a step the graph lacks is refused by `buildProviderSpec`) — whether or not anything was
    // observed. A different tool, or a new node, starts from no graph.
    const currentSpec =
      current?.binding !== undefined && own(base.providers, current.binding.handle)
        ? (base.providers[current.binding.handle] as ProviderSpec)
        : undefined;
    const currentTerminals = currentSpec ? terminalSteps(currentSpec.executionGraph) : [];
    const currentTerminal = currentTerminals.length === 1 ? currentTerminals[0] : undefined;
    const graph =
      currentSpec !== undefined &&
      currentTerminal !== undefined &&
      toolKey(currentTerminal) === toolKey(cap) &&
      currentTerminal.toolVersion === cap.toolVersion
        ? callGraphOf(currentSpec.executionGraph, {
            ...currentTerminal,
            arguments: n.binding.arguments,
          })
        : undefined;
    // Looked up with the node's OWN graph: an observation is only ever of the call this node
    // makes — never the same terminal behind someone else's upstream steps, nor a lone call
    // borrowing a multi-step observation (or the reverse).
    const call = graphCallKey(toolKey(cap), cap.toolVersion, n.binding.arguments, graph);
    if (observations.tools.has(`${toolKey(cap)}@${cap.toolVersion}`)) {
      const mine = current?.binding && observations.byHandle.get(current.binding.handle);
      if (mine && mine.call === call) pinFrom = { ...cap, sampleOutput: mine.sample };
      else if (observations.byCall.has(call))
        pinFrom = { ...cap, sampleOutput: observations.byCall.get(call) };
      else {
        // Nothing observed THIS call; the capability's sample is pre-drift or another call's.
        const handle = providerHandle(
          toolKey(cap),
          cap.toolVersion,
          cap.toolSchemaHash,
          n.binding.arguments,
          n.binding.path,
          graph
        );
        if (own(base.providers, handle)) {
          const kept = base.providers[handle] as ProviderSpec;
          if (!emittedThisRun.has(handle))
            emittedThisRun.set(handle, { spec: kept, capability: cap.handle });
          return {
            handle,
            priority: n.binding.priority,
            ...(klass !== undefined && { sensitivity: klass }),
          };
        }
        const message = `node "${n.id}" re-binds ${toolKey(cap)}@${cap.toolVersion} with arguments no observed sample belongs to, while other calls of that tool were observed; it is not pinned from their output`;
        if (current?.binding !== undefined) {
          findings.push(warn("sample-not-observed", `${message} — its binding is kept`, n.id));
          // Kept, but never below what the capability declares (the revise diff raises it).
          const kept = strictest(current.binding.sensitivity, klass);
          return kept === undefined ? current.binding : { ...current.binding, sensitivity: kept };
        }
        // Dropped, not refused: an error would fail the whole plan and take every OTHER handle's
        // valid repair down with it. The drift request already tells the model this is not
        // bindable this round; a node that still tries is left out.
        findings.push(
          warn(
            "sample-not-observed",
            `${message} — ${current === undefined ? "it is not inserted" : "it is left unchanged"}`,
            n.id
          )
        );
        dropped.add(n.id);
        return undefined;
      }
    }
    const built = buildProviderSpec(pinFrom, n.binding, n.id, graph);
    if (!built.ok) {
      findings.push(built.finding);
      return undefined;
    }
    const spec = built.spec;
    const handle = spec.handle;
    const already = emittedThisRun.get(handle);
    if (already !== undefined && !sameJson(already.spec, spec)) {
      findings.push(
        err(
          "provider-conflict",
          `two nodes bind the same provider handle with different specs (capability ${already.capability} vs ${cap.handle})`,
          n.id
        )
      );
      return undefined;
    }
    if (!declaredSpecs.has(handle) || !sameJson(declaredSpecs.get(handle), spec)) {
      // A new handle on a tool that ever carried a class inherits it in core's `remapProvider`
      // (classification is tool-level: a changed argument or path is a different handle id).
      const inherits = inheritedClass(base, spec);
      const own = classByHandle.get(handle);
      if (inherits !== undefined && strictest(inherits, own) !== own)
        findings.push(
          warn(
            "sensitivity-inherited",
            `provider "${handle}" calls a tool that carries class "${inherits}": it inherits that class, which only the caller can lower`,
            n.id
          )
        );
      ops.push({ type: "remapProvider", handle, spec });
      declaredSpecs.set(handle, spec);
    }
    if (already === undefined) emittedThisRun.set(handle, { spec, capability: cap.handle });
    // `sensitivity` rides on the NODE's binding, not on the provider spec: the same fetch can
    // feed two nodes, and the class describes what a node shows, not how it was fetched — so it
    // is deliberately outside `providerHandle`'s identity. What comes out here is the model's
    // proposal (the declared class is joined in by `resolveBinding`): an inserted node has no current class
    // for it to lower (`strictest(undefined, p) === p`), so the clamp lives in the revise diff below, which is the only place a
    // previously-set class exists to be lowered.
    return {
      handle,
      priority: n.binding.priority,
      ...(klass !== undefined && { sensitivity: klass }),
    };
  };

  // U10b: whatever the branches above built or kept, the node's class is at least what the tools of
  // the FINAL spec it binds declare, over every step of that spec (an upstream step's tool counts,
  // and so does the same tool offered at another version). One derivation, shared with conformance.
  const resolveBinding = (
    n: DraftNode,
    current: SemanticNode | undefined
  ): NonNullable<SemanticNode["binding"]> | undefined => {
    const b = resolveBindingRaw(n, current);
    const spec = b === undefined ? undefined : declaredSpecs.get(b.handle);
    if (b === undefined || spec === undefined) return b;
    const need = requiredClass(spec, capabilities);
    const klass = strictest(b.sensitivity, need);
    return klass === b.sensitivity ? b : { ...b, sensitivity: klass as NonNullable<typeof klass> };
  };

  // ── U15: parents, ordering and the structure the draft describes ────────────────────────────
  // A role container's child count includes what it holds OUTSIDE the draft: an application panel
  // locked inside it stays, and counts (the draft cannot list it).
  const extraChildren = new Map<string, RoleChild[]>();
  if ((structure.roles?.length ?? 0) > 0)
    for (const [lockedId, holder] of region.locked) {
      const k = region.containers.get(holder)?.children.find((c) => c.id === lockedId);
      if (k === undefined || !isContainer(k)) continue;
      const list = extraChildren.get(holder) ?? [];
      list.push({
        id: k.id,
        isContainer: true,
        titled: k.title !== undefined && k.title.fallback !== "",
      });
      extraChildren.set(holder, list);
    }
  const structureIssues = draftStructureIssues(draft.nodes, structure.roles ?? [], {
    ...(structure.partial === true && { partial: true }),
    extraChildren,
  });
  if (structureIssues.length > 0)
    return {
      ops,
      findings: structureIssues.map((i) =>
        err("draft-structure", i.message, draft.nodes[i.index]?.id)
      ),
    };
  // A container this run INSERTS: a valid parent for later entries, and an empty sibling list.
  const newContainers = new Set<string>();
  // Draft ids the plan refused outright: their children are skipped (the refusal is the finding).
  const refused = new Set<string>();
  const parentOf = (e: DraftEntry): string => e.parent ?? root.id;
  // The siblings that STAY where they are: per parent, the longest run of existing children the
  // draft lists in an order consistent with their current order keys (the rest are moved, so a
  // reorder costs the fewest `moveNode`s). Computed once, before any op is emitted.
  const stays = staySet(draft.nodes, existing, parentOf);
  const stayKeys = new Map<string, string[]>();
  for (const e of draft.nodes) {
    if (!stays.has(e.id)) continue;
    const list = stayKeys.get(parentOf(e)) ?? [];
    list.push((existing.get(e.id) as Slot).node.order);
    stayKeys.set(parentOf(e), list);
  }
  for (const list of stayKeys.values()) list.sort();
  const lastKey = new Map<string, string>();
  /**
   * The order key for `id` under `parentId`: just after the previous draft sibling's final key and
   * before the next sibling that stays; with none staying after it, after every sibling (the
   * legacy append). Never throws: a gap with no key between (`"0"` keys, ties) appends instead.
   */
  const keyFor = (parentId: string): string => {
    const sibs = keysOf(parentId);
    const prev = lastKey.get(parentId);
    const fixed = stayKeys.get(parentId) ?? [];
    let next: string | undefined;
    for (const k of fixed)
      if (prev === undefined || k > prev) {
        next = k;
        break;
      }
    let key: string;
    try {
      key =
        next === undefined
          ? orderKeyAfterAll(sibs, { salt: mint.orderSalt })
          : orderKeyBetween(prev ?? null, next, { salt: mint.orderSalt });
    } catch {
      key = orderKeyAfterAll(sibs, { salt: mint.orderSalt });
    }
    sibs.push({ order: key });
    lastKey.set(parentId, key);
    return key;
  };
  /** `span`, with the column clamp the old inline block carried: see the note on `setPlacement` below. */
  const diffSpan = (current: ExperienceNode, span: number): void => {
    if (current.span === span) return;
    const overflows = current.column !== undefined && current.column + span - 1 > GRID_COLUMNS;
    ops.push({
      type: "setPlacement",
      nodeId: current.id,
      span,
      ...(overflows && { column: GRID_COLUMNS - span + 1 }),
    });
  };
  /**
   * Move an existing node when its parent changed or it is out of order. A node with a grid
   * placement cannot enter a non-grid parent (core refuses the move), and the draft never showed
   * the model a placement, so it is cleared first in a SEPARATE op the plan carries visibly.
   */
  const newDirections = new Map<string, ContainerNode["direction"]>();
  const place = (slot: Slot, parentId: string): void => {
    const moved = slot.parentId !== parentId;
    if (!moved && stays.has(slot.node.id)) {
      lastKey.set(parentId, slot.node.order);
      return;
    }
    const dest = region.containers.get(parentId);
    const destGrid =
      dest !== undefined ? dest.direction === "grid" : newDirections.get(parentId) === "grid";
    if (moved && isPlaced(slot.node) && !destGrid)
      ops.push({
        type: "setPlacement",
        nodeId: slot.node.id,
        row: null,
        rowSpan: null,
        column: null,
      });
    ops.push({
      type: "moveNode",
      nodeId: slot.node.id,
      newParentId: parentId,
      newOrder: keyFor(parentId),
    });
  };
  /**
   * A container entry: insert it (empty, planner-owned) or diff it against the one it names —
   * title, role, width and parent. Its direction cannot change (no op moves one): a differing
   * kind is a warning and the container stays as it is. Returns false when refused.
   */
  const draftContainer = (e: DraftContainer, parentId: string): boolean => {
    const slot = existing.get(e.id);
    if (e.id === root.id || region.locked.has(e.id)) {
      findings.push(
        err(
          "not-owned",
          `"${e.id}" is an application-owned container; the planner cannot edit it`,
          e.id
        )
      );
      return false;
    }
    if (slot === undefined && allIds.has(e.id)) {
      findings.push(
        err(
          "nested-node",
          `"${e.id}" is nested inside a container the planner does not author; it can only be edited by the application`,
          e.id
        )
      );
      return false;
    }
    const direction = containerDirection(e.container);
    const role = isPlainContainer(e.container) ? undefined : e.container;
    if (
      role !== undefined &&
      structure.carriedOnly?.has(role) === true &&
      (slot === undefined || slot.node.kind !== "container" || slot.node.role !== role)
    ) {
      findings.push(
        err(
          "role-not-offered",
          `container "${e.id}": the role "${role}" was not offered for this plan; only a container that already carries it may keep it`,
          e.id
        )
      );
      return false;
    }
    if (slot !== undefined) {
      const cur = slot.node;
      if (cur.kind !== "container") {
        findings.push(
          err("kind-changed", `"${e.id}" is a widget; it cannot become a container`, e.id)
        );
        return false;
      }
      place(slot, parentId);
      if (cur.title?.fallback !== e.title)
        ops.push({
          type: "setTitle",
          nodeId: e.id,
          title:
            e.title === undefined
              ? null
              : { key: cur.title?.key ?? `${e.id}.title`, fallback: e.title },
        });
      if (cur.role !== role) ops.push({ type: "setRole", nodeId: e.id, role: role ?? null });
      if (cur.direction !== direction)
        findings.push(
          warn(
            "container-kind-unchanged",
            `container "${e.id}": a ${cur.direction} cannot become a ${direction}; remove and insert it instead — ignored`,
            e.id
          )
        );
      diffSpan(cur, e.span);
      return true;
    }
    const node: ContainerNode = {
      id: e.id,
      order: keyFor(parentId),
      kind: "container",
      direction,
      span: e.span,
      ...(e.title !== undefined && { title: { key: `${e.id}.title`, fallback: e.title } }),
      ...(role !== undefined && { role }),
      owner: "planner",
      children: [],
    };
    ops.push({ type: "insertNode", parentId, node });
    newContainers.add(e.id);
    newDirections.set(e.id, direction);
    siblingKeys.set(e.id, []);
    return true;
  };

  for (const e of draft.nodes) {
    seen.add(e.id);
    const parentId = parentOf(e);
    const parentOk =
      parentId === root.id || region.owned.has(parentId) || newContainers.has(parentId);
    if (!parentOk) {
      // A parent is a container of THIS reply (`draftStructureIssues`), so it can only be unusable
      // because the plan refused it — an application-owned id, a node inside one, a kind clash.
      findings.push(
        err("parent-refused", `"${e.id}" sits in "${parentId}", which the plan did not keep`, e.id)
      );
      refused.add(e.id);
      continue;
    }
    if (isDraftContainer(e)) {
      if (!draftContainer(e, parentId)) refused.add(e.id);
      continue;
    }
    const n = e;
    const entry = entryFor(catalog, n.type, n.version);
    if (entry === undefined) {
      findings.push(
        err(
          "unknown-type",
          `node "${n.id}" names "${n.type}", which is not in catalogue "${catalog.id}"`,
          n.id
        )
      );
      refused.add(n.id);
      continue;
    }
    const existingSlot = existing.get(n.id);
    const existingNode = existingSlot?.node;
    // Refuse a container id BEFORE touching the binding: a draft node that collides with a
    // container must never resolve a capability, declare a provider, or leave a capability
    // finding behind — it is refused outright, with nothing else observable from it. The root
    // itself is a container that is not among its own children, so it is named explicitly. An
    // id naming a LOCKED container is the same refusal (the application's, not the planner's).
    if (
      n.id === root.id ||
      region.locked.has(n.id) ||
      (existingNode !== undefined && existingNode.kind !== "semantic")
    ) {
      findings.push(
        err(
          "not-semantic",
          `"${n.id}" is a container (or an application's); a widget entry cannot take its id`,
          n.id
        )
      );
      refused.add(n.id);
      continue;
    }
    if (existingNode === undefined && allIds.has(n.id)) {
      findings.push(
        err(
          "nested-node",
          `"${n.id}" is nested inside a container the planner does not author; it can only be edited by the application`,
          n.id
        )
      );
      refused.add(n.id);
      continue;
    }
    const bound = resolveBinding(n, existingNode?.kind === "semantic" ? existingNode : undefined);
    if (dropped.has(n.id)) continue;
    if (existingNode === undefined) {
      // A handle's class is sticky (core's `Experience.handleClasses`): a new node onto a handle
      // the experience already classified inherits it whatever the draft says. Say so, so a
      // rename that "dropped" the class is not read as having worked.
      const kept = bound === undefined ? undefined : classByHandle.get(bound.handle);
      if (kept !== undefined && strictest(kept, bound?.sensitivity) !== bound?.sensitivity)
        findings.push(
          warn(
            "sensitivity-inherited",
            `node "${n.id}" binds a handle classified "${kept}": it carries that class, which only the caller can lower`,
            n.id
          )
        );
      // A new node's binding travels INSIDE its insertNode: one op, no intermediate artifact
      // that would trip `missing-binding` for a moment that never actually existed. `bindProvider`
      // is reserved for an EXISTING node whose binding changed (the revise diff, below).
      const node: SemanticNode = {
        id: n.id,
        order: keyFor(parentId),
        kind: "semantic",
        type: entry.name,
        typeVersion: entry.version,
        span: n.span,
        label: { key: `${n.id}.label`, fallback: n.label },
        props: n.props,
        ...(bound !== undefined && { binding: bound }),
      };
      ops.push({ type: "insertNode", parentId, node });
      continue;
    }
    // TypeScript can't derive "existingNode is a SemanticNode" from the disjunctive negation of
    // the compound guard above, so this repeats the discriminant check — always false at runtime
    // here — purely to narrow `existingNode` for the assignments below.
    if (existingNode.kind !== "semantic" || existingSlot === undefined) continue;
    const current = existingNode;
    // Existing semantic node: emit only what changed.
    place(existingSlot, parentId);
    if (current.label?.fallback !== n.label)
      ops.push({
        type: "setLabel",
        nodeId: n.id,
        label: { key: current.label?.key ?? `${n.id}.label`, fallback: n.label },
      });
    if (!sameJson(current.props, n.props)) {
      const removedKeys = Object.keys(current.props).filter((k) => !(k in n.props));
      if (removedKeys.length > 0)
        findings.push(
          warn(
            "props-not-removed",
            `node "${n.id}": setProps merges, so ${removedKeys.map((k) => `"${k}"`).join(", ")} cannot be removed this way and will remain`,
            n.id
          )
        );
      // A patch is worth emitting only if it SETS something: a new key, or a retained key whose
      // value changed. A draft that only drops a key (already reported above) would merge back
      // in as a no-op — patch === current on every key `apply` can actually change — so skip it.
      const setsSomething = Object.keys(n.props).some(
        (k) => !(k in current.props) || !sameJson(current.props[k], n.props[k])
      );
      if (setsSomething) ops.push({ type: "setProps", nodeId: n.id, patch: n.props });
    }
    // Span is structural, not a prop, so it moves through `setPlacement`. Only `span` is named:
    // the draft carries no grid placement, and an absent field is unchanged, so a row/column
    // the user or app set survives the revision. Exception: `describeExperience` never shows the
    // model a `column`, so a widening span on an already-placed node can overflow the grid —
    // core refuses that at the op (`placement-out-of-range`), which would fail the whole plan for
    // a change the model had no way to avoid. Pre-empt it: when the current column would overflow
    // under the new span, clamp `column` down to the widest position the new span still fits, in
    // the SAME op.
    diffSpan(current, n.span);
    // The class the node ends up with. A model may RAISE a class (that is what `model-may-set`
    // admits) but never LOWER one: a draft is the least trusted input in the pipeline, and
    // "declassify this" is precisely the instruction a prompt injection would carry. The clamp
    // is `strictest`, so the monotone direction is the data's own ordering (secret > sensitive >
    // internal), not a rule restated here. It is unconditional: a class on a caller-only type
    // never reaches a well-formed draft (`planSchema` refuses it), and if one does arrive through
    // a direct `materialize` call it still may not weaken what the node carries.
    const currentClass = current.binding?.sensitivity;
    const clamped = strictest(currentClass, bound?.sensitivity);
    // `bindProvider`'s apply merges (`op.sensitivity ?? existing`), so no op can DROP a class and
    // no op is needed to KEEP one: the only class worth carrying is a clamp that actually moved.
    const classChanged = clamped !== currentClass;
    if (
      entry.sensitivity === "model-may-set" &&
      bound !== undefined &&
      currentClass !== undefined
    ) {
      if (bound.sensitivity === undefined)
        findings.push(
          warn(
            "sensitivity-not-removed",
            `node "${n.id}": the merge cannot remove a class, so "${currentClass}" remains; dropping one needs remove + insert`,
            n.id
          )
        );
      else if (bound.sensitivity !== clamped)
        findings.push(
          warn(
            "sensitivity-not-lowered",
            `node "${n.id}": a class may only be raised, so "${currentClass}" remains ("${bound.sensitivity}" ignored)`,
            n.id
          )
        );
    }
    if (
      bound !== undefined &&
      (current.binding?.handle !== bound.handle ||
        current.binding?.priority !== bound.priority ||
        classChanged)
    )
      ops.push({
        type: "bindProvider",
        nodeId: n.id,
        handle: bound.handle,
        priority: bound.priority,
        ...(classChanged && clamped !== undefined && { sensitivity: clamped }),
      });
    if (current.type !== entry.name || current.typeVersion !== entry.version)
      findings.push(
        warn(
          "type-unchanged",
          `node "${n.id}": changing type ${current.type}@${current.typeVersion} → ${entry.name}@${entry.version} needs remove + insert; ignored`,
          n.id
        )
      );
  }
  removals(existing, region, seen, findings, ops);
  // Last of all: a remove or a rebind can leave a provider no node binds any more. Left in
  // place it keeps its stale pin forever, and a pin-freshness check fails on data nothing shows.
  ops.push(...orphanedProviders(base, ops));
  return { ops, findings };
}

export type { ContainerNode };
