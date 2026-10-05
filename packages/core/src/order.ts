// ── LexoRank-style fractional indexing ────────────────────────────────────────
// Keys are strings over a base-62 alphabet whose ASCII order is monotonic, so a plain string
// compare on stored keys yields sibling order. `orderKeyBetween(a, b)` returns a key STRICTLY
// between a and b; null bounds mean -∞ (prepend) / +∞ (append).
//
// What is guaranteed, exactly:
//   - the key is strictly between its bounds, always;
//   - WITHOUT a `salt` the key is a pure function of (a, b): two authors minting for the same
//     gap get the SAME key (that is the legacy behaviour, and it is kept so recorded ops and
//     content addresses never move);
//   - WITH a `salt` (an author / replica / session id) two authors with DIFFERENT salts get
//     different keys for the same gap (up to a collision of the salt hashes: the suffix
//     space is 62 * 62 * 61 ~ 235k, which is why the RENDER order is ALSO totalled by node id —
//     see `compareSiblings` in node.ts). A salt identifies an AUTHOR, not an insert: the same
//     author inserting twice into the same gap mints the same key — a tie, resolved at render;
//   - keys are minted when an op is AUTHORED and travel inside the op (`insertNode.node.order`,
//     `moveNode.newOrder`); `apply` and `replay` never mint one, so replay is deterministic;
//   - there is NO key below "0" and none strictly between k and k + "0", so a prepend before a
//     "0..." key (or a split at such a gap) cannot be satisfied; salted keys never end in "0".

const BASE = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RADIX = BASE.length; // 62
const SALT_LENGTH = 3;

export interface OrderKeyOptions {
  /**
   * An author / replica identifier. Mixed (hashed, deterministically) into the key so concurrent
   * authors minting for the same gap do not collide. Any non-empty string; empty or absent = the
   * unsalted legacy key.
   */
  readonly salt?: string | undefined;
}

/** FNV-1a over UTF-16 code units, rendered as {@link SALT_LENGTH} base-62 chars, last never "0". */
function saltSuffix(salt: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < salt.length; i++) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < SALT_LENGTH; i++) {
    // The last char is 1..61: a key ending in "0" has no key strictly between it and "<key>0…",
    // which would dead-end a later insert at that gap.
    const last = i === SALT_LENGTH - 1;
    const radix = last ? RADIX - 1 : RADIX;
    out += BASE.charAt((last ? 1 : 0) + (h % radix));
    h = Math.floor(h / radix);
  }
  return out;
}

export function orderKeyBetween(
  a: string | null,
  b: string | null,
  opts?: OrderKeyOptions
): string {
  const mid = midpoint(a, b);
  if (opts?.salt === undefined || opts.salt === "") return mid;
  const salted = mid + saltSuffix(opts.salt);
  // Defensive: appending to the midpoint stays below `b` by construction; if a pathological
  // bound ever broke that, the unsalted key (always strictly between) is the safe answer.
  return (a === null || salted > a) && (b === null || salted < b) ? salted : mid;
}

function midpoint(a: string | null, b: string | null): string {
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
export function orderKeyAfterAll(
  siblings: ReadonlyArray<{ order: string }>,
  opts?: OrderKeyOptions
): string {
  let max: string | null = null;
  for (const s of siblings) if (max === null || s.order > max) max = s.order;
  return orderKeyBetween(max, null, opts);
}
