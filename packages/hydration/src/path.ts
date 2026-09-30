// ── Binding path ↔ hydration handle, browser-safe ────────────────────────────────
// A compiled widget binds to `values.<handle>`. `@loom-ui/core` owns that spelling for the
// compile side (`hydrationPath`), but core is CommonJS with named exports a bundler's
// commonjs plugin cannot always resolve, and core cannot import hydration (hydration depends on
// core). So the client entry carries its own definition of the prefix and the inverse, and
// `path.test.ts` pins it against core's so the two cannot drift apart.

/** The hydration projection's top-level key; equal to `@loom-ui/core`'s constant of the same name. */
export const HYDRATION_VALUES_PREFIX = "values";

/**
 * The hydration handle a binding path names: the exact inverse of core's `hydrationPath`.
 * `undefined` for a path not of the form `values.<handle>` with a non-empty handle (including the
 * bare prefix and `values.`). Everything after the first `values.` is the handle, dots included.
 */
export function handleOfPath(path: string): string | undefined {
  const head = `${HYDRATION_VALUES_PREFIX}.`;
  if (!path.startsWith(head) || path.length === head.length) return undefined;
  return path.slice(head.length);
}
