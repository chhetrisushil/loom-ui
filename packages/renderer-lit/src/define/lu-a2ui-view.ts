import { defineElement } from "../define.js";
import { LuA2UIView } from "../widgets/lu-a2ui-view.js";

/** Register `<lu-a2ui-view>`. Idempotent. */
export function defineA2uiView(): void {
  defineElement("lu-a2ui-view", LuA2UIView);
}
