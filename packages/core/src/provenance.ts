import type { DataClass } from "@loom/classify";
import { type UntrustedText, boundSummary, inspectExperience, untrustedSummary } from "./change";
import { type DeclaredToolClasses, type UndeclaredToolPolicy, toolsOf } from "./classes";
import type { Experience } from "./experience";
import { type ExperienceNode, findNode } from "./node";
import type { Operation, Provenance, RecordedOperation } from "./operations";
import type { ProjectionCatalog } from "./projections";
import { type Viewer, mayView, strictestClass } from "./viewer";

// ── Per-node provenance and the "why is this here" explanation (U12) ──────────
// Every recorded op already says WHO (`RecordedOperation.by`); what was missing is the other
// direction: given a NODE, which op created it, which last changed it, which planner decision
// stood behind that, and what the node is fed from. Two halves:
//
//   1. A LEDGER, folded from the lineage's recorded ops. It is a derived index, never part of the
//      artifact or its content address (the log stays the source of truth; the ledger is
//      recomputable from it). It names ids and handles only — never node content, props or values —
//      so holding it leaks nothing a viewer is not shown by `explainNode`.
//   2. `explainNode`, a PURE, VIEWER-SAFE reader: it reads the ledger and the version a viewer is
//      looking at and answers for ONE viewer. It judges visibility with the same inspection
//      `describeChange` uses (`inspectExperience`), so the two cannot disagree.
//
// FAIL-CLOSED. A node the viewer may not see, a node that does not exist and a node the ledger
// cannot read all answer the SAME bare `{ available: false }`: the answer is no oracle for which of
// the three it was. Model text (the planner's summary, the request that prompted the change) is
// carried as `UntrustedText`, bounded and stripped, never an instruction, and shown only when the
// viewer may see the strictest class of everything either version holds and of whatever the
// planner read (`summaryClass`), exactly as `describeChange` shows a summary.

/** Most nodes a ledger tracks; a node beyond it simply has no recorded origin (and says so). */
export const MAX_LEDGER_NODES = 20_000;
/** Most ops one step contributes, nested `prompt.materialized` ops INCLUDED (one shared budget); the rest are not folded and the ledger is marked truncated. */
export const MAX_STEP_OPS = 10_000;
/** How deep `prompt` ops may nest while being folded. */
const MAX_PROMPT_NEST = 16;
/** Longest a recorded provenance string is kept at. */
const MAX_FIELD = 128;

/** One version's contribution to a ledger. A lineage `VersionRecord` satisfies it structurally. */
export interface ProvenanceStep {
  readonly versionHash: string;
  readonly at: string;
  readonly by: Provenance;
  /** The ops folded onto the parent (`[]` for anything but a composed version). */
  readonly ops: readonly RecordedOperation[];
}

/** Who/what/when of one recorded change. Strings are bounded and stripped of control characters. */
export interface ProvenanceEntry {
  readonly versionHash: string;
  readonly at: string;
  readonly by: Provenance;
  /** The op that did it (a `prompt`'s materialised ops are reported as themselves, `viaPrompt` set). */
  readonly op: Operation["type"];
  readonly viaPrompt: boolean;
  /** The request text of the prompt this came from: UNTRUSTED, bounded; gated by `explainNode`. */
  readonly prompt?: string;
}

export interface NodeLedger {
  /** The op that inserted the node; absent when it predates the ledger (see `origin`). */
  readonly created?: ProvenanceEntry;
  /** The latest op that changed it after creation. */
  readonly changed?: ProvenanceEntry;
  /** How many ops changed it after creation (saturates at `MAX_STEP_OPS * 100`). */
  readonly changes: number;
}

export interface ProvenanceLedger {
  readonly nodes: ReadonlyMap<string, NodeLedger>;
  /** The latest op to bind, remap, declassify or remove each provider handle. */
  readonly providers: ReadonlyMap<string, ProvenanceEntry>;
  /** The latest declassify of each projection. */
  readonly projections: ReadonlyMap<string, ProvenanceEntry>;
  /**
   * Where a node with no recorded creation comes from: the line's first version (or, for a branch,
   * the version it forked). `null` = unknown (the ledger could not be built that far).
   */
  readonly origin: {
    readonly versionHash: string;
    readonly at: string;
    readonly by: Provenance;
  } | null;
  /** The ledger dropped something at a cap: an absent node means "not recorded", not "never changed". */
  readonly truncated: boolean;
}

const cleanField = (v: unknown): string | undefined => {
  const t = boundSummary(v);
  if (t === undefined) return undefined;
  const points = [...t];
  return points.length <= MAX_FIELD ? t : points.slice(0, MAX_FIELD).join("");
};

