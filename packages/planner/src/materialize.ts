import {
  type ContainerNode,
  type Experience,
  type Finding,
  GRID_COLUMNS,
  type MCPToolNode,
  type Operation,
  type ProviderSpec,
  type SemanticCatalog,
  type SemanticNode,
  experienceHandles,
  inheritedClass,
  isContainer,
  nodeIds,
  orderKeyAfterAll,
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
import { type DraftBinding, type DraftNode, type PlanDraft, entryFor } from "./contract";
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

/**
 * Draft → operations by DIFFING against `base.root`'s direct children. Compose is the special
 * case where the base is an empty genesis. The reference planner authors a FLAT list under the
 * root (nested containers are the app's, untouched here); a draft id that names a container is
 * refused as `not-semantic`, and one that names a node NESTED inside such a container is refused
 * as `nested-node` — `describeExperience` never shows those, so a draft naming one is either a
 * hallucination or an instruction the model was told to ignore. Order: remapProvider before the bindProvider/insertNode that needs it; removals last — `removeNode`, then a `removeProvider` for every handle the plan orphaned (`orphanedProviders`).
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
  mint: { readonly orderSalt?: string } = {}
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
  const existing = new Map(root.children.map((c) => [c.id, c] as const));
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
  const siblings: Array<{ order: string }> = [...root.children];
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

  for (const n of draft.nodes) {
    seen.add(n.id);
    const entry = entryFor(catalog, n.type, n.version);
    if (entry === undefined) {
      findings.push(
        err(
          "unknown-type",
          `node "${n.id}" names "${n.type}", which is not in catalogue "${catalog.id}"`,
          n.id
        )
      );
      continue;
    }
    const existingNode = existing.get(n.id);
    // Refuse a container id BEFORE touching the binding: a draft node that collides with a
    // container must never resolve a capability, declare a provider, or leave a capability
    // finding behind — it is refused outright, with nothing else observable from it. The root
    // itself is a container that is not among its own children, so it is named explicitly.
    if (n.id === root.id || (existingNode !== undefined && existingNode.kind !== "semantic")) {
      findings.push(
        err(
          "not-semantic",
          `"${n.id}" is a container; the planner only authors semantic nodes`,
          n.id
        )
      );
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
        order: orderKeyAfterAll(siblings, { salt: mint.orderSalt }),
        kind: "semantic",
        type: entry.name,
        typeVersion: entry.version,
        span: n.span,
        label: { key: `${n.id}.label`, fallback: n.label },
        props: n.props,
        ...(bound !== undefined && { binding: bound }),
      };
      siblings.push(node);
      ops.push({ type: "insertNode", parentId: root.id, node });
      continue;
    }
    // TypeScript can't derive "existingNode is a SemanticNode" from the disjunctive negation of
    // the compound guard above, so this repeats the discriminant check — always false at runtime
    // here — purely to narrow `existingNode` for the assignments below.
    if (existingNode.kind !== "semantic") continue;
    const current = existingNode;
    // Existing semantic node: emit only what changed.
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
    if (current.span !== n.span) {
      const overflows = current.column !== undefined && current.column + n.span - 1 > GRID_COLUMNS;
      ops.push({
        type: "setPlacement",
        nodeId: n.id,
        span: n.span,
        ...(overflows && { column: GRID_COLUMNS - n.span + 1 }),
      });
    }
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
  for (const c of root.children) {
    if (!seen.has(c.id) && c.kind === "semantic") ops.push({ type: "removeNode", nodeId: c.id });
  }
  // Last of all: a remove or a rebind can leave a provider no node binds any more. Left in
  // place it keeps its stale pin forever, and a pin-freshness check fails on data nothing shows.
  ops.push(...orphanedProviders(base, ops));
  return { ops, findings };
}

export type { ContainerNode };
