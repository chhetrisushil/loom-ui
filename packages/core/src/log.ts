import {
  type ContentRef,
  type ContentStore,
  contentAddress,
  decodeValue,
  encodeValue,
} from "@loom/plugin-content";
import { Experience, type Finding, experienceArtifact } from "./experience";
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

/** The artifact's content address — the structure revision. Authorship (`meta`) never changes it. */
export function mintVersionHash(exp: Experience): string {
  return contentAddress(encodeValue(experienceArtifact(exp)));
}

/** The same experience with its `versionHash` set. Idempotent. */
export function seal(exp: Experience): Experience {
  return { ...exp, versionHash: mintVersionHash(exp) };
}

export async function putExperience(
  store: ContentStore,
  exp: Experience
): Promise<{ experience: Experience; ref: ContentRef }> {
  const experience = seal(exp);
  const ref = await store.put(encodeValue(experienceArtifactWithMeta(experience)));
  return { experience, ref };
}

// What is STORED is the whole experience (meta included, so authorship is recoverable); what is
// HASHED is the artifact. Identical artifacts from different authors therefore share a hash but
// may store separately — the `ref` dedupes on stored bytes, the `versionHash` on identity.
function experienceArtifactWithMeta(exp: Experience): unknown {
  return exp;
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
  const parsed = Experience.safeParse(decodeValue(bytes));
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
  if (exp.versionHash !== mintVersionHash(exp))
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