/** A bounded, stripped copy of a provenance claim (it comes from an untrusted log). */
export function cleanProvenance(p: Provenance): Provenance {
  const source =
    p.source === "user" || p.source === "agent" || p.source === "application" ? p.source : "system";
  const agentId = cleanField(p.agentId);
  const modelId = cleanField(p.modelId);
  const ref = cleanField(p.ref);
  const decisionId = cleanField(p.decisionId);
  const policyDecisionId = cleanField(p.policyDecisionId);
  return {
    source,
    ...(agentId !== undefined && { agentId }),
    ...(modelId !== undefined && { modelId }),
    ...(ref !== undefined && { ref }),
    ...(decisionId !== undefined && { decisionId }),
    ...(policyDecisionId !== undefined && { policyDecisionId }),
  };
}

/** A ledger with nothing folded in. `origin` is where unrecorded nodes are said to come from. */
export function emptyLedger(origin: ProvenanceLedger["origin"] = null): ProvenanceLedger {
  return {
    nodes: new Map(),
    providers: new Map(),
    projections: new Map(),
    origin:
      origin === null
        ? null
        : { versionHash: origin.versionHash, at: origin.at, by: cleanProvenance(origin.by) },
    truncated: false,
  };
}

interface Ctx {
  base: Omit<ProvenanceEntry, "op" | "viaPrompt" | "prompt">;
  readonly nodes: Map<string, NodeLedger>;
  readonly providers: Map<string, ProvenanceEntry>;
  readonly projections: Map<string, ProvenanceEntry>;
  truncated: boolean;
  /** Ops this step may still fold, nested `prompt.materialized` ops INCLUDED (shared, not per array). */
  budget: number;
}

function entryOf(ctx: Ctx, op: Operation["type"], prompt: string | undefined): ProvenanceEntry {
  return {
    ...ctx.base,
    op,
    viaPrompt: prompt !== undefined,
    ...(prompt !== undefined && { prompt }),
  };
}

function created(ctx: Ctx, id: string, entry: ProvenanceEntry): void {
  if (!ctx.nodes.has(id) && ctx.nodes.size >= MAX_LEDGER_NODES) {
    ctx.truncated = true;
    return;
  }
  ctx.nodes.set(id, { created: entry, changes: 0 });
}

function changed(ctx: Ctx, id: string, entry: ProvenanceEntry): void {
  const cur = ctx.nodes.get(id);
  if (cur === undefined && ctx.nodes.size >= MAX_LEDGER_NODES) {
    ctx.truncated = true;
    return;
  }
  ctx.nodes.set(id, {
    ...(cur?.created !== undefined && { created: cur.created }),
    changed: entry,
    changes: Math.min((cur?.changes ?? 0) + 1, MAX_STEP_OPS * 100),
  });
}

function foldOp(ctx: Ctx, op: Operation, prompt: string | undefined, depth: number): void {
  if (typeof op !== "object" || op === null) return;
  if (ctx.budget <= 0) {
    ctx.truncated = true;
    return;
  }
  ctx.budget -= 1;
  const entry = () => entryOf(ctx, op.type, prompt);
  switch (op.type) {
    case "insertNode": {
      const e = entry();
      // Iterative: a node tree is untrusted here (the log is), so no recursion over its depth.
      const stack: ExperienceNode[] = [op.node];
      const visited = new Set<object>(); // a shared or cyclic subtree is walked once
      for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
        if (typeof n !== "object" || n === null || typeof n.id !== "string") continue;
        if (visited.has(n)) continue;
        visited.add(n);
        created(ctx, n.id, e);
        if (n.kind === "container" && Array.isArray(n.children))
          for (const c of n.children) stack.push(c);
      }
      return;
    }
    case "removeNode":
      // The entry is left: only nodes that exist in the version being explained are looked up,
      // and a re-insert of the same id resets it.
      return;
    case "moveNode":
    case "setProps":
    case "setLabel":
    case "setTitle":
    case "setRole":
    case "setPlacement":
    case "bindProjection":
    case "unbindProvider":
      changed(ctx, op.nodeId, entry());
      return;
    case "bindProvider": {
      const e = entry();
      changed(ctx, op.nodeId, e);
      ctx.providers.set(op.handle, e);
      return;
    }
    case "remapProvider":
    case "removeProvider":
    case "declassifyHandle":
      ctx.providers.set(op.handle, entry());
      return;
    case "declassifyProjection":
      ctx.projections.set(op.projection, entry());
      return;
    case "prompt": {
      if (depth >= MAX_PROMPT_NEST || !Array.isArray(op.materialized)) {
        ctx.truncated = true;
        return;
      }
      const text = boundSummary(op.text) ?? "";
      for (const inner of op.materialized) foldOp(ctx, inner, text, depth + 1);
      return;
    }
    default:
      return;
  }
}

