// The DEFERRED media contracts (see kindValues.ts): each of Image/Audio/Video/File is bound to a
// MediaRef, checked by the ONE shared checker (`mediaRef.ts`) that also backs the zod contract.
import { installDeferredContracts, issuesContract } from "./kindValues";
import { MEDIA_KINDS, mediaValueIssues } from "./mediaRef";

/** Load the media contracts into `checkKindValue`. Idempotent; renderer-lit's `defineMedia()` calls it. */
export function useMediaContracts(): void {
  const contracts: Record<string, ReturnType<typeof issuesContract>> = {};
  for (const kind of MEDIA_KINDS)
    contracts[kind] = issuesContract((v) => mediaValueIssues(kind, v));
  installDeferredContracts(contracts);
}
