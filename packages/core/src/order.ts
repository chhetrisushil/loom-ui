// ── LexoRank-style fractional indexing ────────────────────────────────────────
// Keys are strings over a base-62 alphabet whose ASCII order is monotonic, so a plain string
// compare on stored keys yields sibling order. `orderKeyBetween(a, b)` returns a key STRICTLY
// between a and b; null bounds mean -∞ (prepend) / +∞ (append). Two authors inserting siblings
// concurrently mint non-colliding keys without coordination.

const BASE = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RADIX = BASE.length; // 62

export function orderKeyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`orderKeyBetween: lower bound "${a}" is not < upper bound "${b}"`);
  }
  let result = "";
  for (let i = 0; ; i++) {
    const lo = a !== null && i < a.length ? BASE.indexOf(a.charAt(i)) : 0;
    const hi = b !== null && i < b.length ? BASE.indexOf(b.charAt(i)) : RADIX;
    if (lo + 1 < hi) {
      result += BASE.charAt(Math.floor((lo + hi) / 2));
      return result;
    }
    result += BASE.charAt(lo);
  }
}

/** The order key that sorts strictly after every key in `siblings` (append). */
export function orderKeyAfterAll(siblings: ReadonlyArray<{ order: string }>): string {
  let max: string | null = null;
  for (const s of siblings) if (max === null || s.order > max) max = s.order;
  return orderKeyBetween(max, null);
}
