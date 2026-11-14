import { checkKindValue } from "@loomwork/ui-core/browser";
import { describe, expect, it } from "vitest";
import { LuChat } from "./lu-chat.js";
import { LuDiagram } from "./lu-diagram.js";
import { LuImage } from "./lu-media.js";
import { LuMultiSelectInput } from "./lu-multi-select.js";

// core defers the chat, media and diagram value contracts. defineX() loads them, but a host may
// register a widget CLASS under its own tag and never call defineX(): the class loads its contract
// when it connects. This file must not import `../register` or any defineX().

const CASES = [
  ["x-own-chat", LuChat, "Chat", { mode: "owner", entries: [] }],
  ["x-own-multi", LuMultiSelectInput, "MultiSelectInput", { options: [], selected: [] }],
  ["x-own-image", LuImage, "Image", { address: "sha256:ab", mediaType: "image/png" }],
  [
    "x-own-diagram",
    LuDiagram,
    "Diagram",
    { layout: "flow", nodes: [{ id: "a", label: "A" }], edges: [] },
  ],
] as const;

describe("a widget class registered under the host's own tag", () => {
  it("is refused before connecting (not loaded), checked normally once connected", () => {
    for (const [, , kind, value] of CASES)
      expect(checkKindValue(kind, value).ok, `${kind} before`).toBe(false);
    for (const [tag, cls, kind, value] of CASES) {
      customElements.define(tag, class extends (cls as unknown as typeof HTMLElement) {});
      const el = document.createElement(tag);
      document.body.append(el);
      expect(checkKindValue(kind, value).ok, `${kind} after`).toBe(true);
      el.remove();
    }
  });
});
