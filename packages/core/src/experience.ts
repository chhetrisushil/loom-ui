import { z } from "zod";
import { type ContainerNode, ExperienceNode, MAX_TREE_DEPTH, normalize, treeDepth } from "./node";

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
   */
  reshaping: z.object({ engine: z.enum(["JSONPath", "QuickJS"]), scriptRef: z.string() }),
  outputShapeHash: z.string(),
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
