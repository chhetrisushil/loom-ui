// `@loom-ui/renderer-lit/media` — the media widgets (U9), opt-in.
//
// Creating a registry here (or `registerMediaWidgets`) defines the `lu-image`, `lu-audio`, `lu-video`, `lu-file` and `lu-media-input`
// elements. It is its own entry, like the reference containers, so a page that draws no media does
// not pay for them. The kinds themselves (and their value contract) are universal and live in
// `@loom-ui/core`; this entry is only how the web surface DRAWS them.
//
//   import { createMediaLitRegistry } from "@loom-ui/renderer-lit/media";
//   renderBlueprintDom(host, blueprint, { registry: createMediaLitRegistry({ media: { resolver, policy, upload } }) });
//
// `resolver` and `upload` are the host's authorising seams (see `MediaHostOptions`); build them per
// viewer session. With none, a media widget draws its unavailable state and loads nothing.

import { MEDIA_INPUT_KIND, MEDIA_KINDS } from "@loom-ui/core/media";
import type { CatalogEntry } from "@loom/blueprint-runtime";
import { defineMedia } from "./define/lu-media";
import { type LitRegistryOptions, createLitRegistry, elementRenderer } from "./dom/litRegistry";
import type { DomRegistry } from "./dom/registry";

export { LuAudio, LuFile, LuImage, LuMediaInput, LuVideo } from "./widgets/lu-media";
export type { MediaHostOptions } from "./widgets/lu-media";

/** The loom contracts the media kinds declare (what a catalogue's `surfaces.web` carries for them). */
export const mediaKindContracts: readonly CatalogEntry[] = [
  { kind: "Image", props: ["alt", "caption"], binding: "required" },
  { kind: "Audio", props: ["caption"], binding: "required" },
  { kind: "Video", props: ["caption"], binding: "required" },
  { kind: "File", props: ["caption"], binding: "required" },
  { kind: MEDIA_INPUT_KIND, props: ["accept", "maxBytes", "label"], binding: "none" },
];

const TAGS: Readonly<Record<string, string>> = {
  Image: "lu-image",
  Audio: "lu-audio",
  Video: "lu-video",
  File: "lu-file",
  [MEDIA_INPUT_KIND]: "lu-media-input",
};

/** Register the media kinds on `registry` (returned, for chaining). `opts.media` carries the host seams. */
export function registerMediaWidgets(
  registry: DomRegistry,
  opts: LitRegistryOptions = {}
): DomRegistry {
  defineMedia();
  for (const kind of [...MEDIA_KINDS, MEDIA_INPUT_KIND])
    registry.register(kind, elementRenderer(TAGS[kind] as string, opts));
  return registry;
}

/** A NEW default registry with the media kinds added. */
export function createMediaLitRegistry(opts: LitRegistryOptions = {}): DomRegistry {
  return registerMediaWidgets(createLitRegistry(opts), opts);
}
