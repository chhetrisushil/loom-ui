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
// FAIL-CLOSED KEY STORY: a missing key is replaced by a random per-process key (a SUPPLIED key that
// is too short is a `PlaceholderKeyError`; `requirePlaceholderKey` makes a missing key one too). That
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

/** A misconfigured alias key: thrown by `compile`, never papered over with a random key. */
export class PlaceholderKeyError extends Error {
  readonly code: "placeholder-key-weak" | "placeholder-key-required";
  constructor(code: PlaceholderKeyError["code"], message: string) {
    super(message);
    this.name = "PlaceholderKeyError";
    this.code = code;
  }
}

export interface ResolvedAliasKey {
  readonly bytes: Uint8Array;
  /** `supplied`, or `absent` (replaced by the random per-process key). */
  readonly source: "supplied" | "absent";
}

/**
 * A SUPPLIED key that is not a string / bytes of at least `MIN_ALIAS_KEY_BYTES` is a configuration
 * error (`PlaceholderKeyError`), never silently replaced: a host that believes its aliases are
 * stable would otherwise get a random key and no signal. An ABSENT key falls back to the random
 * per-process key.
 */
export function resolveAliasKey(key: unknown): ResolvedAliasKey {
  if (key === undefined) return { bytes: processAliasKey(), source: "absent" };
  const usable = usableKey(key);
  if (usable === undefined)
    throw new PlaceholderKeyError(
      "placeholder-key-weak",
      `placeholderKey must be a string or bytes of at least ${MIN_ALIAS_KEY_BYTES} bytes`
    );
  return { bytes: usable, source: "supplied" };
}

/** What an alias stands for: a node id, or a handle (for the viewer-visible fingerprint). */
export type AliasDomain = "node" | "handle";

/**
 * The alias of `id` in `experienceId` under `key`: `r_` + 16 base64url characters (96 bits of an
 * HMAC-SHA256). `attempt` > 0 re-derives after a collision. Length-prefixed, so
 * `("ab", "c")` and `("a", "bc")` can never hash the same input. Throws on a key under
 * `MIN_ALIAS_KEY_BYTES`.
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
  // UTF-16 code units, not UTF-8: UTF-8 maps every lone surrogate to U+FFFD, so two different
  // (malformed) ids would hash alike. Code units keep the encoding injective for any JS string.
  return `r_${createHmac("sha256", key).update(Buffer.from(input, "utf16le")).digest().subarray(0, 12).toString("base64url")}`;
}
