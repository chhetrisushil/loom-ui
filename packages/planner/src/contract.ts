import {
  type SemanticCatalog,
  type SemanticEntry,
  compareVersions,
  findEntry,
} from "@loom-ui/core";
import { z } from "zod";
import type { CapabilityRef } from "./spi";

export const DRAFT_ID = /^[a-z][a-z0-9_]{0,31}$/;
export const MAX_DRAFT_NODES = 24;

export interface DraftBinding {
  readonly capability: string;
  readonly arguments: Record<string, unknown>;
  /** Inline dotted JSONPath over the tool's raw output; "" or "$" selects the whole output. */
  readonly path: string;
  readonly priority: "P0" | "P1" | "P2";
}
export interface DraftNode {
  readonly id: string;
  readonly type: string;
  readonly version?: string;
  readonly label: string;
  readonly span: number;
  readonly props: Record<string, unknown>;
  readonly binding?: DraftBinding;
}
export interface PlanDraft {
  readonly summary: string;
  readonly nodes: readonly DraftNode[];
}

/** Resolve a draft's type to a catalogue entry: exact version when given, else the latest. */
export function entryFor(
  catalog: SemanticCatalog,
  type: string,
  version?: string
): SemanticEntry | undefined {
  if (version !== undefined) return findEntry(catalog, type, version);
  let best: SemanticEntry | undefined;
  for (const e of catalog.entries) {
    if (e.name !== type) continue;
    if (best === undefined || compareVersions(e.version, best.version) > 0) best = e;
  }
  return best;
}

/**
 * The model's output contract, DERIVED from the catalogue and the capabilities the caller handed
 * over (spec §7.1). Anything the catalogue does not declare is a schema issue here, not a finding
 * later — so the retry message names the exact path.
 */
export function planSchema(
  catalog: SemanticCatalog,
  capabilities: readonly CapabilityRef[]
): z.ZodType<PlanDraft> {
  const handles = new Set(capabilities.map((c) => c.handle));
  const node = z
    .object({
      id: z.string().regex(DRAFT_ID, "id must match ^[a-z][a-z0-9_]{0,31}$"),
      type: z.string().min(1),
      version: z.string().min(1).optional(),
      label: z.string().min(1).max(120),
      span: z.number().int().min(1).max(12).default(6),
      props: z.record(z.unknown()).default({}),
      binding: z
        .object({
          capability: z.string().min(1),
          arguments: z.record(z.unknown()).default({}),
          path: z.string().default(""),
          priority: z.enum(["P0", "P1", "P2"]).default("P1"),
        })
        .optional(),
    })
    .superRefine((n, ctx) => {
      const entry = entryFor(catalog, n.type, n.version);
      if (entry === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["type"],
          message: `"${n.type}"${n.version ? `@${n.version}` : ""} is not in catalogue "${catalog.id}"`,
        });
        return;
      }
      const allowed = new Set(entry.props);
      for (const key of Object.keys(n.props)) {
        if (!allowed.has(key))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["props", key],
            message: `"${entry.name}" does not declare prop "${key}" (allowed: ${entry.props.join(", ") || "none"})`,
          });
      }
      if (entry.binding === "required" && n.binding === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["binding"],
          message: `"${entry.name}" requires a binding`,
        });
      if (entry.binding === "none" && n.binding !== undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["binding"],
          message: `"${entry.name}" does not bind data; omit binding`,
        });
      if (n.binding !== undefined && !handles.has(n.binding.capability))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["binding", "capability"],
          message: `capability "${n.binding.capability}" was not offered (offered: ${[...handles].join(", ") || "none"})`,
        });
    });
  return z
    .object({
      summary: z.string().min(1).max(600),
      nodes: z.array(node).min(1).max(MAX_DRAFT_NODES),
    })
    .superRefine((d, ctx) => {
      const seen = new Set<string>();
      d.nodes.forEach((n, i) => {
        if (seen.has(n.id))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["nodes", i, "id"],
            message: `duplicate node id "${n.id}"`,
          });
        seen.add(n.id);
      });
    }) as unknown as z.ZodType<PlanDraft>;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; raw: string };

/** genUI's `parseWith`, ported: strip a code fence, JSON.parse, validate; never throws. */
export function parseModelJson<T>(schema: z.ZodType<T>, raw: string): Parsed<T> {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      raw: stripped.slice(0, 4000),
    };
  }
  const result = schema.safeParse(parsed);
  if (result.success) return { ok: true, value: result.data };
  const error = result.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("\n")
    .slice(0, 2000);
  return { ok: false, error, raw: stripped.slice(0, 4000) };
}
