import {
  type ArgPath,
  type ContentRefEntry,
  type ContentRefTable,
  contentRefPaths,
  mergeContentRefEntries,
  toolKey,
} from "@loom-ui/core";
import type { CapabilityRef } from "./spi";

/**
 * U9b: the table of content-reference positions, derived from the capabilities a planner was offered.
 * `args`: per TOOL (`toolKey`), the input paths its `inputSchema` marks `x-content-ref: true`.
 * `produces`: per tool, the output paths its `outputSchema` marks (the root counts): only a step
 * reference to one of those may stand at a marked argument. Hand the SAME table to
 * `validateExperience({ contentRefArgs })` and to hydration's required `contentRefArgs`, so composition
 * and the run-time re-check can never disagree.
 *
 * An input schema that mentions the marker but cannot be fully read is `"unknown"` (strict: the binding is
 * refused); one that is unreadable without mentioning it is `"unreadable"` (a warning, plus address-shaped
 * strings refused). An unreadable OUTPUT schema simply proves nothing. A capability with no marker
 * contributes nothing. The table is plain JSON: persist it with the capability set and re-read it with
 * core `parseContentRefTable`. Memoised on the capabilities' CONTENT (their schemas), not their identity,
 * so a mutated schema is re-read.
 */
export function contentRefArgsFrom(capabilities: readonly CapabilityRef[]): ContentRefTable {
  const sig = signature(capabilities);
  const memo = MEMO.get(capabilities);
  if (sig !== undefined && memo !== undefined && memo.sig === sig) return memo.table;
  const args: Record<string, ContentRefEntry> = Object.create(null);
  const produces: Record<string, readonly ArgPath[]> = Object.create(null);
  for (const c of capabilities) {
    const k = toolKey(c);
    if (c.inputSchema !== undefined) {
      const r = contentRefPaths(c.inputSchema);
      const entry: ContentRefEntry =
        r.status === "ok" ? r.paths : r.markerMentioned ? "unknown" : "unreadable";
      if (typeof entry === "string" || entry.length > 0)
        args[k] = mergeContentRefEntries(Object.hasOwn(args, k) ? args[k] : undefined, entry);
    }
    if (c.outputSchema !== undefined) {
      const r = contentRefPaths(c.outputSchema, { allowRoot: true });
      if (r.status === "ok" && r.paths.length > 0) {
        const have = Object.hasOwn(produces, k) ? (produces[k] as readonly ArgPath[]) : [];
        const seen = new Map([...have, ...r.paths].map((p) => [JSON.stringify(p), p] as const));
        produces[k] = [...seen.values()];
      }
    }
  }
  const table: ContentRefTable = {
    args,
    ...(Object.keys(produces).length > 0 && { produces }),
  };
  if (sig !== undefined) MEMO.set(capabilities, { sig, table });
  return table;
}

// A planner calls this per streamed partial with the SAME array. The signature is the schemas' content,
// so editing a schema in place is seen; an unserialisable (cyclic) schema is simply never memoised.
function signature(capabilities: readonly CapabilityRef[]): string | undefined {
  try {
    return JSON.stringify(
      capabilities.map((c) => [toolKey(c), c.inputSchema ?? null, c.outputSchema ?? null])
    );
  } catch {
    return undefined;
  }
}
const MEMO = new WeakMap<
  readonly CapabilityRef[],
  { readonly sig: string; readonly table: ContentRefTable }
>();
