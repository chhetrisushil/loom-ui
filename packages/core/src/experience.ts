import { z } from "zod";
import { classResidue } from "./classes";
import {
  type ContainerNode,
  ExperienceNode,
  MAX_TREE_DEPTH,
  Sensitivity,
  normalize,
  treeDepth,
} from "./node";

// ── The artifact ──────────────────────────────────────────────────────────────
// `experienceId` names a LINEAGE; `versionHash` names one ARTIFACT — the sha256 of everything
// except `versionHash` itself and `meta` (authorship is not identity: two authors producing the
// same structure converge on one hash, which is what content addressing is for). `parents` IS
// included: a genesis and a same-content edit-back are distinct nodes in the version graph.
// `intent` is inside the hash and no operation may change it (operations.ts has no such op).

export const Intent = z.object({
  objective: z.string().min(1),
  source: z.enum(["user", "agent", "application", "system"]),
  constraints: z.array(z.unknown()).optional(),
  /**
   * The confidentiality class of the objective text itself. The objective is the default
   * Blueprint title, so a classified one is shown only to a viewer cleared for it (`compile`
   * omits the title otherwise). Optional with no default: an Experience written before this
   * field hashes the same.
   */
  sensitivity: Sensitivity.optional(),
});
export type Intent = z.infer<typeof Intent>;

export const MCPToolNode = z.object({
  stepId: z.string().min(1),
  toolName: z.string().min(1),
  toolVersion: z.string(),
  toolSchemaHash: z.string().min(1), // pinned at plan time — makes drift detectable
  arguments: z.record(z.unknown()),
  dependsOn: z.array(z.string()).default([]),
  idempotent: z.boolean().default(true),
  /**
   * Top-level `arguments` keys a per-load param may replace (or supply when absent) — a
   * time-range picker's `from`/`to`, a filter's value. Nothing else is overridable, and an
   * argument holding a `{{steps.…}}` template never is: it is another step's output. Optional
   * with no default: a step written before this field hashes the same.
   */
  overridable: z.array(z.string().min(1)).optional(),
});
export type MCPToolNode = z.infer<typeof MCPToolNode>;

export const ProviderSpec = z.object({
  handle: z.string().min(1),
  executionGraph: z.array(MCPToolNode),
  /**
   * How the terminal step's raw output becomes the value widgets bind to.
   * - `QuickJS`: `scriptRef` is a ContentStore address (`sha256:…`) of a script run in
   *   `@loom/plugin-sandbox` with the raw output as `input`.
   * - `JSONPath`: `scriptRef` holds the path expression INLINE — a dotted path with optional
   *   `[i]` indices (`result.items[0].value`); `""` or `$` selects the whole output. A path is
   *   tiny and human-readable, so content-addressing it buys nothing. (Slice-3 ruling.)
   * - `Named`: `scriptRef` is the NAME of a reshaper the host registered with hydration (a
   *   `ReshaperRegistry`); it runs in-process as host code — no sandbox hop. An unregistered name
   *   is a finding, never a fall-through to another engine.
   */
  reshaping: z.object({
    engine: z.enum(["JSONPath", "QuickJS", "Named"]),
    scriptRef: z.string(),
  }),
  outputShapeHash: z.string(),
  /**
   * How the reshaped value is checked before it is published.
   * - absent or `"shape"`: its structural shape hash must equal `outputShapeHash` (`""` = unchecked,
   *   reported as a warning).
   * - `"contract"`: it must satisfy the value contract (`checkKindValue`) of EVERY kind the
   *   handle's bound nodes resolve to on the surface being hydrated (`handleKinds`); the caller
   *   supplies those kinds, and `outputShapeHash` is not read. A shape hash tells `[]` from
   *   `[{…}]` and `null` from a number, so under `"shape"` an empty result set or a null cell
   *   reads as drift; under `"contract"` drift is a value the widget cannot render.
   * Input drift (a tool's schema pin) is checked the same way under both.
   * Optional with no default: an Experience written before this field hashes the same.
   */
  outputCheck: z.enum(["shape", "contract"]).optional(),
  cachePolicy: z.object({ ttlSeconds: z.number(), scope: z.enum(["principal", "global"]) }),
});
export type ProviderSpec = z.infer<typeof ProviderSpec>;

export const VocabularyFloor = z.object({
  types: z.array(z.object({ name: z.string().min(1), version: z.string().min(1) })),
});
export type VocabularyFloor = z.infer<typeof VocabularyFloor>;

