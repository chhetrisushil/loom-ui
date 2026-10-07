import { createHmac, randomBytes } from "node:crypto";

// ── Opaque aliases for redacted nodes (U10c) ──────────────────────────────────
// A node id is LEXICAL (the reference planner mints readable snake_case ids), so a redacted node's
// real id says what the hidden node is about. A restricted placeholder (and a collapsed container)
// therefore takes an ALIAS: a keyed hash of `(experienceId, nodeId)` under a secret the HOST holds.
//   - stable: the same node gets the same alias in every version of the experience and on every
//     compile with the same key, so a renderer's keyed reconciliation and the layout are unchanged;
//   - meaningless: without the key an alias cannot be inverted or confirmed by a dictionary of
//     likely ids (an UNKEYED hash could be, for exactly the lexical ids this protects);
//   - per experience: the same node id in another experience aliases differently.
// FAIL-CLOSED KEY STORY: a missing (or too short) key is replaced by a random per-process key. That
// loses nothing confidential — the key is still secret — and costs only cross-process stability
// (aliases change on restart or between replicas, so a placeholder remounts once), reported as a
// `placeholder-alias-key-not-supplied` warn finding. Never an unkeyed hash.

/** A secret held by the host. A string is read as UTF-8. */
export type AliasKey = string | Uint8Array;

/** The shortest key accepted, in bytes. A shorter key is treated as absent (and reported). */
export const MIN_ALIAS_KEY_BYTES = 16;

let processKey: Uint8Array | undefined;

/** The random key used when the host supplies none: one per process, never exposed. */
function processAliasKey(): Uint8Array {
  processKey ??= randomBytes(32);
  return processKey;
}

/** The key as bytes if it is usable (a string or bytes of at least `MIN_ALIAS_KEY_BYTES`). */
function usableKey(key: unknown): Uint8Array | undefined {
  let bytes: Uint8Array | undefined;
  if (typeof key === "string") bytes = new TextEncoder().encode(key);
  else if (key instanceof Uint8Array) bytes = key;
  return bytes !== undefined && bytes.length >= MIN_ALIAS_KEY_BYTES ? bytes : undefined;
}

export interface ResolvedAliasKey {
  readonly bytes: Uint8Array;
  /** `supplied`, `weak` (supplied but too short: replaced) or `absent` (replaced). */
  readonly source: "supplied" | "weak" | "absent";
}

export function resolveAliasKey(key: unknown): ResolvedAliasKey {
  const usable = usableKey(key);
  if (usable !== undefined) return { bytes: usable, source: "supplied" };
  return { bytes: processAliasKey(), source: key === undefined ? "absent" : "weak" };
}

/** What an alias stands for: a node id, or a handle (for the viewer-visible fingerprint). */
export type AliasDomain = "node" | "handle";

/**
 * The alias of `id` in `experienceId` under `key`: `r_` + 16 base64url characters (96 bits of an
 * HMAC-SHA256). `attempt` > 0 re-derives after a collision. Length-prefixed, so
 * `("ab", "c")` and `("a", "bc")` can never hash the same input. Throws on a key under
 * `MIN_ALIAS_KEY_BYTES` — `compile` resolves a key first and never reaches that.
 */
export function placeholderAlias(
  key: AliasKey,
  experienceId: string,
  id: string,
  domain: AliasDomain = "node",
  attempt = 0
): string {
  const bytes = usableKey(key);
  if (bytes === undefined)
    throw new RangeError(`an alias key must be at least ${MIN_ALIAS_KEY_BYTES} bytes`);
  return derive(bytes, experienceId, id, domain, attempt);
}

/** @internal `compile`'s entry: the key is already resolved. */
export function derive(
  key: Uint8Array,
  experienceId: string,
  id: string,
  domain: AliasDomain,
  attempt: number
): string {
  const input = `loom-ui/alias/v1\u0000${domain}\u0000${attempt}\u0000${experienceId.length}:${experienceId}${id}`;
  return `r_${createHmac("sha256", key).update(input).digest().subarray(0, 12).toString("base64url")}`;
}
