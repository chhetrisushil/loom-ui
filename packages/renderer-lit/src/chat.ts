// `@loom-ui/renderer-lit/chat` — the chat and input widgets (U8), opt-in.
//
// Creating a registry here (or `registerChatWidgets`) defines the `lu-chat`, `lu-text-input`, `lu-form-input` and `lu-select-input`
// elements. It is its own entry, like the media widgets, so a page that draws no conversation does
// not pay for them. The kinds themselves (and the `ChatValue` contract) are universal and live in
// `@loom-ui/core`; this entry is only how the web surface DRAWS them. File upload in a conversation
// is the existing `MediaInput` (`@loom-ui/renderer-lit/media`).
//
//   import { createChatLitRegistry } from "@loom-ui/renderer-lit/chat";
//   renderBlueprintDom(host, blueprint, {
//     registry: createChatLitRegistry({ media }),     // `media` is optional: it draws image/file parts of a transcript
//     onAction: (action) => writeBack.handle(action, { principal, current }),  // returns an ActionOutcome
//   });
//
// The inputs wait for the host's answer to their action (`onAction` may return a promise of
// `{ ok }`): the draft stays until it hears `ok: true`. See the README for the whole write-back model.

import { CHAT_INPUT_KINDS, CHAT_KIND } from "@loom-ui/core/chat-ui";
import type { CatalogEntry } from "@loom/blueprint-runtime";
import { defineChat } from "./define/lu-chat";
import { defineInputs } from "./define/lu-inputs";
import { type LitRegistryOptions, createLitRegistry, elementRenderer } from "./dom/litRegistry";
import type { DomRegistry } from "./dom/registry";

export { LuChat } from "./widgets/lu-chat";
export { LuFormInput, LuSelectInput, LuTextInput } from "./widgets/lu-inputs";

/** The loom contracts the chat kinds declare (what a catalogue's `surfaces.web` carries for them). */
export const chatKindContracts: readonly CatalogEntry[] = [
  { kind: "Chat", props: ["emptyText", "editable"], binding: "required" },
  {
    kind: "TextInput",
    props: ["label", "placeholder", "multiline", "maxChars", "submitLabel"],
    binding: "none",
  },
  { kind: "FormInput", props: ["label", "fields", "submitLabel"], binding: "none" },
  {
    kind: "SelectInput",
    props: ["label", "options", "placeholder", "size"],
    binding: "optional",
  },
];

const TAGS: Readonly<Record<string, string>> = {
  Chat: "lu-chat",
  TextInput: "lu-text-input",
  FormInput: "lu-form-input",
  SelectInput: "lu-select-input",
};

/** Register the chat kinds on `registry` (returned, for chaining). `opts.media` carries the host seams for media parts. */
export function registerChatWidgets(
  registry: DomRegistry,
  opts: LitRegistryOptions = {}
): DomRegistry {
  defineChat();
  defineInputs();
  for (const kind of [CHAT_KIND, ...CHAT_INPUT_KINDS])
    registry.register(kind, elementRenderer(TAGS[kind] as string, opts));
  return registry;
}

/** A NEW default registry with the chat kinds added. */
export function createChatLitRegistry(opts: LitRegistryOptions = {}): DomRegistry {
  return registerChatWidgets(createLitRegistry(opts), opts);
}
