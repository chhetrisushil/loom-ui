import { defineElement } from "../define.js";
import { LuA2UIWidget, LuSandboxWidget } from "../widgets/lu-embedded.js";
import { defineA2uiView } from "./lu-a2ui-view.js";
import { defineSandbox } from "./lu-sandbox.js";

/** Register `<lu-a2ui-widget>`, `<lu-sandbox-widget>` (and the elements it draws). Idempotent. */
export function defineEmbedded(): void {
  defineA2uiView();
  defineSandbox();
  defineElement("lu-a2ui-widget", LuA2UIWidget);
  defineElement("lu-sandbox-widget", LuSandboxWidget);
}
