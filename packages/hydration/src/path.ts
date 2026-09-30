// ── Binding path ↔ hydration handle, browser-safe ────────────────────────────────
// A compiled widget binds to `values.<handle>`. `@loom-ui/core` owns that spelling for the
// compile side (`hydrationPath`), but the client entry must not pull core's runtime module graph
// into a browser bundle, and core cannot import hydration (hydration depends on core). So the
// client entry carries its own definition of the prefix and the inverse, pinned against core's
// twice: at compile time (the `satisfies` below, type-only, erased at build) and by
// `path.test.ts`, which compares the values and round-trips `hydrationPath`.

import type { HYDRATION_VALUES_PREFIX as CoreValuesPrefix } from "@loom-ui/core";

/** The hydration projection's top-level key; equal to `@loom-ui/core`'s constant of the same name. */
export const HYDRATION_VALUES_PREFIX = "values" satisfies typeof CoreValuesPrefix;

/**
 * The hydration handle a binding path names: the exact inverse of core's `hydrationPath`.
 * `undefined` for a path not of the form `values.<handle>` with a non-empty handle (including the
 * bare prefix and `values.`). Everything after the first `values.` is the handle, spelled exactly
 * as `hydrationPath` spelled it. Note: blueprint-runtime resolves a binding path by splitting on
 * `.`, so a handle that itself contains a dot round-trips here but will not resolve at render time —
 * keep handles dot-free. A reserved handle (`__proto__` etc.) is returned as-is; the store refuses it.
 */
export function handleOfPath(path: string): string | undefined {
  const head = `${HYDRATION_VALUES_PREFIX}.`;
  if (!path.startsWith(head) || path.length === head.length) return undefined;
  return path.slice(head.length);
}
