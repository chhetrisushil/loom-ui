import {
  type ContainerRoleSpec,
  type SemanticCatalog,
  type SemanticEntry,
  Sensitivity,
  compareVersions,
  findEntry,
  roleChildProblems,
} from "@loom-ui/core";
import type { DataClass } from "@loom/classify";
import { z } from "zod";
import type { CapabilityRef } from "./spi";

export const DRAFT_ID = /^[a-z][a-z0-9_]{0,31}$/;
/** Most entries (widgets AND containers) in one reply. Was 24 flat nodes before containers (U15). */
export const MAX_DRAFT_NODES = 64;
/** Deepest nesting of a draft entry: a top-level entry is depth 1, a child of a top-level container 2. */
export const MAX_DRAFT_DEPTH = 4;
/** Most children of one container, the root included (the old flat cap). */
export const MAX_DRAFT_CHILDREN = 24;
/** Containers every host gets: a titled column, a row, a 12-column grid. Roles are offered on top. */
export const PLAIN_CONTAINERS = ["section", "row", "grid"] as const;

export interface DraftBinding {
  readonly capability: string;
  readonly arguments: Record<string, unknown>;
  /** Inline dotted JSONPath over the tool's raw output; "" or "$" selects the whole output. */
  readonly path: string;
  readonly priority: "P0" | "P1" | "P2";
  /**
   * The confidentiality class the model proposes for this binding's data. Admitted ONLY where the
   * catalogue entry says `sensitivity: "model-may-set"`; everywhere else it is the caller's to
   * set and a draft carrying one is a schema issue.
   */
  readonly sensitivity?: DataClass;
}
export interface DraftNode {
  readonly id: string;
  readonly type: string;
  readonly version?: string;
  readonly label: string;
  readonly span: number;
  readonly props: Record<string, unknown>;
  readonly binding?: DraftBinding;
  /** The id of an EARLIER container in the same reply this node sits in; absent = top level. */
  readonly parent?: string;
}
/**
 * A container entry (U15): `container` is a plain kind (`PLAIN_CONTAINERS`) or an offered role.
 * It carries no type, props or binding — it groups. `title` is its heading (a tab's or a step's
 * label for a role that needs one). `span` is its width where its parent is a grid.
 */
export interface DraftContainer {
  readonly id: string;
  readonly container: string;
  readonly title?: string;
  readonly span: number;
  readonly parent?: string;
}
export type DraftEntry = DraftNode | DraftContainer;
export const isDraftContainer = (e: DraftEntry): e is DraftContainer => "container" in e;
export interface PlanDraft {
  readonly summary: string;
  readonly nodes: readonly DraftEntry[];
}

/** The container kinds a reply may name: the plain ones plus the roles the host offered. */
export function containerKinds(roles: readonly ContainerRoleSpec[] = []): string[] {
  return [...PLAIN_CONTAINERS, ...roles.map((r) => r.role)];
}

export interface StructureIssue {
  /** Index into `nodes`. */
  readonly index: number;
  /** The field the issue is about. */
  readonly field: "parent" | "container" | "id" | "nodes";
  readonly message: string;
}

/**
 * The tree a reply's flat entries describe, checked: every `parent` names an EARLIER container
 * (so the list is a topological order and cannot cycle), nesting is at most `MAX_DRAFT_DEPTH`, a
 * container holds at most `MAX_DRAFT_CHILDREN`, a role container's children satisfy its spec, and
 * a container is not empty. Linear in the entries. `partial` is a PREFIX of a streamed reply: a
 * container's children may still be coming, so the emptiness and minimum-count rules are skipped.
 */
