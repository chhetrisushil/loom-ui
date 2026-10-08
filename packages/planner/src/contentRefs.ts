import {
  type ContentRefTable,
  contentRefPaths,
  mergeContentRefEntries,
  toolKey,
} from "@loom-ui/core";
import type { CapabilityRef } from "./spi";

/**
 * U9b: the marked content-reference argument paths per TOOL, derived from the capabilities a
 * planner was offered (their `inputSchema`, marker `x-content-ref: true`). Hand the SAME table to
 * `validateExperience({ contentRefArgs })` and to hydration's `contentRefArgs`, so composition and
 * the run-time re-check can never disagree about which arguments are references. A capability with
 * no `inputSchema` or no marker contributes nothing; one whose schema cannot be read contributes
 * `"unknown"` (fail closed: see core `contentRefPaths`), which absorbs any other entry for the
 * same tool. Keyed by `toolKey`, so a tool offered at two versions is one tool.
 */
export function contentRefArgsFrom(capabilities: readonly CapabilityRef[]): ContentRefTable {
  const memo = MEMO.get(capabilities);
  if (memo !== undefined) return memo;
  const out: Record<string, ReturnType<typeof mergeContentRefEntries>> = Object.create(null);
  for (const c of capabilities) {
    if (c.inputSchema === undefined) continue;
    const r = contentRefPaths(c.inputSchema);
    const entry = r.status === "ok" ? r.paths : "unknown";
    if (entry !== "unknown" && entry.length === 0) continue;
    const k = toolKey(c);
    out[k] = mergeContentRefEntries(Object.hasOwn(out, k) ? out[k] : undefined, entry);
  }
  MEMO.set(capabilities, out);
  return out;
}

// A planner calls this per streamed partial with the SAME array; the schemas are read once.
const MEMO = new WeakMap<readonly CapabilityRef[], ContentRefTable>();
