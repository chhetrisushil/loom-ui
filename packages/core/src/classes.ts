import type { DataClass } from "@loom/classify";
import type { Experience, ProviderSpec } from "./experience";
import { type ExperienceNode, walk } from "./node";
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
 * The tools a provider calls, by NAME. Name only, not name@version: a version bump (or an MCP
 * server re-listing the same tool) must not shed a class, and the spec carries no server
 * identity, so two servers' same-named tools share a class — which over-classifies, fail-closed.
 */
export function toolsOf(spec: ProviderSpec): string[] {
  return [...new Set(spec.executionGraph.map((s) => s.toolName))];
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
export function effectiveClasses(exp: Experience): Map<string, DataClass> {
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
      spec === undefined ? undefined : toolClassOf(exp, spec, liveTools)
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
