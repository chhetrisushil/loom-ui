import type { HydrationStore } from "@loom-ui/hydration/client";
import type { Blueprint } from "@loom/blueprint-runtime";
import { type RenderExperienceOptions, renderExperience } from "./status";

/** Render now and on every change to the store's projection. Returns an unsubscribe. */
export function watch(
  blueprint: Blueprint,
  store: HydrationStore,
  onFrame: (frame: string) => void,
  opts: RenderExperienceOptions = {}
): () => void {
  onFrame(renderExperience(blueprint, store, opts));
  return store.runtimeSubscribe(() => onFrame(renderExperience(blueprint, store, opts)));
}