export const Experience = z.object({
  experienceId: z.string().min(1),
  versionHash: z.string(), // "" until sealed (log.ts)
  parents: z.array(z.string()),
  intent: Intent,
  root: ExperienceNode,
  providers: z.record(z.string(), ProviderSpec),
  /**
   * The confidentiality class of each HANDLE, sticky: a handle is as classified as the strictest
   * class any node EVER bound it with, so removing (or rebinding away) every node that carried a
   * class does not declassify it. Folded in by `insertNode` / `removeNode` / `bindProvider`
   * (`strictest`, never lower); only the explicit `declassifyHandle` op lowers an entry, and no
   * planner path emits it. Optional with no default; only the part the live nodes do not imply is
   * hashed, so an Experience whose classified nodes are all still present hashes the same as before
   * this field existed.
   */
  handleClasses: z.record(z.string(), Sensitivity).optional(),
  /**
   * The confidentiality class of each TOOL (by `toolName`), sticky like `handleClasses`: a handle id
   * hashes its arguments and path, so a changed argument is a NEW handle, and without this the new
   * handle would be born unclassified. Folded in by the provider and binding ops; a NEW handle on
   * a tool that ever carried a class inherits the strictest one (`remapProvider`), with a
   * `sensitivity-inherited` warn from the planner, and EVERY handle on the tool — including one
   * bound before the tool was classified — reads at least the tool's class (`effectiveClasses`, read
   * time). Lowered only by `declassifyHandle { tool: true }`.
   * Optional, and only the part live nodes do not imply is hashed (see `experienceArtifact`).
   */
  toolClasses: z.record(z.string(), Sensitivity).optional(),
  vocabularyFloor: VocabularyFloor,
  meta: z.object({ author: z.string(), createdAt: z.string(), sourceKind: z.string() }),
});
export type Experience = z.infer<typeof Experience>;

/** One reported condition. Never thrown; a rate can be computed over findings, an exception cannot. */
export interface Finding {
  readonly code: string;
  readonly severity: "error" | "warn";
  readonly message: string;
  readonly nodeId?: string;
}

/** The hashable projection: identity minus `versionHash` (the hash of this) and `meta`. */
export function experienceArtifact(exp: Experience): unknown {
  return {
    experienceId: exp.experienceId,
    parents: [...exp.parents].sort(),
    intent: exp.intent,
    root: normalize(exp.root),
    providers: exp.providers,
    vocabularyFloor: exp.vocabularyFloor,
    // Only the class residue beyond what live nodes imply: an experience whose classified nodes are
    // all still present hashes exactly as it did before classes were stored. The hash changes only
    // when a class outlives the node that carried it (removed or rebound) or is inherited by tool.
    ...classResidue(exp),
  };
}

export interface GenesisInput {
  experienceId: string;
  intent: Intent;
  meta: Experience["meta"];
  root?: ContainerNode;
  vocabularyFloor?: VocabularyFloor;
}

/**
 * A new lineage: unpersisted, parentless, with an empty 12-column GRID root unless one is supplied.
 *
 * The root is a grid, not a column, because every child carries a `span` 1–12 and the planner
 * asks the model for one ("a 12-column row"); only a grid parent turns that span into a cell —
 * under a `row`/`column` parent compile drops it without a finding (ADR 0097 D5).
 *
 * THROWS if a supplied `root` nests past {@link MAX_TREE_DEPTH}. Unlike `apply`/`compile`, which
 * receive trees from the outside and refuse them with a finding, `genesis` is handed a tree the
 * caller just built: a tree that deep is a programmer error at the point it is constructed, and
 * admitting it here would seed a lineage every later entry point has to refuse.
 */
export function genesis(input: GenesisInput): Experience {
  if (input.root !== undefined) {
    const depth = treeDepth(input.root);
    if (depth > MAX_TREE_DEPTH)
      throw new Error(
        `genesis: the supplied root nests ${depth} levels, over the ${MAX_TREE_DEPTH} limit`
      );
  }
  return {
    experienceId: input.experienceId,
    versionHash: "",
    parents: [],
    intent: input.intent,
    root: input.root ?? {
      id: "root",
      order: "V",
      kind: "container",
      direction: "grid",
      span: 12,
      children: [],
    },
    providers: {},
    vocabularyFloor: input.vocabularyFloor ?? { types: [] },
    meta: input.meta,
  };
}
