import type { HydrationStore } from "@loom-ui/hydration/client";
import type { Blueprint } from "@loom/blueprint-runtime";
import { type RenderExperienceOptions, renderExperience } from "./status";

/**
 * Render now and on every change to the store's projection (and, with `projectionSubscribe`, to
 * any other projection the blueprint binds). Returns an unsubscribe.
 */
export function watch(
  blueprint: Blueprint,
  store: HydrationStore,
  onFrame: (frame: string) => void,
  opts: RenderExperienceOptions = {}
): () => void {
  onFrame(renderExperience(blueprint, store, opts));
  const frame = (): void => onFrame(renderExperience(blueprint, store, opts));
  const stops = [store.runtimeSubscribe(frame)];
  if (opts.projectionSubscribe !== undefined) stops.push(opts.projectionSubscribe(frame));
  return () => {
    for (const stop of stops) stop();
  };
}
