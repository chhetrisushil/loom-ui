import type { DataClass } from "@loom/classify";
import type { Experience, ProviderSpec } from "./experience";
import { type ExperienceNode, walk } from "./node";
import type { ProjectionCatalog } from "./projections";
import { toolKey } from "./steps";
import { strictestClass } from "./viewer";

// ── Where a class lives ───────────────────────────────────────────────────────
// A node's `binding.sensitivity` is the class. Two sticky residues sit beside it so that removing
// or renaming nodes never lowers one: `Experience.handleClasses` (per HANDLE) and
// `Experience.toolClasses` (per TOOL: a handle id is a hash of tool, args and path, so a changed
// argument mints a new handle, and the class must follow the tool). This module reads them; the
// ops fold them. It imports no runtime from `experience.ts`, which hashes through it.

const own = <V>(rec: Readonly<Record<string, V>> | undefined, key: string): V | undefined =>
  rec !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;

/**
 * The tools a provider calls, by `toolKey`: the NAME for an MCP step, `<kind>:<name>` for any other
 * kind (a class sticks to a target within its kind). Name only, not name@version: a version bump (or an MCP
 * server re-listing the same tool) must not shed a class, and the spec carries no server
 * identity, so two servers' same-named tools share a class — which over-classifies, fail-closed.
 */
export function toolsOf(spec: ProviderSpec): string[] {
  return [...new Set(spec.executionGraph.map(toolKey))];
}

/**
 * A host-declared class per tool, keyed by `toolKey` (the MCP tool NAME, or `<kind>:<name>`), applied
 * at READ time as a floor under every handle whose provider calls that tool. Unlike the sticky
 * `Experience.toolClasses` it is not stored: it is the host's current declaration of what a
 * capability returns (the same `sensitivity` a planner's `CapabilityRef` carries), so a node written
 * by an older planner, or by a raw op, with no class of its own is still gated as strictly as the
 * tool is declared. It can only RAISE what a handle reads as; it never lowers anything.
 */
export type DeclaredToolClasses = Readonly<Record<string, DataClass>>;

/**
 * Join declared tables key by key, STRICTEST wins; an absent (`undefined`) table adds nothing. The
 * only way two tables may meet (a constructor-level one and a per-call one): a table can raise the
 * floor, never lower it, so `{}` or `undefined` passed per call cannot undo what the host bound.
 * Returns `undefined` when no table is present at all.
 */
export function mergeDeclaredToolClasses(
  ...tables: ReadonlyArray<DeclaredToolClasses | undefined>
): DeclaredToolClasses | undefined {
  let out: Record<string, DataClass> | undefined;
  for (const t of tables) {
    if (t === undefined || t === null) continue;
    out ??= Object.create(null) as Record<string, DataClass>;
    for (const [k, v] of Object.entries(t)) out[k] = strictestClass(out[k], v) as DataClass;
  }
  return out;
}

/**
 * What a handle calling a tool the declared table does NOT list reads as, under
 * `undeclared: "deny"`: a class no clearance ranks, so NO viewer may see it (fail-closed, as an
 * unrecognised class always is in `strictestClass`/`mayView`).
 */
export const UNDECLARED_TOOL_CLASS = "restricted" as DataClass;

/**
 * What a read does with a tool the declared table does not list: `"allow"` (the default) reads it
 * as the experience's own classes say; `"deny"` (opt-in, only when a table is present) reads any
 * handle whose provider calls such a tool as `UNDECLARED_TOOL_CLASS`. Raise-only: `"deny"` bound
 * once cannot be undone by a per-call `"allow"` (`mergeReadPolicy`), and it CLOSES the table's key
 * set: a later tier may raise a listed tool but not list a new one. With no table, `"deny"` means an
 * empty one — every tool-bound handle is unreadable.
 */
export type UndeclaredToolPolicy = "allow" | "deny";

/**
 * The host's read policy, bound ONCE where the host builds a reader (`Lineage`, `SeenLog`, the
 * change feed, the hydration serve surface) so no single read can forget it. The same names the
 * per-call options carry. Per-call values may only ADD to a bound policy (`mergeReadPolicy`).
 */
export interface ReadPolicy {
  /** A declared class per tool, a read-time floor (`DeclaredToolClasses`). Build it with the planner's `declaredToolClassesFrom(capabilities)`. */
  readonly declaredToolClasses?: DeclaredToolClasses;
  /** The projections the host offers (the catalogue `compile` takes). A bound catalogue wins over a per-call one. */
  readonly projections?: ProjectionCatalog;
  /** The host's hydration projection id (reserved). A bound id wins over a per-call one. */
  readonly hydrationProjectionId?: string;
  /** What to do with a tool the table does not list. Default `"allow"`. */
  readonly undeclared?: UndeclaredToolPolicy;
}