/**
 * `base` with `steps` (oldest first) folded in. Pure and total: `base` is never mutated, a
 * malformed step is skipped and marks the ledger truncated, and the work is bounded by
 * `MAX_STEP_OPS` per step and `MAX_LEDGER_NODES` overall.
 */
export function foldProvenance(
  base: ProvenanceLedger,
  steps: readonly ProvenanceStep[]
): ProvenanceLedger {
  const ctx: Ctx = {
    base: { versionHash: "", at: "", by: { source: "system" } },
    nodes: new Map(base.nodes),
    providers: new Map(base.providers),
    projections: new Map(base.projections),
    truncated: base.truncated,
    budget: 0,
  };
  for (const step of steps) {
    try {
      const ops = Array.isArray(step.ops) ? step.ops : [];
      if (ops.length > MAX_STEP_OPS) ctx.truncated = true;
      ctx.budget = MAX_STEP_OPS;
      for (const rec of ops.slice(0, MAX_STEP_OPS)) {
        ctx.base = {
          versionHash: cleanField(step.versionHash) ?? "",
          at: cleanField(rec.at) ?? cleanField(step.at) ?? "",
          by: cleanProvenance(rec.by ?? step.by),
        };
        foldOp(ctx, rec.op, undefined, 0);
      }
    } catch {
      ctx.truncated = true;
    }
  }
  return {
    nodes: ctx.nodes,
    providers: ctx.providers,
    projections: ctx.projections,
    origin: base.origin,
    truncated: ctx.truncated,
  };
}

// ── the explanation ───────────────────────────────────────────────────────────

/** What a node is fed from. Tool and handle names only: never an argument, path or value. */
export type NodeSource =
  | { readonly kind: "static" }
  | {
      readonly kind: "provider";
      readonly handle: string;
      /** `toolKey`s the provider calls (`name` for MCP, `<kind>:<name>` otherwise). */
      readonly tools: readonly string[];
      /** The latest op that bound, remapped or declassified the provider. */
      readonly lastChanged?: ExplainedEntry;
    }
  | {
      readonly kind: "projection";
      readonly id: string;
      readonly version: string;
      readonly lastChanged?: ExplainedEntry;
    };

/** A ledger entry as shown to a viewer: the request text is not here (see `NodeExplanation.prompt`). */
export interface ExplainedEntry {
  readonly versionHash: string;
  readonly at: string;
  readonly by: Provenance;
  readonly op: Operation["type"] | "origin";
  readonly viaPrompt: boolean;
}

export type NodeExplanation =
  | {
      /** Unknown node, node hidden from this viewer, or an unreadable input: indistinguishable. */
      readonly available: false;
    }
  | {
      readonly available: true;
      readonly nodeId: string;
      readonly kind: "container" | "semantic";
      /** The catalogue type of a semantic node. */
      readonly type?: string;
      readonly source: NodeSource;
      /** Who created it. `op: "origin"` = it predates the ledger; the entry is the line's start. */
      readonly created?: ExplainedEntry;
      readonly changed?: ExplainedEntry;
      readonly changes: number;
      /**
       * What the author said about the version that created the node (a planner's summary). It
       * describes that whole version, not this node. UNTRUSTED, bounded; absent when not recorded
       * or when this viewer may not see everything it could have been written from.
       */
      readonly why?: UntrustedText;
      /** The request that prompted the creating op (a `prompt` op's text). UNTRUSTED; gated like `why`. */
      readonly prompt?: UntrustedText;
      /** The ledger dropped something at a cap, so `changes` may undercount. */
      readonly truncated: boolean;
    };

const UNAVAILABLE: NodeExplanation = Object.freeze({ available: false as const });

export interface VersionNote {
  readonly summary?: string;
  /** The class of what the summary was written from (host-stamped at compose). */
  readonly summaryClass?: DataClass;
}

