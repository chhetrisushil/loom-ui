/**
 * Structural equality for Blueprint nodes: primitives by `===`, arrays element-wise, plain
 * objects key-wise (order ignored, `undefined`-valued keys count). Anything else — functions,
 * class instances, Dates — by reference. Enough for `Widget`/`Layout`, which are JSON shapes.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (
    Object.getPrototypeOf(a) !== Object.prototype ||
    Object.getPrototypeOf(b) !== Object.prototype
  )
    return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.hasOwn(rb, k)) return false;
    if (!deepEqual(ra[k], rb[k])) return false;
  }
  return true;
}