/**
 * Join read policies, the FIRST one being the bound one: tables merge strictest-wins, `"deny"`
 * beats `"allow"`, and `projections` / `hydrationProjectionId` keep the first one given (a
 * per-call catalogue must not replace the bound one — a different catalogue could lower a class).
 * `undefined` entries add nothing, so an omitted or `{}` per-call policy cannot lower the bound one.
 */
export function mergeReadPolicy(...policies: ReadonlyArray<ReadPolicy | undefined>): ReadPolicy {
  let projections: ProjectionCatalog | undefined;
  let hydrationProjectionId: string | undefined;
  let deny = false;
  let table: Record<string, DataClass> | undefined;
  for (const p of policies) {
    if (p === undefined || p === null) continue;
    projections ??= p.projections;
    hydrationProjectionId ??= p.hydrationProjectionId;
    if (p.declaredToolClasses !== undefined && p.declaredToolClasses !== null) {
      table ??= Object.create(null) as Record<string, DataClass>;
      // Once a tier has set "deny", the table's key set is CLOSED: a later tier may only RAISE a key
      // already listed, never list a new one (that would move a tool from "undeclared, unreadable"
      // to a readable class — a per-call value lowering what the host bound).
      for (const [k, v] of Object.entries(p.declaredToolClasses)) {
        if (deny && !Object.hasOwn(table, k)) continue;
        table[k] = strictestClass(table[k], v) as DataClass;
      }
    }
    if (p.undeclared === "deny") deny = true;
  }
  // Strict mode with no table at all is an EMPTY table: every tool-bound handle is undeclared.
  if (deny) table ??= Object.create(null) as Record<string, DataClass>;
  return {
    ...(table !== undefined && { declaredToolClasses: table }),
    ...(projections !== undefined && { projections }),
    ...(hydrationProjectionId !== undefined && { hydrationProjectionId }),
    ...(deny && { undeclared: "deny" as const }),
  };
}

/** The strictest declared class among the tools `spec` calls (an unlisted tool: see `UndeclaredToolPolicy`). */
function declaredClassOf(
  declared: DeclaredToolClasses | undefined,
  spec: ProviderSpec,
  undeclared: UndeclaredToolPolicy | undefined
): DataClass | undefined {
  // `deny` with no table is strict mode with an empty table: nothing is declared, so all is denied.
  if (declared === undefined && undeclared !== "deny") return undefined;
  let c: DataClass | undefined;
  for (const k of toolsOf(spec)) {
    const d = own(declared, k);
    c = strictestClass(c, d === undefined && undeclared === "deny" ? UNDECLARED_TOOL_CLASS : d);
  }
  return c;
}

/** The strictest class each handle's LIVE nodes carry. */
export function liveClasses(root: ExperienceNode): Map<string, DataClass> {
  const out = new Map<string, DataClass>();
  walk(root, (n) => {
    if (n.kind !== "semantic" || n.binding?.sensitivity === undefined) return;
    out.set(
      n.binding.handle,
      strictestClass(out.get(n.binding.handle), n.binding.sensitivity) as DataClass
    );
  });
  return out;
}

/** The strictest class each projection's LIVE nodes carry (by the node's own declared class). */
export function liveProjectionClasses(root: ExperienceNode): Map<string, DataClass> {
  const out = new Map<string, DataClass>();
  walk(root, (n) => {
    if (n.kind !== "semantic" || n.projection?.sensitivity === undefined) return;
    out.set(
      n.projection.id,
      strictestClass(out.get(n.projection.id), n.projection.sensitivity) as DataClass
    );
  });
  return out;
}

/** What `handle` is, from its own record: live nodes joined with the sticky per-handle class. */
export function ownClass(
  exp: Experience,
  live: ReadonlyMap<string, DataClass>,
  handle: string
): DataClass | undefined {
  return strictestClass(live.get(handle), own(exp.handleClasses, handle));
}

/** The class each tool carries from handles that are LIVE right now. */
function liveToolClasses(exp: Experience, live: ReadonlyMap<string, DataClass>) {
  const out = new Map<string, DataClass>();
  for (const [handle, spec] of Object.entries(exp.providers)) {
    const c = ownClass(exp, live, handle);
    if (c === undefined) continue;
    for (const k of toolsOf(spec)) out.set(k, strictestClass(out.get(k), c) as DataClass);
  }
  return out;
}

/**
 * The class a handle calling `spec` inherits from its tools: the strictest of what each tool ever
 * carried (`toolClasses`) and what handles on it carry now. `undefined` = a clean tool.
 */
export function inheritedClass(exp: Experience, spec: ProviderSpec): DataClass | undefined {
  return toolClassOf(exp, spec, liveToolClasses(exp, liveClasses(exp.root)));
}

function toolClassOf(
  exp: Experience,
  spec: ProviderSpec,
  liveTools: ReadonlyMap<string, DataClass>
): DataClass | undefined {
  let c: DataClass | undefined;
  for (const k of toolsOf(spec))
    c = strictestClass(c, strictestClass(own(exp.toolClasses, k), liveTools.get(k)));
  return c;
}