export function draftStructureIssues(
  entries: readonly DraftEntry[],
  roles: readonly ContainerRoleSpec[] = [],
  opts: { readonly partial?: boolean } = {}
): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const specs = new Map(roles.map((r) => [r.role, r] as const));
  const at = new Map<string, number>();
  const depth = new Map<string, number>();
  const kids = new Map<string | null, { id: string; isContainer: boolean; titled: boolean }[]>();
  entries.forEach((e, i) => {
    const parentId = e.parent ?? null;
    let d = 1;
    if (parentId !== null) {
      const pi = at.get(parentId);
      const p = pi === undefined ? undefined : entries[pi];
      if (pi === undefined || p === undefined)
        issues.push({
          index: i,
          field: "parent",
          message: `parent "${parentId}" is not an earlier container in this reply (list a container before its children)`,
        });
      else if (!isDraftContainer(p))
        issues.push({
          index: i,
          field: "parent",
          message: `parent "${parentId}" is a widget, not a container`,
        });
      else d = (depth.get(parentId) ?? 1) + 1;
    }
    if (d > MAX_DRAFT_DEPTH)
      issues.push({
        index: i,
        field: "parent",
        message: `"${e.id}" is nested ${d} deep; at most ${MAX_DRAFT_DEPTH} levels are allowed`,
      });
    if (!at.has(e.id)) {
      at.set(e.id, i);
      depth.set(e.id, d);
    }
    const list = kids.get(parentId) ?? [];
    list.push({
      id: e.id,
      isContainer: isDraftContainer(e),
      titled: isDraftContainer(e) && e.title !== undefined && e.title !== "",
    });
    kids.set(parentId, list);
  });
  const top = kids.get(null) ?? [];
  if (top.length > MAX_DRAFT_CHILDREN)
    issues.push({
      index: entries.length - 1,
      field: "nodes",
      message: `${top.length} top-level entries; at most ${MAX_DRAFT_CHILDREN} are allowed (group them in a container)`,
    });
  entries.forEach((e, i) => {
    if (!isDraftContainer(e)) return;
    const list = kids.get(e.id) ?? [];
    if (list.length > MAX_DRAFT_CHILDREN)
      issues.push({
        index: i,
        field: "container",
        message: `"${e.id}" holds ${list.length} children; at most ${MAX_DRAFT_CHILDREN} are allowed`,
      });
    if (list.length === 0 && opts.partial !== true)
      issues.push({ index: i, field: "container", message: `container "${e.id}" is empty` });
    const spec = specs.get(e.container);
    if (spec !== undefined && list.length > 0)
      for (const message of roleChildProblems(spec, list, opts))
        issues.push({ index: i, field: "container", message: `"${e.id}": ${message}` });
  });
  return issues;
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
export function draftNodeSchema(
  catalog: SemanticCatalog,
  capabilities: readonly CapabilityRef[]
): z.ZodType<DraftNode> {
  const handles = new Set(capabilities.map((c) => c.handle));
  const node = z
    .object({
      id: z.string().regex(DRAFT_ID, "id must match ^[a-z][a-z0-9_]{0,31}$"),
      type: z.string().min(1),
      version: z.string().min(1).optional(),
      label: z.string().min(1).max(120),
      span: z.number().int().min(1).max(12).default(6),
      props: z.record(z.unknown()).default({}),
      parent: z.string().regex(DRAFT_ID, "parent must be a node id").optional(),
      binding: z
        .object({
          capability: z.string().min(1),
          arguments: z.record(z.unknown()).default({}),
          path: z.string().default(""),
          priority: z.enum(["P0", "P1", "P2"]).default("P1"),
          sensitivity: Sensitivity.optional(),
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
      // An entry that says nothing means `"caller"` (catalog.ts): a class the model proposes is
      // refused unless the entry opts in by name. This is the ONLY reader of
      // `SemanticEntry.sensitivity` — the default lives here, not in a helper nobody else calls.
      if (n.binding?.sensitivity !== undefined && entry.sensitivity !== "model-may-set")
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["binding", "sensitivity"],
          message: `"${entry.name}" does not let the model set a sensitivity class`,
        });
    });
  return node as unknown as z.ZodType<DraftNode>;
}

/** A container entry's contract: an allowed kind, a short title, nothing else (`strict`: no props, no binding). */
export function draftContainerSchema(
  roles: readonly ContainerRoleSpec[] = []
): z.ZodType<DraftContainer> {
  const kinds = containerKinds(roles);
  return z
    .object({
      id: z.string().regex(DRAFT_ID, "id must match ^[a-z][a-z0-9_]{0,31}$"),
      container: z.string().refine((k) => kinds.includes(k), {
        message: `container must be one of: ${kinds.join(", ")}`,
      }),
      title: z.string().min(1).max(120).optional(),
      span: z.number().int().min(1).max(12).default(12),
      parent: z.string().regex(DRAFT_ID, "parent must be a node id").optional(),
    })
    .strict() as unknown as z.ZodType<DraftContainer>;
}

/**
 * One entry of the reply: a container when it carries a `container` key, else a widget node. The
 * dispatch keeps each branch's own issue paths (a union would bury them under `invalid_union`).
 */
export function draftEntrySchema(
  catalog: SemanticCatalog,
  capabilities: readonly CapabilityRef[],
  roles: readonly ContainerRoleSpec[] = []
): z.ZodType<DraftEntry> {
  const node = draftNodeSchema(catalog, capabilities);
  const container = draftContainerSchema(roles);
  return z.unknown().transform((raw, ctx): DraftEntry => {
    const isContainer =
      typeof raw === "object" && raw !== null && Object.hasOwn(raw as object, "container");
    const r = (isContainer ? container : node).safeParse(raw);
    if (r.success) return r.data;
    for (const issue of r.error.issues) ctx.addIssue(issue);
    // Handed on (never `z.NEVER`) so the whole-reply checks still see its id; marked so they know
    // it is not a valid entry and do not reason about its shape.
    const kept = (typeof raw === "object" && raw !== null ? raw : {}) as DraftEntry;
    INVALID_ENTRIES.add(kept);
    return kept;
  }) as unknown as z.ZodType<DraftEntry>;
}

const INVALID_ENTRIES = new WeakSet<object>();

/** The whole-reply contract, built from {@link draftEntrySchema}. */
export function planSchema(
  catalog: SemanticCatalog,
  capabilities: readonly CapabilityRef[],
  roles: readonly ContainerRoleSpec[] = []
): z.ZodType<PlanDraft> {
  const entry = draftEntrySchema(catalog, capabilities, roles);
  return z
    .object({
      summary: z.string().min(1).max(600),
      nodes: z.array(entry).min(1).max(MAX_DRAFT_NODES),
    })
    .superRefine((d, ctx) => {
      const seen = new Set<string>();
      d.nodes.forEach((n, i) => {
        if (typeof n.id !== "string") return;
        if (seen.has(n.id))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["nodes", i, "id"],
            message: `duplicate node id "${n.id}"`,
          });
        seen.add(n.id);
      });
      // Nesting is judged only over a reply whose entries are each valid: an entry already
      // reported has no trustworthy `parent`, and one issue per defect reads best.
      if (d.nodes.some((n) => INVALID_ENTRIES.has(n))) return;
      for (const i of draftStructureIssues(d.nodes, roles))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["nodes", i.index, i.field === "nodes" ? "id" : i.field],
          message: i.message,
        });
    }) as unknown as z.ZodType<PlanDraft>;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string; raw: string };

/** Strip a code fence, JSON.parse, validate; never throws. */
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
