import { defineElement } from "../define";
import { LuA2UIView } from "../widgets/lu-a2ui-view";

/** Register `<lu-a2ui-view>`. Idempotent. */
export function defineA2uiView(): void {
  defineElement("lu-a2ui-view", LuA2UIView);
}