/**
 * The EFFECTIVE class of every handle, read at once (fail-closed, tool-level): its own class
 * (live nodes + sticky `handleClasses`) joined with the class of every tool its provider calls.
 * A handle bound before its tool was classified is gated as soon as the tool is: classification is
 * a READ-time property, so no op order can leave a sibling on a classified tool open.
 */
export function effectiveClasses(
  exp: Experience,
  declared?: DeclaredToolClasses,
  undeclared?: UndeclaredToolPolicy
): Map<string, DataClass> {
  const live = liveClasses(exp.root);
  const liveTools = liveToolClasses(exp, live);
  const out = new Map<string, DataClass>();
  const handles = new Set<string>([...live.keys(), ...Object.keys(exp.providers)]);
  if (exp.handleClasses !== undefined)
    for (const h of Object.keys(exp.handleClasses)) handles.add(h);
  for (const h of handles) {
    const spec = own(exp.providers, h);
    const c = strictestClass(
      ownClass(exp, live, h),
      spec === undefined
        ? undefined
        : strictestClass(
            toolClassOf(exp, spec, liveTools),
            declaredClassOf(declared, spec, undeclared)
          )
    );
    if (c !== undefined) out.set(h, c);
  }
  return out;
}

/**
 * The part of the stored class maps that the live nodes do NOT already imply: what the content
 * address needs. An experience whose classes are all implied by its live nodes has no residue, so
 * it hashes exactly as it did before classes were stored.
 */
export function classResidue(exp: Experience): {
  handleClasses?: Record<string, DataClass>;
  toolClasses?: Record<string, DataClass>;
  projectionClasses?: Record<string, DataClass>;
} {
  const live = liveClasses(exp.root);
  const handles: Record<string, DataClass> = {};
  for (const [h, c] of Object.entries(exp.handleClasses ?? {}))
    if (strictestClass(live.get(h), c) !== live.get(h)) handles[h] = c;
  const implied = liveToolClasses({ ...exp, handleClasses: undefined }, live);
  const tools: Record<string, DataClass> = {};
  for (const [k, c] of Object.entries(exp.toolClasses ?? {}))
    if (strictestClass(implied.get(k), c) !== implied.get(k)) tools[k] = c;
  const liveP = liveProjectionClasses(exp.root);
  const projections: Record<string, DataClass> = {};
  for (const [id, c] of Object.entries(exp.projectionClasses ?? {}))
    if (strictestClass(liveP.get(id), c) !== liveP.get(id)) projections[id] = c;
  return {
    ...(Object.keys(handles).length > 0 && { handleClasses: handles }),
    ...(Object.keys(projections).length > 0 && { projectionClasses: projections }),
    ...(Object.keys(tools).length > 0 && { toolClasses: tools }),
  };
}

/** `entries` folded into `kept` by `strictest` — never lower; `kept` itself when nothing changed. */
function foldInto(
  kept: Record<string, DataClass> | undefined,
  entries: Iterable<readonly [string, DataClass]>
): Record<string, DataClass> | undefined {
  let out = kept;
  for (const [k, c] of entries) {
    const had = own(out, k);
    const merged = strictestClass(had, c);
    if (merged === had || merged === undefined) continue;
    out = { ...out, [k]: merged };
  }
  return out;
}

/**
 * `onto` with every class `from` ever carried — its live nodes' and its sticky residues', per
 * handle, per tool (including the class a live handle gives its tool) and per projection — folded
 * into `onto`'s sticky maps by `strictest`. NEVER lowers anything on `onto`.
 *
 * It exists for a version that is built from an artifact other than the one it follows (a revert,
 * a branch): the artifact it adopts carries only the classes ITS history learned, and the
 * line's history is longer. `from` is the artifact that history ended at. The sticky maps are the
 * only place a class survives its last node, so a class held ONLY by `from`'s live nodes must be
 * written into the sticky map here — it will not be implied by `onto`'s tree. Unsealed result
 * (the caller seals); returns `onto` itself when `from` adds nothing.
 */
export function carryClasses(from: Experience, onto: Experience): Experience {
  const live = liveClasses(from.root);
  const handles = foldInto(onto.handleClasses, [
    ...live,
    ...Object.entries(from.handleClasses ?? {}),
  ]);
  const tools = foldInto(onto.toolClasses, [
    ...liveToolClasses(from, live),
    ...Object.entries(from.toolClasses ?? {}),
  ]);
  const projections = foldInto(onto.projectionClasses, [
    ...liveProjectionClasses(from.root),
    ...Object.entries(from.projectionClasses ?? {}),
  ]);
  if (
    handles === onto.handleClasses &&
    tools === onto.toolClasses &&
    projections === onto.projectionClasses
  )
    return onto;
  return {
    ...onto,
    ...(handles !== undefined && { handleClasses: handles }),
    ...(tools !== undefined && { toolClasses: tools }),
    ...(projections !== undefined && { projectionClasses: projections }),
  };
}
