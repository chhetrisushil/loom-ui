import { z } from "zod";
import { type ContainerNode, ExperienceNode, normalize } from "./node";

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
  reshaping: z.object({ engine: z.enum(["JSONPath", "QuickJS"]), scriptRef: z.string() }),
  outputShapeHash: z.string(),
  cachePolicy: z.object({ ttlSeconds: z.number(), scope: z.enum(["principal", "global"]) }),
});
export type ProviderSpec = z.infer<typeof ProviderSpec>;

export const VocabularyFloor = z.object({
  minVersion: z.string(),
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

/** A new lineage: unpersisted, parentless, with an empty column root unless one is supplied. */
export function genesis(input: GenesisInput): Experience {
  return {
    experienceId: input.experienceId,
    versionHash: "",
    parents: [],
    intent: input.intent,
    root: input.root ?? {
      id: "root",
      order: "V",
      kind: "container",
      direction: "column",
      span: 12,
      children: [],
    },
    providers: {},
    vocabularyFloor: input.vocabularyFloor ?? { minVersion: "0.0.0", types: [] },
    meta: input.meta,
  };
}
