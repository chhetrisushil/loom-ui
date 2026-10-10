import { defineElement } from "../define";
import { LuA2UIWidget, LuSandboxWidget } from "../widgets/lu-embedded";
import { defineA2uiView } from "./lu-a2ui-view";
import { defineSandbox } from "./lu-sandbox";

/** Register `<lu-a2ui-widget>`, `<lu-sandbox-widget>` (and the elements it draws). Idempotent. */
export function defineEmbedded(): void {
  defineA2uiView();
  defineSandbox();
  defineElement("lu-a2ui-widget", LuA2UIWidget);
  defineElement("lu-sandbox-widget", LuSandboxWidget);
}