export interface ExplainOptions {
  /** Who the answer is for. Absent = no clearance (fail-closed). */
  readonly viewer?: Viewer;
  /** The ledger of `experience`'s version. */
  readonly ledger: ProvenanceLedger;
  /** The same projection catalogue `compile` takes (absent = every projection node is hidden). */
  readonly projections?: ProjectionCatalog;
  readonly hydrationProjectionId?: string;
  /**
   * The host's DECLARED class per tool (`toolKey`: the MCP tool name, or `<kind>:<name>`), applied
   * at read time as a floor under every handle calling that tool — see `DeclaredToolClasses`.
   * Absent = only what the experience itself carries.
   */
  readonly declaredToolClasses?: DeclaredToolClasses;
  /**
   * What a tool the `declaredToolClasses` table does not list reads as: `"allow"` (default) = as the
   * experience itself says; `"deny"` = unreadable by every viewer. Only with a table present.
   */
  readonly undeclared?: UndeclaredToolPolicy;
  /** What each version's author said, by version hash (a lineage supplies it from its events). */
  readonly notes?: ReadonlyMap<string, VersionNote>;
  /**
   * The strictest class of the OTHER versions a summary or prompt was written against (the version
   * that created the node, and the one that last changed it). `explainNode` reads only the version
   * it is given, and a class can be lowered between versions, so a host that has them passes their
   * floor here. Absent = the viewed version's floor alone.
   */
  readonly extraFloor?: DataClass;
}

const own = <V>(m: ReadonlyMap<string, V>, k: string): V | undefined => m.get(k);

function explained(e: ProvenanceEntry): ExplainedEntry {
  return {
    versionHash: e.versionHash,
    at: e.at,
    by: e.by,
    op: e.op,
    viaPrompt: e.viaPrompt,
  };
}

/**
 * Why is `nodeId` in `experience`, for `opts.viewer`? Pure and total: it never throws, and anything
 * it cannot answer for the viewer is `{ available: false }`.
 */
export function explainNode(
  experience: Experience,
  nodeId: string,
  opts: ExplainOptions
): NodeExplanation {
  try {
    const inspected = inspectExperience(experience, opts);
    if (!inspected.readable) return UNAVAILABLE;
    const view = inspected.nodes.get(nodeId);
    if (view === undefined || view.blocked || !mayView(opts.viewer, view.cls)) return UNAVAILABLE;
    const node = findNode(experience.root, nodeId);
    if (node === undefined) return UNAVAILABLE;

    const ledgerNode = own(opts.ledger.nodes, nodeId);
    const origin = opts.ledger.origin;
    const createdEntry: ExplainedEntry | undefined =
      ledgerNode?.created !== undefined
        ? explained(ledgerNode.created)
        : origin === null
          ? undefined
          : {
              versionHash: origin.versionHash,
              at: origin.at,
              by: origin.by,
              op: "origin",
              viaPrompt: false,
            };

    // The text is judged against everything either version holds, and what the planner read.
    const floor = strictestClass(inspected.floor, opts.extraFloor);
    const noteOf = (v: string | undefined): VersionNote | undefined =>
      v === undefined ? undefined : opts.notes?.get(v);
    const note = noteOf(ledgerNode?.created?.versionHash ?? origin?.versionHash);
    const textOk =
      !inspected.anyBlocked && mayView(opts.viewer, strictestClass(floor, note?.summaryClass));
    const why = textOk ? untrustedSummary(note?.summary) : undefined;
    const prompt = textOk ? untrustedSummary(ledgerNode?.created?.prompt) : undefined;

    return {
      available: true,
      nodeId,
      kind: node.kind,
      ...(node.kind === "semantic" && { type: node.type }),
      source: sourceOf(experience, node, opts.ledger),
      ...(createdEntry !== undefined && { created: createdEntry }),
      ...(ledgerNode?.changed !== undefined && { changed: explained(ledgerNode.changed) }),
      changes: ledgerNode?.changes ?? 0,
      ...(why !== undefined && { why }),
      ...(prompt !== undefined && { prompt }),
      truncated: opts.ledger.truncated,
    };
  } catch {
    return UNAVAILABLE;
  }
}

function sourceOf(exp: Experience, node: ExperienceNode, ledger: ProvenanceLedger): NodeSource {
  if (node.kind !== "semantic") return { kind: "static" };
  if (node.binding !== undefined) {
    const handle = node.binding.handle;
    const spec = Object.hasOwn(exp.providers, handle) ? exp.providers[handle] : undefined;
    const last = own(ledger.providers, handle);
    return {
      kind: "provider",
      handle,
      tools: spec === undefined ? [] : toolsOf(spec),
      ...(last !== undefined && { lastChanged: explained(last) }),
    };
  }
  if (node.projection !== undefined) {
    const last = own(ledger.projections, node.projection.id);
    return {
      kind: "projection",
      id: node.projection.id,
      version: node.projection.version,
      ...(last !== undefined && { lastChanged: explained(last) }),
    };
  }
  return { kind: "static" };
}
