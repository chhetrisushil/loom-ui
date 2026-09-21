import { canonicalJson } from "@loom/core";
import {
  type ContentRef,
  type ContentStore,
  contentAddress,
  decodeValue,
  encodeValue,
} from "@loom/plugin-content";
import { Experience, type Finding, experienceArtifact } from "./experience";
import { MAX_TREE_DEPTH, treeDepth } from "./node";
import type { RecordedOperation } from "./operations";

// ── Persistence: the composed-surfaces recipe, for an Experience ──────────────
// Composition is an event; rendering is a replay. The bytes go in loom's ContentStore under
// their sha256 address; the APP emits `EXPERIENCE_COMPOSED { ref, parents, ops }` from inside a
// loom execution (a userspace event the fold skips — no EVENT_SCHEMA change). This module is the
// only part of @loom-ui/core that touches Node (the hash), which is why it is its own subpath.

export const EXPERIENCE_COMPOSED = "EXPERIENCE_COMPOSED";

export interface ExperienceComposedPayload {
  readonly ref: ContentRef;
  readonly parents: readonly string[];
  readonly ops: readonly RecordedOperation[];
}

/**
 * The artifact's content address — the structure revision. Authorship (`meta`) never changes it.
 *
 * Parse FIRST, then canonicalise. Both halves are load-bearing and neither is optional:
 *
 *   - `Experience.parse` applies the schema's defaults (`MCPToolNode.dependsOn`, `idempotent`)
 *     and drops keys the schema does not declare, so an artifact written with a default omitted
 *     hashes the same as one written with it spelled out;
 *   - `canonicalJson` sorts keys at every depth, so an artifact written in a non-schema key
 *     order hashes the same as one written in schema order.
 *
 * Without both, `seal` (which used to hash the raw object) and `getExperience` (which hashes the
 * parsed one) disagree, and a perfectly good stored artifact reads back as `artifact-tampered`.
 *
 * THROWS only for programmer error: an `exp` that is not a valid `Experience`, or a value
 * `canonicalJson` cannot represent (NaN / ±Infinity, bigint, function, symbol, nesting deeper
 * than 1024). Callers that must stay total — `putExperience`, `getExperience` — catch it and
 * report `artifact-unhashable`.
 */
export function mintVersionHash(exp: Experience): string {
  const parsed = Experience.parse(exp);
  return contentAddress(new TextEncoder().encode(canonicalJson(experienceArtifact(parsed))));
}

/**
 * The same experience, PARSED, with its `versionHash` set — what is stored is exactly what was
 * hashed. Idempotent. Throws under the same conditions as {@link mintVersionHash}.
 */
export function seal(exp: Experience): Experience {
  const parsed = Experience.parse(exp);
  return { ...parsed, versionHash: mintVersionHash(parsed) };
}

const unhashable = (message: string): { ok: false; finding: Finding } => ({
  ok: false,
  finding: { code: "artifact-unhashable", severity: "error", message },
});

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function putExperience(
  store: ContentStore,
  exp: Experience
): Promise<
  { ok: true; experience: Experience; ref: ContentRef } | { ok: false; finding: Finding }
> {
  let experience: Experience;
  try {
    experience = seal(exp);
  } catch (err) {
    return unhashable(`experience "${exp.experienceId}" cannot be hashed: ${reason(err)}`);
  }
  // What is STORED is the whole experience (meta included, so authorship is recoverable); what is
  // HASHED is the artifact. Identical artifacts from different authors therefore share a hash but
  // may store separately — the `ref` dedupes on stored bytes, the `versionHash` on identity.
  const ref = await store.put(encodeValue(experience));
  return { ok: true, experience, ref };
}

export async function getExperience(
  store: ContentStore,
  ref: ContentRef
): Promise<{ ok: true; experience: Experience } | { ok: false; finding: Finding }> {
  const bytes = await store.get(ref);
  if (!bytes)
    return {
      ok: false,
      finding: {
        code: "artifact-missing",
        severity: "error",
        message: `no content at ${ref.__loomContent}`,
      },
    };
  const decoded = decodeValue(bytes);
  // Depth BEFORE `safeParse`: zod's parse of the node tree is recursive, so a blob nested past
  // the cap would blow the stack inside the schema rather than return a finding.
  const depth = treeDepth((decoded as { root?: unknown } | null)?.root as never);
  if (depth > MAX_TREE_DEPTH)
    return {
      ok: false,
      finding: {
        code: "artifact-invalid",
        severity: "error",
        message: `content at ${ref.__loomContent} nests ${depth} levels, over the ${MAX_TREE_DEPTH} limit`,
      },
    };
  const parsed = Experience.safeParse(decoded);
  if (!parsed.success)
    return {
      ok: false,
      finding: {
        code: "artifact-invalid",
        severity: "error",
        message: `content at ${ref.__loomContent} is not an Experience: ${parsed.error.issues[0]?.message ?? "schema error"}`,
      },
    };
  const exp = parsed.data;
  let hash: string;
  try {
    hash = mintVersionHash(exp);
  } catch (err) {
    return unhashable(`content at ${ref.__loomContent} cannot be hashed: ${reason(err)}`);
  }
  if (exp.versionHash !== hash)
    return {
      ok: false,
      finding: {
        code: "artifact-tampered",
        severity: "error",
        message: `versionHash ${exp.versionHash} does not match the stored artifact`,
      },
    };
  return { ok: true, experience: exp };
}

// The content codec the stored bytes use, re-exported so a caller that writes or inspects an
// experience blob by hand uses the same pair this module does.
export { decodeValue, encodeValue };
